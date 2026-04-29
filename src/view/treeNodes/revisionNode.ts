import * as vscode from 'vscode';
import { RevisionModel } from '../../phabricator/revisionModel';
import { FileChangeNode } from './fileChangeNode';

const STATUS_BADGE: Record<string, string> = {
	'needs-review': 'Needs Review',
	'needs-revision': 'Needs Revision',
	'changes-planned': 'Changes Planned',
	'accepted': 'Accepted',
	'published': 'Closed',
	'abandoned': 'Abandoned',
	'draft': 'Draft',
};

export class RevisionNode extends vscode.TreeItem {
	contextValue = 'revision';
	public readonly browserUri: string;

	constructor(public readonly model: RevisionModel) {
		super(`${model.monogram}: ${model.title}`, vscode.TreeItemCollapsibleState.Collapsed);
		this.id = `revision:${model.phid}`;
		this.description = STATUS_BADGE[model.statusValue] || model.statusName;
		this.tooltip = `${model.monogram} — ${model.title}\n${model.statusName}`;
		this.iconPath = new vscode.ThemeIcon('git-pull-request');
		this.browserUri = model.uri;
		this.command = {
			command: 'phabricator.openRevision',
			title: 'Open Revision',
			arguments: [model.id],
		};
	}

	public async getChildren(): Promise<vscode.TreeItem[]> {
		try {
			const files = await this.model.getFiles();
			if (files.length === 0) {
				const empty = new vscode.TreeItem('No files in this diff');
				empty.contextValue = 'empty';
				return [empty];
			}
			return files.map((file) => new FileChangeNode(this.model, file));
		} catch (err) {
			const error = new vscode.TreeItem(`Failed to load diff: ${err instanceof Error ? err.message : err}`);
			error.iconPath = new vscode.ThemeIcon('error');
			return [error];
		}
	}
}
