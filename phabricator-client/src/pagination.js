'use strict';

/**
 * @template T
 * @typedef {(cursor: string|null) => Promise<{ data: T[], cursor: import('./types').ConduitCursor }>} PageFetcher
 */

/**
 * Wraps a cursor-paged Conduit search method as an AsyncIterable.
 *
 * @template T
 * @param {PageFetcher<T>} fetchPage
 * @returns {AsyncIterableIterator<T>}
 */
function paginate(fetchPage) {
	let cursor = /** @type {string|null} */ (null);
	let buffer = /** @type {T[]} */ ([]);
	let exhausted = false;

	const iterator = {
		[Symbol.asyncIterator]() {
			return iterator;
		},
		async next() {
			while (buffer.length === 0 && !exhausted) {
				const page = await fetchPage(cursor);
				buffer = page.data.slice();
				if (page.cursor && page.cursor.after) {
					cursor = page.cursor.after;
				} else {
					exhausted = true;
				}
			}
			if (buffer.length > 0) {
				return { value: /** @type {T} */ (buffer.shift()), done: false };
			}
			return { value: undefined, done: true };
		},
	};

	return /** @type {AsyncIterableIterator<T>} */ (iterator);
}

/**
 * Drain an AsyncIterable into an array. Honors `limit` if provided.
 *
 * @template T
 * @param {AsyncIterable<T>} iter
 * @param {number} [limit]
 * @returns {Promise<T[]>}
 */
async function collect(iter, limit) {
	const out = /** @type {T[]} */ ([]);
	for await (const item of iter) {
		out.push(item);
		if (limit !== undefined && out.length >= limit) {
			break;
		}
	}
	return out;
}

module.exports = { paginate, collect };
