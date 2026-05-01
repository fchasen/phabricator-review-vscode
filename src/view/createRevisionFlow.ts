import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GitExtension, GitAPI, Repository } from '../api/git';
import { RevisionsManager } from '../phabricator/revisionsManager';
import { RevisionOverviewPanel } from '../phabricator/revisionOverview';
import { RevisionModel } from '../phabricator/revisionModel';
import Logger from '../common/logger';

const execFileAsync = promisify(execFile);

const COMPONENT = 'CreateRevision';
const BUG_RE = /^Bug\s+(\d{5,8})/im;

interface CommitPick extends vscode.QuickPickItem {
	hash: string;
	subject: string;
	body: string;
}

/**
 * Walk the user through creating or updating a Phabricator revision from a
 * local git commit. Returns the new RevisionModel on success.
 */
export async function runSubmitCommitFlow(
	manager: RevisionsManager,
	extensionUri: vscode.Uri,
	mode: 'create' | 'update',
): Promise<void> {
	const session = manager.session;
	if (!session) {
		vscode.window.showErrorMessage('Sign in to Phabricator first.');
		return;
	}

	const gitApi = await getGitApi();
	if (!gitApi) {
		vscode.window.showErrorMessage('VS Code Git extension is not available.');
		return;
	}
	const repo = await pickRepository(gitApi);
	if (!repo) {
		return;
	}

	const commit = await pickCommit(repo);
	if (!commit) {
		return;
	}

	const rawDiff = await getCommitDiff(gitApi.git.path, repo.rootUri.fsPath, commit.hash);
	if (!rawDiff) {
		vscode.window.showErrorMessage(`Commit ${commit.hash.slice(0, 8)} produced an empty diff.`);
		return;
	}

	const phabRepoPHID = await pickPhabRepository(manager);
	if (!phabRepoPHID) {
		return;
	}

	let targetRevisionPHID: string | undefined;
	if (mode === 'update') {
		targetRevisionPHID = await pickRevisionToUpdate(manager);
		if (!targetRevisionPHID) {
			return;
		}
	}

	const reviewerPHIDs = mode === 'create' ? await pickReviewers(manager) : undefined;
	if (mode === 'create' && !reviewerPHIDs) {
		return;
	}

	const subject = commit.subject;
	const body = commit.body;
	const bugMatch = BUG_RE.exec(commit.subject) || BUG_RE.exec(body);
	const bug = bugMatch ? bugMatch[1] : undefined;

	const title = mode === 'create' ? await ask('Title', subject) : undefined;
	if (mode === 'create' && !title) {
		return;
	}
	const summary = mode === 'create' ? await ask('Summary', body, true) || '' : undefined;
	const testPlan = mode === 'create' ? (await ask('Test plan', '', true)) || '' : undefined;

	let diffPHID: string;
	try {
		Logger.info('Uploading raw diff', COMPONENT);
		const created = await session.client.createRawDiff({
			diff: rawDiff,
			repositoryPHID: phabRepoPHID,
			sourceControlBaseRevision: commit.hash + '^',
		});
		diffPHID = created.phid;
		Logger.info(`Diff uploaded: ${diffPHID}`, COMPONENT);
	} catch (err) {
		vscode.window.showErrorMessage(`Diff upload failed: ${err instanceof Error ? err.message : err}`);
		return;
	}

	try {
		const result =
			mode === 'create'
				? await session.client.createRevision({
						diffPHID,
						title: title!,
						summary,
						testPlan,
						reviewerPHIDs,
						bug,
				  })
				: await session.client.updateRevision(targetRevisionPHID!, {
						diffPHID,
						message: subject,
				  });

		const revPHID = result.object;
		const model: RevisionModel | undefined = await manager.getOrFetchRevision(revPHID);
		manager.refresh();
		if (model) {
			await RevisionOverviewPanel.show(extensionUri, manager, model.id);
			vscode.window.showInformationMessage(`Submitted ${model.monogram}.`);
		} else {
			vscode.window.showInformationMessage('Submitted revision.');
		}
	} catch (err) {
		vscode.window.showErrorMessage(`Submit failed: ${err instanceof Error ? err.message : err}`);
	}
}

async function getGitApi(): Promise<GitAPI | undefined> {
	const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!extension) {
		return undefined;
	}
	const ext = extension.isActive ? extension.exports : await extension.activate();
	return ext.getAPI(1);
}

