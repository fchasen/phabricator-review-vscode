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
	const resolver = manager.userResolver;
	if (resolver && current.length > 0) {
		await resolver.resolveMany(current);
	}
	const currentSlugs = current.map((p) => resolver?.displayName(p) || p);
	const input = await vscode.window.showInputBox({
		prompt: 'Project tags (comma-separated slugs, with or without #)',
		placeHolder: 'firefox-build-system, backup-reviewers-rotation',
		value: currentSlugs.join(', '),
		ignoreFocusOut: true,
	});
	if (input === undefined) {
		return;
	}
	const tokens = input
		.split(',')
		.map((t) => t.trim().replace(/^#/, ''))
		.filter((t) => t.length > 0);

	const resolvedPHIDs: string[] = [];
	if (tokens.length > 0) {
		try {
			const result = await session.client.call<{ data: Array<{ phid: string; fields: { slug: string | null; name: string } }> }>(
				'project.search',
				{ constraints: { slugs: tokens } },
			);
			const found = new Map<string, string>();
			for (const project of result.data) {
				if (project.fields.slug) {
					found.set(project.fields.slug, project.phid);
				}
			}
			const unknown: string[] = [];
			for (const slug of tokens) {
				const phid = found.get(slug);
				if (phid) {
					resolvedPHIDs.push(phid);
				} else {
					unknown.push(slug);
				}
			}
			if (unknown.length > 0) {
				const proceed = await vscode.window.showWarningMessage(
					`Unknown project slug(s): ${unknown.join(', ')}. Continue and ignore them?`,
					{ modal: true },
					'Continue',
					'Cancel',
				);
				if (proceed !== 'Continue') {
					return;
				}
			}
		} catch (err) {
			vscode.window.showErrorMessage(`project.search failed: ${err instanceof Error ? err.message : err}`);
			return;
		}
	}

	try {
		await model.setProjects(resolvedPHIDs);
		vscode.window.showInformationMessage(`Updated project tags on ${model.monogram}.`);
	} catch (err) {
		vscode.window.showErrorMessage(`Failed to update projects: ${err instanceof Error ? err.message : err}`);
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
