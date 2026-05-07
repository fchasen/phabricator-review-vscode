import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import type { Changeset, Transaction } from '../client';
import { WebviewBase, REVISION_OVERVIEW_VIEW_TYPE, IRequestMessage } from '../common/webview';
import { RevisionsManager } from './revisionsManager';
import { RevisionModel } from './revisionModel';
import { changesetStatus } from '../view/treeNodes/fileChangeNode';
import { flexibleBool } from '../common/flexibleBool';
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
	activeDiffPHID: string | null;
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
		oldPath: string | null;
		status: string;
		unifiedDiff: string;
		oldContents: string;
		newContents: string;
		isBinary: boolean;
		addLines: number;
		delLines: number;
		inlineComments: Array<{
			commentPHID: string;
			line: number;
			length: number;
			isNewFile: boolean;
			isOutdated: boolean;
			isDone: boolean;
			authorName: string;
			authorPHID: string;
			dateCreated: number;
			content: string;
			contentHtml: string;
		}>;
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
	phidNames: Record<string, string>;
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
		this._register(this._model.onDidChange(() => {
			this._panel.title = `${this._model.monogram}: ${this._model.title}`;
			this._refresh();
		}));
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
			case 'openLando': {
				const base = vscode.workspace.getConfiguration('phabricator').get<string>('landoBaseUrl', 'https://lando.moz.tools/');
				const trimmed = base.endsWith('/') ? base : `${base}/`;
				vscode.env.openExternal(vscode.Uri.parse(`${trimmed}${this._model.monogram}/`));
				return this._replyMessage(message, true);
			}
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
					await this._model.requestChanges(message.args ? String(message.args) : undefined);
					return this._replyMessage(message, true);
				} catch (err) {
					return this._throwError(message, err instanceof Error ? err.message : String(err));
				}
			case 'submitInlineReply': {
				const args = message.args as {
					replyToCommentPHID?: string;
					diffPHID?: string;
					path?: string;
					line?: number;
					length?: number;
					isNewFile?: boolean;
					content?: string;
				} | undefined;
				if (!args?.replyToCommentPHID || !args.diffPHID || !args.path || !args.content || args.line === undefined) {
					return this._throwError(message, 'Missing reply arguments.');
				}
				try {
					await this._model.postInlineComment({
						diffPHID: args.diffPHID,
						path: args.path,
						line: args.line,
						length: args.length || 0,
						isNewFile: args.isNewFile !== false,
						content: args.content,
						replyToCommentPHID: args.replyToCommentPHID,
					});
					// Publish drafts (including the one we just created) via an empty
					// comment transaction. Phab interprets this as "publish my drafts".
					await this._model.comment('');
					return this._replyMessage(message, true);
				} catch (err) {
					return this._throwError(message, err instanceof Error ? err.message : String(err));
				}
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
			case 'openFileDiff': {
				const args = message.args as { path?: string; status?: string } | undefined;
				if (!args?.path) {
					return this._replyMessage(message, false);
				}
				await vscode.commands.executeCommand('phabricator.revealInlineComment', {
					revisionId: this._model.id,
					revisionPHID: this._model.phid,
					diffPHID: this._model.revision.fields.diffPHID,
					path: args.path,
					line: 1,
					length: 0,
					isNewFile: true,
					status: (args.status as 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | undefined) || 'modified',
				});
				return this._replyMessage(message, true);
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
			case 'editRevision': {
				const args = (message.args || {}) as { title?: string; summary?: string };
				try {
					await this._model.editFields(args);
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
			case 'searchfoxPickPath': {
				const result = await runSearchfoxPathPicker();
				return this._replyMessage(message, result);
			}
			case 'searchfoxPickSymbol': {
				const result = await runSearchfoxSymbolPicker();
				return this._replyMessage(message, result);
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
		transactions.forEach((t: Transaction) => {
			phidsToResolve.add(t.authorPHID);
			collectPhids(t.fields, phidsToResolve);
		});
		if (resolver) {
			await resolver.resolveMany(Array.from(phidsToResolve));
		}
		const phidNames: Record<string, string> = {};
		for (const phid of phidsToResolve) {
			if (resolver) phidNames[phid] = resolver.displayName(phid);
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

		type FileInlineComment = OverviewPayload['files'][number]['inlineComments'][number];
		type InlineFields = {
			path?: string;
			diff?: { phid?: string };
			diffPHID?: string;
			line?: number;
			length?: number;
			isNewFile?: unknown;
			isDone?: unknown;
		};

		const inlineByPath = new Map<string, FileInlineComment[]>();
		for (const t of transactions) {
			const fields = t.fields as InlineFields;
			if (!fields?.path || fields.line === undefined) continue;
			const diffPHID = fields.diffPHID || fields.diff?.phid;
			if (!diffPHID) continue;
			const isOutdated = !!activeDiffPHID && diffPHID !== activeDiffPHID;
			const isNewFile = flexibleBool(fields.isNewFile, true);
			const isDone = flexibleBool(fields.isDone, false);
			const visibleComments = (t.comments || []).filter((c) => !c.removed);
			if (visibleComments.length === 0) continue;
			const list = inlineByPath.get(fields.path) || [];
			for (const c of visibleComments) {
				list.push({
					commentPHID: c.phid,
					line: fields.line,
					length: fields.length || 0,
					isNewFile,
					isOutdated,
					isDone,
					authorName: resolver?.displayName(t.authorPHID) || t.authorPHID,
					authorPHID: t.authorPHID,
					dateCreated: c.dateCreated,
					content: c.content.raw,
					contentHtml: commentHtmlByPHID.get(c.phid) || '',
				});
			}
			inlineByPath.set(fields.path, list);
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
			activeDiffPHID: activeDiffPHID || null,
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
			files: changesets.map((cs) => {
				const newPath = cs.currentPath || cs.oldPath || '';
				const oldPath = cs.oldPath || cs.currentPath || null;
				const isBinary = isBinaryChangeset(cs);
				const oldContents = isBinary ? '' : this._model.synthesizeContent(cs, 'before');
				const newContents = isBinary ? '' : this._model.synthesizeContent(cs, 'after');
				const inlineComments: FileInlineComment[] = [
					...(inlineByPath.get(newPath) || []),
					...(oldPath && oldPath !== newPath ? inlineByPath.get(oldPath) || [] : []),
				].sort((a, b) => a.dateCreated - b.dateCreated);
				return {
					path: newPath,
					oldPath,
					status: changesetStatus(cs.type),
					unifiedDiff: buildUnifiedDiff(cs),
					oldContents,
					newContents,
					isBinary,
					addLines: cs.addLines || 0,
					delLines: cs.delLines || 0,
					inlineComments,
				};
			}),
			timeline: [...transactions]
				.sort((a, b) => a.dateCreated - b.dateCreated)
				.map((t: Transaction) => ({
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
			phidNames,
		};
	}

	private _html(): string {
		const webview = this._panel.webview;
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'dist', 'webviews', 'revisionOverview.js'),
		);
		const nonce = makeNonce();
		const csp = `default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:;`;
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
	const skipType = anchor.isNewFile ? 'remove' : 'add';
	const lineNumOf = (entry: SnippetLine) => (anchor.isNewFile ? entry.newLine : entry.oldLine);
	// Restrict the snippet to lines on the side being commented on — including
	// wrong-side rows in the slice was leaking an extra line into the leading
	// window and adjacent to the commented span.
	const sameSide = flat.filter((e) => e.type !== skipType);
	const anchorIdx = sameSide.findIndex((e) => lineNumOf(e) === anchor.line);
	if (anchorIdx === -1) return [];
	let endIdx = anchorIdx;
	const spanEnd = anchor.line + Math.max(0, anchor.length);
	for (let i = anchorIdx + 1; i < sameSide.length; i++) {
		const num = lineNumOf(sameSide[i]);
		if (num !== null && num > spanEnd) break;
		endIdx = i;
	}
	const start = Math.max(0, anchorIdx - SNIPPET_CONTEXT_LINES);
	const end = Math.min(sameSide.length, endIdx + 1);
	return sameSide.slice(start, end);
}

// Phabricator changeset types from differential.querydiffs.
const CS_TYPE_ADD = 1;
const CS_TYPE_DELETE = 3;
const CS_TYPE_MOVE_HERE = 6;
const CS_TYPE_COPY_HERE = 7;

function isBinaryChangeset(cs: Changeset): boolean {
	// 2=image, 3=binary
	return cs.fileType === 2 || cs.fileType === 3 || cs.oldFileType === 2 || cs.oldFileType === 3;
}

function buildUnifiedDiff(cs: Changeset): string {
	if (cs.hunks.length === 0) return '';
	const isAdd = cs.type === CS_TYPE_ADD;
	const isDelete = cs.type === CS_TYPE_DELETE;
	const isRename = cs.type === CS_TYPE_MOVE_HERE;
	const isCopy = cs.type === CS_TYPE_COPY_HERE;
	const newPath = cs.currentPath || cs.oldPath || 'unknown';
	const oldPath = cs.oldPath || cs.currentPath || 'unknown';
	const lines: string[] = [];
	lines.push(`diff --git a/${oldPath} b/${newPath}`);
	if (isAdd) {
		lines.push('new file mode 100644');
	} else if (isDelete) {
		lines.push('deleted file mode 100644');
	} else if (isRename) {
		lines.push(`rename from ${oldPath}`);
		lines.push(`rename to ${newPath}`);
	} else if (isCopy) {
		lines.push(`copy from ${oldPath}`);
		lines.push(`copy to ${newPath}`);
	}
	lines.push(`--- ${isAdd ? '/dev/null' : `a/${oldPath}`}`);
	lines.push(`+++ ${isDelete ? '/dev/null' : `b/${newPath}`}`);
	for (const hunk of cs.hunks) {
		const oldLen = hunk.oldLength;
		const newLen = hunk.newLength;
		const oldStart = oldLen === 0 ? 0 : hunk.oldOffset;
		const newStart = newLen === 0 ? 0 : hunk.newOffset;
		lines.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`);
		const corpus = hunk.corpus.endsWith('\n') ? hunk.corpus.slice(0, -1) : hunk.corpus;
		lines.push(corpus);
	}
	return lines.join('\n') + '\n';
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

function makeNonce(): string {
	return randomBytes(16).toString('base64');
}

interface SearchfoxItem extends vscode.QuickPickItem {
	url: string;
	insertText: string;
}

const SEARCHFOX_DEBOUNCE_MS = 250;
const SEARCHFOX_LIMIT = 50;

function searchfoxBase(): string {
	const repo = vscode.workspace.getConfiguration('phabricator').get<string>('searchfoxRepo', 'firefox-main');
	return `https://searchfox.org/${repo}/source/`;
}

function basenameOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash >= 0 ? path.slice(slash + 1) : path;
}

function parsePathOutput(stdout: string, base: string): SearchfoxItem[] {
	const items: SearchfoxItem[] = [];
	for (const raw of stdout.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('Total matches:')) continue;
		const path = line;
		const file = basenameOf(path);
		items.push({
			label: file,
			description: path,
			url: `${base}${path}`,
			insertText: file,
			alwaysShow: true,
		});
	}
	return items;
}

function parseSymbolOutput(stdout: string, symbol: string, base: string): SearchfoxItem[] {
	const items: SearchfoxItem[] = [];
	for (const raw of stdout.split('\n')) {
		const line = raw.trimEnd();
		if (!line || line.startsWith('Total matches:')) continue;
		const m = line.match(/^([^:]+):(\d+):\s?(.*)$/);
		if (!m) continue;
		const [, path, lineNo, snippet] = m;
		items.push({
			label: `${basenameOf(path)}:${lineNo}`,
			description: path,
			detail: snippet,
			url: `${base}${path}#${lineNo}`,
			insertText: symbol,
			alwaysShow: true,
		});
	}
	return items;
}

interface SearchfoxRunResult {
	stdout: string;
	errorMessage?: string;
	errorCode?: string | number | null;
}

function runSearchfoxCli(args: string[]): Promise<SearchfoxRunResult> {
	return new Promise((resolve) => {
		execFile('searchfox-cli', args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
			resolve({
				stdout: stdout || '',
				errorMessage: err?.message,
				errorCode: err?.code,
			});
		});
	});
}

type Mode = 'path' | 'symbol';

function runSearchfoxLivePicker(mode: Mode): Promise<{ url: string; text: string } | null> {
	return new Promise((resolve) => {
		const base = searchfoxBase();
		const qp = vscode.window.createQuickPick<SearchfoxItem>();
		qp.placeholder = mode === 'path'
			? 'Find file in Searchfox'
			: 'Find symbol in Searchfox';
		qp.matchOnDescription = true;
		qp.matchOnDetail = true;

		let token = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const settle = (value: { url: string; text: string } | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};

		const search = (value: string) => {
			const cur = ++token;
			const term = value.trim();
			if (!term) {
				qp.items = [];
				qp.busy = false;
				return;
			}
			qp.busy = true;
			const args = mode === 'path'
				? ['-p', term, '-l', String(SEARCHFOX_LIMIT)]
				: ['-q', term, '-l', String(SEARCHFOX_LIMIT)];
			void runSearchfoxCli(args).then(({ stdout, errorMessage, errorCode }) => {
				if (cur !== token) return;
				qp.busy = false;
				if (errorMessage) {
					if (errorCode === 'ENOENT') {
						vscode.window.showErrorMessage('searchfox-cli not found on PATH. Install it with `cargo install searchfox-cli`.');
						qp.hide();
						return;
					}
					Logger.warn(`searchfox-cli failed: ${errorMessage}`, 'Searchfox');
					qp.items = [];
					return;
				}
				qp.items = mode === 'path' ? parsePathOutput(stdout, base) : parseSymbolOutput(stdout, term, base);
			});
		};

		qp.onDidChangeValue((v) => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => search(v), SEARCHFOX_DEBOUNCE_MS);
		});
		qp.onDidAccept(() => {
			const sel = qp.selectedItems[0];
			if (sel) settle({ url: sel.url, text: sel.insertText });
			qp.hide();
		});
		qp.onDidHide(() => {
			if (timer) clearTimeout(timer);
			settle(null);
			qp.dispose();
		});
		qp.show();
	});
}

function runSearchfoxPathPicker(): Promise<{ url: string; text: string } | null> {
	return runSearchfoxLivePicker('path');
}

function collectPhids(value: unknown, out: Set<string>): void {
	if (!value) return;
	if (typeof value === 'string') {
		if (value.startsWith('PHID-')) out.add(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const v of value) collectPhids(v, out);
		return;
	}
	if (typeof value === 'object') {
		for (const v of Object.values(value as Record<string, unknown>)) collectPhids(v, out);
	}
}

function runSearchfoxSymbolPicker(): Promise<{ url: string; text: string } | null> {
	return runSearchfoxLivePicker('symbol');
}
