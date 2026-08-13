import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import Logger, { WORKTREE } from '../common/logger';
import { mozconfigCandidatePaths } from './sparsePresets';

export interface CreateSparseWorktreeOptions {
	sourceRepo: string;
	worktreePath: string;
	branch?: string;
	from?: string;
	sparsePatterns: string[] | null;
}

export interface RunGitResult {
	stdout: string;
	stderr: string;
}

export interface RunGitError extends Error {
	stdout?: string;
	stderr?: string;
}

const MAX_BUFFER = 64 * 1024 * 1024;

const MATERIALIZING_PATTERN = '/.vscode-phab-materializing';

export function runGit(args: string[], opts: { cwd?: string; stdin?: string } = {}): Promise<RunGitResult> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			'git',
			args,
			{ cwd: opts.cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER },
			(err, stdout, stderr) => {
				if (err) {
					const e = err as RunGitError;
					e.stdout = stdout;
					e.stderr = stderr;
					reject(e);
					return;
				}
				resolve({ stdout, stderr });
			},
		);
		if (opts.stdin !== undefined) {
			child.stdin?.end(opts.stdin);
		}
	});
}

export async function createSparseWorktree(opts: CreateSparseWorktreeOptions): Promise<void> {
	const addArgs = ['-C', opts.sourceRepo, 'worktree', 'add', '--no-checkout'];
	if (opts.branch) {
		addArgs.push('-b', opts.branch);
	} else {
		addArgs.push('--detach');
	}
	addArgs.push(opts.worktreePath);
	if (opts.from) {
		addArgs.push(opts.from);
	}
	await runGit(addArgs);

	try {
		await stageSkippedIndex(opts.worktreePath);
		const patterns = opts.sparsePatterns;
		if (patterns && patterns.length > 0) {
			await runGit(
				['-C', opts.worktreePath, '-c', 'checkout.workers=0', 'sparse-checkout', 'set', '--no-cone', '--stdin'],
				{ stdin: patterns.join('\n') + '\n' },
			);
		} else {
			await runGit(['-C', opts.worktreePath, '-c', 'checkout.workers=0', 'sparse-checkout', 'disable']);
		}
		await runGit(['-C', opts.worktreePath, '-c', 'checkout.workers=0', 'reset', '--hard', 'HEAD']);
	} catch (err) {
		await removeWorktree(opts.sourceRepo, opts.worktreePath);
		throw err;
	}

	copyMozconfig(opts.sourceRepo, opts.worktreePath);
}

async function stageSkippedIndex(worktreePath: string): Promise<void> {
	await runGit(['-C', worktreePath, 'read-tree', 'HEAD']);
	await runGit(['-C', worktreePath, 'sparse-checkout', 'set', '--no-cone', '--stdin'], {
		stdin: MATERIALIZING_PATTERN + '\n',
	});
}

export function copyMozconfig(sourceRepo: string, worktreePath: string): void {
	const target = path.join(worktreePath, 'mozconfig');
	if (fs.existsSync(target)) {
		return;
	}
	for (const source of mozconfigCandidatePaths(sourceRepo, process.env)) {
		try {
			if (!fs.statSync(source).isFile()) {
				continue;
			}
			fs.copyFileSync(source, target);
			Logger.info(`Copied ${source} → ${target}`, WORKTREE);
			return;
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
				Logger.warn(`Could not copy ${source} → ${target}: ${String(err)}`, WORKTREE);
			}
		}
	}
}

export async function removeWorktree(sourceRepo: string, worktreePath: string): Promise<void> {
	try {
		await runGit(['-C', sourceRepo, 'worktree', 'remove', '--force', worktreePath]);
	} catch {
		// best-effort cleanup
	}
}
