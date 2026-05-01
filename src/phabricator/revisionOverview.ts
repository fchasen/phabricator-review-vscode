import * as vscode from 'vscode';
import type { Changeset } from 'phabricator-client';
import { WebviewBase, REVISION_OVERVIEW_VIEW_TYPE, IRequestMessage } from '../common/webview';
import { RevisionsManager } from './revisionsManager';
import { RevisionModel } from './revisionModel';
import type { Transaction } from './interface';
import { changesetStatus } from '../view/treeNodes/fileChangeNode';
import Logger from '../common/logger';

interface OverviewPayload {
	id: number;
	monogram: string;
	phid: string;
	uri: string;
	title: string;
	statusName: string;
	statusValue: string;
	authorPHID: string;
	authorName: string;
	repositoryPHID: string | null;
	bug: string | null;
	isAuthor: boolean;
	isReviewer: boolean;
	summary: string;
	summaryHtml: string;
	testPlan: string;
	testPlanHtml: string;
	reviewers: Array<{
		phid: string;
		displayName: string;
		isProject: boolean;
		status: string;
		isBlocking: boolean;
	}>;
	subscribers: string[];
	projects: Array<{ phid: string; displayName: string }>;
	files: Array<{
		path: string;
		status: string;
	}>;
	timeline: Array<{
		id: string;
		type: string;
		authorPHID: string;
		authorName: string;
		dateCreated: number;
		fields: object;
		comments: Array<{ phid: string; content: string; contentHtml: string; dateCreated: number }>;
		inline?: InlineLink;
	}>;
}

interface InlineLink {
	diffPHID: string;
	path: string;
	line: number;
	length: number;
	isNewFile: boolean;
	status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied';
	isOutdated: boolean;
	isDone: boolean;
	commentPHID: string | null;
	snippet: SnippetLine[];
}

interface SnippetLine {
	type: 'context' | 'add' | 'remove';
	oldLine: number | null;
	newLine: number | null;
	text: string;
}

const SNIPPET_CONTEXT_LINES = 3;

/**
 * Tracks open revision panels keyed by revision PHID. Mirrors the reference's
 * PullRequestOverviewPanel — one panel per revision, reusable.
 */
export class RevisionOverviewPanel extends WebviewBase {
	private static readonly _byPhid = new Map<string, RevisionOverviewPanel>();

	public static async show(extensionUri: vscode.Uri, manager: RevisionsManager, idOrPHID: number | string): Promise<void> {
		const model = await manager.getOrFetchRevision(idOrPHID);
		if (!model) {
			vscode.window.showErrorMessage(`Could not load revision ${idOrPHID}`);
			return;
		}
		const existing = RevisionOverviewPanel._byPhid.get(model.phid);
		if (existing) {
			existing._panel.reveal();
			return;
		}
		const panel = new RevisionOverviewPanel(extensionUri, manager, model);
		RevisionOverviewPanel._byPhid.set(model.phid, panel);
	}

	private readonly _panel: vscode.WebviewPanel;

