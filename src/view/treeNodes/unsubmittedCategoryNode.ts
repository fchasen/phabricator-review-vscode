import * as vscode from 'vscode';
import { WorktreeRevisionMap } from '../../phabricator/worktreeRevisionMap';
import { UnsubmittedCommitNode } from './unsubmittedCommitNode';

export class UnsubmittedCategoryNode extends vscode.TreeItem {
	contextValue = 'unsubmitted-category';

	constructor(private readonly _map: WorktreeRevisionMap) {
		super('Unsubmitted', vscode.TreeItemCollapsibleState.Expanded);
		this.id = 'category:unsubmitted';
	}

	public getChildren(): vscode.TreeItem[] {
		const mappings = this._map.getUnsubmitted();
		if (mappings.length === 0) {
			const empty = new vscode.TreeItem('No unsubmitted commits');
			empty.contextValue = 'empty';
			return [empty];
		}
		mappings.sort((a, b) => {
			const ad = a.headDate?.getTime() || 0;
			const bd = b.headDate?.getTime() || 0;
			return bd - ad;
		});
		return mappings.map((m) => new UnsubmittedCommitNode(m));
	}
}
