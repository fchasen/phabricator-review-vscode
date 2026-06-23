import * as vscode from 'vscode';
import { CredentialStore } from './auth/credentialStore';
import { runSignInFlow } from './auth/tokenInput';
import Logger from './common/logger';
import { RevisionsManager } from './phabricator/revisionsManager';
import { RevisionsTreeDataProvider } from './view/revisionsTreeDataProvider';
import { InMemRevisionFileSystemProvider } from './view/inMemRevisionContentProvider';
import { PHAB_SCHEME } from './common/uri';
import { RevisionOverviewPanel } from './phabricator/revisionOverview';
import { RevisionCommentController } from './view/revisionCommentController';
import { WorktreeRevisionMap } from './phabricator/worktreeRevisionMap';
import { WorktreeAnchorResolver, OpenWorktreeOrPhabDiffArgs } from './phabricator/worktreeAnchor';
import { WorktreeSyncWatcher } from './phabricator/worktreeSyncWatcher';
import { runMozPhabSubmit } from './phabricator/mozPhabSubmit';
import { runCheckoutRevisionWorktree, ensureWorktreeInWorkspace } from './phabricator/checkoutRevisionWorktree';
import { PreSubmitOverviewPanel } from './view/preSubmitOverviewPanel';
import { GitExtension, GitAPI } from './api/git';
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

	const worktreeMap = new WorktreeRevisionMap();
	context.subscriptions.push(worktreeMap);

	const treeProvider = new RevisionsTreeDataProvider(revisionsManager, worktreeMap);
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

	const gitApi = await getGitApi();
	const anchorResolver = new WorktreeAnchorResolver(gitApi, worktreeMap, revisionsManager, context.workspaceState);
	context.subscriptions.push(anchorResolver);

	const commentController = new RevisionCommentController(revisionsManager, anchorResolver);
	context.subscriptions.push(commentController);

	const worktreeSync = new WorktreeSyncWatcher(revisionsManager, worktreeMap, anchorResolver);
	context.subscriptions.push(worktreeSync);

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
			RevisionOverviewPanel.show(
				context.extensionUri,
				revisionsManager,
				{ resolveActiveRepoRoot, onDidChangeWorktrees: anchorResolver.onDidChangeWorktrees },
				revisionId,
			),
		),
		vscode.commands.registerCommand('phabricator.submitInlineComment', async (thread: vscode.CommentThread) => {
			try {
				await commentController.submit(thread);
			} catch (err) {
				vscode.window.showErrorMessage(`Failed to submit comment: ${err instanceof Error ? err.message : err}`);
			}
		}),
		vscode.commands.registerCommand('phabricator.submitCommit', async () => {
			const repoRoot = await resolveActiveRepoRoot();
			if (!repoRoot) {
				vscode.window.showErrorMessage('No git repository found for the active editor.');
				return;
			}
			runMozPhabSubmit(repoRoot);
		}),
		vscode.commands.registerCommand('phabricator.updateRevisionFromCommit', async () => {
			const repoRoot = await resolveActiveRepoRoot();
			if (!repoRoot) {
				vscode.window.showErrorMessage('No git repository found for the active editor.');
				return;
			}
			runMozPhabSubmit(repoRoot);
		}),
		vscode.commands.registerCommand(
			'phabricator.openUnsubmittedCommit',
			(args: { repoRoot: string; headSha: string }) =>
				PreSubmitOverviewPanel.show(context.extensionUri, revisionsManager, worktreeMap, args),
		),
		vscode.commands.registerCommand(
			'phabricator.submitUnsubmittedCommit',
			(arg: { repoRoot?: string; headSha?: string } | { mapping?: { rootUri?: vscode.Uri } } | undefined) => {
				const repoRoot = extractRepoRoot(arg);
				if (!repoRoot) {
					vscode.window.showErrorMessage('Could not determine the repository for this commit.');
					return;
				}
				runMozPhabSubmit(repoRoot);
			},
		),
		vscode.commands.registerCommand(
			'phabricator.revealInlineComment',
			(args: RevealInlineArgs) => revealInlineComment(anchorResolver, args),
		),
		vscode.commands.registerCommand(
			'phabricator.openWorktreeOrPhabDiff',
			(args: OpenWorktreeOrPhabDiffArgs) => openWorktreeOrPhabDiff(anchorResolver, args),
		),
		vscode.commands.registerCommand('phabricator.editProjects', (revisionPHID: string) =>
			editProjectsFlow(revisionsManager, revisionPHID),
		),
		vscode.commands.registerCommand(
			'phabricator.checkoutRevisionWorktree',
			(arg?: unknown) =>
				runCheckoutRevisionWorktree(
					{
						resolveActiveRepoRoot,
						pinAppliedDiff: async (revisionId) => {
							const model = await revisionsManager.getOrFetchRevision(revisionId);
							if (model) {
								await model.refresh().catch(() => {});
								anchorResolver.pin(revisionId, model.revision.fields.diffPHID);
							}
						},
					},
					normalizeRevisionArg(arg),
				),
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

/**
 * Open a file's before/after diff, anchored to the checked-out worktree
 * (native `git:` diff) when one is available and synthetic `phab://` otherwise.
 * Resolving the "before" ref is async, so both the tree's file nodes and
 * revealInlineComment route through here. A stale worktree is brought up to
 * date first (lazy sync trigger).
 */
async function openWorktreeOrPhabDiff(
	resolver: WorktreeAnchorResolver,
	args: OpenWorktreeOrPhabDiffArgs,
): Promise<void> {
	await resolver.ensureFresh(args.revisionId).catch(() => false);
	await ensureWorktreeFolderForDiff(resolver, args.revisionId);
	const beforeUri = await resolver.fileUriFor({
		revisionId: args.revisionId,
		revisionPHID: args.revisionPHID,
		diffPHID: args.diffPHID,
		path: args.oldPath || args.currentPath,
		side: 'before',
		status: args.status,
	});
	const afterUri = await resolver.fileUriFor({
		revisionId: args.revisionId,
		revisionPHID: args.revisionPHID,
		diffPHID: args.diffPHID,
		path: args.currentPath || args.oldPath,
		side: 'after',
		status: args.status,
	});

	let range: vscode.Range | undefined;
	let showOptions: vscode.TextDocumentShowOptions | undefined;
	if (args.selection) {
		const startLine = Math.max(0, args.selection.line - 1);
		const endLine = Math.max(startLine, startLine + (args.selection.length || 0));
		range = new vscode.Range(startLine, 0, endLine, 0);
		showOptions = { selection: range };
	}

	await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, args.title, showOptions);

	if (args.selection && range) {
		const targetUri = args.selection.isNewFile ? afterUri : beforeUri;
		const editor = vscode.window.visibleTextEditors.find(
			(e) => e.document.uri.toString() === targetUri.toString(),
		);
		if (editor) {
			editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
			editor.selection = new vscode.Selection(range.start, range.end);
		}
	}
}

