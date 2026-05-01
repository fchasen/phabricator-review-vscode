'use strict';

const { PhabricatorClient } = require('./client');
const { ConduitError } = require('./errors');
const { isPHID, phidType, PHID_TYPES } = require('./phid');

/**
 * @typedef {import('./types').ClientOptions} ClientOptions
 * @typedef {import('./types').WhoAmI} WhoAmI
 * @typedef {import('./types').Revision} Revision
 * @typedef {import('./types').Diff} Diff
 * @typedef {import('./types').Repository} Repository
 * @typedef {import('./types').User} User
 * @typedef {import('./types').Project} Project
 * @typedef {import('./types').Transaction} Transaction
 * @typedef {import('./types').TransactionComment} TransactionComment
 * @typedef {import('./types').InlineCommentFields} InlineCommentFields
 * @typedef {import('./types').RevisionStatus} RevisionStatus
 * @typedef {import('./types').RevisionConstraints} RevisionConstraints
 * @typedef {import('./types').RevisionAttachments} RevisionAttachments
 * @typedef {import('./types').RevisionReviewer} RevisionReviewer
 * @typedef {import('./types').EditTransaction} EditTransaction
 * @typedef {import('./types').EditResult} EditResult
 * @typedef {import('./types').ConduitCursor} ConduitCursor
 * @typedef {import('./types').Changeset} Changeset
 * @typedef {import('./types').ChangesetHunk} ChangesetHunk
 * @typedef {import('./types').ChangesetType} ChangesetType
 * @typedef {import('./types').ChangesetFileType} ChangesetFileType
 * @typedef {import('./types').QueriedDiff} QueriedDiff
 */

module.exports = {
	PhabricatorClient,
	ConduitError,
	isPHID,
	phidType,
	PHID_TYPES,
};
