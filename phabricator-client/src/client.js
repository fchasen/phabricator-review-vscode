'use strict';

const { createState, callConduit } = require('./conduit');
const { paginate, collect } = require('./pagination');

/**
 * @typedef {import('./types').ClientOptions} ClientOptions
 * @typedef {import('./types').WhoAmI} WhoAmI
 * @typedef {import('./types').Revision} Revision
 * @typedef {import('./types').Diff} Diff
 * @typedef {import('./types').Repository} Repository
 * @typedef {import('./types').User} User
 * @typedef {import('./types').Project} Project
 * @typedef {import('./types').Transaction} Transaction
 * @typedef {import('./types').RevisionConstraints} RevisionConstraints
 * @typedef {import('./types').RevisionAttachments} RevisionAttachments
 * @typedef {import('./types').EditTransaction} EditTransaction
 * @typedef {import('./types').EditResult} EditResult
 * @typedef {import('./types').ConduitCursor} ConduitCursor
 */

/**
 * @template T
 * @typedef {(cursor: string|null) => Promise<{ data: T[], cursor: ConduitCursor }>} PageFetcher
 */

class PhabricatorClient {
	/**
	 * @param {ClientOptions} opts
	 */
	constructor(opts) {
		/** @private */
		this._state = createState(opts);
	}

	/**
	 * Returns the public base URL the client is talking to.
	 * @returns {string}
	 */
	get baseUrl() {
		return this._state.baseUrl;
	}

	/**
	 * @template T
	 * @param {string} method
	 * @param {object} [args]
	 * @returns {Promise<T>}
	 */
	call(method, args) {
		return callConduit(this._state, method, args);
	}

	/**
	 * Verify the configured token. Throws ConduitError on bad credentials.
	 * @returns {Promise<WhoAmI>}
	 */
	whoami() {
		return this.call('user.whoami');
	}

	// ---------------------------------------------------------------- remarkup

	/**
	 * Render Remarkup source to HTML using Phabricator's own renderer via the
	 * `remarkup.process` Conduit endpoint. Accepts a list of bodies and returns
	 * a parallel list of HTML strings. Returns an empty array if `contents` is
	 * empty (no Conduit call made).
	 *
	 * Note: `context` is the renderer **engine** name (e.g. `phriction-document`,
	 * `differential-revision`), not a PHID. Phabricator returns
	 * `ERR-INVALID_ENGINE` for unknown engine names. Defaults to
	 * `phriction-document`, which is the most permissive engine available on
	 * most installs.
	 *
	 * @param {string[]} contents
	 * @param {{ context?: string }} [opts]
	 * @returns {Promise<string[]>}
	 */
	async processRemarkup(contents, opts) {
		if (!Array.isArray(contents) || contents.length === 0) {
			return [];
		}
		const args = {
			context: (opts && opts.context) || 'phriction-document',
			contents,
		};
		/** @type {any} */
		const result = await this.call('remarkup.process', args);
		const list = Array.isArray(result) ? result : [];
		return list.map((entry) => {
			if (entry && typeof entry.content === 'string') {
				return entry.content;
			}
			return typeof entry === 'string' ? entry : '';
		});
	}

	// ---------------------------------------------------------------- revisions

	/**
	 * @param {RevisionConstraints} [constraints]
	 * @param {RevisionAttachments} [attachments]
	 * @param {{ order?: string, limit?: number }} [opts]
	 * @returns {AsyncIterableIterator<Revision>}
	 */
	searchRevisions(constraints, attachments, opts) {
		const args = {
			constraints: constraints || {},
			attachments: attachments || {},
			order: opts && opts.order,
			limit: opts && opts.limit,
		};
		return paginate(async (after) => {
			/** @type {{ data: Revision[], cursor: ConduitCursor }} */
			const result = await this.call('differential.revision.search', { ...args, after });
			return result;
		});
	}

