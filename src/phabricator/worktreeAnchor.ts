import * as path from 'path';
import * as vscode from 'vscode';
import { GitAPI } from '../api/git';
import { Disposable } from '../common/lifecycle';
import Logger from '../common/logger';
import { PhabUriParams, PHAB_SCHEME, fromPhabUri, toPhabUri } from '../common/uri';
import { applyRevisionToWorktree } from './checkoutRevisionWorktree';
import { RevisionsManager } from './revisionsManager';
import { WorktreeMapping, WorktreeRevisionMap } from './worktreeRevisionMap';

const COMPONENT = 'WorktreeAnchor';
const PINNED_DIFF_KEY = 'phabricator.worktreePinnedDiffs';
const GIT_SCHEME = 'git';
const FILE_SCHEME = 'file';

export interface AnchorRecord {
	revisionId: number;
	revisionPHID: string;
	diffPHID: string;
	path: string;
	side: 'before' | 'after';
	status: PhabUriParams['status'];
}

export interface FileUriRequest {
	revisionId: number;
	revisionPHID: string;
	diffPHID: string;
	path: string;
	side: 'before' | 'after';
	status: PhabUriParams['status'];
}

/**
 * Arguments for the `phabricator.openWorktreeOrPhabDiff` command. Carries only
 * plain data so tree nodes can precompute it synchronously; the command handler
 * resolves the before/after URIs (git: or phab://) asynchronously.
 */
export interface OpenWorktreeOrPhabDiffArgs {
	revisionId: number;
	revisionPHID: string;
	diffPHID: string;
	oldPath: string;
	currentPath: string;
	status: PhabUriParams['status'];
	title: string;
	selection?: { line: number; length?: number; isNewFile: boolean };
}

/**
 * Single decision point for whether a revision's review (diffs + inline
 * comments) anchors to a real checked-out worktree (`git:` URIs served by
 * `git show <ref>:<path>`) or falls back to the synthetic `phab://` documents.
 *
 * It also keeps the worktree in sync with the active Phabricator diff: when a
 * newer diff supersedes the one the worktree was patched at, `ensureFresh`
 * re-applies it through the same moz-phab path the checkout command uses.
 */
export class WorktreeAnchorResolver extends Disposable {
	private readonly _anchors = new Map<string, AnchorRecord>();
	private readonly _beforeRefCache = new Map<string, string>();
	private readonly _pinnedDiff = new Map<number, string>();
	private readonly _inFlight = new Map<number, Promise<boolean>>();
	private readonly _handledStale = new Map<number, string>();
	// After a re-patch, the worktree map only learns the new HEAD once the git
	// extension detects it (asynchronously). Until then we anchor to the HEAD we
	// read authoritatively right after patching, so the lazy diff-launch path
	// doesn't render the old commit's lines.
	private readonly _freshHead = new Map<number, { applied: string; previous: string }>();

	constructor(
		private readonly _api: GitAPI | undefined,
		private readonly _worktreeMap: WorktreeRevisionMap,
		private readonly _manager: RevisionsManager,
		private readonly _memento: vscode.Memento,
	) {
		super();
		const stored = this._memento.get<Record<string, string>>(PINNED_DIFF_KEY, {});
		for (const [id, diff] of Object.entries(stored)) {
			const n = Number(id);
			if (Number.isFinite(n) && typeof diff === 'string') {
				this._pinnedDiff.set(n, diff);
			}
		}
		// A worktree appearing / disappearing / re-patching changes HEAD, so the
		// derived before-refs are no longer valid. Consumers re-anchor on the
		// same event.
		this._register(
			this._worktreeMap.onDidChange(() => {
				this._beforeRefCache.clear();
				// Stop overriding HEAD once the worktree map has moved off the
				// pre-patch sha (caught up to our applied sha, or the user moved it).
				for (const [id, override] of this._freshHead) {
					const mapping = this.readyMappingFor(id);
					if (!mapping || mapping.headSha !== override.previous) {
						this._freshHead.delete(id);
					}
				}
			}),
		);
	}

