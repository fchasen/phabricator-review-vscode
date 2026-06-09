import * as vscode from 'vscode';

const TERMINAL_NAME = 'Phabricator: moz-phab';

function findOrCreateTerminal(repoRoot: vscode.Uri): vscode.Terminal {
	const existing = vscode.window.terminals.find(
		(t) => t.name === TERMINAL_NAME && terminalCwd(t)?.fsPath === repoRoot.fsPath,
	);
	if (existing) return existing;
	return vscode.window.createTerminal({
		name: TERMINAL_NAME,
		cwd: repoRoot.fsPath,
	});
}

function terminalCwd(terminal: vscode.Terminal): vscode.Uri | undefined {
	const opts = terminal.creationOptions as { cwd?: string | vscode.Uri } | undefined;
	if (!opts?.cwd) return undefined;
	return typeof opts.cwd === 'string' ? vscode.Uri.file(opts.cwd) : opts.cwd;
}

export function runMozPhabSubmit(repoRoot: vscode.Uri): void {
	const mozPhabPath = vscode.workspace
		.getConfiguration('phabricator')
		.get<string>('mozPhabPath', 'moz-phab');
	const terminal = findOrCreateTerminal(repoRoot);
	terminal.show(false);
	terminal.sendText(`${mozPhabPath} submit`, true);
}
