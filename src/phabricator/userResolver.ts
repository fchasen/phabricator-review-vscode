import { PhabricatorClient } from '../client';
import type { Project, User } from './interface';

/**
 * Caches resolved user/project PHIDs and batches resolution calls.
 */
export class UserResolver {
	private readonly _users = new Map<string, User>();
	private readonly _projects = new Map<string, Project>();
	private _pendingPhids = new Set<string>();
	private _flushTimer: ReturnType<typeof setTimeout> | undefined;
	private _flushPromise: Promise<void> | undefined;

	constructor(private readonly _client: PhabricatorClient) {}

	public async resolveOne(phid: string): Promise<User | Project | undefined> {
		if (this._users.has(phid)) {
			return this._users.get(phid);
		}
		if (this._projects.has(phid)) {
			return this._projects.get(phid);
		}
		this._pendingPhids.add(phid);
		await this._scheduleFlush();
		return this._users.get(phid) || this._projects.get(phid);
	}

	public async resolveMany(phids: string[]): Promise<void> {
		const fresh = phids.filter((p) => !this._users.has(p) && !this._projects.has(p));
		if (fresh.length === 0) {
			return;
		}
		fresh.forEach((p) => this._pendingPhids.add(p));
		await this._scheduleFlush();
	}

	public displayName(phid: string): string {
		const user = this._users.get(phid);
		if (user) {
			return user.fields.username;
		}
		const project = this._projects.get(phid);
		if (project) {
			const raw = project.fields.slug || project.fields.name || '';
			// Strip a leading '#' if Phabricator already provided it; consumers
			// (webview, comment labels) decide whether to display the prefix.
			return raw.startsWith('#') ? raw.slice(1) : raw;
		}
		return phid;
	}

	public isProject(phid: string): boolean {
		return this._projects.has(phid);
	}

	public clear(): void {
		this._users.clear();
		this._projects.clear();
	}

	private _scheduleFlush(): Promise<void> {
		if (this._flushPromise) {
			return this._flushPromise;
		}
		this._flushPromise = new Promise((resolve, reject) => {
			this._flushTimer = setTimeout(async () => {
				const phids = Array.from(this._pendingPhids);
				this._pendingPhids.clear();
				this._flushTimer = undefined;
				this._flushPromise = undefined;
				try {
					if (phids.length > 0) {
						const userPhids = phids.filter((p) => p.includes('-USER-'));
						const projectPhids = phids.filter((p) => p.includes('-PROJ-'));
						const others = phids.filter((p) => !p.includes('-USER-') && !p.includes('-PROJ-'));
						const userBucket = [...userPhids, ...others];
						const [users, projects] = await Promise.all([
							userBucket.length > 0 ? this._client.resolveUsers(userBucket) : Promise.resolve(new Map<string, User>()),
							projectPhids.length > 0 ? this._client.resolveProjects(projectPhids) : Promise.resolve(new Map<string, Project>()),
						]);
						users.forEach((u, k) => this._users.set(k, u));
						projects.forEach((p, k) => this._projects.set(k, p));
					}
					resolve();
				} catch (err) {
					reject(err);
				}
			}, 10);
		});
		return this._flushPromise;
	}
}
