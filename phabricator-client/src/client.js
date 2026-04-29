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
	 * @param {string} diffPHID
	 * @returns {Promise<string>}
	 */
	getRawDiff(diffPHID) {
		return this.call('differential.getrawdiff', { diffID: diffPHID });
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
	 * Post an inline comment on a diff. Pairs the inline transaction with a
	 * `comment` transaction so Phabricator publishes it (otherwise it stays
	 * a draft).
	 *
	 * @param {string|number} revIdOrPHID
	 * @param {{
	 *   diffPHID: string,
	 *   path: string,
	 *   line: number,
	 *   length?: number,
	 *   isNewFile: boolean,
	 *   content: string,
	 *   replyToCommentPHID?: string,
	 *   submitMessage?: string
	 * }} inline
	 * @returns {Promise<EditResult>}
	 */
	inlineComment(revIdOrPHID, inline) {
		const inlineValue = {
			diffPHID: inline.diffPHID,
			path: inline.path,
			line: inline.line,
			length: inline.length || 0,
			isNewFile: inline.isNewFile,
			content: inline.content,
			replyToCommentPHID: inline.replyToCommentPHID,
		};
		return this.editRevision({
			objectIdentifier: revIdOrPHID,
			transactions: [
				{ type: 'inline', value: inlineValue },
				{ type: 'comment', value: inline.submitMessage || '' },
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

module.exports = { PhabricatorClient };
