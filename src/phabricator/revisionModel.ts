import * as vscode from 'vscode';
import { PhabricatorClient } from 'phabricator-client';
import type { Revision, Diff, Transaction } from './interface';
import { applyPatchToContent, paddedReconstruction, parseUnifiedDiff, ParsedFile } from '../common/diffHunk';
import { UserResolver } from './userResolver';
import { LocalGitResolver } from './localGitResolver';
import Logger from '../common/logger';

export class RevisionModel {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	public readonly onDidChange = this._onDidChange.event;

	private _activeDiff: Diff | undefined;
	private _activeDiffPHID: string | undefined;
	private _rawDiffCache = new Map<string, string>();
	private _filesCache = new Map<string, ParsedFile[]>();
	private _transactions: Transaction[] | undefined;
	private readonly _baseContentCache = new Map<string, string | null>();
	private static _diffusionDisabled = false;

	constructor(
		private _revision: Revision,
		private readonly _client: PhabricatorClient,
		public readonly userResolver: UserResolver,
		private readonly _localGit: LocalGitResolver,
	) {
		this._activeDiffPHID = _revision.fields.diffPHID;
	}

	public get revision(): Revision {
		return this._revision;
	}

	public get id(): number {
		return this._revision.id;
	}

	public get phid(): string {
		return this._revision.phid;
	}

	public get title(): string {
		return this._revision.fields.title;
	}

	public get statusName(): string {
		return this._revision.fields.status.name;
	}

	public get statusValue(): string {
		return this._revision.fields.status.value;
	}

	public get uri(): string {
		return this._revision.fields.uri;
	}

	public get monogram(): string {
		return `D${this._revision.id}`;
	}

	public update(revision: Revision): void {
		this._revision = revision;
		if (revision.fields.diffPHID !== this._activeDiffPHID) {
			this._activeDiff = undefined;
			this._activeDiffPHID = revision.fields.diffPHID;
			this._filesCache.clear();
			this._rawDiffCache.clear();
		}
		this._transactions = undefined;
		this._onDidChange.fire();
	}

	public async getActiveDiff(): Promise<Diff | undefined> {
		if (this._activeDiff) {
			return this._activeDiff;
		}
		if (!this._activeDiffPHID) {
			return undefined;
		}
		const iter = this._client.searchDiffs({ phids: [this._activeDiffPHID] }, { commits: true });
		const result = await iter.next();
		if (!result.done && result.value) {
			this._activeDiff = result.value;
			return this._activeDiff;
		}
		return undefined;
	}

	public async getRawDiff(diffPHID?: string): Promise<string> {
		const phid = diffPHID || this._activeDiffPHID;
		if (!phid) {
			throw new Error(`Revision ${this.monogram} has no diff yet`);
		}
		const cached = this._rawDiffCache.get(phid);
		if (cached !== undefined) {
			return cached;
		}
		const diffId = await this._resolveDiffId(phid);
		const raw = await this._client.getRawDiff(diffId);
		this._rawDiffCache.set(phid, raw);
		return raw;
	}

	private async _resolveDiffId(diffPHID: string): Promise<number> {
		if (this._activeDiff && this._activeDiff.phid === diffPHID) {
			return this._activeDiff.id;
		}
		const iter = this._client.searchDiffs({ phids: [diffPHID] });
		const result = await iter.next();
		if (result.done || !result.value) {
			throw new Error(`Diff ${diffPHID} not found`);
		}
		if (diffPHID === this._activeDiffPHID) {
			this._activeDiff = result.value;
		}
		return result.value.id;
	}

	/**
	 * Reconstruct the full text of a file at the chosen side, suitable for
	 * displaying in the diff editor with real line numbers.
	 *
	 * For 'before' side we fetch the base file from Diffusion and return it
	 * verbatim. For 'after' side we apply the diff hunks to that base.
	 *
	 * Falls back to the hunk-only reconstruction (with potentially mismatched
	 * line numbers) when the base content can't be fetched — better than
	 * showing nothing.
	 */
	public async getFileFullContent(file: ParsedFile, side: 'before' | 'after'): Promise<string> {
		if (side === 'before' && file.status === 'added') {
			return '';
		}
		if (side === 'after' && file.status === 'removed') {
			return '';
		}
		if (file.binary) {
			return '(binary file)\n';
		}

		const base = await this._fetchBaseContent(file);
		if (base === null) {
			Logger.info(
				`Falling back to padded hunk view for ${file.oldPath || file.newPath} (${side}); see warnings above. ` +
					`Comment line numbers will still match.`,
				'RevisionModel',
			);
			return paddedReconstruction(file.hunks, side);
		}
		if (side === 'before') {
			return base;
		}
		return applyPatchToContent(base, file.hunks);
	}