	/**
	 * Fetch a single revision by numeric id (e.g. 12345) or PHID.
	 *
	 * @param {number|string} idOrPHID
	 * @param {RevisionAttachments} [attachments]
	 * @returns {Promise<Revision|undefined>}
	 */
	async getRevision(idOrPHID, attachments) {
		const constraints = typeof idOrPHID === 'number'
			? { ids: [idOrPHID] }
			: { phids: [idOrPHID] };
		const iter = this.searchRevisions(constraints, attachments, { limit: 1 });
		const next = await iter.next();
		return next.done ? undefined : next.value;
	}

	// --------------------------------------------------------------------- diffs

	/**
	 * @param {{ ids?: number[], phids?: string[], revisionPHIDs?: string[] }} constraints
	 * @param {{ commits?: boolean }} [attachments]
	 * @returns {AsyncIterableIterator<Diff>}
	 */
	searchDiffs(constraints, attachments) {
		const args = {
			constraints: constraints || {},
			attachments: attachments || {},
		};
		return paginate(async (after) => {
			/** @type {{ data: Diff[], cursor: ConduitCursor }} */
			const result = await this.call('differential.diff.search', { ...args, after });
			return result;
		});
	}

	/**
	 * Fetch the unified-diff text for a diff. Conduit requires the numeric
	 * diff id (not the PHID) — pass an integer.
	 *
	 * @param {number} diffId
	 * @returns {Promise<string>}
	 */
	getRawDiff(diffId) {
		return this.call('differential.getrawdiff', { diffID: diffId });
	}

	/**
	 * Fetch one or more diffs by numeric id, returning their full changesets
	 * (file metadata + hunks with corpus text). On Mozilla's instance the
	 * hunk corpus contains effectively the whole file, so synthesizing the
	 * before/after content from it produces a real full-file view.
	 *
	 * @param {number[]} diffIds
	 * @returns {Promise<Map<number, import('./types').QueriedDiff>>}
	 */
	async queryDiffs(diffIds) {
		if (diffIds.length === 0) {
			return new Map();
		}
		/** @type {Object<string, any>} */
		const result = await this.call('differential.querydiffs', { ids: diffIds });
		const out = /** @type {Map<number, import('./types').QueriedDiff>} */ (new Map());
		for (const key of Object.keys(result)) {
			const raw = result[key];
			const id = typeof raw.id === 'number' ? raw.id : Number(raw.id);
			out.set(id, {
				id,
				phid: raw.phid || null,
				revisionPHID: raw.revisionPHID || null,
				repositoryPHID: raw.repositoryPHID || null,
				sourceControlBaseRevision: raw.sourceControlBaseRevision || null,
				dateCreated: raw.dateCreated ? Number(raw.dateCreated) : null,
				dateModified: raw.dateModified ? Number(raw.dateModified) : null,
				changes: (raw.changes || []).map(normalizeChangeset),
			});
		}
		return out;
	}

	/**
	 * Fetch a file's content from Diffusion at a given commit. Used to
	 * reconstruct full-file diff views.
	 *
	 * Returns the file body as a string, or null if the file cannot be
	 * resolved (commit unknown, file absent, endpoint missing on the
	 * Phabricator instance).
	 *
	 * @param {{ repository: string, commit: string, path: string }} args
	 *   `repository` accepts a callsign, shortName, or PHID.
	 * @returns {Promise<string|null>}
	 */
	async getFileContent(args) {
		/** @type {any} */
		let result;
		try {
			result = await this.call('diffusion.filecontentquery', {
				repositoryPHID: args.repository,
				commit: args.commit,
				path: args.path,
			});
		} catch (err) {
			this._state.log('warn', `diffusion.filecontentquery rejected: ${err && /** @type {any} */ (err).code || err}`);
			return null;
		}
		if (!result || !result.filePHID) {
			this._state.log('warn', 'diffusion.filecontentquery returned no filePHID', {
				tooSlow: result?.tooSlow,
				tooHuge: result?.tooHuge,
			});
			return null;
		}
		try {
			/** @type {any} */
			const base64 = await this.call('file.download', { phid: result.filePHID });
			if (typeof base64 !== 'string' || base64.length === 0) {
				return null;
			}
			return decodeBase64(base64);
		} catch (err) {
			this._state.log('warn', `file.download failed: ${err && /** @type {any} */ (err).code || err}`);
			return null;
		}
	}

