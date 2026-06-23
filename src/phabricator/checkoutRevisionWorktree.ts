import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import Logger, { WORKTREE } from '../common/logger';
import { createSparseWorktree, removeWorktree, runGit } from './createSparseWorktree';
import { resolvePreset } from './sparsePresets';
import { parseRevisionNumber } from './revisionMonogram';

export interface CheckoutContext {
	resolveActiveRepoRoot: () => Promise<vscode.Uri | undefined>;
	pinAppliedDiff?: (revisionId: number) => Promise<void> | void;
}

export interface ApplyRevisionToWorktreeOptions {
	worktreePath: string;
	branchName: string;
	revisionId: number;
	mozPhabPath: string;
	reuse: boolean;
	sourceRepo?: string;
	sparsePatterns?: string[] | null;
	report?: (message: string) => void;
}

const MAX_BUFFER = 64 * 1024 * 1024;

export async function runCheckoutRevisionWorktree(
	ctx: CheckoutContext,
	revisionArg?: number | string,
): Promise<void> {
	let revisionId: number | undefined;
	try {
		revisionId = await resolveRevisionId(revisionArg);
	} catch (err) {
		vscode.window.showErrorMessage(messageOf(err));
		return;
	}
	if (revisionId === undefined) {
		return;
	}

	let sourceRepo: string;
	try {
		sourceRepo = await resolveFirefoxSource(ctx);
	} catch (err) {
		vscode.window.showErrorMessage(messageOf(err));
		return;
	}

	const config = vscode.workspace.getConfiguration('phabricator');
	const presetName = config.get<string>('worktreeSparsePreset', 'auto');
	let sparsePatterns: string[] | null;
	try {
		sparsePatterns = resolvePreset(presetName, sourceRepo, {});
	} catch (err) {
		vscode.window.showErrorMessage(`Invalid sparse preset '${presetName}': ${messageOf(err)}`);
		return;
	}

	const { worktreePath, branchName, monogram } = worktreeLocationFor(sourceRepo, revisionId);
	const mozPhabPath = config.get<string>('mozPhabPath', 'moz-phab');

	const existed = fs.existsSync(worktreePath);
	if (existed) {
		const choice = await vscode.window.showWarningMessage(
			`A worktree for ${monogram} already exists at ${worktreePath}.`,
			{ modal: true, detail: 'Reuse it (its HEAD will be detached and re-patched)?' },
			'Reuse',
		);
		if (choice !== 'Reuse') {
			return;
		}
	}

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Checking out ${monogram}`, cancellable: false },
		async (progress) => {
			try {
				await applyRevisionToWorktree({
					worktreePath,
					branchName,
					revisionId,
					mozPhabPath,
					reuse: existed,
					sourceRepo,
					sparsePatterns,
					report: (message) => progress.report({ message }),
				});
			} catch (err) {
				if (!existed) {
					await removeWorktree(sourceRepo, worktreePath);
				}
				Logger.error(`Failed to check out ${monogram}: ${detailOf(err)}`, WORKTREE);
				vscode.window.showErrorMessage(`Failed to check out ${monogram}: ${userFacing(err)}`);
				return;
			}

			Logger.info(`Checked out ${monogram} → ${worktreePath}`, WORKTREE);
			ensureWorktreeInWorkspace(worktreePath, monogram);
			try {
				await ctx.pinAppliedDiff?.(revisionId);
			} catch (err) {
				Logger.warn(`Failed to pin applied diff for ${monogram}: ${detailOf(err)}`, WORKTREE);
			}
			vscode.window.showInformationMessage(`Added ${monogram} worktree to the workspace.`);
		},
	);
}

/**
 * Run the detach/create → delete-branch → moz-phab patch sequence that
 * materializes a revision into a worktree. Shared by the checkout command
 * (fresh and reuse paths) and by WorktreeAnchorResolver.ensureFresh, which
 * re-applies a newer diff to an existing worktree.
 *
 * When `reuse` is true the worktree already exists: its HEAD is force-detached
 * so the phab/D<n> branch can be deleted and re-created by moz-phab. When
 * false a new sparse worktree is created first (`sourceRepo` required).
 *
 * `sourceRepo` (the main checkout) is used for fetch + branch deletion when
 * provided; otherwise those run against the worktree itself, which shares the
 * same object store and refs.
 */
export async function applyRevisionToWorktree(opts: ApplyRevisionToWorktreeOptions): Promise<void> {
	const report = opts.report ?? (() => {});
	const adminRepo = opts.sourceRepo ?? opts.worktreePath;

	report('fetching latest refs');
	try {
		await runGit(['-C', adminRepo, 'fetch', '--quiet', 'origin']);
	} catch (err) {
		Logger.warn(`git fetch failed (continuing with local refs): ${detailOf(err)}`, WORKTREE);
	}

	if (opts.reuse) {
		report('preparing existing worktree');
		await runGit(['-C', opts.worktreePath, 'checkout', '--detach', '--force']);
	} else {
		if (!opts.sourceRepo) {
			throw new Error('sourceRepo is required to create a new worktree');
		}
		report('creating sparse worktree');
		await createSparseWorktree({
			sourceRepo: opts.sourceRepo,
			worktreePath: opts.worktreePath,
			sparsePatterns: opts.sparsePatterns ?? null,
		});
	}

	await deleteBranchIfExists(adminRepo, opts.branchName);

	report('applying patch with moz-phab');
	await runMozPhabPatch(opts.mozPhabPath, opts.worktreePath, opts.branchName, opts.revisionId);
}

async function resolveRevisionId(revisionArg?: number | string): Promise<number | undefined> {
	if (revisionArg !== undefined && revisionArg !== null && revisionArg !== '') {
		return parseRevisionNumber(revisionArg);
	}
	const input = await vscode.window.showInputBox({
		title: 'Check Out Revision in Sparse Worktree',
		prompt: 'Phabricator revision to check out',
		placeHolder: 'D123456',
		validateInput: (v) => {
			if (!v.trim()) {
				return 'Enter a revision (e.g. D123456)';
			}
			try {
				parseRevisionNumber(v);
				return undefined;
			} catch (e) {
				return messageOf(e);
			}
		},
	});
	if (input === undefined) {
		return undefined;
	}
	return parseRevisionNumber(input);
}

export async function resolveFirefoxSource(ctx: CheckoutContext): Promise<string> {
	const active = await ctx.resolveActiveRepoRoot();
	if (active && isDirectory(active.fsPath)) {
		return active.fsPath;
	}
	const configured = vscode.workspace
		.getConfiguration('phabricator')
		.get<string>('firefoxSourcePath', '')
		.trim();
	if (configured) {
		const expanded = expandHome(configured);
		if (isDirectory(expanded)) {
			return expanded;
		}
	}
	const fromEnv = process.env.FIREFOX_SOURCE?.trim();
	if (fromEnv && isDirectory(fromEnv)) {
		return fromEnv;
	}
	const fallback = path.join(os.homedir(), 'firefox');
	if (isDirectory(fallback)) {
		return fallback;
	}
	throw new Error(
		'No Firefox source checkout found. Open it in VS Code, set phabricator.firefoxSourcePath, or set $FIREFOX_SOURCE.',
	);
}

function resolveStorageRoot(config: vscode.WorkspaceConfiguration): string {
	const configured = config.get<string>('worktreeStorageRoot', '~/.worktrees').trim();
	if (configured) {
		return expandHome(configured);
	}
	const fromEnv = process.env.WORKTREE_STORAGE_ROOT?.trim();
	if (fromEnv) {
		return expandHome(fromEnv);
	}
	return path.join(os.homedir(), '.worktrees');
}

export function worktreeStoragePath(root: string, repoName: string, revisionId: number): string {
	return path.join(root, repoName, `patch-D${revisionId}`);
}

export interface WorktreeLocation {
	sourceRepo: string;
	worktreePath: string;
	branchName: string;
	monogram: string;
}

export async function resolveWorktreeLocation(
	ctx: CheckoutContext,
	revisionId: number,
): Promise<WorktreeLocation> {
	const sourceRepo = await resolveFirefoxSource(ctx);
	return { sourceRepo, ...worktreeLocationFor(sourceRepo, revisionId) };
}

function worktreeLocationFor(
	sourceRepo: string,
	revisionId: number,
): Omit<WorktreeLocation, 'sourceRepo'> {
	const config = vscode.workspace.getConfiguration('phabricator');
	const storageRoot = resolveStorageRoot(config);
	const repoName = path.basename(sourceRepo);
	return {
		worktreePath: worktreeStoragePath(storageRoot, repoName, revisionId),
		branchName: `phab/D${revisionId}`,
		monogram: `D${revisionId}`,
	};
}

export async function openExistingWorktree(worktreePath: string, monogram: string): Promise<void> {
	const uri = vscode.Uri.file(worktreePath);
	ensureWorktreeInWorkspace(worktreePath, monogram);
	try {
		await vscode.commands.executeCommand('revealInExplorer', uri);
	} catch {
		// best-effort reveal
	}
}

export function isWorktreeInWorkspace(worktreePath: string): boolean {
	const fsPath = vscode.Uri.file(worktreePath).fsPath;
	return (vscode.workspace.workspaceFolders ?? []).some((folder) => folder.uri.fsPath === fsPath);
}

export function ensureWorktreeInWorkspace(worktreePath: string, monogram: string): boolean {
	if (isWorktreeInWorkspace(worktreePath)) {
		return false;
	}
	addWorktreeToWorkspace(worktreePath, monogram);
	return true;
}

async function deleteBranchIfExists(sourceRepo: string, branchName: string): Promise<void> {
	try {
		await runGit(['-C', sourceRepo, 'branch', '-D', branchName]);
	} catch {
		// branch did not exist
	}
}

function runMozPhabPatch(
	mozPhabPath: string,
	cwd: string,
	branchName: string,
	revisionId: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(
			mozPhabPath,
			['patch', '--yes', '--name', branchName, String(revisionId)],
			{ cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER },
			(err, _stdout, stderr) => {
				if (err) {
					const tail = tailLines(stderr, 30);
					reject(new Error(tail ? `moz-phab patch failed:\n${tail}` : err.message || 'moz-phab patch failed'));
					return;
				}
				resolve();
			},
		);
	});
}

function addWorktreeToWorkspace(worktreePath: string, monogram: string): void {
	const uri = vscode.Uri.file(worktreePath);
	const start = vscode.workspace.workspaceFolders?.length ?? 0;
	vscode.workspace.updateWorkspaceFolders(start, 0, { uri, name: `patch-${monogram}` });
}

function expandHome(p: string): string {
	if (!p) {
		return p;
	}
	if (p === '~') {
		return os.homedir();
	}
	if (p.startsWith('~/')) {
		return path.join(os.homedir(), p.slice(2));
	}
	return p;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function tailLines(text: string, n: number): string {
	if (!text) {
		return '';
	}
	const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
	return lines.slice(-n).join('\n');
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function detailOf(err: unknown): string {
	if (err instanceof Error) {
		const e = err as Error & { stderr?: string };
		return e.stderr ? `${err.message}\n${e.stderr}` : err.stack || err.message;
	}
	return String(err);
}

function userFacing(err: unknown): string {
	const detail = detailOf(err);
	if (/sparse-checkout/.test(detail) && /(unknown|usage|not a git command)/i.test(detail)) {
		return 'git sparse-checkout is unavailable. Upgrade git (≥ 2.36) or set phabricator.worktreeSparsePreset to "full".';
	}
	return messageOf(err);
}
