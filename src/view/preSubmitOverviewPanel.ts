import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { WorktreeMapping, WorktreeRevisionMap } from '../phabricator/worktreeRevisionMap';
import { Change, Repository } from '../api/git';
import { WebviewBase, REVISION_OVERVIEW_VIEW_TYPE, IRequestMessage } from '../common/webview';
import { RevisionsManager } from '../phabricator/revisionsManager';
import Logger from '../common/logger';

const COMPONENT = 'PreSubmit';

// vscode.git Status enum values, mirrored as literal numbers (the const enum
// gets inlined at build time and is not available across module boundaries).
const INDEX_MODIFIED = 0;
const INDEX_ADDED = 1;
const INDEX_DELETED = 2;
const INDEX_RENAMED = 3;
const INDEX_COPIED = 4;
const MODIFIED = 5;
const DELETED = 6;
const UNTRACKED = 7;

const STATUS_STRING: Record<number, 'added' | 'removed' | 'modified' | 'renamed' | 'copied'> = {
	[INDEX_ADDED]: 'added',
	[INDEX_MODIFIED]: 'modified',
	[INDEX_DELETED]: 'removed',
	[INDEX_RENAMED]: 'renamed',
	[INDEX_COPIED]: 'copied',
	[MODIFIED]: 'modified',
	[DELETED]: 'removed',
	[UNTRACKED]: 'added',
};

interface OverviewPayload {
	mode: 'unsubmitted';
	id: number;
	monogram: string;
	uri: string;
	title: string;
	statusName: string;
	statusValue: string;
	authorName: string;
	activeDiffPHID: string | null;
	bug: string | null;
	isAuthor: boolean;
	isReviewer: boolean;
	stack: null;
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
	files: Array<{
		path: string;
		oldPath: string | null;
		status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied';
		unifiedDiff: string;
		oldContents: string;
		newContents: string;
		isBinary: boolean;
		addLines: number;
		delLines: number;
		inlineComments: never[];
	}>;
	projects: never[];
	testingTagSlug: null;
	timeline: never[];
	phidNames: Record<string, string>;
}