	public get onDidChangeWorktrees(): vscode.Event<void> {
		return this._worktreeMap.onDidChange;
	}

	public isEnabled(): boolean {
		return (
			!!this._api &&
			vscode.workspace.getConfiguration('phabricator').get<boolean>('anchorReviewToWorktree', true)
		);
	}

	/**
	 * The worktree mapping to anchor `revisionId` to, or undefined when none is
	 * usable. Prefers the dedicated `phab/D<n>` branch; falls back to our own
	 * `patch-D<n>` worktree directory while the branch is briefly absent during
	 * a re-patch (detached HEAD). This deliberately ignores the main checkout
	 * even when its HEAD happens to be the revision's landed commit.
	 */
	public readyMappingFor(revisionId: number): WorktreeMapping | undefined {
		if (!this.isEnabled()) {
			return undefined;
		}
		const expectedBranch = `phab/D${revisionId}`;
		const expectedDir = `patch-D${revisionId}`;
		const candidates = this._worktreeMap.getMapped().filter((m) => m.revisionId === revisionId);
		return (
			candidates.find((m) => m.branch === expectedBranch) ??
			candidates.find((m) => path.basename(m.rootUri.fsPath) === expectedDir)
		);
	}

	public pinnedDiffFor(revisionId: number): string | undefined {
		return this._pinnedDiff.get(revisionId);
	}

	public worktreeRootFor(revisionId: number): vscode.Uri | undefined {
		return this.readyMappingFor(revisionId)?.rootUri;
	}

	public pin(revisionId: number, diffPHID: string): void {
		this._pinnedDiff.set(revisionId, diffPHID);
		this._handledStale.delete(revisionId);
		void this._persistPins();
	}

	/**
	 * True when the worktree was patched at a diff older than the revision's
	 * current active diff. Best-effort and synchronous: only reports stale when
	 * we have both a pinned diff and a cached model to compare against.
	 */
	public isStale(revisionId: number): boolean {
		const pinned = this._pinnedDiff.get(revisionId);
		if (!pinned) {
			return false;
		}
		const current = this._manager.getRevisionById(revisionId)?.revision.fields.diffPHID;
		if (!current) {
			return false;
		}
		return pinned !== current;
	}

	/**
	 * Adopt a ready worktree that has no pinned diff yet (re-opened via the
	 * overview panel, discovered from a prior session, or a manual `moz-phab
	 * patch`) by pinning it to the revision's current active diff. This starts
	 * staleness tracking from first sight so a later diff is detected, and lets
	 * anchoring proceed. Authoritative pins from checkout / re-patch are never
	 * overwritten. No-op until the model is cached.
	 */
	private _ensureAdopted(revisionId: number): void {
		if (this._pinnedDiff.has(revisionId)) {
			return;
		}
		const current = this._manager.getRevisionById(revisionId)?.revision.fields.diffPHID;
		if (current) {
			Logger.info(`D${revisionId}: adopting worktree at current diff ${current}`, COMPONENT);
			this.pin(revisionId, current);
		}
	}

	public anchorFor(uri: vscode.Uri): AnchorRecord | undefined {
		return this._anchors.get(uri.toString());
	}

	/**
	 * Identify which revision (if any) a visible editor belongs to. phab:// URIs
	 * carry the PHID; git: URIs are matched to our dedicated worktree by the file
	 * path encoded in their query. The return value is accepted directly by
	 * RevisionsManager.getOrFetchRevision; undefined means "not part of review".
	 */
	public revisionKeyForEditor(uri: vscode.Uri): number | string | undefined {
		if (uri.scheme === PHAB_SCHEME) {
			return fromPhabUri(uri)?.revisionPHID;
		}
		if (uri.scheme === FILE_SCHEME) {
			if (!this.isEnabled()) {
				return undefined;
			}
			return this._anchors.get(uri.toString())?.revisionId;
		}
		if (uri.scheme === GIT_SCHEME) {
			if (!this.isEnabled()) {
				return undefined;
			}
			const decoded = decodeGitUri(uri);
			if (!decoded) {
				return undefined;
			}
			const mapping = this._mappingForFsPath(decoded.fsPath);
			if (!mapping || mapping.revisionId === undefined) {
				return undefined;
			}
			const ready = this.readyMappingFor(mapping.revisionId);
			if (!ready || ready.rootUri.toString() !== mapping.rootUri.toString()) {
				return undefined;
			}
			return mapping.revisionId;
		}
		return undefined;
	}