	/**
	 * Upload a unified-diff string and return the new diff identifiers.
	 *
	 * Mozilla's instance accepts the legacy `differential.creatediff` shape;
	 * the modern `differential.diff.create` is not yet enabled. Verify before
	 * relying on this in production code.
	 *
	 * @param {{ diff: string, repositoryPHID: string, sourceControlBaseRevision?: string, sourceControlSystem?: string }} args
	 * @returns {Promise<{ phid: string, id: number, uri: string|null }>}
	 */
	async createRawDiff(args) {
		const result = await this.call('differential.createrawdiff', {
			diff: args.diff,
			repositoryPHID: args.repositoryPHID,
			baseRevision: args.sourceControlBaseRevision,
		});
		const r = /** @type {any} */ (result);
		return {
			phid: r.phid,
			id: r.id,
			uri: r.uri || null,
		};
	}

	// ----------------------------------------------------------- transactions

	/**
	 * @param {string} objectIdentifier  PHID or monogram (e.g. D12345)
	 * @returns {AsyncIterableIterator<Transaction>}
	 */
	searchTransactions(objectIdentifier) {
		return paginate(async (after) => {
			/** @type {{ data: Transaction[], cursor: ConduitCursor }} */
			const result = await this.call('transaction.search', {
				objectIdentifier,
				after,
			});
			return result;
		});
	}

	// --------------------------------------------------------------- edit / acts

	/**
	 * Low-level edit endpoint. Apply transactions to a revision.
	 *
	 * @param {{ objectIdentifier?: string|number, transactions: EditTransaction[] }} args
	 * @returns {Promise<EditResult>}
	 */
	editRevision(args) {
		return this.call('differential.revision.edit', {
			objectIdentifier: args.objectIdentifier,
			transactions: args.transactions,
		});
	}

	/**
	 * @param {string|number} revIdOrPHID
	 * @param {string} body
	 * @returns {Promise<EditResult>}
	 */
	comment(revIdOrPHID, body) {
		return this.editRevision({
			objectIdentifier: revIdOrPHID,
			transactions: [{ type: 'comment', value: body }],
		});
	}

	/**
	 * @param {string|number} revIdOrPHID
	 * @param {string} [body]
	 * @returns {Promise<EditResult>}
	 */
	accept(revIdOrPHID, body) {
		const transactions = /** @type {EditTransaction[]} */ ([{ type: 'accept', value: true }]);
		if (body) {
			transactions.push({ type: 'comment', value: body });
		}
		return this.editRevision({ objectIdentifier: revIdOrPHID, transactions });
	}

	/**
	 * @param {string|number} revIdOrPHID
	 * @param {string} body
	 * @returns {Promise<EditResult>}
	 */
	requestChanges(revIdOrPHID, body) {
		return this.editRevision({
			objectIdentifier: revIdOrPHID,
			transactions: [
				{ type: 'reject', value: true },
				{ type: 'comment', value: body },
			],
		});
	}

	/**
	 * Take over ownership of someone else's revision. Optional comment.
	 *
	 * @param {string|number} revIdOrPHID
	 * @param {string} [body]
	 * @returns {Promise<EditResult>}
	 */
	commandeer(revIdOrPHID, body) {
		const transactions = /** @type {EditTransaction[]} */ ([{ type: 'commandeer', value: true }]);
		if (body) {
			transactions.push({ type: 'comment', value: body });
		}
		return this.editRevision({ objectIdentifier: revIdOrPHID, transactions });
	}

	/**
	 * Resign as a reviewer on someone else's revision.
	 *
	 * @param {string|number} revIdOrPHID
	 * @param {string} [body]
	 * @returns {Promise<EditResult>}
	 */
	resign(revIdOrPHID, body) {
		const transactions = /** @type {EditTransaction[]} */ ([{ type: 'resign', value: true }]);
		if (body) {
			transactions.push({ type: 'comment', value: body });
		}
		return this.editRevision({ objectIdentifier: revIdOrPHID, transactions });
	}

