import * as vscode from 'vscode';
import { RevisionsManager } from '../phabricator/revisionsManager';
import { fromPhabUri } from '../common/uri';
import { Disposable } from '../common/lifecycle';

const EMPTY = new Uint8Array();

/**
 * Read-only filesystem provider for phab:// URIs. Each URI is parsed to find
 * the revision/diff/file/side, and content is reconstructed from the cached
 * raw diff hunks. We never write back.
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

	stat(uri: vscode.Uri): vscode.FileStat {
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
		const files = await model.getFiles(params.diffPHID);
		const file = files.find((f) =>
			(params.side === 'before' ? f.oldPath : f.newPath) === params.fileName,
		);
		if (!file) {
			return EMPTY;
		}
		const text = await model.getFileFullContent(file, params.side);
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