	/**
	 * Resolve the URI that backs one side of one file. Returns a `git:` URI
	 * (recording the anchor so the write path can recover its metadata) when a
	 * ready, fresh worktree contains the blob; otherwise the synthetic phab://
	 * URI, byte-for-byte as before.
	 */
	public async fileUriFor(req: FileUriRequest): Promise<vscode.Uri> {
		const fallback = (reason: string) => {
			Logger.debug(`anchor D${req.revisionId} ${req.side} ${req.path}: phab:// (${reason})`, COMPONENT);
			return toPhabUri({
				revisionId: req.revisionId,
				revisionPHID: req.revisionPHID,
				diffPHID: req.diffPHID,
				fileName: req.path,
				side: req.side,
				status: req.status,
			});
		};
		if (!this._api) {
			return fallback('no git API');
		}
		if (!this.isEnabled()) {
			return fallback('anchoring disabled');
		}
		const mapping = this.readyMappingFor(req.revisionId);
		if (!mapping) {
			const ids = this._worktreeMap.getMapped().map((m) => `${m.revisionId}@${m.branch ?? 'detached'}:${path.basename(m.rootUri.fsPath)}`);
			return fallback(`no ready worktree (mapped: [${ids.join(', ')}])`);
		}
		// Track staleness from first sight; lets anchoring proceed for worktrees
		// re-opened or discovered without an authoritative pin.
		this._ensureAdopted(req.revisionId);
		// A worktree known to be behind the current diff no longer matches its
		// lines; serve phab:// until ensureFresh re-patches it (threads re-anchor).
		if (this.isStale(req.revisionId)) {
			const pinned = this._pinnedDiff.get(req.revisionId);
			const current = this._manager.getRevisionById(req.revisionId)?.revision.fields.diffPHID;
			return fallback(`stale (pinned=${pinned ?? 'none'}, current=${current ?? '?'})`);
		}
		// Sides that are definitionally empty can't live in the chosen tree
		// (an added file has no parent blob; a removed file has no head blob).
		if (
			(req.side === 'before' && req.status === 'added') ||
			(req.side === 'after' && req.status === 'removed') ||
			!req.path
		) {
			return fallback(`empty side (status=${req.status})`);
		}
		const fileUri = vscode.Uri.joinPath(mapping.rootUri, ...req.path.split('/'));
		if (req.side === 'after') {
			try {
				await vscode.workspace.fs.stat(fileUri);
				Logger.debug(`anchor D${req.revisionId} after ${req.path}: file: (worktree)`, COMPONENT);
				this._recordAnchor(fileUri, req);
				return fileUri;
			} catch {
				// not materialized (sparse-omitted); fall through to the git: blob
			}
		}
		const head = this._effectiveHead(req.revisionId, mapping);
		const ref =
			req.side === 'after' ? head : await this.beforeRef(req.revisionId, mapping, head);
		// Confirm the blob exists in that tree. Sparse worktrees omit files from
		// disk, but git show reads the object store, so this is a tree-presence
		// check, not a filesystem check.
		try {
			await mapping.repo.getObjectDetails(ref, req.path);
		} catch (err) {
			return fallback(`blob absent at ${ref.slice(0, 12)} (${msg(err)})`);
		}
		const gitUri = this._api.toGitUri(fileUri, ref);
		Logger.debug(`anchor D${req.revisionId} ${req.side} ${req.path}: git: @ ${ref.slice(0, 12)}`, COMPONENT);
		this._recordAnchor(gitUri, req);
		return gitUri;
	}

	private _recordAnchor(uri: vscode.Uri, req: FileUriRequest): void {
		this._anchors.set(uri.toString(), {
			revisionId: req.revisionId,
			revisionPHID: req.revisionPHID,
			diffPHID: req.diffPHID,
			path: req.path,
			side: req.side,
			status: req.status,
		});
	}