	/**
	 * Abandon your own revision. Optional comment.
	 *
	 * @param {string|number} revIdOrPHID
	 * @param {string} [body]
	 * @returns {Promise<EditResult>}
	 */
	abandon(revIdOrPHID, body) {
		const transactions = /** @type {EditTransaction[]} */ ([{ type: 'abandon', value: true }]);
		if (body) {
			transactions.push({ type: 'comment', value: body });
		}
		return this.editRevision({ objectIdentifier: revIdOrPHID, transactions });
	}

	/**
	 * Create a draft inline comment via the legacy `differential.createinline`
	 * endpoint. Phabricator stores it as a draft visible only to the author;
	 * it gets promoted to a published inline the next time the same user
	 * fires a revision-level transaction (comment / accept / reject) via
	 * `differential.revision.edit`.
	 *
	 * Note: Phabricator's `lineLength` is "additional lines after the first",
	 * so a single-line comment uses `lineLength: 0`, a 3-line comment uses
	 * `lineLength: 2`. We translate `length` (number of lines) to that form.
	 *
	 * @param {{
	 *   diffId: number,
	 *   path: string,
	 *   line: number,
	 *   length?: number,
	 *   isNewFile: boolean,
	 *   content: string,
	 *   replyToCommentPHID?: string
	 * }} args
	 * @returns {Promise<{ phid: string }>}
	 */
	async createInline(args) {
		const lineLength = Math.max(0, (args.length || 1) - 1);
		/** @type {any} */
		const result = await this.call('differential.createinline', {
			diffID: args.diffId,
			filePath: args.path,
			lineNumber: args.line,
			lineLength,
			isNewFile: args.isNewFile,
			content: args.content,
			replyToCommentPHID: args.replyToCommentPHID,
		});
		return { phid: result?.phid || result?.id || '' };
	}

	/**
	 * Delete a draft inline comment by PHID. Only works on drafts owned by
	 * the authenticated user.
	 *
	 * @param {string} phid
	 * @returns {Promise<void>}
	 */
	async deleteInline(phid) {
		await this.call('differential.deleteinline', { phid });
	}

	/**
	 * Mark an inline comment as Done (or undo it).
	 *
	 * Phorge accepts a `inline.done` transaction on `differential.revision.edit`
	 * whose value is a list of inline comment PHIDs. The transaction toggles the
	 * isDone state on each PHID; pass `done: false` to undo. We pre-check the
	 * current state by fetching the revision's inlines is unnecessary — the
	 * server flips state to match `done`.
	 *
	 * @param {{ revisionPHID: string, commentPHIDs: string[], done?: boolean }} args
	 * @returns {Promise<EditResult>}
	 */
	async markInlineDone(args) {
		const done = args.done !== false;
		return this.editRevision({
			objectIdentifier: args.revisionPHID,
			transactions: [
				{
					type: done ? 'inline.done' : 'inline.undone',
					value: args.commentPHIDs,
				},
			],
		});
	}

	// -------------------------------------------------------------- create / update

	/**
	 * Create a brand-new revision around an already-uploaded diff.
	 *
	 * @param {{
	 *   diffPHID: string,
	 *   title: string,
	 *   summary?: string,
	 *   testPlan?: string,
	 *   reviewerPHIDs?: string[],
	 *   subscriberPHIDs?: string[],
	 *   bug?: string|number,
	 *   projectPHIDs?: string[]
	 * }} fields
	 * @returns {Promise<EditResult>}
	 */
	createRevision(fields) {
		const transactions = /** @type {EditTransaction[]} */ ([
			{ type: 'update', value: fields.diffPHID },
			{ type: 'title', value: fields.title },
		]);
		if (fields.summary !== undefined) {
			transactions.push({ type: 'summary', value: fields.summary });
		}
		if (fields.testPlan !== undefined) {
			transactions.push({ type: 'test-plan', value: fields.testPlan });
		}
		if (fields.reviewerPHIDs && fields.reviewerPHIDs.length > 0) {
			transactions.push({ type: 'reviewers.add', value: fields.reviewerPHIDs });
		}
		if (fields.subscriberPHIDs && fields.subscriberPHIDs.length > 0) {
			transactions.push({ type: 'subscribers.add', value: fields.subscriberPHIDs });
		}
		if (fields.projectPHIDs && fields.projectPHIDs.length > 0) {
			transactions.push({ type: 'projects.add', value: fields.projectPHIDs });
		}
		if (fields.bug !== undefined && fields.bug !== null && fields.bug !== '') {
			transactions.push({ type: 'bugzilla.bug-id', value: String(fields.bug) });
		}
		return this.editRevision({ transactions });
	}

