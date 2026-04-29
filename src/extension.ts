import * as vscode from 'vscode';
import { CredentialStore } from './auth/credentialStore';
import { runSignInFlow } from './auth/tokenInput';
import Logger from './common/logger';
import { RevisionsManager } from './phabricator/revisionsManager';
import { RevisionsTreeDataProvider } from './view/revisionsTreeDataProvider';
import { InMemRevisionFileSystemProvider } from './view/inMemRevisionContentProvider';
import { PHAB_SCHEME } from './common/uri';
import { RevisionOverviewPanel } from './phabricator/revisionOverview';

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
		vscode.commands.registerCommand('phabricator.openInBrowser', (uri: string | { uri?: string }) => {
			const target = typeof uri === 'string' ? uri : uri && uri.uri;
			if (target) {
				vscode.env.openExternal(vscode.Uri.parse(target));
			}
		}),
	);

	const restored = await credentials.restore();
	if (restored) {
		updateContext(true);
	}
}

export function deactivate(): void {
	// nothing to clean up — disposables run via context.subscriptions
}
