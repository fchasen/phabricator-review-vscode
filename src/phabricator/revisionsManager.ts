import * as vscode from 'vscode';
import { CredentialStore, PhabSession } from '../auth/credentialStore';
import { Disposable } from '../common/lifecycle';
import Logger, { REVISION_TREE } from '../common/logger';
import { UserResolver } from './userResolver';
import { RevisionModel } from './revisionModel';
import { LocalGitResolver } from './localGitResolver';
import { TESTING_TAG_SLUGS, TestingTagSlug } from './testingTag';
import type { Revision, RevisionConstraints, RevisionStatus } from '../client';

export type CategoryKey = 'mine' | 'reviewer' | 'subscriber' | 'closed';

export interface CategoryDefinition {
	key: CategoryKey;
	label: string;
}

export const CATEGORIES: CategoryDefinition[] = [
	{ key: 'mine', label: 'My Active' },
	{ key: 'reviewer', label: 'Needs My Review' },
	{ key: 'subscriber', label: 'Subscribed' },
	{ key: 'closed', label: 'Recently Closed' },
];

const ACTIVE_REVISION_STATUSES: RevisionStatus[] = [
	'needs-review',
	'accepted',
	'needs-revision',
	'changes-planned',
	'draft',
];

export class RevisionsManager extends Disposable {
	private readonly _onDidChangeRevisions = this._register(new vscode.EventEmitter<CategoryKey | undefined>());
	public readonly onDidChangeRevisions = this._onDidChangeRevisions.event;

	private _userResolver: UserResolver | undefined;
	private _projectMembership: string[] = [];
	private readonly _testingTagPHIDs = new Map<TestingTagSlug, string>();
	private _testingTagLoad: Promise<void> | undefined;
	public readonly localGit = new LocalGitResolver();
	private readonly _categoryCache = new Map<CategoryKey, RevisionModel[]>();
	private readonly _byPHID = new Map<string, RevisionModel>();
	private readonly _byId = new Map<number, RevisionModel>();
	private _pollTimer: ReturnType<typeof setInterval> | undefined;

