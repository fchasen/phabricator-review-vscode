import * as vscode from 'vscode';
import { CredentialStore } from './auth/credentialStore';
import { runSignInFlow } from './auth/tokenInput';
import Logger from './common/logger';
import { RevisionsManager } from './phabricator/revisionsManager';
import { RevisionsTreeDataProvider } from './view/revisionsTreeDataProvider';
import { InMemRevisionFileSystemProvider } from './view/inMemRevisionContentProvider';
import { PHAB_SCHEME, toPhabUri } from './common/uri';
import { RevisionOverviewPanel } from './phabricator/revisionOverview';
import { RevisionCommentController } from './view/revisionCommentController';
import { runSubmitCommitFlow } from './view/createRevisionFlow';
import type { Project } from './client';

const SESSION_CONTEXT_KEY = 'phabricator.session';

export async function activate(context: vscode.ExtensionContext) {
	Logger.info('Activating Mozilla Phabricator extension');

	const credentials = new CredentialStore(
		context.secrets,
		context.workspaceState,
		() => vscode.workspace.getConfiguration('phabricator').get<string>('baseUrl', 'https://phabricator.services.mozilla.com/api/'),
	);
	context.subscriptions.push(credentials);

	const revisionsManager = new RevisionsManager(credentials);
	context.subscriptions.push(revisionsManager);

	const treeProvider = new RevisionsTreeDataProvider(revisionsManager);
	context.subscriptions.push(treeProvider);
	const treeView = vscode.window.createTreeView('phabricator:revisions', { treeDataProvider: treeProvider });
	context.subscriptions.push(treeView);

	const updateBadge = async () => {
		try {
			const total = await revisionsManager.getAttentionCount();
			if (total === 0) {
				treeView.badge = undefined;
				return;
			}
			treeView.badge = { value: total, tooltip: `${total} item${total === 1 ? '' : 's'} need your attention` };
		} catch (err) {
			Logger.warn(`Failed to compute attention badge: ${err instanceof Error ? err.message : err}`);
		}
	};
	context.subscriptions.push(revisionsManager.onDidChangeRevisions(() => { void updateBadge(); }));
	void updateBadge();

	const fsProvider = new InMemRevisionFileSystemProvider(revisionsManager);
	context.subscriptions.push(fsProvider);
	context.subscriptions.push(
		vscode.workspace.registerFileSystemProvider(PHAB_SCHEME, fsProvider, {
			isReadonly: true,
			isCaseSensitive: true,
		}),
	);

	const commentController = new RevisionCommentController(revisionsManager);
	context.subscriptions.push(commentController);

	const updateContext = (authed: boolean) => {
		vscode.commands.executeCommand('setContext', SESSION_CONTEXT_KEY, authed ? 'authenticated' : 'unauthenticated');
	};
	updateContext(false);
	credentials.onDidChangeSession((session) => updateContext(!!session));

	context.subscriptions.push(
		vscode.commands.registerCommand('phabricator.signIn', () => runSignInFlow(credentials)),
		vscode.commands.registerCommand('phabricator.signOut', () => credentials.signOut()),
		vscode.commands.registerCommand('phabricator.refresh', () => revisionsManager.refresh()),
		vscode.commands.registerCommand('phabricator.openRevision', (revisionId: number | string) =>
			RevisionOverviewPanel.show(context.extensionUri, revisionsManager, revisionId),
		),
		vscode.commands.registerCommand('phabricator.submitInlineComment', async (thread: vscode.CommentThread) => {
			try {
				await commentController.submit(thread);
			} catch (err) {
				vscode.window.showErrorMessage(`Failed to submit comment: ${err instanceof Error ? err.message : err}`);
			}
		}),
		vscode.commands.registerCommand('phabricator.submitCommit', () =>
			runSubmitCommitFlow(revisionsManager, context.extensionUri, 'create'),
		),
		vscode.commands.registerCommand('phabricator.updateRevisionFromCommit', () =>
			runSubmitCommitFlow(revisionsManager, context.extensionUri, 'update'),
		),
		vscode.commands.registerCommand(
			'phabricator.revealInlineComment',
			(args: RevealInlineArgs) => revealInlineComment(args),
		),
		vscode.commands.registerCommand('phabricator.editProjects', (revisionPHID: string) =>
			editProjectsFlow(revisionsManager, revisionPHID),
		),
	);

	const restored = await credentials.restore();
	if (restored) {
		updateContext(true);
	}
}