async function pickRepository(api: GitAPI): Promise<Repository | undefined> {
	if (api.repositories.length === 0) {
		vscode.window.showErrorMessage('No git repository open.');
		return undefined;
	}
	if (api.repositories.length === 1) {
		return api.repositories[0];
	}
	type RepoPick = vscode.QuickPickItem & { repo: Repository };
	const items: RepoPick[] = api.repositories.map((r) => ({
		label: r.rootUri.fsPath.split('/').pop() || r.rootUri.fsPath,
		description: r.rootUri.fsPath,
		repo: r,
	}));
	const pick = await vscode.window.showQuickPick<RepoPick>(items, { placeHolder: 'Select repository' });
	return pick?.repo;
}

async function pickCommit(repo: Repository): Promise<CommitPick | undefined> {
	const commits = await repo.log({ maxEntries: 25 });
	if (commits.length === 0) {
		vscode.window.showErrorMessage('No commits found in this repository.');
		return undefined;
	}
	const items: CommitPick[] = commits.map((c) => {
		const [subject, ...rest] = c.message.split('\n');
		return {
			hash: c.hash,
			subject: subject.trim(),
			body: rest.join('\n').trim(),
			label: subject.slice(0, 80),
			description: c.hash.slice(0, 8),
			detail: `${c.authorName || 'unknown'} · ${c.commitDate?.toLocaleString() || ''}`,
		};
	});
	return vscode.window.showQuickPick(items, { placeHolder: 'Select commit to submit' });
}

async function getCommitDiff(gitPath: string, cwd: string, commitHash: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync(
			gitPath,
			['diff', '--no-color', '--no-textconv', `${commitHash}^`, commitHash],
			{ cwd, maxBuffer: 64 * 1024 * 1024 },
		);
		return stdout;
	} catch (err) {
		Logger.warn(`git diff failed: ${err instanceof Error ? err.message : err}`, COMPONENT);
		return '';
	}
}

async function pickPhabRepository(manager: RevisionsManager): Promise<string | undefined> {
	const session = manager.session!;
	const repos = [];
	for await (const repo of session.client.searchRepositories({ vcs: ['git'] })) {
		repos.push(repo);
		if (repos.length >= 50) {
			break;
		}
	}
	if (repos.length === 0) {
		vscode.window.showErrorMessage('No Phabricator repositories visible to you.');
		return undefined;
	}
	const pick = await vscode.window.showQuickPick(
		repos.map((r) => ({
			label: r.fields.name,
			description: r.fields.shortName || r.fields.callsign || '',
			detail: r.phid,
			phid: r.phid,
		})),
		{ placeHolder: 'Select Phabricator repository' },
	);
	return pick?.phid;
}

async function pickRevisionToUpdate(manager: RevisionsManager): Promise<string | undefined> {
	const mine = await manager.getRevisionsForCategory('mine');
	if (mine.length === 0) {
		vscode.window.showErrorMessage('You have no active revisions to update.');
		return undefined;
	}
	const pick = await vscode.window.showQuickPick(
		mine.map((m) => ({
			label: `${m.monogram}: ${m.title}`,
			description: m.statusName,
			phid: m.phid,
		})),
		{ placeHolder: 'Select revision to update' },
	);
	return pick?.phid;
}

async function pickReviewers(manager: RevisionsManager): Promise<string[] | undefined> {
	const session = manager.session!;
	const input = await vscode.window.showInputBox({
		prompt: 'Reviewers (comma-separated usernames or #project slugs). Leave empty for none.',
		placeHolder: 'alice, bob, #firefox-build-system',
	});
	if (input === undefined) {
		return undefined;
	}
	const tokens = input
		.split(',')
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
	if (tokens.length === 0) {
		return [];
	}
	const usernames = tokens.filter((t) => !t.startsWith('#'));
	const projectSlugs = tokens.filter((t) => t.startsWith('#')).map((t) => t.slice(1));
	const out: string[] = [];
	if (usernames.length > 0) {
		const found = await session.client.resolveUsersByUsername(usernames);
		for (const username of usernames) {
			const user = found.get(username);
			if (user) {
				out.push(user.phid);
			} else {
				vscode.window.showWarningMessage(`Unknown user: ${username}`);
			}
		}
	}
	if (projectSlugs.length > 0) {
		const found = await session.client.resolveProjectsBySlug(projectSlugs);
		for (const slug of projectSlugs) {
			const project = found.get(slug);
			if (project) {
				out.push(project.phid);
			} else {
				vscode.window.showWarningMessage(`Unknown project: #${slug}`);
			}
		}
	}
	return out;
}

async function ask(label: string, defaultValue: string, multiline = false): Promise<string | undefined> {
	const value = await vscode.window.showInputBox({
		prompt: label,
		value: defaultValue,
		ignoreFocusOut: true,
	});
	if (value === undefined) {
		return undefined;
	}
	return multiline ? value : value.trim();
}
