import * as vscode from 'vscode';
import { Disposable } from '../common/lifecycle';
import { fromPhabUri, PhabUriParams, PHAB_SCHEME } from '../common/uri';
import Logger from '../common/logger';
import { RevisionsManager } from '../phabricator/revisionsManager';
import { RevisionModel } from '../phabricator/revisionModel';
import type { Transaction } from '../phabricator/interface';

interface InlineFields {
	diffPHID?: string;
	path?: string;
	isNewFile?: boolean;
	line?: number;
	length?: number;
	replyToCommentPHID?: string | null;
}

const COMPONENT = 'CommentController';

/**
 * Wires vscode.CommentController against phab:// URIs.
 *
 * Read path: pulls inline transactions from the active revision and
 * synthesizes a CommentThread per (path, line) group. Replies are folded
 * into their parent thread using replyToCommentPHID.
 *
 * Write path: a `phabricator.submitInlineComment` command (registered by
 * the activation entry) reads the user's typed body from the thread,
 * posts an `inline` + `comment` transaction pair, then refreshes.
 */
export class RevisionCommentController extends Disposable {
	private readonly _controller: vscode.CommentController;
	private readonly _threadsByRevision = new Map<string, vscode.CommentThread[]>();
	private readonly _refreshing = new Set<string>();

	constructor(private readonly _manager: RevisionsManager) {
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
					if (editor.document.uri.scheme === PHAB_SCHEME) {
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

		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document.uri.scheme === PHAB_SCHEME) {
				this._ensureThreadsForUri(editor.document.uri).catch((err) =>
					Logger.warn(err, COMPONENT),
				);
			}
		}
	}

	/**
	 * Submit a typed comment from a CommentThread (either a newly-created one
	 * or a reply to an existing inline). Called from the
	 * `phabricator.submitInlineComment` command.
	 */
	public async submit(thread: vscode.CommentThread): Promise<void> {
		const params = fromPhabUri(thread.uri);
		if (!params) {
			throw new Error('Comment thread is not on a phab:// URI');
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
		const model = await this._manager.getOrFetchRevision(params.revisionPHID);
		if (!model) {
			throw new Error(`Revision ${params.revisionId} not found`);
		}
		const session = this._manager.session;
		if (!session) {
			throw new Error('Not signed in');
		}

		const range = thread.range || new vscode.Range(0, 0, 0, 0);
		await session.client.inlineComment(model.phid, {
			diffPHID: params.diffPHID,
			path: params.fileName,
			isNewFile: params.side === 'after',
			line: range.start.line + 1,
			length: Math.max(0, range.end.line - range.start.line),
			content: body,
			replyToCommentPHID: replyToPHID,
		});

		thread.dispose();
		await this._refreshThreadsFor(model);
	}

	private _provideCommentingRanges(document: vscode.TextDocument): vscode.Range[] | undefined {
		if (document.uri.scheme !== PHAB_SCHEME) {
			return undefined;
		}
		return [new vscode.Range(0, 0, document.lineCount, 0)];
	}

	private async _ensureThreadsForUri(uri: vscode.Uri): Promise<void> {
		const params = fromPhabUri(uri);
		if (!params) {
			return;
		}
		if (this._refreshing.has(params.revisionPHID)) {
			return;
		}
		this._refreshing.add(params.revisionPHID);
		try {
			const model = await this._manager.getOrFetchRevision(params.revisionPHID);
			if (model) {
				await this._refreshThreadsFor(model);
			}
		} finally {
			this._refreshing.delete(params.revisionPHID);
		}
	}

	private async _refreshThreadsFor(model: RevisionModel): Promise<void> {
		const transactions = await model.getTransactions();
		const inlines = transactions.filter((t) => t.type === 'inline');

		const existing = this._threadsByRevision.get(model.phid);
		if (existing) {
			existing.forEach((t) => t.dispose());
		}
		const threads: vscode.CommentThread[] = [];

		for (const group of groupReplies(inlines)) {
			const head = group[0];
			const fields = (head.fields as InlineFields) || {};
			if (!fields.path || !fields.diffPHID || fields.line === undefined) {
				continue;
			}
			const side: 'before' | 'after' = fields.isNewFile ? 'after' : 'before';
			const uri = phabFileUri(model, fields.diffPHID, fields.path, side);
			const startLine = Math.max(0, fields.line - 1);
			const endLine = Math.max(startLine, startLine + (fields.length || 0));
			const range = new vscode.Range(startLine, 0, endLine, 0);

			const comments: vscode.Comment[] = [];
			for (const tx of group) {
				const author = model.userResolver.displayName(tx.authorPHID);
				for (const c of (tx.comments || []).filter((c) => !c.removed)) {
					comments.push({
						body: new vscode.MarkdownString(c.content.raw),
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
		}

		this._threadsByRevision.set(model.phid, threads);
	}

	private _disposeAllThreads(): void {
		for (const threads of this._threadsByRevision.values()) {
			threads.forEach((t) => t.dispose());
		}
		this._threadsByRevision.clear();
	}
}

function phabFileUri(model: RevisionModel, diffPHID: string, path: string, side: 'before' | 'after'): vscode.Uri {
	const params: PhabUriParams = {
		revisionId: model.id,
		revisionPHID: model.phid,
		diffPHID,
		fileName: path,
		side,
		status: 'modified',
	};
	const query = encodeURIComponent(JSON.stringify(params));
	return vscode.Uri.parse(`${PHAB_SCHEME}://D${model.id}/${side}/${path}?${query}`);
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