const REVIEWER_TOKEN_RE = /\br=([A-Za-z0-9_.,!#-]+)/g;

/**
 * Pre-submit overview panel. Mirrors RevisionOverviewPanel's UX (same webview
 * bundle, same payload shape) but sources data from a local HEAD commit and
 * presents Submit-with-moz-phab in place of the Phab review actions.
 */
export class PreSubmitOverviewPanel extends WebviewBase {
	private static readonly _byRoot = new Map<string, PreSubmitOverviewPanel>();

	public static show(
		extensionUri: vscode.Uri,
		manager: RevisionsManager,
		map: WorktreeRevisionMap,
		args: { repoRoot: string; headSha: string },
	): void {
		const mapping = map.getMappingForRoot(vscode.Uri.parse(args.repoRoot));
		if (!mapping) {
			vscode.window.showErrorMessage('Could not locate the repository for this commit.');
			return;
		}
		const key = mapping.rootUri.toString();
		const existing = PreSubmitOverviewPanel._byRoot.get(key);
		if (existing) {
			existing._panel.reveal();
			existing._setMapping(mapping);
			return;
		}
		const panel = new PreSubmitOverviewPanel(extensionUri, manager, map, mapping);
		PreSubmitOverviewPanel._byRoot.set(key, panel);
	}

	private readonly _panel: vscode.WebviewPanel;
	private _mapping: WorktreeMapping;
	private _refreshSeq = 0;

	private constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _manager: RevisionsManager,
		private readonly _map: WorktreeRevisionMap,
		mapping: WorktreeMapping,
	) {
		super();
		this._mapping = mapping;
		const title = mapping.headSubject || `Unsubmitted ${mapping.headSha.slice(0, 7)}`;
		this._panel = vscode.window.createWebviewPanel(
			REVISION_OVERVIEW_VIEW_TYPE,
			title,
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(_extensionUri, 'dist'),
					vscode.Uri.joinPath(_extensionUri, 'resources'),
				],
			},
		);
		this._webview = this._panel.webview;
		this._panel.webview.html = this._html();
		this.initialize();
		this._register(this._panel.onDidDispose(() => {
			PreSubmitOverviewPanel._byRoot.delete(mapping.rootUri.toString());
			this.dispose();
		}));
		this._register(this._map.onDidChange(() => {
			const fresh = this._map.getMappingForRoot(this._mapping.rootUri);
			if (fresh && (fresh.headSha !== this._mapping.headSha || fresh.headSubject !== this._mapping.headSubject)) {
				this._setMapping(fresh);
			}
		}));
	}

	private _setMapping(mapping: WorktreeMapping): void {
		this._mapping = mapping;
		this._panel.title = mapping.headSubject || `Unsubmitted ${mapping.headSha.slice(0, 7)}`;
		void this._refresh();
	}

	protected async _onDidReceiveMessage(message: IRequestMessage<any>): Promise<any> {
		const handled = await super._onDidReceiveMessage(message);
		if (handled !== this.MESSAGE_UNHANDLED) {
			if (message.command === 'ready') {
				void this._refresh();
			}
			return handled;
		}
		switch (message.command) {
			case 'submitUnsubmitted':
				try {
					await vscode.commands.executeCommand('phabricator.submitUnsubmittedCommit', {
						repoRoot: this._mapping.rootUri.toString(),
						headSha: this._mapping.headSha,
					});
					return this._replyMessage(message, true);
				} catch (err) {
					return this._throwError(message, err instanceof Error ? err.message : String(err));
				}
			case 'editRevision': {
				const args = (message.args || {}) as { title?: string; summary?: string };
				try {
					await this._amendCommit(args);
					return this._replyMessage(message, true);
				} catch (err) {
					return this._throwError(message, err instanceof Error ? err.message : String(err));
				}
			}
			case 'openFileDiff':
			case 'openFile': {
				const args = message.args as { path?: string } | undefined;
				if (!args?.path) {
					return this._replyMessage(message, false);
				}
				await vscode.commands.executeCommand(
					'vscode.open',
					vscode.Uri.joinPath(this._mapping.rootUri, args.path),
				);
				return this._replyMessage(message, true);
			}
			case 'openInBrowser':
			case 'openLando':
			case 'comment':
			case 'accept':
			case 'requestChanges':
			case 'commandeer':
			case 'resign':
			case 'abandon':
			case 'setTestingTag':
			case 'clearTestingTag':
			case 'editProjects':
			case 'submitInlineReply':
			case 'openInlineInBrowser':
			case 'revealInlineComment':
			case 'openStackRevision':
				// Not available pre-submit.
				return this._replyMessage(message, false);
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
			case 'searchProjects':
				return this._replyMessage(message, []);
			default:
				return this.MESSAGE_UNHANDLED;
		}
	}

	private async _amendCommit(args: { title?: string; summary?: string }): Promise<void> {
		const repo = this._mapping.repo;
		if (repo.state.indexChanges.length > 0 || repo.state.mergeChanges.length > 0) {
			throw new Error(
				'Cannot edit the commit message while there are staged or merging changes. Commit, stash, or unstage them first.',
			);
		}
		const current = await repo.getCommit('HEAD');
		const { subject, body } = splitCommitMessage(current.message || '');
		const { prose, trailers } = splitProseAndTrailers(body);
		const nextSubject = (args.title !== undefined ? args.title : subject).trim();
		if (!nextSubject) {
			throw new Error('Commit subject cannot be empty.');
		}
		const nextProse = (args.summary !== undefined ? args.summary : prose).trim();
		const parts: string[] = [nextSubject];
		if (nextProse) parts.push('', nextProse);
		if (trailers) parts.push('', trailers);
		await repo.commit(parts.join('\n') + '\n', { amend: true });
		void this._refresh();
	}

	private async _refresh(): Promise<void> {
		const seq = ++this._refreshSeq;
		try {
			const payload = await this._buildPayload();
			if (seq !== this._refreshSeq) return;
			void this._postMessage({ command: 'overview', payload });
		} catch (err) {
			Logger.warn(
				`Failed to refresh pre-submit overview: ${err instanceof Error ? err.message : err}`,
				COMPONENT,
			);
		}
	}

	private async _buildPayload(): Promise<OverviewPayload> {
		const mapping = this._mapping;
		const repo = mapping.repo;
		const headSha = mapping.headSha;
		const parentSha = `${headSha}^`;

		let changes: Change[] = [];
		try {
			changes = await repo.diffBetween(parentSha, headSha);
		} catch (err) {
			Logger.warn(`diffBetween failed: ${err instanceof Error ? err.message : err}`, COMPONENT);
		}

		const repoRoot = mapping.rootUri;
		const fileResults = await Promise.all(
			changes.map((change) => buildFileEntry(repo, repoRoot, parentSha, headSha, change)),
		);
		const files = fileResults.filter((f): f is NonNullable<typeof f> => !!f);

		const subjectInfo = parseSubject(mapping.headSubject);
		const summary = splitProseAndTrailers(mapping.headBody).prose;
		const author = mapping.repo.state.HEAD?.name || 'you';

		const reviewers = await this._resolveReviewers(subjectInfo.reviewers);

		const myPHID = this._manager.session?.userPHID;
		const monogramLabel = mapping.branch || mapping.headSha.slice(0, 7);

		const phidNames: Record<string, string> = {};
		for (const r of reviewers) {
			phidNames[r.phid] = r.displayName;
		}
		if (myPHID) {
			phidNames[myPHID] = author;
		}

		return {
			mode: 'unsubmitted',
			id: 0,
			monogram: monogramLabel,
			uri: '',
			title: mapping.headSubject || '(no subject)',
			statusName: 'Unsubmitted',
			statusValue: 'unsubmitted',
			authorName: author,
			activeDiffPHID: null,
			bug: subjectInfo.bug,
			isAuthor: true,
			isReviewer: false,
			stack: null,
			summary,
			summaryHtml: '',
			testPlan: '',
			testPlanHtml: '',
			reviewers,
			subscribers: [],
			files,
			projects: [],
			testingTagSlug: null,
			timeline: [],
			phidNames,
		};
	}

	private async _resolveReviewers(
		names: string[],
	): Promise<OverviewPayload['reviewers']> {
		if (names.length === 0) return [];
		const session = this._manager.session;
		const out: OverviewPayload['reviewers'] = [];
		for (const name of names) {
			const isProject = name.startsWith('#');
			const lookup = isProject ? name.slice(1) : name;
			let phid = `local:${name}`;
			let displayName = name;
			if (session) {
				try {
					const users = await session.client.searchUsers({ query: lookup, limit: 5 });
					const match = users.find(
						(u: { fields?: { username?: string } }) =>
							u.fields?.username?.toLowerCase() === lookup.toLowerCase(),
					);
					if (match) {
						phid = match.phid;
						displayName = match.fields?.username || lookup;
					}
				} catch (err) {
					Logger.warn(
						`Reviewer lookup for ${name} failed: ${err instanceof Error ? err.message : err}`,
						COMPONENT,
					);
				}
			}
			out.push({
				phid,
				displayName,
				isProject,
				status: 'added',
				isBlocking: false,
			});
		}
		return out;
	}

	private _html(): string {
		const webview = this._panel.webview;
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'dist', 'webviews', 'revisionOverview.js'),
		);
		const nonce = randomBytes(16).toString('base64');
		const csp = `default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:;`;
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<title>Unsubmitted commit</title>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function relativePath(root: vscode.Uri, file: vscode.Uri): string {
	const rootPath = root.path.endsWith('/') ? root.path : root.path + '/';
	if (file.path.startsWith(rootPath)) {
		return file.path.slice(rootPath.length);
	}
	return file.path;
}

