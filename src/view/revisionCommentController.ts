import * as vscode from 'vscode';
import { Disposable } from '../common/lifecycle';
import { fromPhabUri } from '../common/uri';
import { flexibleBool } from '../common/flexibleBool';
import Logger from '../common/logger';
import { RevisionsManager } from '../phabricator/revisionsManager';
import { RevisionModel } from '../phabricator/revisionModel';
import { WorktreeAnchorResolver } from '../phabricator/worktreeAnchor';
import type { Transaction } from '../client';
import { changesetStatus } from './treeNodes/fileChangeNode';

interface InlineFields {
	// Phorge/Phabricator emit either form depending on version.
	diffPHID?: string;
	diff?: { phid?: string; id?: number };
	path?: string;
	// Phabricator sends booleans across Conduit as JSON booleans on some
	// instances and as "0"/"1" strings on others; treat as unknown.
	isNewFile?: unknown;
	line?: number;
	length?: number;
	replyToCommentPHID?: string | null;
}

function inlineDiffPHID(fields: InlineFields): string | undefined {
	return fields.diffPHID || fields.diff?.phid;
}

function isInlineByAnchor(t: Transaction): boolean {
	const fields = (t.fields as InlineFields) || {};
	return (
		!!fields.path &&
		!!inlineDiffPHID(fields) &&
		typeof fields.line === 'number'
	);
}

const COMPONENT = 'CommentController';

/**
 * Wires vscode.CommentController against the URIs that back a revision's files.
 *
 * Read path: pulls inline transactions from the active revision and
 * synthesizes a CommentThread per (path, line) group. Replies are folded
 * into their parent thread using replyToCommentPHID. Each thread is anchored
 * via WorktreeAnchorResolver, which yields a `git:` URI on the checked-out
 * worktree when one is available and a synthetic `phab://` URI otherwise.
 *
 * Write path: a `phabricator.submitInlineComment` command (registered by
 * the activation entry) reads the user's typed body from the thread,
 * posts an `inline` + `comment` transaction pair, then refreshes.
 */
export class RevisionCommentController extends Disposable {
	private readonly _controller: vscode.CommentController;
	private readonly _threadsByRevision = new Map<string, vscode.CommentThread[]>();
	private readonly _loaded = new Set<string>();
	private readonly _modelSubscriptions = new Map<string, vscode.Disposable>();
	private readonly _inFlight = new Map<string, Promise<void>>();
	private readonly _refreshChains = new Map<string, Promise<void>>();

	constructor(
		private readonly _manager: RevisionsManager,
		private readonly _resolver: WorktreeAnchorResolver,
	) {
		super();
		this._controller = this._register(
			vscode.comments.createCommentController('mozilla.phabricator', 'Mozilla Phabricator'),
		);

		this._controller.commentingRangeProvider = {
			provideCommentingRanges: (document) => this._provideCommentingRanges(document),
		};

		this._controller.options = {
			prompt: 'Add an inline comment…',
			placeHolder: 'Comment',
		};

		this._register(
			vscode.window.onDidChangeVisibleTextEditors((editors) => {
				for (const editor of editors) {
					if (this._resolver.revisionKeyForEditor(editor.document.uri) !== undefined) {
						this._ensureThreadsForUri(editor.document.uri).catch((err) =>
							Logger.warn(`comment refresh failed: ${err instanceof Error ? err.message : err}`, COMPONENT),
						);
					}
				}
			}),
		);

		this._register(
			this._manager.onDidChangeRevisions(() => {
				this._disposeAllThreads();
			}),
		);

		this._register(
			this._resolver.onDidChangeWorktrees(() => {
				// A worktree appeared / was removed / re-patched: drop threads
				// anchored to the old URIs and re-anchor against the new ones.
				this._disposeAllThreads();
				this._rescanVisibleEditors();
			}),
		);

		this._register({ dispose: () => this._disposeAllThreads() });

		this._rescanVisibleEditors();
	}

