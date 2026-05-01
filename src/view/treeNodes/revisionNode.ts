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

interface IconSpec {
	codicon: string;
	color?: string;
}

const STATUS_ICON: Record<string, IconSpec> = {
	'needs-review': { codicon: 'git-pull-request', color: 'charts.blue' },
	'needs-revision': { codicon: 'git-pull-request', color: 'charts.red' },
	'changes-planned': { codicon: 'edit', color: 'charts.yellow' },
	'accepted': { codicon: 'pass-filled', color: 'charts.green' },
	'published': { codicon: 'git-merge', color: 'charts.purple' },
	'abandoned': { codicon: 'circle-slash', color: 'descriptionForeground' },
	'draft': { codicon: 'git-pull-request-draft', color: 'descriptionForeground' },
};

function iconForStatus(status: string): vscode.ThemeIcon {
	const spec = STATUS_ICON[status] || { codicon: 'git-pull-request' };
	return spec.color
		? new vscode.ThemeIcon(spec.codicon, new vscode.ThemeColor(spec.color))
		: new vscode.ThemeIcon(spec.codicon);
}

export class RevisionNode extends vscode.TreeItem {
	contextValue = 'revision';
	public readonly browserUri: string;

	constructor(public readonly model: RevisionModel) {
		super(model.title, vscode.TreeItemCollapsibleState.Collapsed);
		this.id = `revision:${model.phid}`;
		const statusLabel = STATUS_BADGE[model.statusValue] || model.statusName;
		this.description = `${model.monogram} ${statusLabel}`;
		this.tooltip = `${model.monogram} — ${model.title}\n${model.statusName}`;
		this.iconPath = iconForStatus(model.statusValue);
		this.browserUri = model.uri;
		this.command = {
			command: 'phabricator.openRevision',
			title: 'Open Revision',
			arguments: [model.id],
		};
	}

	public async getChildren(): Promise<vscode.TreeItem[]> {
		try {
			const changesets = await this.model.getChangesets();
			if (changesets.length === 0) {
				const empty = new vscode.TreeItem('No files in this diff');
				empty.contextValue = 'empty';
				return [empty];
			}
			return changesets.map((cs) => new FileChangeNode(this.model, cs));
		} catch (err) {
			const error = new vscode.TreeItem(`Failed to load diff: ${err instanceof Error ? err.message : err}`);
			error.iconPath = new vscode.ThemeIcon('error');
			return [error];
		}
	}
}
