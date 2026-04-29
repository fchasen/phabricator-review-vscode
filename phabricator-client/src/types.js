'use strict';

/**
 * @typedef {Object} ClientOptions
 * @property {string} token
 * @property {string} [baseUrl]
 * @property {typeof fetch} [fetch]
 * @property {(level: 'debug'|'info'|'warn'|'error', msg: string, meta?: object) => void} [logger]
 * @property {string} [userAgent]
 */

/**
 * @typedef {Object} ConduitCursor
 * @property {string|null} after
 * @property {string|null} [before]
 * @property {number|null} [limit]
 * @property {string|null} [order]
 */

/**
 * @template T
 * @typedef {Object} ConduitSearchResult
 * @property {T[]} data
 * @property {Object<string, unknown>} [maps]
 * @property {string|null} [query]
 * @property {ConduitCursor} cursor
 */

/**
 * @typedef {Object} User
 * @property {number} id
 * @property {string} phid
 * @property {{ username: string, realName: string, roles: string[], dateCreated: number, dateModified: number }} fields
 */

/**
 * @typedef {Object} WhoAmI
 * @property {number} userPHIDIDOnlyDoNotUse_id
 * @property {string} phid
 * @property {string} userName
 * @property {string} realName
 * @property {string} primaryEmail
 * @property {string[]} roles
 */

/**
 * @typedef {(
 *   'needs-review'|'needs-revision'|'changes-planned'|
 *   'accepted'|'published'|'abandoned'|'draft'
 * )} RevisionStatus
 */

/**
 * @typedef {Object} RevisionConstraints
 * @property {number[]} [ids]
 * @property {string[]} [phids]
 * @property {string[]} [responsiblePHIDs]
 * @property {string[]} [authorPHIDs]
 * @property {string[]} [reviewerPHIDs]
 * @property {string[]} [subscribers]
 * @property {string[]} [repositoryPHIDs]
 * @property {RevisionStatus[]} [statuses]
 * @property {string} [query]
 * @property {number} [createdStart]
 * @property {number} [createdEnd]
 * @property {number} [modifiedStart]
 * @property {number} [modifiedEnd]
 */

/**
 * @typedef {Object} RevisionAttachments
 * @property {boolean} [reviewers]
 * @property {boolean} [reviewers_extra]
 * @property {boolean} [subscribers]
 * @property {boolean} [projects]
 */

/**
 * @typedef {Object} RevisionReviewer
 * @property {string} reviewerPHID
 * @property {('added'|'accepted'|'rejected'|'blocking'|'resigned'|'accepted-prior')} status
 * @property {boolean} isBlocking
 * @property {string|null} actorPHID
 */

/**
 * @typedef {Object} Revision
 * @property {number} id
 * @property {'DREV'} type
 * @property {string} phid
 * @property {{
 *   title: string,
 *   uri: string,
 *   authorPHID: string,
 *   status: { value: RevisionStatus, name: string, closed: boolean, 'color.ansi': string|null },
 *   repositoryPHID: string|null,
 *   diffPHID: string,
 *   summary: string,
 *   testPlan: string,
 *   isDraft: boolean,
 *   holdAsDraft: boolean,
 *   dateCreated: number,
 *   dateModified: number,
 *   policy: { view: string, edit: string },
 *   bugzilla?: { 'bug-id': string|null }
 * }} fields
 * @property {{
 *   reviewers?: { reviewers: RevisionReviewer[] },
 *   subscribers?: { subscriberPHIDs: string[], subscriberCount: number, viewerIsSubscribed: boolean },
 *   projects?: { projectPHIDs: string[] }
 * }} attachments
 */

/**
 * @typedef {Object} Diff
 * @property {number} id
 * @property {'DIFF'} type
 * @property {string} phid
 * @property {{
 *   revisionPHID: string|null,
 *   authorPHID: string,
 *   repositoryPHID: string|null,
 *   refs: { type: string, identifier: string }[],
 *   dateCreated: number,
 *   dateModified: number,
 *   policy: { view: string }
 * }} fields
 * @property {{
 *   commits?: { commits: { identifier: string, tree: string, parents: string[], author: { name: string, email: string, raw: string, epoch: number }, message: string }[] }
 * }} attachments
 */

