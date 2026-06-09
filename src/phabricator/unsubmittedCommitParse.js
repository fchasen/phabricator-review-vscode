'use strict';

/**
 * Pure helpers for the Unsubmitted sidebar. Kept in JS (with JSDoc) so the
 * node test runner can require them without a TS compile step.
 */

const DIFFERENTIAL_TRAILER_RE = /^Differential Revision:\s+https?:\/\/\S+?\/D(\d+)\/?\s*$/im;
const BUG_SUBJECT_RE = /^Bug\s+\d+/;

/**
 * @param {string} commitMessage
 * @returns {number | undefined}
 */
function extractRevisionId(commitMessage) {
	const m = DIFFERENTIAL_TRAILER_RE.exec(commitMessage);
	return m ? Number(m[1]) : undefined;
}

/**
 * @param {string} subject
 * @returns {boolean}
 */
function isBugSubject(subject) {
	return BUG_SUBJECT_RE.test(subject);
}

/**
 * @param {string | undefined} branch
 * @param {string} headSha
 * @returns {string}
 */
function deriveSubtitle(branch, headSha) {
	return branch || headSha.slice(0, 7);
}

module.exports = {
	DIFFERENTIAL_TRAILER_RE,
	BUG_SUBJECT_RE,
	extractRevisionId,
	isBugSubject,
	deriveSubtitle,
};
