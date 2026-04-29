import * as vscode from 'vscode';
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
	summary: string;
	testPlan: string;
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
		status: string;
	}>;
	timeline: Array<{
		id: string;
		type: string;
		authorPHID: string;
		authorName: string;
		dateCreated: number;
		fields: object;
		comments: Array<{ phid: string; content: string; dateCreated: number }>;
	}>;
}

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
			default:
				return this.MESSAGE_UNHANDLED;
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
		const resolver = this._manager.userResolver;

		const phidsToResolve = new Set<string>();
		phidsToResolve.add(revision.fields.authorPHID);
		const reviewerEntries = revision.attachments.reviewers?.reviewers || [];
		reviewerEntries.forEach((r) => phidsToResolve.add(r.reviewerPHID));
		(revision.attachments.subscribers?.subscriberPHIDs || []).forEach((p) => phidsToResolve.add(p));
		transactions.forEach((t: Transaction) => phidsToResolve.add(t.authorPHID));
		if (resolver) {
			await resolver.resolveMany(Array.from(phidsToResolve));
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
			summary: revision.fields.summary || '',
			testPlan: revision.fields.testPlan || '',
			reviewers: reviewerEntries.map((r) => ({
				phid: r.reviewerPHID,
				displayName: resolver?.displayName(r.reviewerPHID) || r.reviewerPHID,
				isProject: resolver?.isProject(r.reviewerPHID) || false,
				status: r.status,
				isBlocking: r.isBlocking,
			})),
			subscribers: revision.attachments.subscribers?.subscriberPHIDs || [],
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
					.map((c) => ({ phid: c.phid, content: c.content.raw, dateCreated: c.dateCreated })),
			})),
		};
	}

	private _html(): string {
		const webview = this._panel.webview;
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'dist', 'webviews', 'revisionOverview.js'),
		);
		const nonce = makeNonce();
		const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource};`;
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

function makeNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