async function safeShow(repo: Repository, ref: string, path: string): Promise<string> {
	try {
		return await repo.show(ref, path);
	} catch {
		return '';
	}
}

async function buildFileEntry(
	repo: Repository,
	repoRoot: vscode.Uri,
	parentSha: string,
	headSha: string,
	change: Change,
): Promise<OverviewPayload['files'][number] | null> {
	const status = STATUS_STRING[change.status] || 'modified';
	const newPath = relativePath(repoRoot, change.uri);
	const originalPath = change.originalUri ? relativePath(repoRoot, change.originalUri) : newPath;
	const oldPath = status === 'renamed' || status === 'copied' ? originalPath : newPath;

	let unifiedDiff = '';
	try {
		unifiedDiff = await repo.diffBetween(parentSha, headSha, newPath);
	} catch (err) {
		Logger.warn(
			`diffBetween(${newPath}) failed: ${err instanceof Error ? err.message : err}`,
			COMPONENT,
		);
	}

	const oldContents = status === 'added' ? '' : await safeShow(repo, parentSha, oldPath);
	const newContents = status === 'removed' ? '' : await safeShow(repo, headSha, newPath);

	const { addLines, delLines } = countDiffLines(unifiedDiff);
	const isBinary = unifiedDiff.includes('Binary files') || containsNullByte(oldContents) || containsNullByte(newContents);

	return {
		path: newPath,
		oldPath: oldPath === newPath ? null : oldPath,
		status,
		unifiedDiff,
		oldContents,
		newContents,
		isBinary,
		addLines,
		delLines,
		inlineComments: [],
	};
}

