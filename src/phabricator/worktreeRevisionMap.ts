import * as vscode from 'vscode';
import { GitExtension, GitAPI, Repository } from '../api/git';
import { Disposable, toDisposable } from '../common/lifecycle';
import Logger from '../common/logger';
import { extractRevisionId, isBugSubject } from './unsubmittedCommitParse';

const COMPONENT = 'WorktreeMap';

export interface WorktreeMapping {
	repo: Repository;
	rootUri: vscode.Uri;
	headSha: string;
	headSubject: string;
	headBody: string;
	headDate: Date | undefined;
	branch: string | undefined;
	revisionId: number | undefined;
}

interface CacheEntry {
	headSha: string;
	mapping: WorktreeMapping | null;
}

/**
 * Watches the vscode.git API and maintains a map between open repos and the
 * Phabricator revision (if any) referenced by their HEAD commit.
 */
export class WorktreeRevisionMap extends Disposable {
	private readonly _onDidChange = this._register(new vscode.EventEmitter<void>());
	public readonly onDidChange = this._onDidChange.event;

	private _api: GitAPI | undefined;
	private _ready: Promise<void> | undefined;
	private _mappings = new Map<string, WorktreeMapping>();
	private readonly _cache = new Map<string, CacheEntry>();
	private readonly _repoListeners = new Map<string, vscode.Disposable>();

	constructor() {
		super();
		void this._ensureApi();
	}

	public getMapped(): WorktreeMapping[] {
		return Array.from(this._mappings.values()).filter((m) => m.revisionId !== undefined);
	}

	public getUnsubmitted(): WorktreeMapping[] {
		return Array.from(this._mappings.values()).filter(
			(m) => m.revisionId === undefined && isBugSubject(m.headSubject),
		);
	}

	public getMappingForRoot(rootUri: vscode.Uri): WorktreeMapping | undefined {
		return this._mappings.get(rootUri.toString());
	}

	public getMappingForRevision(revisionId: number): WorktreeMapping | undefined {
		for (const m of this._mappings.values()) {
			if (m.revisionId === revisionId) return m;
		}
		return undefined;
	}

	private async _ensureApi(): Promise<GitAPI | undefined> {
		if (this._api) return this._api;
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
			const api: GitAPI = exports.getAPI(1);
			this._api = api;
			this._register(api.onDidOpenRepository((repo: Repository) => this._watchRepo(repo)));
			this._register(
				api.onDidCloseRepository((repo: Repository) => {
					this._unwatchRepo(repo);
					this._cache.delete(repo.rootUri.toString());
					if (this._mappings.delete(repo.rootUri.toString())) {
						this._onDidChange.fire();
					}
				}),
			);
			for (const repo of api.repositories) {
				this._watchRepo(repo);
			}
		})();
		await this._ready;
		return this._api;
	}

	private _watchRepo(repo: Repository): void {
		const key = repo.rootUri.toString();
		if (this._repoListeners.has(key)) return;
		const listener = repo.state.onDidChange(() => {
			void this._refreshRepo(repo);
		});
		this._repoListeners.set(key, listener);
		this._register(toDisposable(() => listener.dispose()));
		void this._refreshRepo(repo);
	}

	private _unwatchRepo(repo: Repository): void {
		const key = repo.rootUri.toString();
		const listener = this._repoListeners.get(key);
		if (listener) {
			listener.dispose();
			this._repoListeners.delete(key);
		}
	}

	private async _refreshRepo(repo: Repository): Promise<void> {
		const key = repo.rootUri.toString();
		const head = repo.state.HEAD;
		const sha = head?.commit;
		if (!sha) {
			if (this._mappings.delete(key)) {
				this._cache.delete(key);
				this._onDidChange.fire();
			}
			return;
		}
		const cached = this._cache.get(key);
		if (cached && cached.headSha === sha) {
			const existing = this._mappings.get(key);
			if (existing) {
				const branch = head.name;
				if (existing.branch !== branch) {
					this._mappings.set(key, { ...existing, branch });
					this._onDidChange.fire();
				}
			}
			return;
		}
		let commit;
		try {
			commit = await repo.getCommit(sha);
		} catch (err) {
			Logger.warn(`getCommit failed for ${sha.slice(0, 8)}: ${err instanceof Error ? err.message : err}`, COMPONENT);
			return;
		}
		const [subject, ...rest] = (commit.message || '').split('\n');
		const headSubject = (subject || '').trim();
		const headBody = rest.join('\n').trim();
		const revisionId = extractRevisionId(commit.message || '');
		const branch = head.name;
		const mapping: WorktreeMapping = {
			repo,
			rootUri: repo.rootUri,
			headSha: sha,
			headSubject,
			headBody,
			headDate: commit.commitDate || commit.authorDate,
			branch,
			revisionId,
		};
		this._cache.set(key, { headSha: sha, mapping });
		this._mappings.set(key, mapping);
		this._onDidChange.fire();
	}
}

