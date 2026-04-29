import * as vscode from 'vscode';
import type { Changeset } from 'phabricator-client';
import { RevisionModel } from '../../phabricator/revisionModel';
import { toPhabUri, PhabUriParams } from '../../common/uri';

const TYPE_LABEL: Record<number, string> = {
	1: 'A', // add
	2: 'M', // change
	3: 'D', // delete
	4: 'R', // moveAway
	5: 'C', // copyAway
	6: 'R', // moveHere
	7: 'C', // copyHere
	8: 'C', // multicopy
};

const TYPE_ICON: Record<number, vscode.ThemeIcon> = {
	1: new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground')),
	2: new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')),
	3: new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('gitDecoration.deletedResourceForeground')),
	4: new vscode.ThemeIcon('diff-renamed', new vscode.ThemeColor('gitDecoration.renamedResourceForeground')),
	5: new vscode.ThemeIcon('diff-renamed'),
	6: new vscode.ThemeIcon('diff-renamed', new vscode.ThemeColor('gitDecoration.renamedResourceForeground')),
	7: new vscode.ThemeIcon('diff-renamed'),
	8: new vscode.ThemeIcon('diff-renamed'),
};

const TYPE_TO_STATUS: Record<number, PhabUriParams['status']> = {
	1: 'added',
	2: 'modified',
	3: 'removed',
	4: 'renamed',
	5: 'copied',
	6: 'renamed',
	7: 'copied',
	8: 'copied',
};

export function changesetStatus(type: number): PhabUriParams['status'] {
	return TYPE_TO_STATUS[type] || 'modified';
}

export class FileChangeNode extends vscode.TreeItem {
	contextValue = 'fileChange';

	constructor(public readonly model: RevisionModel, public readonly changeset: Changeset) {
		super(changeset.currentPath || changeset.oldPath || '<unknown>', vscode.TreeItemCollapsibleState.None);
		this.id = `${model.phid}:${changeset.currentPath || changeset.oldPath}`;
		this.description = TYPE_LABEL[changeset.type] || '?';
		this.tooltip = `${TYPE_LABEL[changeset.type] || '?'} ${changeset.currentPath || changeset.oldPath}`;
		this.iconPath = TYPE_ICON[changeset.type] || new vscode.ThemeIcon('file');
		const status = changesetStatus(changeset.type);
		this.command = {
			command: 'vscode.diff',
			title: 'Open Diff',
			arguments: [
				toPhabUri({
					revisionId: model.id,
					revisionPHID: model.phid,
					diffPHID: model.revision.fields.diffPHID,
					fileName: changeset.oldPath || changeset.currentPath || '',
					side: 'before',
					status,
				}),
				toPhabUri({
					revisionId: model.id,
					revisionPHID: model.phid,
					diffPHID: model.revision.fields.diffPHID,
					fileName: changeset.currentPath || changeset.oldPath || '',
					side: 'after',
					status,
				}),
				`${model.monogram} — ${changeset.currentPath || changeset.oldPath}`,
			],
		};
	}
}
