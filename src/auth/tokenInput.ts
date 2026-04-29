import * as vscode from 'vscode';
import { CredentialStore, describeAuthError, PhabSession } from './credentialStore';

const TOKEN_DOCS_URL = 'https://phabricator.services.mozilla.com/conduit/login';

export async function runSignInFlow(credentials: CredentialStore): Promise<PhabSession | undefined> {
	const open: vscode.MessageItem = { title: 'Open token page' };
	const enter: vscode.MessageItem = { title: 'I have my token' };
	const cancel: vscode.MessageItem = { title: 'Cancel', isCloseAffordance: true };

	const choice = await vscode.window.showInformationMessage(
		'To sign in, paste a Conduit API token from Mozilla Phabricator.',
		{ modal: true, detail: TOKEN_DOCS_URL },
		open,
		enter,
		cancel,
	);
	if (!choice || choice === cancel) {
		return undefined;
	}
	if (choice === open) {
		await vscode.env.openExternal(vscode.Uri.parse(TOKEN_DOCS_URL));
	}

	const token = await vscode.window.showInputBox({
		prompt: 'Conduit API Token',
		placeHolder: 'api-...',
		password: true,
		ignoreFocusOut: true,
		validateInput: (value) => (value && value.trim().length > 0 ? undefined : 'Token cannot be empty'),
	});
	if (!token) {
		return undefined;
	}

	try {
		const session = await credentials.signIn(token.trim());
		vscode.window.showInformationMessage(`Signed in as ${session.userName}.`);
		return session;
	} catch (err) {
		vscode.window.showErrorMessage(`Sign in failed: ${describeAuthError(err)}`);
		return undefined;
	}
}