function countDiffLines(unifiedDiff: string): { addLines: number; delLines: number } {
	let addLines = 0;
	let delLines = 0;
	for (const line of unifiedDiff.split('\n')) {
		if (line.startsWith('+') && !line.startsWith('+++')) addLines++;
		else if (line.startsWith('-') && !line.startsWith('---')) delLines++;
	}
	return { addLines, delLines };
}

function containsNullByte(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		if (s.charCodeAt(i) === 0) return true;
	}
	return false;
}

function splitCommitMessage(message: string): { subject: string; body: string } {
	const newlineIdx = message.indexOf('\n');
	if (newlineIdx === -1) return { subject: message.trim(), body: '' };
	const subject = message.slice(0, newlineIdx).trim();
	const body = message.slice(newlineIdx + 1).replace(/^\n+/, '');
	return { subject, body };
}

function splitProseAndTrailers(body: string): { prose: string; trailers: string } {
	const lines = body.split('\n');
	let end = lines.length;
	while (end > 0 && lines[end - 1].trim() === '') end--;
	if (end === 0) return { prose: '', trailers: '' };
	let trailerStart = end;
	while (trailerStart > 0 && /^[A-Za-z][A-Za-z0-9-]*:\s*\S/.test(lines[trailerStart - 1])) {
		trailerStart--;
	}
	if (trailerStart === end) {
		return { prose: lines.slice(0, end).join('\n'), trailers: '' };
	}
	if (trailerStart > 0 && lines[trailerStart - 1].trim() !== '') {
		return { prose: lines.slice(0, end).join('\n'), trailers: '' };
	}
	let proseEnd = trailerStart;
	while (proseEnd > 0 && lines[proseEnd - 1].trim() === '') proseEnd--;
	return {
		prose: lines.slice(0, proseEnd).join('\n'),
		trailers: lines.slice(trailerStart, end).join('\n'),
	};
}

function parseSubject(subject: string): { bug: string | null; reviewers: string[] } {
	const bugMatch = /^Bug\s+(\d+)/i.exec(subject);
	const bug = bugMatch ? bugMatch[1] : null;
	const reviewers: string[] = [];
	const seen = new Set<string>();
	REVIEWER_TOKEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = REVIEWER_TOKEN_RE.exec(subject)) !== null) {
		const tokens = m[1].split(',');
		for (const raw of tokens) {
			const cleaned = raw.replace(/[!?]+$/, '').trim();
			if (cleaned && !seen.has(cleaned)) {
				seen.add(cleaned);
				reviewers.push(cleaned);
			}
		}
	}
	return { bug, reviewers };
}