	/**
	 * The git ref for the "before" side of a revision. Default is the patched
	 * commit's first parent (correct for a single moz-phab-applied revision);
	 * `worktreeDiffBase: mergeBase` instead diffs against origin/main for stacks.
	 */
	public async beforeRef(revisionId: number, mapping: WorktreeMapping, headSha: string): Promise<string> {
		const cacheKey = `${revisionId}:${headSha}`;
		const cached = this._beforeRefCache.get(cacheKey);
		if (cached) {
			return cached;
		}
		const base = vscode.workspace
			.getConfiguration('phabricator')
			.get<'parent' | 'mergeBase'>('worktreeDiffBase', 'parent');
		let ref: string | undefined;
		if (base === 'mergeBase') {
			ref = await mapping.repo.getMergeBase(headSha, 'origin/main').catch(() => undefined);
		}
		if (!ref) {
			try {
				const commit = await mapping.repo.getCommit(headSha);
				ref = commit.parents[0];
			} catch (err) {
				Logger.warn(`getCommit(${headSha.slice(0, 8)}) failed: ${msg(err)}`, COMPONENT);
			}
		}
		if (!ref) {
			ref = await mapping.repo.getMergeBase(headSha, 'origin/main').catch(() => undefined);
		}
		if (!ref) {
			ref = `${headSha}~1`;
		}
		this._beforeRefCache.set(cacheKey, ref);
		return ref;
	}

	/**
	 * Bring the worktree up to the revision's current diff if it has fallen
	 * behind. Returns true once the worktree is (or already was) fresh, false if
	 * anchoring is off, there is no ready worktree, or the update was declined /
	 * failed. De-dupes concurrent updates per revision.
	 */
	public async ensureFresh(revisionId: number): Promise<boolean> {
		if (!this.isEnabled()) {
			return false;
		}
		const mapping = this.readyMappingFor(revisionId);
		if (!mapping) {
			return false;
		}
		this._ensureAdopted(revisionId);
		if (!this.isStale(revisionId)) {
			return true;
		}
		const existing = this._inFlight.get(revisionId);
		if (existing) {
			return existing;
		}
		const work = this._reapply(revisionId, mapping).finally(() => this._inFlight.delete(revisionId));
		this._inFlight.set(revisionId, work);
		return work;
	}

	private async _reapply(revisionId: number, mapping: WorktreeMapping): Promise<boolean> {
		const model = this._manager.getRevisionById(revisionId);
		const targetDiff = model?.revision.fields.diffPHID;
		if (!targetDiff) {
			return false;
		}
		// Don't re-prompt / re-warn for a target diff we already handled and the
		// user declined (or that's blocked by `off`); a newer diff re-arms it.
		if (this._handledStale.get(revisionId) === targetDiff) {
			return false;
		}
		const config = vscode.workspace.getConfiguration('phabricator');
		const mode = config.get<'prompt' | 'auto' | 'off'>('worktreeAutoUpdateOnNewDiff', 'prompt');
		const monogram = `D${revisionId}`;

		if (mode === 'off') {
			this._handledStale.set(revisionId, targetDiff);
			Logger.info(`${monogram}: newer diff available; auto-update off, staying on phab://`, COMPONENT);
			vscode.window.showWarningMessage(
				`${monogram}: a newer diff is available, but the checked-out worktree is out of date. Review is using the synthetic phab:// diff. Re-check-out the revision or set phabricator.worktreeAutoUpdateOnNewDiff to update it.`,
			);
			return false;
		}

		if (mode === 'prompt') {
			let detail =
				`The ${monogram} worktree will be force-detached and re-patched to the newer diff. ` +
				'Any uncommitted changes in the worktree will be discarded.';
			try {
				const changes = await mapping.repo.diffWithHEAD();
				if (changes.length > 0) {
					detail += `\n\n⚠ ${changes.length} uncommitted change(s) in the worktree will be lost.`;
				}
			} catch {
				// best-effort; proceed without the extra warning
			}
			const choice = await vscode.window.showWarningMessage(
				`A newer diff is available for ${monogram}.`,
				{ modal: true, detail },
				'Update',
			);
			if (choice !== 'Update') {
				this._handledStale.set(revisionId, targetDiff);
				return false;
			}
		}

		const mozPhabPath = config.get<string>('mozPhabPath', 'moz-phab');
		const previousHead = mapping.headSha;
		try {
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Updating ${monogram} worktree`,
					cancellable: false,
				},
				async (progress) => {
					await applyRevisionToWorktree({
						worktreePath: mapping.rootUri.fsPath,
						branchName: `phab/D${revisionId}`,
						revisionId,
						mozPhabPath,
						reuse: true,
						report: (message) => progress.report({ message }),
					});
				},
			);
		} catch (err) {
			this._handledStale.set(revisionId, targetDiff);
			Logger.error(`${monogram}: re-patch failed: ${msg(err)}`, COMPONENT);
			vscode.window.showErrorMessage(
				`Failed to update ${monogram} worktree: ${msg(err)}. Review is using phab:// until this is resolved.`,
			);
			return false;
		}

