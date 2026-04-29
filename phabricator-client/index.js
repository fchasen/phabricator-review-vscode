'use strict';

const { PhabricatorClient } = require('./src/client');
const { ConduitError } = require('./src/errors');
const { isPHID, phidType, PHID_TYPES } = require('./src/phid');

/**
 * @typedef {import('./src/types').ClientOptions} ClientOptions
 * @typedef {import('./src/types').WhoAmI} WhoAmI
 * @typedef {import('./src/types').Revision} Revision
 * @typedef {import('./src/types').Diff} Diff
 * @typedef {import('./src/types').Repository} Repository
 * @typedef {import('./src/types').User} User
 * @typedef {import('./src/types').Project} Project
 * @typedef {import('./src/types').Transaction} Transaction
 * @typedef {import('./src/types').TransactionComment} TransactionComment
 * @typedef {import('./src/types').InlineCommentFields} InlineCommentFields
 * @typedef {import('./src/types').RevisionStatus} RevisionStatus
 * @typedef {import('./src/types').RevisionConstraints} RevisionConstraints
 * @typedef {import('./src/types').RevisionAttachments} RevisionAttachments
 * @typedef {import('./src/types').RevisionReviewer} RevisionReviewer
 * @typedef {import('./src/types').EditTransaction} EditTransaction
 * @typedef {import('./src/types').EditResult} EditResult
 * @typedef {import('./src/types').ConduitCursor} ConduitCursor
 * @typedef {import('./src/types').Changeset} Changeset
 * @typedef {import('./src/types').ChangesetHunk} ChangesetHunk
 * @typedef {import('./src/types').ChangesetType} ChangesetType
 * @typedef {import('./src/types').ChangesetFileType} ChangesetFileType
 * @typedef {import('./src/types').QueriedDiff} QueriedDiff
 */

module.exports = {
	PhabricatorClient,
	ConduitError,
	isPHID,
	phidType,
	PHID_TYPES,
};