	/**
	 * Submit a typed comment from a CommentThread (either a newly-created one
	 * or a reply to an existing inline). Called from the
	 * `phabricator.submitInlineComment` command.
	 */
	public async submit(thread: vscode.CommentThread): Promise<void> {
		let revisionRef: number | string;
		let diffPHID: string;
		let filePath: string;
		let side: 'before' | 'after';

		const params = fromPhabUri(thread.uri);
		if (params) {
			revisionRef = params.revisionPHID;
			diffPHID = params.diffPHID;
			filePath = params.fileName;
			side = params.side;
		} else {
			const anchor = this._resolver.anchorFor(thread.uri);
			if (!anchor) {
				throw new Error('Comment thread is not anchored to a known revision file');
			}
			revisionRef = anchor.revisionPHID;
			diffPHID = anchor.diffPHID;
			filePath = anchor.path;
			side = anchor.side;
		}

		const draft = thread.comments[thread.comments.length - 1];
		if (!draft) {
			throw new Error('No comment text to submit');
		}
		const body = typeof draft.body === 'string' ? draft.body : draft.body.value;
		if (!body || body.trim().length === 0) {
			return;
		}

		const replyToPHID = findReplyTarget(thread);
		const model = await this._manager.getOrFetchRevision(revisionRef);
		if (!model) {
			throw new Error(`Revision ${revisionRef} not found`);
		}
		if (!this._manager.session) {
			throw new Error('Not signed in');
		}

		const range = thread.range || new vscode.Range(0, 0, 0, 0);
		const numLines = Math.max(1, range.end.line - range.start.line + 1);
		await model.postInlineComment({
			diffPHID,
			path: filePath,
			isNewFile: side === 'after',
			line: range.start.line + 1,
			length: numLines,
			content: body,
			replyToCommentPHID: replyToPHID,
		});

		thread.dispose();
		vscode.window.showInformationMessage(
			`Draft inline saved on ${model.monogram}. Submit a top-level review (Comment / Accept / Request Changes) to publish.`,
		);
	}

	private _provideCommentingRanges(document: vscode.TextDocument): vscode.Range[] | undefined {
		if (this._resolver.revisionKeyForEditor(document.uri) === undefined) {
			return undefined;
		}
		return [new vscode.Range(0, 0, document.lineCount, 0)];
	}

