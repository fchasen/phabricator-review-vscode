import * as vscode from 'vscode';
import { CategoryDefinition, RevisionsManager } from '../../phabricator/revisionsManager';
import { RevisionNode } from './revisionNode';

export class CategoryNode extends vscode.TreeItem {
	contextValue = 'category';

	constructor(
		public readonly definition: CategoryDefinition,
		private readonly _manager: RevisionsManager,
	) {
		super(definition.label, vscode.TreeItemCollapsibleState.Expanded);
		this.id = `category:${definition.key}`;
	}

	public async getChildren(): Promise<RevisionNode[]> {
		const revisions = await this._manager.getRevisionsForCategory(this.definition.key);
		if (revisions.length === 0) {
			const empty = new vscode.TreeItem('No revisions') as RevisionNode;
			empty.contextValue = 'empty';
			empty.description = '';
			empty.collapsibleState = vscode.TreeItemCollapsibleState.None;
			return [empty];
		}
		return revisions.map((r) => new RevisionNode(r));
	}
}