		// Record the authoritative new HEAD before the worktree map catches up,
		// so diffs opened immediately after this re-patch anchor to it.
		try {
			const headCommit = await mapping.repo.getCommit('HEAD');
			if (headCommit.hash && headCommit.hash !== previousHead) {
				this._freshHead.set(revisionId, { applied: headCommit.hash, previous: previousHead });
			}
		} catch (err) {
			Logger.warn(`${monogram}: could not read new HEAD after re-patch: ${msg(err)}`, COMPONENT);
		}

		// moz-phab applied the current latest diff; re-pin to it. Refresh the
		// model first so revision.fields.diffPHID reflects what was just applied.
		try {
			await model?.refresh();
		} catch {
			// best-effort
		}
		const applied = this._manager.getRevisionById(revisionId)?.revision.fields.diffPHID ?? targetDiff;
		this.pin(revisionId, applied);
		this._beforeRefCache.clear();
		Logger.info(`${monogram}: worktree re-patched and re-pinned to ${applied}`, COMPONENT);
		return true;
	}

	private _effectiveHead(revisionId: number, mapping: WorktreeMapping): string {
		return this._freshHead.get(revisionId)?.applied ?? mapping.headSha;
	}

	private _mappingForFsPath(fsPath: string): WorktreeMapping | undefined {
		let best: WorktreeMapping | undefined;
		for (const m of this._worktreeMap.getMapped()) {
			const root = m.rootUri.fsPath;
			const prefix = root.endsWith(path.sep) ? root : root + path.sep;
			if (fsPath === root || fsPath.startsWith(prefix)) {
				if (!best || root.length > best.rootUri.fsPath.length) {
					best = m;
				}
			}
		}
		return best;
	}

	private async _persistPins(): Promise<void> {
		const obj: Record<string, string> = {};
		for (const [id, diff] of this._pinnedDiff) {
			obj[String(id)] = diff;
		}
		try {
			await this._memento.update(PINNED_DIFF_KEY, obj);
		} catch (err) {
			Logger.warn(`Failed to persist pinned diffs: ${msg(err)}`, COMPONENT);
		}
	}
}

interface GitUriQuery {
	path?: string;
	ref?: string;
}

/**
 * Decode the file path (and ref) encoded by vscode.git's `toGitUri`. The query
 * is JSON `{ path, ref }`; we fall back to the git: URI's own fsPath if that
 * format ever changes.
 */
function decodeGitUri(uri: vscode.Uri): { fsPath: string; ref: string } | undefined {
	if (uri.query) {
		try {
			const parsed = JSON.parse(uri.query) as GitUriQuery;
			if (typeof parsed.path === 'string') {
				return {
					fsPath: vscode.Uri.file(parsed.path).fsPath,
					ref: typeof parsed.ref === 'string' ? parsed.ref : '',
				};
			}
		} catch {
			// fall through to path-based recovery
		}
	}
	if (uri.path) {
		return { fsPath: uri.fsPath, ref: '' };
	}
	return undefined;
}

function msg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
