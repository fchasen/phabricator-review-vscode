import * as vscode from 'vscode';
import { ParsedFile } from '../../common/diffHunk';
import { RevisionModel } from '../../phabricator/revisionModel';
import { toPhabUri } from '../../common/uri';

const STATUS_LABEL: Record<ParsedFile['status'], string> = {
	added: 'A',
	removed: 'D',
	modified: 'M',
	renamed: 'R',
	copied: 'C',
};

export class FileChangeNode extends vscode.TreeItem {
	contextValue = 'fileChange';

	constructor(public readonly model: RevisionModel, public readonly file: ParsedFile) {
		super(file.newPath || file.oldPath || '<unknown>', vscode.TreeItemCollapsibleState.None);
		this.id = `${model.phid}:${file.newPath || file.oldPath}`;
		this.description = STATUS_LABEL[file.status];
		this.tooltip = `${file.status.toUpperCase()} ${file.newPath || file.oldPath}`;
		this.command = {
			command: 'vscode.diff',
			title: 'Open Diff',
			arguments: [
				toPhabUri({
					revisionId: model.id,
					revisionPHID: model.phid,
					diffPHID: model.revision.fields.diffPHID,
					fileName: file.oldPath || file.newPath || '',
					side: 'before',
					status: file.status,
				}),
				toPhabUri({
					revisionId: model.id,
					revisionPHID: model.phid,
					diffPHID: model.revision.fields.diffPHID,
					fileName: file.newPath || file.oldPath || '',
					side: 'after',
					status: file.status,
				}),
				`${model.monogram} — ${file.newPath || file.oldPath}`,
			],
		};
	}
}