	private _rescanVisibleEditors(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			if (this._resolver.revisionKeyForEditor(editor.document.uri) !== undefined) {
				this._ensureThreadsForUri(editor.document.uri).catch((err) =>
					Logger.warn(`comment refresh failed: ${err instanceof Error ? err.message : err}`, COMPONENT),
				);
			}
		}
	}

	private async _ensureThreadsForUri(uri: vscode.Uri): Promise<void> {
		const key = this._resolver.revisionKeyForEditor(uri);
		if (key === undefined) {
			return;
		}
		const keyStr = String(key);
		if (this._loaded.has(keyStr)) {
			return;
		}
		const inFlight = this._inFlight.get(keyStr);
		if (inFlight) {
			return inFlight;
		}
		const work = (async () => {
			const model = await this._manager.getOrFetchRevision(key);
			if (!model) {
				return;
			}
			this._subscribeToModel(model);
			await this._refreshThreadsFor(model);
			// Mark every key that can reach this model so a later git:/phab://
			// editor for the same revision short-circuits.
			this._loaded.add(keyStr);
			this._loaded.add(model.phid);
			this._loaded.add(String(model.id));
		})().finally(() => {
			this._inFlight.delete(keyStr);
		});
		this._inFlight.set(keyStr, work);
		return work;
	}

	private _subscribeToModel(model: RevisionModel): void {
		if (this._modelSubscriptions.has(model.phid)) {
			return;
		}
		const sub = model.onDidChange(() => {
			this._refreshThreadsFor(model).catch((err) =>
				Logger.warn(`refresh after model change failed: ${err instanceof Error ? err.message : err}`, COMPONENT),
			);
		});
		this._modelSubscriptions.set(model.phid, sub);
	}

	private _refreshThreadsFor(model: RevisionModel): Promise<void> {
		// Serialize per model so a worktree-change rescan, a duplicate
		// _ensureThreadsForUri (its dedup guards are cleared on dispose), or a
		// model.onDidChange can't interleave with an in-flight refresh and orphan
		// untracked duplicate threads.
		const prev = this._refreshChains.get(model.phid) ?? Promise.resolve();
		const next = prev.catch(() => undefined).then(() => this._doRefreshThreadsFor(model));
		this._refreshChains.set(model.phid, next);
		void next.finally(() => {
			if (this._refreshChains.get(model.phid) === next) {
				this._refreshChains.delete(model.phid);
			}
		});
		return next;
	}

	private async _doRefreshThreadsFor(model: RevisionModel): Promise<void> {
		const transactions = await model.getTransactions();
		const inlines = transactions.filter(isInlineByAnchor);
		Logger.info(
			`${model.monogram}: ${inlines.length} inline transaction(s) of ${transactions.length} total`,
			COMPONENT,
		);
		if (inlines.length > 0) {
			Logger.debug(
				`Sample inline tx (type=${inlines[0].type}): ${JSON.stringify(inlines[0].fields)}`,
				COMPONENT,
			);
		}

		// Resolve every author PHID up front so displayName has data to return.
		const authorPHIDs = Array.from(new Set(inlines.map((t) => t.authorPHID).filter(Boolean)));
		if (authorPHIDs.length > 0) {
			await model.userResolver.resolveMany(authorPHIDs).catch((err) =>
				Logger.warn(`resolveMany failed: ${err instanceof Error ? err.message : err}`, COMPONENT),
			);
		}

		const changesets = await model.getChangesets().catch(() => []);
		const fileStatusByPath = new Map<string, 'added' | 'removed' | 'modified' | 'renamed' | 'copied'>();
		for (const cs of changesets) {
			const status = changesetStatus(cs.type);
			if (cs.currentPath) {
				fileStatusByPath.set(cs.currentPath, status);
			}
			if (cs.oldPath) {
				fileStatusByPath.set(cs.oldPath, status);
			}
		}

		const existing = this._threadsByRevision.get(model.phid);
		if (existing) {
			existing.forEach((t) => t.dispose());
		}
		const threads: vscode.CommentThread[] = [];

		const allTexts: string[] = [];
		for (const tx of inlines) {
			for (const c of (tx.comments || []).filter((c) => !c.removed)) {
				allTexts.push(c.content.raw);
			}
		}
		let renderedByText = new Map<string, string>();
		try {
			const rendered = await model.renderRemarkup(allTexts);
			for (let i = 0; i < allTexts.length; i++) {
				renderedByText.set(allTexts[i], rendered[i] || '');
			}
		} catch (err) {
			Logger.warn(
				`remarkup.process for inlines failed; falling back to raw text: ${err instanceof Error ? err.message : err}`,
				COMPONENT,
			);
			renderedByText = new Map();
		}

		for (const group of groupReplies(inlines)) {
			const head = group[0];
			const fields = (head.fields as InlineFields) || {};
			const diffPHID = inlineDiffPHID(fields);
			if (!fields.path || !diffPHID || fields.line === undefined) {
				Logger.debug(
					`skipping inline ${head.phid}: missing path/diffPHID/line (${JSON.stringify(fields)})`,
					COMPONENT,
				);
				continue;
			}
			const side: 'before' | 'after' = flexibleBool(fields.isNewFile, true) ? 'after' : 'before';
			const status = fileStatusByPath.get(fields.path) || 'modified';
			const uri = await this._resolver.fileUriFor({
				revisionId: model.id,
				revisionPHID: model.phid,
				diffPHID,
				path: fields.path,
				side,
				status,
			});
			const startLine = Math.max(0, fields.line - 1);
			const endLine = Math.max(startLine, startLine + (fields.length || 0));
			const range = new vscode.Range(startLine, 0, endLine, 0);

			const comments: vscode.Comment[] = [];
			for (const tx of group) {
				const author = model.userResolver.displayName(tx.authorPHID);
				for (const c of (tx.comments || []).filter((c) => !c.removed)) {
					const html = renderedByText.get(c.content.raw);
					const md = html ? new vscode.MarkdownString(html) : new vscode.MarkdownString(c.content.raw);
					if (html) {
						md.supportHtml = true;
					}
					md.isTrusted = false;
					comments.push({
						body: md,
						mode: vscode.CommentMode.Preview,
						author: { name: author },
						timestamp: new Date(c.dateCreated * 1000),
						contextValue: tx.phid,
					});
				}
			}
			if (comments.length === 0) {
				continue;
			}
			const thread = this._controller.createCommentThread(uri, range, comments);
			thread.label = `${model.monogram} ${fields.path}:${fields.line}`;
			thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
			thread.canReply = true;
			threads.push(thread);
			Logger.debug(`thread on ${uri.toString()} @ L${fields.line}`, COMPONENT);
		}

		Logger.info(`${model.monogram}: ${threads.length} comment thread(s) attached`, COMPONENT);
		this._threadsByRevision.set(model.phid, threads);
	}

	private _disposeAllThreads(): void {
		for (const threads of this._threadsByRevision.values()) {
			threads.forEach((t) => t.dispose());
		}
		this._threadsByRevision.clear();
		for (const sub of this._modelSubscriptions.values()) {
			sub.dispose();
		}
		this._modelSubscriptions.clear();
		this._loaded.clear();
		this._inFlight.clear();
	}
}

function findReplyTarget(thread: vscode.CommentThread): string | undefined {
	for (let i = thread.comments.length - 1; i >= 0; i--) {
		const c = thread.comments[i];
		if (c.contextValue && c.contextValue.startsWith('PHID-')) {
			return c.contextValue;
		}
	}
	return undefined;
}

function groupReplies(inlines: Transaction[]): Transaction[][] {
	const byPhid = new Map(inlines.map((t) => [t.phid, t]));
	const heads: Transaction[] = [];
	const replies = new Map<string, Transaction[]>();
	for (const tx of inlines) {
		const fields = tx.fields as InlineFields;
		const parent = fields?.replyToCommentPHID;
		if (parent) {
			let head: Transaction | undefined = byPhid.get(parent);
			while (head && (head.fields as InlineFields)?.replyToCommentPHID) {
				head = byPhid.get((head.fields as InlineFields).replyToCommentPHID || '');
			}
			const headPhid = head ? head.phid : parent;
			if (!replies.has(headPhid)) {
				replies.set(headPhid, []);
			}
			replies.get(headPhid)!.push(tx);
		} else {
			heads.push(tx);
		}
	}
	return heads.map((h) => [h, ...(replies.get(h.phid) || [])]);
}