	constructor(private readonly _credentials: CredentialStore) {
		super();
		this._register(
			this._credentials.onDidChangeSession(async (session) => {
				this._categoryCache.clear();
				this._byPHID.clear();
				this._byId.clear();
				this._testingTagPHIDs.clear();
				this._testingTagLoad = undefined;
				this._userResolver = session ? new UserResolver(session.client) : undefined;
				if (session) {
					await this._loadProjectMembership(session);
					this._startPolling();
				} else {
					this._projectMembership = [];
					this._stopPolling();
				}
				this._onDidChangeRevisions.fire(undefined);
			}),
		);
		this._register(
			vscode.window.onDidChangeWindowState((state) => {
				if (state.focused && this._credentials.session) {
					this._startPolling();
				} else {
					this._stopPolling();
				}
			}),
		);
		this._register(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('phabricator.refreshIntervalSeconds')) {
					this._restartPolling();
				}
			}),
		);
		this._register({ dispose: () => this._stopPolling() });

		const existing = this._credentials.session;
		if (existing) {
			this._userResolver = new UserResolver(existing.client);
			this._loadProjectMembership(existing).catch((err) => Logger.warn(err, REVISION_TREE));
			this._startPolling();
		}
	}

	public get session(): PhabSession | undefined {
		return this._credentials.session;
	}

	public get userResolver(): UserResolver | undefined {
		return this._userResolver;
	}

	public get projectMembership(): readonly string[] {
		return this._projectMembership;
	}

	public refresh(category?: CategoryKey): void {
		if (category) {
			this._categoryCache.delete(category);
			this._onDidChangeRevisions.fire(category);
		} else {
			this._categoryCache.clear();
			this._onDidChangeRevisions.fire(undefined);
		}
	}

	public async getRevisionsForCategory(category: CategoryKey): Promise<RevisionModel[]> {
		const cached = this._categoryCache.get(category);
		if (cached) {
			return cached;
		}
		const session = this._credentials.session;
		if (!session) {
			return [];
		}
		const constraints = this._constraintsForCategory(category, session.userPHID);
		if (!constraints) {
			return [];
		}
		const limit = category === 'closed' ? 25 : 100;
		const revisions = category === 'subscriber'
			? await this._getSubscribedRevisions(session, constraints, limit)
			: await this._searchRevisions(session, constraints, limit);
		let models = revisions.map((r) => this._adopt(r));
		if (category === 'reviewer') {
			models = models.filter((m) => m.authorPHID !== session.userPHID);
		}
		this._categoryCache.set(category, models);
		return models;
	}

	private async _searchRevisions(
		session: PhabSession,
		constraints: RevisionConstraints,
		limit: number,
	): Promise<Revision[]> {
		const revisions: Revision[] = [];
		for await (const revision of session.client.searchRevisions(
			constraints,
			{ reviewers: true, subscribers: true, projects: true },
			{ order: 'updated' },
		)) {
			revisions.push(revision);
			if (revisions.length >= limit) {
				break;
			}
		}
		return revisions;
	}

	private async _getSubscribedRevisions(
		session: PhabSession,
		constraints: RevisionConstraints,
		limit: number,
	): Promise<Revision[]> {
		const revisions = await this._searchRevisions(session, constraints, limit);
		if (revisions.length > 0) {
			return revisions;
		}
		try {
			const phids = await session.client.querySubscribedRevisionPHIDs(session.userPHID, { limit });
			if (phids.length === 0) {
				return [];
			}
			const byOrder = new Map(phids.map((phid, index) => [phid, index]));
			const fetched = await this._searchRevisions(session, { phids }, limit);
			return fetched.sort((a, b) => (byOrder.get(a.phid) ?? 0) - (byOrder.get(b.phid) ?? 0));
		} catch (err) {
			Logger.warn(`Failed to load subscribed revisions with legacy API: ${err instanceof Error ? err.message : err}`, REVISION_TREE);
			return revisions;
		}
	}

	public getRevisionByPHID(phid: string): RevisionModel | undefined {
		return this._byPHID.get(phid);
	}

	public async getAttentionCount(): Promise<number> {
		const session = this._credentials.session;
		if (!session) return 0;
		const [mine, reviewer] = await Promise.all([
			this.getRevisionsForCategory('mine'),
			this.getRevisionsForCategory('reviewer'),
		]);
		let count = 0;
		for (const m of mine) {
			if (m.authorPHID !== session.userPHID) continue;
			if (m.statusValue === 'accepted' || m.statusValue === 'needs-revision') count++;
		}
		for (const m of reviewer) {
			if (m.statusValue !== 'needs-review') continue;
			const me = m.reviewers.find((r) => r.reviewerPHID === session.userPHID);
			if (!me) continue;
			if (me.status === 'added' || me.status === 'accepted-prior') count++;
		}
		return count;
	}

	public async getOrFetchRevision(idOrPHID: number | string): Promise<RevisionModel | undefined> {
		const fromCache =
			typeof idOrPHID === 'number'
				? this._byId.get(idOrPHID)
				: this._byPHID.get(idOrPHID);
		if (fromCache) {
			return fromCache;
		}
		const session = this._credentials.session;
		if (!session) {
			return undefined;
		}
		const revision = await session.client.getRevision(idOrPHID, {
			reviewers: true,
			subscribers: true,
			projects: true,
		});
		if (!revision) {
			return undefined;
		}
		return this._adopt(revision);
	}

	private _adopt(revision: Revision): RevisionModel {
		const existing = this._byPHID.get(revision.phid);
		if (existing) {
			existing.update(revision);
			return existing;
		}
		const session = this._credentials.session;
		if (!session) {
			throw new Error('cannot adopt revision without an active session');
		}
		const model = new RevisionModel(revision, session.client, this._userResolver!, this.localGit);
		this._byPHID.set(revision.phid, model);
		this._byId.set(revision.id, model);
		return model;
	}

	private _constraintsForCategory(category: CategoryKey, userPHID: string) {
		switch (category) {
			case 'mine':
				return {
					authorPHIDs: [userPHID],
					statuses: ACTIVE_REVISION_STATUSES,
				};
			case 'reviewer':
				return {
					reviewerPHIDs: [userPHID, ...this._projectMembership],
					statuses: ['needs-review'] as RevisionStatus[],
				};
			case 'subscriber':
				return {
					subscribers: [userPHID],
					statuses: ACTIVE_REVISION_STATUSES,
				};
			case 'closed':
				return {
					authorPHIDs: [userPHID],
					statuses: ['published', 'abandoned'] as RevisionStatus[],
				};
			default:
				return undefined;
		}
	}

	public testingTagPHID(slug: TestingTagSlug): string | undefined {
		return this._testingTagPHIDs.get(slug);
	}

	public loadTestingTagDirectory(): Promise<void> {
		const session = this._credentials.session;
		if (!session) return Promise.resolve();
		const missing = TESTING_TAG_SLUGS.filter((s) => !this._testingTagPHIDs.has(s));
		if (missing.length === 0) return Promise.resolve();
		if (this._testingTagLoad) return this._testingTagLoad;
		this._testingTagLoad = (async () => {
			try {
				const map = await session.client.resolveProjectsBySlug(missing);
				for (const slug of missing) {
					const project = map.get(slug);
					if (project) this._testingTagPHIDs.set(slug, project.phid);
				}
			} catch (err) {
				Logger.warn(`Testing tag lookup failed: ${err instanceof Error ? err.message : err}`, REVISION_TREE);
			} finally {
				this._testingTagLoad = undefined;
			}
		})();
		return this._testingTagLoad;
	}

	private async _loadProjectMembership(session: PhabSession): Promise<void> {
		try {
			const projects = await session.client.listProjectsForMember(session.userPHID);
			this._projectMembership = projects.map((p) => p.phid);
			Logger.debug(`Cached ${this._projectMembership.length} project memberships`, REVISION_TREE);
		} catch (err) {
			Logger.warn(`Failed to load project memberships: ${err instanceof Error ? err.message : err}`, REVISION_TREE);
			this._projectMembership = [];
		}
	}

	private _startPolling(): void {
		this._stopPolling();
		const seconds = vscode.workspace
			.getConfiguration('phabricator')
			.get<number>('refreshIntervalSeconds', 900);
		if (seconds <= 0) {
			return;
		}
		this._pollTimer = setInterval(() => {
			if (!vscode.window.state.focused || !this._credentials.session) {
				return;
			}
			this.refresh();
		}, seconds * 1000);
	}

	private _stopPolling(): void {
		if (this._pollTimer) {
			clearInterval(this._pollTimer);
			this._pollTimer = undefined;
		}
	}

	private _restartPolling(): void {
		if (this._credentials.session && vscode.window.state.focused) {
			this._startPolling();
		}
	}
}