	/**
	 * Update an existing revision with a new diff and/or metadata.
	 *
	 * @param {string|number} revIdOrPHID
	 * @param {{ diffPHID?: string, title?: string, summary?: string, message?: string, bug?: string|number }} fields
	 * @returns {Promise<EditResult>}
	 */
	updateRevision(revIdOrPHID, fields) {
		const transactions = /** @type {EditTransaction[]} */ ([]);
		if (fields.diffPHID !== undefined) {
			transactions.push({ type: 'update', value: fields.diffPHID });
		}
		if (fields.title !== undefined) {
			transactions.push({ type: 'title', value: fields.title });
		}
		if (fields.summary !== undefined) {
			transactions.push({ type: 'summary', value: fields.summary });
		}
		if (fields.bug !== undefined && fields.bug !== null && fields.bug !== '') {
			transactions.push({ type: 'bugzilla.bug-id', value: String(fields.bug) });
		}
		if (fields.message !== undefined) {
			transactions.push({ type: 'comment', value: fields.message });
		}
		return this.editRevision({ objectIdentifier: revIdOrPHID, transactions });
	}

	// ----------------------------------------------------------- resolution helpers

	/**
	 * @param {string[]} phids
	 * @returns {Promise<Map<string, User>>}
	 */
	async resolveUsers(phids) {
		const out = /** @type {Map<string, User>} */ (new Map());
		if (phids.length === 0) {
			return out;
		}
		const iter = paginate(async (after) => {
			/** @type {{ data: User[], cursor: ConduitCursor }} */
			const result = await this.call('user.search', {
				constraints: { phids: Array.from(new Set(phids)) },
				after,
			});
			return result;
		});
		for await (const user of iter) {
			out.set(user.phid, user);
		}
		return out;
	}

	/**
	 * @param {string[]} phids
	 * @returns {Promise<Map<string, Project>>}
	 */
	async resolveProjects(phids) {
		const out = /** @type {Map<string, Project>} */ (new Map());
		if (phids.length === 0) {
			return out;
		}
		const iter = paginate(async (after) => {
			/** @type {{ data: Project[], cursor: ConduitCursor }} */
			const result = await this.call('project.search', {
				constraints: { phids: Array.from(new Set(phids)) },
				after,
			});
			return result;
		});
		for await (const project of iter) {
			out.set(project.phid, project);
		}
		return out;
	}

	/**
	 * Search users by name fragment for autocomplete. `query` matches usernames
	 * and real names case-insensitively. Returns up to `limit` results
	 * (default 8) without paginating.
	 *
	 * @param {{ query: string, limit?: number }} args
	 * @returns {Promise<User[]>}
	 */
	async searchUsers(args) {
		const query = (args.query || '').trim();
		if (query.length === 0) return [];
		const limit = Math.min(Math.max(1, args.limit ?? 8), 50);
		/** @type {{ data: User[], cursor: ConduitCursor }} */
		const result = await this.call('user.search', {
			constraints: { nameLike: query, isDisabled: false },
			limit,
		});
		return result.data || [];
	}

	/**
	 * Search projects by name fragment for autocomplete.
	 *
	 * @param {{ query: string, limit?: number }} args
	 * @returns {Promise<Project[]>}
	 */
	async searchProjects(args) {
		const query = (args.query || '').trim();
		if (query.length === 0) return [];
		const limit = Math.min(Math.max(1, args.limit ?? 8), 50);
		/** @type {{ data: Project[], cursor: ConduitCursor }} */
		const result = await this.call('project.search', {
			constraints: { query, statuses: ['active'] },
			limit,
		});
		return result.data || [];
	}

