import * as vscode from 'vscode';
import { PhabricatorClient } from 'phabricator-client';
import type { Revision, Diff, Transaction } from './interface';
import { parseUnifiedDiff, ParsedFile } from '../common/diffHunk';
import { UserResolver } from './userResolver';

export class RevisionModel {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	public readonly onDidChange = this._onDidChange.event;

	private _activeDiff: Diff | undefined;
	private _activeDiffPHID: string | undefined;
	private _rawDiffCache = new Map<string, string>();
	private _filesCache = new Map<string, ParsedFile[]>();
	private _transactions: Transaction[] | undefined;

	constructor(
		private _revision: Revision,
		private readonly _client: PhabricatorClient,
		public readonly userResolver: UserResolver,
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
		const raw = await this._client.getRawDiff(phid);
		this._rawDiffCache.set(phid, raw);
		return raw;
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

	public dispose(): void {
		this._onDidChange.dispose();
	}
}