async function ensureWorktreeFolderForDiff(
	resolver: WorktreeAnchorResolver,
	revisionId: number,
): Promise<void> {
	const root = resolver.worktreeRootFor(revisionId);
	if (!root) {
		return;
	}
	const added = ensureWorktreeInWorkspace(root.fsPath, `D${revisionId}`);
	if (!added) {
		return;
	}
	await waitForWorkspaceFolder(root);
	vscode.window.showInformationMessage(`Added D${revisionId} worktree to the workspace; its files are now editable.`);
}

function waitForWorkspaceFolder(uri: vscode.Uri, timeoutMs = 3000): Promise<void> {
	const present = () => !!vscode.workspace.getWorkspaceFolder(uri);
	if (present()) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
			if (present()) {
				clearTimeout(timer);
				sub.dispose();
				resolve();
			}
		});
		const timer = setTimeout(() => {
			sub.dispose();
			resolve();
		}, timeoutMs);
	});
}

function revealInlineComment(resolver: WorktreeAnchorResolver, args: RevealInlineArgs): Promise<void> {
	return openWorktreeOrPhabDiff(resolver, {
		revisionId: args.revisionId,
		revisionPHID: args.revisionPHID,
		diffPHID: args.diffPHID,
		oldPath: args.path,
		currentPath: args.path,
		status: args.status || 'modified',
		title: `D${args.revisionId} — ${args.path}`,
		selection: { line: args.line, length: args.length, isNewFile: args.isNewFile },
	});
}

async function getGitApi(): Promise<GitAPI | undefined> {
	const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!extension) return undefined;
	const ext = extension.isActive ? extension.exports : await extension.activate();
	return ext.getAPI(1);
}

async function resolveActiveRepoRoot(): Promise<vscode.Uri | undefined> {
	const api = await getGitApi();
	if (!api || api.repositories.length === 0) return undefined;
	const activeUri = vscode.window.activeTextEditor?.document.uri;
	if (activeUri) {
		const repo = api.getRepository(activeUri);
		if (repo) return repo.rootUri;
	}
	if (api.repositories.length === 1) {
		return api.repositories[0].rootUri;
	}
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder) {
		const repo = api.getRepository(folder.uri);
		if (repo) return repo.rootUri;
	}
	return api.repositories[0].rootUri;
}

function normalizeRevisionArg(arg: unknown): number | string | undefined {
	if (arg === undefined || arg === null) {
		return undefined;
	}
	if (typeof arg === 'number' || typeof arg === 'string') {
		return arg;
	}
	if (typeof arg === 'object' && 'model' in arg) {
		const model = (arg as { model?: { id?: number } }).model;
		if (model && typeof model.id === 'number') {
			return model.id;
		}
	}
	return undefined;
}

function extractRepoRoot(
	arg: { repoRoot?: string; headSha?: string } | { mapping?: { rootUri?: vscode.Uri } } | undefined,
): vscode.Uri | undefined {
	if (!arg) return undefined;
	if ('repoRoot' in arg && typeof arg.repoRoot === 'string') {
		return vscode.Uri.parse(arg.repoRoot);
	}
	if ('mapping' in arg && arg.mapping?.rootUri) {
		return arg.mapping.rootUri;
	}
	return undefined;
}

export function deactivate(): void {
	// nothing to clean up — disposables run via context.subscriptions
}
