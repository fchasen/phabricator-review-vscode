'use strict';

const PHID_TYPES = Object.freeze({
	REVISION: 'DREV',
	DIFF: 'DIFF',
	USER: 'USER',
	REPO: 'REPO',
	PROJECT: 'PROJ',
	BUILD_TARGET: 'HMBT',
	BUILD_PLAN: 'HMCP',
	XACT_DREV: 'XACT',
	FILE: 'FILE',
});

const PHID_RE = /^PHID-([A-Z]+)-[A-Za-z0-9]+$/;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isPHID(value) {
	return typeof value === 'string' && PHID_RE.test(value);
}

/**
 * @param {string} phid
 * @returns {string|null}
 */
function phidType(phid) {
	const match = PHID_RE.exec(phid);
	return match ? match[1] : null;
}

module.exports = { isPHID, phidType, PHID_TYPES };
