import * as vscode from 'vscode';
import { Disposable } from '../common/lifecycle';
import { CATEGORIES, RevisionsManager } from '../phabricator/revisionsManager';
import { CategoryNode } from './treeNodes/categoryNode';
import { RevisionNode } from './treeNodes/revisionNode';

type Node = CategoryNode | RevisionNode | vscode.TreeItem;

export class RevisionsTreeDataProvider extends Disposable implements vscode.TreeDataProvider<Node> {
	private readonly _onDidChangeTreeData = this._register(new vscode.EventEmitter<Node | undefined>());
	public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly _manager: RevisionsManager) {
		super();
		this._register(
			this._manager.onDidChangeRevisions(() => {
				this._onDidChangeTreeData.fire(undefined);
			}),
		);
	}

	public getTreeItem(element: Node): vscode.TreeItem {
		return element;
	}

	public async getChildren(element?: Node): Promise<Node[]> {
		if (!element) {
			if (!this._manager.session) {
				return [];
			}
			return CATEGORIES.map((c) => new CategoryNode(c, this._manager));
		}
		if (element instanceof CategoryNode) {
			return element.getChildren();
		}
		if (element instanceof RevisionNode) {
			return element.getChildren();
		}
		return [];
	}
}
