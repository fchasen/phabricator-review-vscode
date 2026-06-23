'use strict';

/**
 * Revision-id parsing ported from fxy's parse_revision. Kept in JS (with JSDoc)
 * so the node test runner can require it without a TS compile step.
 */

/**
 * Parse a revision argument into its numeric id. Accepts a number, a
 * D-prefixed monogram (`D123456`, `d123`), or bare digits. Throws on anything
 * else.
 *
 * @param {number | string} input
 * @returns {number}
 */
function parseRevisionNumber(input) {
	if (typeof input === 'number') {
		if (Number.isInteger(input) && input > 0) {
			return input;
		}
		throw new Error(`Invalid revision '${input}': expected a positive integer`);
	}
	const trimmed = String(input == null ? '' : input).trim();
	if (!trimmed) {
		throw new Error('Revision is required');
	}
	const digits = trimmed.replace(/^[Dd]/, '');
	if (!/^\d+$/.test(digits)) {
		throw new Error(
			`Invalid revision '${input}': expected a D-prefixed number (e.g. D123456) or digits`,
		);
	}
	return Number(digits);
}

module.exports = { parseRevisionNumber };