	private constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _manager: RevisionsManager,
		private readonly _model: RevisionModel,
	) {
		super();
		this._panel = vscode.window.createWebviewPanel(
			REVISION_OVERVIEW_VIEW_TYPE,
			`${_model.monogram}: ${_model.title}`,
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(_extensionUri, 'dist'), vscode.Uri.joinPath(_extensionUri, 'resources')],
			},
		);
		this._webview = this._panel.webview;
		this._panel.webview.html = this._html();
		this.initialize();
		this._register(this._panel.onDidDispose(() => {
			RevisionOverviewPanel._byPhid.delete(_model.phid);
			this.dispose();
		}));
		this._register(this._model.onDidChange(() => this._refresh()));
	}

	protected async _onDidReceiveMessage(message: IRequestMessage<any>): Promise<any> {
		const handled = await super._onDidReceiveMessage(message);
		if (handled !== this.MESSAGE_UNHANDLED) {
			if (message.command === 'ready') {
				this._refresh();
			}
			return handled;
		}
		switch (message.command) {
			case 'openInBrowser':
				vscode.env.openExternal(vscode.Uri.parse(this._model.uri));
				return this._replyMessage(message, true);
			case 'openLando':
				vscode.env.openExternal(vscode.Uri.parse(`https://lando.moz.tools/${this._model.id}/`));
				return this._replyMessage(message, true);
			case 'comment':
				try {
					await this._model.comment(String(message.args));
					return this._replyMessage(message, true);
				} catch (err) {
					return this._throwError(message, err instanceof Error ? err.message : String(err));
				}
			case 'accept':
				try {
					await this._model.accept(message.args ? String(message.args) : undefined);
					return this._replyMessage(message, true);
				} catch (err) {
					return this._throwError(message, err instanceof Error ? err.message : String(err));
				}
			case 'requestChanges':
				try {
					await this._model.requestChanges(String(message.args));
					return this._replyMessage(message, true);
				} catch (err) {
					return this._throwError(message, err instanceof Error ? err.message : String(err));
				}
			case 'markInlineDone': {
				const args = message.args as { commentPHID?: string; done?: boolean } | undefined;
				if (!args?.commentPHID) {
					return this._replyMessage(message, false);
				}
				try {
					await this._model.markInlineDone([args.commentPHID], args.done !== false);
					return this._replyMessage(message, true);
				} catch (err) {
					return this._throwError(message, err instanceof Error ? err.message : String(err));
				}
			}
			case 'revealInlineComment': {
				const inline = message.args as InlineLink | undefined;
				if (!inline) {
					return this._replyMessage(message, false);
				}
				await vscode.commands.executeCommand('phabricator.revealInlineComment', {
					revisionId: this._model.id,
					revisionPHID: this._model.phid,
					...inline,
				});
				return this._replyMessage(message, true);
			}
			case 'editProjects': {
				try {
					await vscode.commands.executeCommand('phabricator.editProjects', this._model.phid);
					return this._replyMessage(message, true);
				} catch (err) {
					return this._throwError(message, err instanceof Error ? err.message : String(err));
				}
			}
			case 'commandeer':
				return this._handleDestructiveAction(
					message,
					'Commandeer',
					`Take ownership of ${this._model.monogram} from its current author? You'll become the author and the existing author will be subscribed.`,
					(body) => this._model.commandeer(body),
				);
			case 'resign':
				return this._handleDestructiveAction(
					message,
					'Resign',
					`Resign as a reviewer on ${this._model.monogram}? Your name will be removed from the reviewer list.`,
					(body) => this._model.resign(body),
				);
			case 'abandon':
				return this._handleDestructiveAction(
					message,
					'Abandon',
					`Abandon ${this._model.monogram}? It will be marked Abandoned. You can reclaim it later from the Phabricator web UI.`,
					(body) => this._model.abandon(body),
				);
			case 'promptInput': {
				const args = (message.args || {}) as { prompt?: string; value?: string; placeHolder?: string };
				const result = await vscode.window.showInputBox({
					prompt: args.prompt,
					value: args.value,
					placeHolder: args.placeHolder,
					ignoreFocusOut: true,
				});
				return this._replyMessage(message, result === undefined ? null : result);
			}
			case 'searchUsers': {
				const session = this._manager.session;
				if (!session) return this._replyMessage(message, []);
				const args = (message.args || {}) as { query?: string; limit?: number };
				try {
					const users = await session.client.searchUsers({ query: args.query || '', limit: args.limit });
					return this._replyMessage(message, users);
				} catch (err) {
					return this._throwError(message, err instanceof Error ? err.message : String(err));
				}
			}
			case 'searchProjects': {
				const session = this._manager.session;
				if (!session) return this._replyMessage(message, []);
				const args = (message.args || {}) as { query?: string; limit?: number };
				try {
					const projects = await session.client.searchProjects({ query: args.query || '', limit: args.limit });
					return this._replyMessage(message, projects);
				} catch (err) {
					return this._throwError(message, err instanceof Error ? err.message : String(err));
				}
			}
			default:
				return this.MESSAGE_UNHANDLED;
		}
	}

	private async _handleDestructiveAction(
		message: IRequestMessage<any>,
		actionLabel: string,
		prompt: string,
		run: (body: string | undefined) => Promise<void>,
	): Promise<any> {
		const body = typeof message.args === 'string' ? message.args : undefined;
		const choice = await vscode.window.showWarningMessage(
			prompt,
			{ modal: true, detail: body ? `Comment: ${body}` : undefined },
			actionLabel,
		);
		if (choice !== actionLabel) {
			return this._replyMessage(message, false);
		}
		try {
			await run(body && body.trim().length > 0 ? body : undefined);
			return this._replyMessage(message, true);
		} catch (err) {
			return this._throwError(message, err instanceof Error ? err.message : String(err));
		}
	}

	private async _refresh(): Promise<void> {
		try {
			const payload = await this._buildPayload();
			this._postMessage({ command: 'overview', payload });
		} catch (err) {
			Logger.warn(`Failed to refresh revision overview: ${err instanceof Error ? err.message : err}`, 'Overview');
		}
	}

	private async _buildPayload(): Promise<OverviewPayload> {
		const revision = this._model.revision;
		const transactions = await this._model.getTransactions();
		const changesets = await this._model.getChangesets().catch(() => []);
		const statusByPath = new Map<string, ReturnType<typeof changesetStatus>>();
		const changesetByPath = new Map<string, Changeset>();
		for (const cs of changesets) {
			const status = changesetStatus(cs.type);
			if (cs.currentPath) {
				statusByPath.set(cs.currentPath, status);
				changesetByPath.set(cs.currentPath, cs);
			}
			if (cs.oldPath) {
				statusByPath.set(cs.oldPath, status);
				if (!changesetByPath.has(cs.oldPath)) changesetByPath.set(cs.oldPath, cs);
			}
		}
		const flatByChangeset = new Map<number, SnippetLine[]>();
		const activeDiffPHID = revision.fields.diffPHID;
		const resolver = this._manager.userResolver;

		const phidsToResolve = new Set<string>();
		phidsToResolve.add(revision.fields.authorPHID);
		const reviewerEntries = revision.attachments.reviewers?.reviewers || [];
		reviewerEntries.forEach((r) => phidsToResolve.add(r.reviewerPHID));
		const myPHID = this._manager.session?.userPHID;
		const isAuthor = !!myPHID && revision.fields.authorPHID === myPHID;
		const isReviewer = !!myPHID && reviewerEntries.some((r) => r.reviewerPHID === myPHID);
		(revision.attachments.subscribers?.subscriberPHIDs || []).forEach((p) => phidsToResolve.add(p));
		const projectPHIDs = revision.attachments.projects?.projectPHIDs || [];
		projectPHIDs.forEach((p) => phidsToResolve.add(p));
		transactions.forEach((t: Transaction) => phidsToResolve.add(t.authorPHID));
		if (resolver) {
			await resolver.resolveMany(Array.from(phidsToResolve));
		}

		const summary = revision.fields.summary || '';
		const testPlan = revision.fields.testPlan || '';
		type CommentSlot = { phid: string; content: string; dateCreated: number; htmlIdx: number };
		const commentSlots: CommentSlot[] = [];
		const renderInputs: string[] = [summary, testPlan];
		for (const t of transactions) {
			for (const c of t.comments || []) {
				if (c.removed) continue;
				commentSlots.push({
					phid: c.phid,
					content: c.content.raw,
					dateCreated: c.dateCreated,
					htmlIdx: renderInputs.length,
				});
				renderInputs.push(c.content.raw);
			}
		}
		let renderedHtml: string[];
		try {
			renderedHtml = await this._model.renderRemarkup(renderInputs);
		} catch (err) {
			Logger.warn(
				`remarkup.process failed; falling back to raw text: ${err instanceof Error ? err.message : err}`,
				'Overview',
			);
			renderedHtml = renderInputs.map(() => '');
		}
		const summaryHtml = renderedHtml[0] || '';
		const testPlanHtml = renderedHtml[1] || '';
		const commentHtmlByPHID = new Map<string, string>();
		for (const slot of commentSlots) {
			commentHtmlByPHID.set(slot.phid, renderedHtml[slot.htmlIdx] || '');
		}

		return {
			id: revision.id,
			monogram: this._model.monogram,
			phid: revision.phid,
			uri: revision.fields.uri,
			title: revision.fields.title,
			statusName: revision.fields.status.name,
			statusValue: revision.fields.status.value,
			authorPHID: revision.fields.authorPHID,
			authorName: resolver?.displayName(revision.fields.authorPHID) || revision.fields.authorPHID,
			repositoryPHID: revision.fields.repositoryPHID,
			bug: revision.fields.bugzilla?.['bug-id'] || null,
			isAuthor,
			isReviewer,
			summary,
			summaryHtml,
			testPlan,
			testPlanHtml,
			reviewers: reviewerEntries.map((r) => ({
				phid: r.reviewerPHID,
				displayName: resolver?.displayName(r.reviewerPHID) || r.reviewerPHID,
				isProject: resolver?.isProject(r.reviewerPHID) || false,
				status: r.status,
				isBlocking: r.isBlocking,
			})),
			subscribers: revision.attachments.subscribers?.subscriberPHIDs || [],
			projects: projectPHIDs.map((phid) => ({
				phid,
				displayName: resolver?.displayName(phid) || phid,
			})),
			files: changesets.map((cs) => ({
				path: cs.currentPath || cs.oldPath || '',
				status: changesetStatus(cs.type),
			})),
			timeline: transactions.map((t: Transaction) => ({
				id: t.id,
				type: t.type,
				authorPHID: t.authorPHID,
				authorName: resolver?.displayName(t.authorPHID) || t.authorPHID,
				dateCreated: t.dateCreated,
				fields: t.fields,
				comments: (t.comments || [])
					.filter((c) => !c.removed)
					.map((c) => ({
						phid: c.phid,
						content: c.content.raw,
						contentHtml: commentHtmlByPHID.get(c.phid) || '',
						dateCreated: c.dateCreated,
					})),
				inline: extractInlineLink(t, statusByPath, changesetByPath, flatByChangeset, activeDiffPHID),
			})),
		};
	}

	private _html(): string {
		const webview = this._panel.webview;
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'dist', 'webviews', 'revisionOverview.js'),
		);
		const nonce = makeNonce();
		const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:;`;
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<title>${this._model.monogram}</title>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function extractInlineLink(
	t: Transaction,
	statusByPath: Map<string, ReturnType<typeof changesetStatus>>,
	changesetByPath: Map<string, Changeset>,
	flatByChangeset: Map<number, SnippetLine[]>,
	activeDiffPHID: string | null | undefined,
): InlineLink | undefined {
	const fields = t.fields as Record<string, unknown> & {
		diff?: { phid?: string };
		diffPHID?: string;
		path?: string;
		isNewFile?: unknown;
		line?: number;
		length?: number;
	};
	const diffPHID = fields.diffPHID || fields.diff?.phid;
	// Detect by the presence of inline anchor fields, since Phorge variants
	// emit different type strings ("inline", "differential.inline", etc.).
	if (!fields.path || !diffPHID || fields.line === undefined) {
		return undefined;
	}
	const isNewFile = flexibleBool(fields.isNewFile, true);
	const line = fields.line;
	const length = fields.length || 0;
	const isOutdated = !!activeDiffPHID && diffPHID !== activeDiffPHID;
	const snippet = isOutdated ? [] : buildInlineSnippet(
		changesetByPath.get(fields.path),
		flatByChangeset,
		{ line, length, isNewFile },
	);
	const isDone = flexibleBool((fields as { isDone?: unknown }).isDone, false);
	const headComment = (t.comments || []).find((c) => !c.removed);
	return {
		diffPHID,
		path: fields.path,
		line,
		length,
		isNewFile,
		status: statusByPath.get(fields.path) || 'modified',
		isOutdated,
		isDone,
		commentPHID: headComment ? headComment.phid : null,
		snippet,
	};
}

function buildInlineSnippet(
	changeset: Changeset | undefined,
	flatByChangeset: Map<number, SnippetLine[]>,
	anchor: { line: number; length: number; isNewFile: boolean },
): SnippetLine[] {
	if (!changeset || changeset.hunks.length === 0) return [];
	let flat = flatByChangeset.get(changeset.id);
	if (!flat) {
		flat = flattenChangesetCorpus(changeset);
		flatByChangeset.set(changeset.id, flat);
	}
	if (flat.length === 0) return [];
	const lineNumOf = (entry: SnippetLine) => (anchor.isNewFile ? entry.newLine : entry.oldLine);
	const skipType = anchor.isNewFile ? 'remove' : 'add';
	let anchorIdx = -1;
	for (let i = 0; i < flat.length; i++) {
		const entry = flat[i];
		if (entry.type === skipType) continue;
		if (lineNumOf(entry) === anchor.line) {
			anchorIdx = i;
			break;
		}
	}
	if (anchorIdx === -1) return [];
	let endIdx = anchorIdx;
	const spanEnd = anchor.line + Math.max(0, anchor.length);
	for (let i = anchorIdx + 1; i < flat.length; i++) {
		const entry = flat[i];
		const num = lineNumOf(entry);
		if (num !== null && num > spanEnd) break;
		endIdx = i;
	}
	const start = Math.max(0, anchorIdx - SNIPPET_CONTEXT_LINES);
	const end = Math.min(flat.length, endIdx + SNIPPET_CONTEXT_LINES + 1);
	return flat.slice(start, end);
}

function flattenChangesetCorpus(changeset: Changeset): SnippetLine[] {
	const out: SnippetLine[] = [];
	for (const hunk of changeset.hunks) {
		let oldLine = hunk.oldOffset;
		let newLine = hunk.newOffset;
		const lines = hunk.corpus.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const raw = lines[i];
			if (raw.length === 0 && i === lines.length - 1) break;
			const prefix = raw[0];
			if (prefix === '\\' || prefix === undefined) continue;
			const text = raw.slice(1);
			if (prefix === '+') {
				out.push({ type: 'add', oldLine: null, newLine, text });
				newLine++;
			} else if (prefix === '-') {
				out.push({ type: 'remove', oldLine, newLine: null, text });
				oldLine++;
			} else {
				out.push({ type: 'context', oldLine, newLine, text });
				oldLine++;
				newLine++;
			}
		}
	}
	return out;
}

function flexibleBool(value: unknown, fallback: boolean): boolean {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return value !== 0;
	if (typeof value === 'string') {
		const lowered = value.toLowerCase();
		if (lowered === '1' || lowered === 'true') return true;
		if (lowered === '0' || lowered === 'false') return false;
	}
	return fallback;
}

function makeNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
