import * as vscode from 'vscode';
import { GitExtension, GitAPI, Repository } from '../api/git';
import Logger from '../common/logger';

const COMPONENT = 'LocalGit';

/**
 * Reads file content from any open git repository in the workspace.
 * We try every repository in turn; the first one that has the requested
 * commit (and the path at it) wins. Returns null if nothing matches.
 */
export class LocalGitResolver {
	private _api: GitAPI | undefined;
	private _ready: Promise<void> | undefined;

	private _commitPresence = new Map<string, Repository | null>();

	private async _ensureApi(): Promise<GitAPI | undefined> {
		if (this._api) {
			return this._api;
		}
		if (this._ready) {
			await this._ready;
			return this._api;
		}
		this._ready = (async () => {
			const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
			if (!ext) {
				Logger.warn('vscode.git extension not present', COMPONENT);
				return;
			}
			const exports = ext.isActive ? ext.exports : await ext.activate();
			this._api = exports.getAPI(1);
		})();
		await this._ready;
		return this._api;
	}

	public async fetchFile(commit: string, path: string): Promise<string | null> {
		const api = await this._ensureApi();
		if (!api) {
			return null;
		}
		if (api.repositories.length === 0) {
			Logger.warn('No git repositories open in this workspace', COMPONENT);
			return null;
		}

		const cached = this._commitPresence.get(commit);
		if (cached === null) {
			return null;
		}
		if (cached) {
			return this._tryShow(cached, commit, path);
		}

		// Try `git show <sha>:<path>` directly in each repo. This works whether
		// or not the SHA is reachable from a ref, as long as the object exists.
		const errors: string[] = [];
		for (const repo of api.repositories) {
			const content = await this._tryShow(repo, commit, path);
			if (content !== null) {
				this._commitPresence.set(commit, repo);
				Logger.info(`Resolved ${commit.slice(0, 8)} via ${repo.rootUri.fsPath}`, COMPONENT);
				return content;
			}
			errors.push(repo.rootUri.fsPath);
		}
		Logger.warn(
			`${commit.slice(0, 8)}:${path} not in any open repo (${errors.join(', ')}). ` +
				`Run 'git fetch origin' in your firefox checkout to pull this commit.`,
			COMPONENT,
		);
		this._commitPresence.set(commit, null);
		return null;
	}

	private async _tryShow(repo: Repository, commit: string, path: string): Promise<string | null> {
		try {
			const content = await repo.show(commit, path);
			return content;
		} catch {
			return null;
		}
	}
}