/**
 * @typedef {Object} Repository
 * @property {number} id
 * @property {'REPO'} type
 * @property {string} phid
 * @property {{
 *   name: string,
 *   vcs: 'git'|'hg'|'svn',
 *   callsign: string|null,
 *   shortName: string|null,
 *   status: 'active'|'inactive',
 *   isImporting: boolean,
 *   spacePHID: string|null,
 *   dateCreated: number,
 *   dateModified: number,
 *   policy: { view: string, edit: string, push: string }
 * }} fields
 */

/**
 * @typedef {Object} Project
 * @property {number} id
 * @property {'PROJ'} type
 * @property {string} phid
 * @property {{
 *   name: string,
 *   slug: string|null,
 *   icon: { key: string, name: string, icon: string },
 *   color: { key: string, name: string },
 *   parent: object|null,
 *   depth: number,
 *   milestone: number|null,
 *   description: string,
 *   dateCreated: number,
 *   dateModified: number
 * }} fields
 */

/**
 * @typedef {Object} TransactionComment
 * @property {string} phid
 * @property {number} version
 * @property {string} authorPHID
 * @property {number} dateCreated
 * @property {number} dateModified
 * @property {boolean} removed
 * @property {{ raw: string }} content
 */

/**
 * @typedef {Object} Transaction
 * @property {string} id
 * @property {string} phid
 * @property {string} type
 * @property {string} authorPHID
 * @property {string} objectPHID
 * @property {number} dateCreated
 * @property {number} dateModified
 * @property {string|null} groupID
 * @property {object} fields
 * @property {TransactionComment[]} comments
 */

/**
 * @typedef {Object} InlineCommentFields
 * @property {string} diffPHID
 * @property {string} path
 * @property {boolean} isNewFile
 * @property {number} line
 * @property {number} length
 * @property {string|null} replyToCommentPHID
 */

/**
 * @typedef {Object} EditTransaction
 * @property {string} type
 * @property {unknown} value
 */

/**
 * @typedef {Object} EditResult
 * @property {string} object
 * @property {string[]} transactions
 */

/**
 * @typedef {Object} ChangesetHunk
 * @property {number} oldOffset
 * @property {number} oldLength
 * @property {number} newOffset
 * @property {number} newLength
 * @property {string} corpus  Full unified-diff text for the hunk; each line
 *   begins with ' ' (context), '+' (added), '-' (removed), or '\\'
 *   (no-newline marker). Mozilla's instance emits effectively unlimited
 *   context, so the corpus often contains the whole file.
 */

/**
 * Phabricator file-change types from `differential.querydiffs`.
 * @typedef {1|2|3|4|5|6|7|8} ChangesetType
 *   1=add, 2=change, 3=delete, 4=moveAway, 5=copyAway,
 *   6=moveHere, 7=copyHere, 8=multicopy
 */

/**
 * @typedef {1|2|3|4|5|6|7} ChangesetFileType
 *   1=text, 2=image, 3=binary, 4=directory, 5=symlink, 6=deleted, 7=normal
 */

/**
 * @typedef {Object} Changeset
 * @property {number} id
 * @property {string|null} oldPath
 * @property {string} currentPath
 * @property {string[]} awayPaths
 * @property {ChangesetType} type
 * @property {ChangesetFileType} fileType
 * @property {ChangesetFileType} oldFileType
 * @property {number} addLines
 * @property {number} delLines
 * @property {Object<string, string>} metadata
 * @property {ChangesetHunk[]} hunks
 */

/**
 * @typedef {Object} QueriedDiff
 * @property {number} id
 * @property {string|null} phid
 * @property {string|null} revisionPHID
 * @property {string|null} repositoryPHID
 * @property {string|null} sourceControlBaseRevision
 * @property {number|null} dateCreated
 * @property {number|null} dateModified
 * @property {Changeset[]} changes
 */

module.exports = {};
