import * as vscode from 'vscode';
import { Disposable } from '../common/lifecycle';
import { CATEGORIES, RevisionsManager } from '../phabricator/revisionsManager';
import { WorktreeRevisionMap } from '../phabricator/worktreeRevisionMap';
import { CategoryNode } from './treeNodes/categoryNode';
import { RevisionNode } from './treeNodes/revisionNode';
import { UnsubmittedCategoryNode } from './treeNodes/unsubmittedCategoryNode';
import { UnsubmittedCommitNode } from './treeNodes/unsubmittedCommitNode';

type Node = CategoryNode | RevisionNode | UnsubmittedCategoryNode | UnsubmittedCommitNode | vscode.TreeItem;

export class RevisionsTreeDataProvider extends Disposable implements vscode.TreeDataProvider<Node> {
	private readonly _onDidChangeTreeData = this._register(new vscode.EventEmitter<Node | undefined>());
	public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(
		private readonly _manager: RevisionsManager,
		private readonly _worktreeMap: WorktreeRevisionMap,
	) {
		super();
		this._register(
			this._manager.onDidChangeRevisions(() => {
				this._onDidChangeTreeData.fire(undefined);
			}),
		);
		this._register(
			this._worktreeMap.onDidChange(() => {
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
			const nodes: Node[] = [new UnsubmittedCategoryNode(this._worktreeMap)];
			for (const c of CATEGORIES) {
				nodes.push(new CategoryNode(c, this._manager));
			}
			return nodes;
		}
		if (element instanceof UnsubmittedCategoryNode) {
			return element.getChildren();
		}
		if (element instanceof UnsubmittedCommitNode) {
			return element.getChildren();
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