	private async _fetchBaseContent(file: ParsedFile): Promise<string | null> {
		const path = file.oldPath || file.newPath;
		if (!path) {
			Logger.warn(`Cannot fetch base content: file has no path`, 'RevisionModel');
			return null;
		}
		const diff = await this.getActiveDiff();
		if (!diff) {
			Logger.warn(`Cannot fetch base content for ${path}: no active diff resolved`, 'RevisionModel');
			return null;
		}
		const baseRef = extractBaseRef(diff);
		const repoPHID = diff.fields.repositoryPHID || this._revision.fields.repositoryPHID;
		if (!baseRef) {
			Logger.warn(
				`Cannot fetch base content for ${path}: no base ref on diff. refs=${JSON.stringify(diff.fields.refs)}`,
				'RevisionModel',
			);
			return null;
		}
		if (!repoPHID) {
			Logger.warn(`Cannot fetch base content for ${path}: no repositoryPHID`, 'RevisionModel');
			return null;
		}
		const cacheKey = `${repoPHID}\0${baseRef}\0${path}`;
		if (this._baseContentCache.has(cacheKey)) {
			return this._baseContentCache.get(cacheKey) ?? null;
		}

		const local = await this._localGit.fetchFile(baseRef, path);
		if (local !== null) {
			Logger.info(`Got ${local.length} bytes for ${path} from local git`, 'RevisionModel');
			this._baseContentCache.set(cacheKey, local);
			return local;
		}

		if (RevisionModel._diffusionDisabled) {
			this._baseContentCache.set(cacheKey, null);
			return null;
		}
		Logger.info(`Local git missed; trying Diffusion for ${path}@${baseRef.slice(0, 8)}`, 'RevisionModel');
		try {
			const content = await this._client.getFileContent({
				repository: repoPHID,
				commit: baseRef,
				path,
			});
			if (content === null) {
				Logger.warn(
					`Diffusion returned no content for ${path}@${baseRef.slice(0, 8)}. Disabling further attempts this session.`,
					'RevisionModel',
				);
				RevisionModel._diffusionDisabled = true;
			} else {
				Logger.info(`Got ${content.length} bytes for ${path} from Diffusion`, 'RevisionModel');
			}
			this._baseContentCache.set(cacheKey, content);
			return content;
		} catch (err) {
			Logger.warn(
				`getFileContent threw for ${path}@${baseRef.slice(0, 8)}: ${err instanceof Error ? err.message : err}. Disabling further attempts this session.`,
				'RevisionModel',
			);
			RevisionModel._diffusionDisabled = true;
			this._baseContentCache.set(cacheKey, null);
			return null;
		}
	}

	public async getFiles(diffPHID?: string): Promise<ParsedFile[]> {
		const phid = diffPHID || this._activeDiffPHID;
		if (!phid) {
			return [];
		}
		const cached = this._filesCache.get(phid);
		if (cached) {
			return cached;
		}
		const raw = await this.getRawDiff(phid);
		const files = parseUnifiedDiff(raw);
		this._filesCache.set(phid, files);
		return files;
	}

	public async getTransactions(): Promise<Transaction[]> {
		if (this._transactions) {
			return this._transactions;
		}
		const transactions: Transaction[] = [];
		for await (const tx of this._client.searchTransactions(this._revision.phid)) {
			transactions.push(tx);
		}
		this._transactions = transactions;
		return transactions;
	}

	public async accept(message?: string): Promise<void> {
		await this._client.accept(this._revision.phid, message);
		this._transactions = undefined;
		this._onDidChange.fire();
	}

	public async requestChanges(message: string): Promise<void> {
		await this._client.requestChanges(this._revision.phid, message);
		this._transactions = undefined;
		this._onDidChange.fire();
	}

	public async comment(message: string): Promise<void> {
		await this._client.comment(this._revision.phid, message);
		this._transactions = undefined;
		this._onDidChange.fire();
	}

	public async postInlineComment(args: {
		diffPHID: string;
		path: string;
		line: number;
		length?: number;
		isNewFile: boolean;
		content: string;
		replyToCommentPHID?: string;
		submitMessage?: string;
	}): Promise<void> {
		await this._client.inlineComment(this._revision.phid, args);
		this._transactions = undefined;
		this._onDidChange.fire();
	}

	public dispose(): void {
		this._onDidChange.dispose();
	}
}

function extractBaseRef(diff: Diff): string | undefined {
	const refs = diff.fields.refs || [];
	const preferredOrder = ['base', 'sourceControlBaseRevision', 'merge.base', 'parent', 'onto'];
	for (const wanted of preferredOrder) {
		const match = refs.find((r) => r.type === wanted);
		if (match) {
			return match.identifier;
		}
	}
	const commits = diff.attachments?.commits?.commits;
	if (commits && commits.length > 0) {
		const parents = commits[0].parents;
		if (parents && parents.length > 0) {
			return parents[0];
		}
	}
	return undefined;
}
