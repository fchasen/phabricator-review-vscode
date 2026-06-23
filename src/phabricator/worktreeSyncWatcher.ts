import * as vscode from 'vscode';
import { Disposable } from '../common/lifecycle';
import Logger from '../common/logger';
import { RevisionsManager } from './revisionsManager';
import { WorktreeAnchorResolver } from './worktreeAnchor';
import { WorktreeRevisionMap } from './worktreeRevisionMap';

const COMPONENT = 'WorktreeSync';

/**
 * Proactively keeps checked-out worktrees in sync with their Phabricator
 * revision. When the active diff for a revision that has a ready worktree
 * advances, it asks the resolver to re-apply the newer diff — so an open
 * worktree updates as soon as the next poll observes the change, without the
 * user opening anything.
 *
 * It listens both to the manager's coarse revision-changed event and to each
 * relevant model's onDidChange (which fires precisely when a model's diff
 * pointer moves). `ensureFresh` itself is a no-op when nothing is stale and
 * de-dupes concurrent updates, so firing eagerly is safe.
 */
export class WorktreeSyncWatcher extends Disposable {
	private readonly _modelSubs = new Map<string, vscode.Disposable>();

	constructor(
		private readonly _manager: RevisionsManager,
		private readonly _worktreeMap: WorktreeRevisionMap,
		private readonly _resolver: WorktreeAnchorResolver,
	) {
		super();
		this._register(this._manager.onDidChangeRevisions(() => this._sweep()));
		this._register(this._worktreeMap.onDidChange(() => this._sweep()));
		this._register({ dispose: () => this._disposeModelSubs() });
		this._sweep();
	}

	private _sweep(): void {
		for (const mapping of this._worktreeMap.getMapped()) {
			const revisionId = mapping.revisionId;
			if (revisionId === undefined) {
				continue;
			}
			if (!this._resolver.readyMappingFor(revisionId)) {
				continue;
			}
			const model = this._manager.getRevisionById(revisionId);
			if (model) {
				this._subscribeToModel(model.phid, revisionId);
			}
			void this._resolver.ensureFresh(revisionId).catch((err) => {
				Logger.warn(`ensureFresh(D${revisionId}) failed: ${err instanceof Error ? err.message : err}`, COMPONENT);
			});
		}
	}

	private _subscribeToModel(phid: string, revisionId: number): void {
		if (this._modelSubs.has(phid)) {
			return;
		}
		const model = this._manager.getRevisionById(revisionId);
		if (!model) {
			return;
		}
		this._modelSubs.set(
			phid,
			model.onDidChange(() => {
				void this._resolver.ensureFresh(revisionId).catch((err) => {
					Logger.warn(`ensureFresh(D${revisionId}) failed: ${err instanceof Error ? err.message : err}`, COMPONENT);
				});
			}),
		);
	}

	private _disposeModelSubs(): void {
		for (const sub of this._modelSubs.values()) {
			sub.dispose();
		}
		this._modelSubs.clear();
	}
}
