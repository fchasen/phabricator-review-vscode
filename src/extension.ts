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
	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('phabricator:revisions', treeProvider),
	);

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
		vscode.commands.registerCommand('phabricator.openInBrowser', (arg: unknown) => {
			let target: string | undefined;
			if (typeof arg === 'string') {
				target = arg;
			} else if (arg && typeof arg === 'object') {
				const obj = arg as { browserUri?: string; model?: { uri?: string } };
				target = obj.browserUri || obj.model?.uri;
			}
			if (target) {
				vscode.env.openExternal(vscode.Uri.parse(target));
			}
		}),
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
