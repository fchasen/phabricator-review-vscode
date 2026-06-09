import * as vscode from 'vscode';
import { Change } from '../../api/git';
import { WorktreeMapping } from '../../phabricator/worktreeRevisionMap';

// Mirrors the (const enum) Status values from vscode.git's API. Using literal
// numbers avoids const-enum inlining issues across the TS/esbuild boundary.
const INDEX_MODIFIED = 0;
const INDEX_ADDED = 1;
const INDEX_DELETED = 2;
const INDEX_RENAMED = 3;
const INDEX_COPIED = 4;
const MODIFIED = 5;
const DELETED = 6;
const UNTRACKED = 7;

const STATUS_LABEL: Record<number, string> = {
	[INDEX_ADDED]: 'A',
	[INDEX_MODIFIED]: 'M',
	[INDEX_DELETED]: 'D',
	[INDEX_RENAMED]: 'R',
	[INDEX_COPIED]: 'C',
	[MODIFIED]: 'M',
	[DELETED]: 'D',
	[UNTRACKED]: 'A',
};

const STATUS_ICON: Record<number, vscode.ThemeIcon> = {
	[INDEX_ADDED]: new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground')),
	[INDEX_MODIFIED]: new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')),
	[INDEX_DELETED]: new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('gitDecoration.deletedResourceForeground')),
	[INDEX_RENAMED]: new vscode.ThemeIcon('diff-renamed', new vscode.ThemeColor('gitDecoration.renamedResourceForeground')),
	[INDEX_COPIED]: new vscode.ThemeIcon('diff-renamed'),
	[MODIFIED]: new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')),
	[DELETED]: new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('gitDecoration.deletedResourceForeground')),
	[UNTRACKED]: new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.untrackedResourceForeground')),
};

export class UnsubmittedCommitNode extends vscode.TreeItem {
	contextValue = 'unsubmitted-commit';
	public readonly mapping: WorktreeMapping;

	constructor(mapping: WorktreeMapping) {
		super(mapping.headSubject || '(no subject)', vscode.TreeItemCollapsibleState.Collapsed);
		this.mapping = mapping;
		this.id = `unsubmitted:${mapping.rootUri.toString()}:${mapping.headSha}`;
		this.description = mapping.branch || mapping.headSha.slice(0, 7);
		const repoName = mapping.rootUri.path.split('/').pop() || mapping.rootUri.fsPath;
		this.tooltip = `${mapping.headSubject}\n${repoName} · ${mapping.headSha.slice(0, 7)}`;
		this.iconPath = new vscode.ThemeIcon('git-commit');
		this.command = {
			command: 'phabricator.openUnsubmittedCommit',
			title: 'Open Unsubmitted Commit',
			arguments: [{ repoRoot: mapping.rootUri.toString(), headSha: mapping.headSha }],
		};
	}

	public async getChildren(): Promise<vscode.TreeItem[]> {
		const { repo, headSha } = this.mapping;
		const parent = `${headSha}^`;
		let changes: Change[];
		try {
			changes = await repo.diffBetween(parent, headSha);
		} catch (err) {
			const error = new vscode.TreeItem(`Failed to load diff: ${err instanceof Error ? err.message : err}`);
			error.iconPath = new vscode.ThemeIcon('error');
			return [error];
		}
		if (!changes || changes.length === 0) {
			const empty = new vscode.TreeItem('No files in this commit');
			empty.contextValue = 'empty';
			return [empty];
		}
		return changes.map((c) => makeFileChangeItem(c, headSha));
	}
}

function makeFileChangeItem(change: Change, headSha: string): vscode.TreeItem {
	const uri = change.uri;
	const label = uri.path.split('/').pop() || uri.fsPath;
	const dir = uri.path.slice(0, uri.path.length - label.length).replace(/^\//, '').replace(/\/$/, '');
	const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
	item.id = `unsubmitted-change:${headSha}:${uri.toString()}`;
	item.description = STATUS_LABEL[change.status] || '?';
	item.tooltip = `${item.description} ${uri.fsPath}`;
	item.resourceUri = uri;
	item.iconPath = STATUS_ICON[change.status] || new vscode.ThemeIcon('file');
	item.contextValue = 'unsubmitted-file';
	if (dir) {
		item.description = `${item.description}  ${dir}`;
	}
	item.command = {
		command: 'vscode.open',
		title: 'Open File',
		arguments: [uri],
	};
	return item;
}