interface RevealInlineArgs {
	revisionId: number;
	revisionPHID: string;
	diffPHID: string;
	path: string;
	line: number;
	length?: number;
	isNewFile: boolean;
	status?: 'added' | 'removed' | 'modified' | 'renamed' | 'copied';
}

interface ProjectPickItem extends vscode.QuickPickItem {
	phid: string;
}

const PROJECT_PICK_DEBOUNCE_MS = 200;
const PROJECT_PICK_LIMIT = 20;

function pickProject(
	session: import('./auth/credentialStore').PhabSession,
	existingPHIDs: Set<string>,
): Promise<ProjectPickItem | null> {
	return new Promise((resolve) => {
		const qp = vscode.window.createQuickPick<ProjectPickItem>();
		qp.placeholder = 'Search project tags by name';
		qp.matchOnDescription = true;

		let token = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const settle = (value: ProjectPickItem | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};

		const search = (value: string) => {
			const cur = ++token;
			const term = value.trim();
			if (!term) {
				qp.items = [];
				qp.busy = false;
				return;
			}
			qp.busy = true;
			void session.client.searchProjects({ query: term, limit: PROJECT_PICK_LIMIT }).then(
				(projects: Project[]) => {
					if (cur !== token) return;
					qp.busy = false;
					qp.items = projects
						.filter((p) => !existingPHIDs.has(p.phid))
						.map((p) => {
							const name = p.fields?.name || p.phid;
							const slug = p.fields?.slug;
							return {
								label: name,
								description: slug ? `#${slug}` : undefined,
								phid: p.phid,
								alwaysShow: true,
							};
						});
				},
				(err: unknown) => {
					if (cur !== token) return;
					qp.busy = false;
					qp.items = [];
					Logger.warn(`project.search failed: ${err instanceof Error ? err.message : err}`, 'Projects');
				},
			);
		};

		qp.onDidChangeValue((v) => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => search(v), PROJECT_PICK_DEBOUNCE_MS);
		});
		qp.onDidAccept(() => {
			settle(qp.selectedItems[0] || null);
			qp.hide();
		});
		qp.onDidHide(() => {
			if (timer) clearTimeout(timer);
			settle(null);
			qp.dispose();
		});
		qp.show();
	});
}

async function editProjectsFlow(manager: import('./phabricator/revisionsManager').RevisionsManager, revisionPHID: string): Promise<void> {
	const session = manager.session;
	if (!session) {
		vscode.window.showErrorMessage('Sign in to edit project tags.');
		return;
	}
	const model = await manager.getOrFetchRevision(revisionPHID);
	if (!model) {
		vscode.window.showErrorMessage('Revision not found.');
		return;
	}
	const current = model.revision.attachments.projects?.projectPHIDs || [];
	const picked = await pickProject(session, new Set(current));
	if (!picked) {
		return;
	}
	try {
		await model.setProjects([...current, picked.phid]);
		vscode.window.showInformationMessage(`Tagged ${model.monogram} with ${picked.label}.`);
	} catch (err) {
		vscode.window.showErrorMessage(`Failed to add project tag: ${err instanceof Error ? err.message : err}`);
	}
}

async function revealInlineComment(args: RevealInlineArgs): Promise<void> {
	const side: 'before' | 'after' = args.isNewFile ? 'after' : 'before';
	const status = args.status || 'modified';
	const beforeUri = toPhabUri({
		revisionId: args.revisionId,
		revisionPHID: args.revisionPHID,
		diffPHID: args.diffPHID,
		fileName: args.path,
		side: 'before',
		status,
	});
	const afterUri = toPhabUri({
		revisionId: args.revisionId,
		revisionPHID: args.revisionPHID,
		diffPHID: args.diffPHID,
		fileName: args.path,
		side: 'after',
		status,
	});
	const startLine = Math.max(0, args.line - 1);
	const endLine = Math.max(startLine, startLine + (args.length || 0));
	const range = new vscode.Range(startLine, 0, endLine, 0);
	const targetUri = side === 'after' ? afterUri : beforeUri;
	await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, `D${args.revisionId} — ${args.path}`, {
		selection: range,
	} satisfies vscode.TextDocumentShowOptions);
	const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === targetUri.toString());
	if (editor) {
		editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
		editor.selection = new vscode.Selection(range.start, range.end);
	}
}

export function deactivate(): void {
	// nothing to clean up — disposables run via context.subscriptions
}
