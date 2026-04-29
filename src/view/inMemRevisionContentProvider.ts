import * as vscode from 'vscode';
import { RevisionsManager } from '../phabricator/revisionsManager';
import { fromPhabUri } from '../common/uri';
import { Disposable } from '../common/lifecycle';

const EMPTY = new Uint8Array();

/**
 * Read-only filesystem provider for phab:// URIs. Each URI points at a
 * (revision, diff, file, side); we look up the matching changeset on the
 * revision model and synthesize the file content from its hunk corpus.
 */
export class InMemRevisionFileSystemProvider extends Disposable implements vscode.FileSystemProvider {
	private readonly _onDidChangeFile = this._register(new vscode.EventEmitter<vscode.FileChangeEvent[]>());
	public readonly onDidChangeFile = this._onDidChangeFile.event;

	constructor(private readonly _manager: RevisionsManager) {
		super();
	}

	watch(): vscode.Disposable {
		return { dispose: () => undefined };
	}

	stat(): vscode.FileStat {
		return {
			type: vscode.FileType.File,
			ctime: 0,
			mtime: 0,
			size: 0,
			permissions: vscode.FilePermission.Readonly,
		};
	}

	readDirectory(): [string, vscode.FileType][] {
		return [];
	}

	createDirectory(): void {
		throw vscode.FileSystemError.NoPermissions('phab:// is read-only');
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const params = fromPhabUri(uri);
		if (!params) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		const model = await this._manager.getOrFetchRevision(params.revisionPHID);
		if (!model) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		const changeset = await model.findChangeset(params.fileName, params.side);
		if (!changeset) {
			return EMPTY;
		}
		const text = model.synthesizeContent(changeset, params.side);
		return new TextEncoder().encode(text);
	}

	writeFile(): void {
		throw vscode.FileSystemError.NoPermissions('phab:// is read-only');
	}

	delete(): void {
		throw vscode.FileSystemError.NoPermissions('phab:// is read-only');
	}

	rename(): void {
		throw vscode.FileSystemError.NoPermissions('phab:// is read-only');
	}
}
