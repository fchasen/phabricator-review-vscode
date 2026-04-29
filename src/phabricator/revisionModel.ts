import * as vscode from 'vscode';
import { PhabricatorClient } from 'phabricator-client';
import type { Changeset } from 'phabricator-client';
import type { Revision, Diff, Transaction } from './interface';
import { synthesizeSideFromCorpus } from '../common/diffHunk';
import { UserResolver } from './userResolver';
import { LocalGitResolver } from './localGitResolver';

export class RevisionModel {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	public readonly onDidChange = this._onDidChange.event;

	private _activeDiff: Diff | undefined;
	private _activeDiffPHID: string | undefined;
	private _changesetsCache = new Map<number, Changeset[]>();
	private _transactions: Transaction[] | undefined;

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
		const previous = this._revision;
		const diffChanged = revision.fields.diffPHID !== this._activeDiffPHID;
		const dateModifiedChanged = revision.fields.dateModified !== previous.fields.dateModified;
		this._revision = revision;
		if (diffChanged) {
			this._activeDiff = undefined;
			this._activeDiffPHID = revision.fields.diffPHID;
			this._changesetsCache.clear();
		}
		if (!diffChanged && !dateModifiedChanged) {
			// Nothing observable moved — skip the redundant change event so the
			// comment controller doesn't re-create all its threads.
			return;
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

	/**
	 * Fetch and cache the active diff's changesets. Each changeset includes
	 * hunks with `corpus` text — on Mozilla's instance this is effectively
	 * the entire file with `+`/`-`/` ` prefixes.
	 */
	public async getChangesets(): Promise<Changeset[]> {
		const diff = await this.getActiveDiff();
		if (!diff) {
			return [];
		}
		const cached = this._changesetsCache.get(diff.id);
		if (cached) {
			return cached;
		}
		const result = await this._client.queryDiffs([diff.id]);
		const queried = result.get(diff.id);
		const changes = queried?.changes || [];
		this._changesetsCache.set(diff.id, changes);
		return changes;
	}

	/**
	 * Synthesize the file content for one side from the changeset's hunks.
	 *
	 * For added files, the 'before' side is empty; for removed files, the
	 * 'after' side is empty. For 'change' / move / copy, both sides come
	 * from the corpus (which contains the entire file thanks to Mozilla
	 * Phabricator's unlimited-context diffs).
	 */
	public synthesizeContent(changeset: Changeset, side: 'before' | 'after'): string {
		if (changeset.type === ChangesetType.Add && side === 'before') {
			return '';
		}
		if (changeset.type === ChangesetType.Delete && side === 'after') {
			return '';
		}
		if (isBinaryFileType(changeset.fileType) || isBinaryFileType(changeset.oldFileType)) {
			return '(binary file)\n';
		}
		const corpus = changeset.hunks.map((h) => h.corpus).join('');
		return synthesizeSideFromCorpus(corpus, side);
	}

	/**
	 * Convenience: find the changeset for a file path on a side. Returns
	 * undefined if the diff doesn't include that path.
	 */
	public async findChangeset(path: string, side: 'before' | 'after'): Promise<Changeset | undefined> {
		const changes = await this.getChangesets();
		return changes.find((c) => (side === 'before' ? c.oldPath : c.currentPath) === path);
	}

	public async getRawDiff(diffPHID?: string): Promise<string> {
		const phid = diffPHID || this._activeDiffPHID;
		if (!phid) {
			throw new Error(`Revision ${this.monogram} has no diff yet`);
		}
		const diffId = await this._resolveDiffId(phid);
		return this._client.getRawDiff(diffId);
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
	 * Try to fetch a base file from a local git checkout. Best-effort.
	 * Returns null if no repository has the commit.
	 */
	public async tryLocalGitBase(commit: string, path: string): Promise<string | null> {
		return this._localGit.fetchFile(commit, path);
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

	/**
	 * Create a draft inline comment. Phabricator stores it as a private draft
	 * for the authenticated user; it is published as part of the next
	 * top-level transaction (comment / accept / requestChanges).
	 *
	 * Returns the draft PHID so callers can render or delete it later.
	 */
	public async postInlineComment(args: {
		diffPHID: string;
		path: string;
		line: number;
		length?: number;
		isNewFile: boolean;
		content: string;
		replyToCommentPHID?: string;
	}): Promise<{ phid: string }> {
		const diff = await this.getActiveDiff();
		if (!diff || diff.phid !== args.diffPHID) {
			// fall back to looking up by phid
			const iter = this._client.searchDiffs({ phids: [args.diffPHID] });
			const result = await iter.next();
			if (result.done || !result.value) {
				throw new Error(`Diff ${args.diffPHID} not found`);
			}
		}
		const diffId = (diff && diff.phid === args.diffPHID ? diff.id : 0) || (await this._lookupDiffId(args.diffPHID));
		const created = await this._client.createInline({
			diffId,
			path: args.path,
			line: args.line,
			length: args.length,
			isNewFile: args.isNewFile,
			content: args.content,
			replyToCommentPHID: args.replyToCommentPHID,
		});
		// Drafts don't appear in transaction.search until published, so don't
		// invalidate the transactions cache here.
		return created;
	}

	private async _lookupDiffId(diffPHID: string): Promise<number> {
		const iter = this._client.searchDiffs({ phids: [diffPHID] });
		const result = await iter.next();
		if (result.done || !result.value) {
			throw new Error(`Diff ${diffPHID} not found`);
		}
		return result.value.id;
	}

	public dispose(): void {
		this._onDidChange.dispose();
	}
}

enum ChangesetType {
	Add = 1,
	Change = 2,
	Delete = 3,
	MoveAway = 4,
	CopyAway = 5,
	MoveHere = 6,
	CopyHere = 7,
	MultiCopy = 8,
}

function isBinaryFileType(fileType: number): boolean {
	// 2=image, 3=binary
	return fileType === 2 || fileType === 3;
}