	/**
	 * Find the projects a user is a direct member of (used to expand
	 * "Needs My Review" so project-tagged reviews show up).
	 *
	 * @param {string} userPHID
	 * @returns {Promise<Project[]>}
	 */
	listProjectsForMember(userPHID) {
		const iter = paginate(async (after) => {
			/** @type {{ data: Project[], cursor: ConduitCursor }} */
			const result = await this.call('project.search', {
				constraints: { members: [userPHID] },
				after,
			});
			return result;
		});
		return collect(iter);
	}

	/**
	 * @param {{ ids?: number[], phids?: string[], callsigns?: string[], shortNames?: string[], vcs?: string[] }} [constraints]
	 * @returns {AsyncIterableIterator<Repository>}
	 */
	searchRepositories(constraints) {
		return paginate(async (after) => {
			/** @type {{ data: Repository[], cursor: ConduitCursor }} */
			const result = await this.call('diffusion.repository.search', {
				constraints: constraints || {},
				after,
			});
			return result;
		});
	}

	/**
	 * Walk the revision dependency graph (parents/children).
	 *
	 * @param {{ sourcePHIDs: string[], types: string[] }} args
	 * @returns {Promise<{ source: string, target: string, type: string }[]>}
	 */
	async searchEdges(args) {
		/** @type {any} */
		const result = await this.call('edge.search', args);
		const out = /** @type {{ source: string, target: string, type: string }[]} */ ([]);
		const data = /** @type {Array<{ sourcePHID: string, destinationPHID: string, edgeType: string }>} */ (
			(result && Array.isArray(result.data)) ? result.data : []
		);
		for (const edge of data) {
			out.push({
				source: edge.sourcePHID,
				target: edge.destinationPHID,
				type: edge.edgeType,
			});
		}
		return out;
	}
}

/**
 * Cross-runtime base64 decoder. Uses Node's Buffer when present, falls back
 * to atob in browsers.
 *
 * @param {string} input
 * @returns {string}
 */
function decodeBase64(input) {
	/** @type {any} */
	const g = globalThis;
	if (g.Buffer) {
		return g.Buffer.from(input, 'base64').toString('utf8');
	}
	if (typeof atob === 'function') {
		return atob(input);
	}
	return input;
}

/**
 * @param {any} raw
 * @returns {import('./types').Changeset}
 */
function normalizeChangeset(raw) {
	const id = typeof raw.id === 'number' ? raw.id : Number(raw.id) || 0;
	const oldPath = raw.oldPath && raw.oldPath.length > 0 ? String(raw.oldPath) : null;
	const currentPath = raw.currentPath ? String(raw.currentPath) : '';
	const type = (typeof raw.type === 'number' ? raw.type : Number(raw.type)) || 2;
	const fileType = (typeof raw.fileType === 'number' ? raw.fileType : Number(raw.fileType)) || 1;
	const oldFileType = (typeof raw.oldFileType === 'number' ? raw.oldFileType : Number(raw.oldFileType)) || 1;
	const addLines = (typeof raw.addLines === 'number' ? raw.addLines : Number(raw.addLines)) || 0;
	const delLines = (typeof raw.delLines === 'number' ? raw.delLines : Number(raw.delLines)) || 0;
	/** @type {Object<string, string>} */
	const metadata = {};
	if (raw.metadata && typeof raw.metadata === 'object') {
		for (const k of Object.keys(raw.metadata)) {
			const v = raw.metadata[k];
			metadata[k] = typeof v === 'string' ? v : String(v);
		}
	}
	const hunks = (raw.hunks || []).map(/** @param {any} h */ (h) => ({
		oldOffset: Number(h.oldOffset) || 0,
		oldLength: Number(h.oldLength) || 0,
		newOffset: Number(h.newOffset) || 0,
		newLength: Number(h.newLength) || 0,
		corpus: typeof h.corpus === 'string' ? h.corpus : '',
	}));
	return {
		id,
		oldPath,
		currentPath,
		awayPaths: Array.isArray(raw.awayPaths) ? raw.awayPaths.map(String) : [],
		type: /** @type {any} */ (type),
		fileType: /** @type {any} */ (fileType),
		oldFileType: /** @type {any} */ (oldFileType),
		addLines,
		delLines,
		metadata,
		hunks,
	};
}

module.exports = { PhabricatorClient };
