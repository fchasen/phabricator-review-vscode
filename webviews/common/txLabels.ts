/**
 * Phabricator transaction types → user-readable verbs.
 * Unknown types fall back to a humanised version of the type string.
 */
const LABELS: Record<string, string> = {
	'core:create': 'created the revision',
	'core:edit': 'edited the revision',
	'core:comment': 'commented',
	'core:subscribe': 'updated subscribers',
	'core:columns': 'moved on a workboard',
	'comment': 'commented',
	'inline': 'left an inline comment',
	'differential.inline': 'left an inline comment',
	'differential:inline': 'left an inline comment',

	'differential.action.accept': 'accepted',
	'differential.action.reject': 'requested changes',
	'differential.action.comment': 'commented',
	'differential.action.update': 'updated the diff',
	'differential.action.abandon': 'abandoned',
	'differential.action.reclaim': 'reclaimed',
	'differential.action.reopen': 'reopened',
	'differential.action.rethink': 'planned changes',
	'differential.action.request': 'requested review',
	'differential.action.resign': 'resigned as reviewer',
	'differential.action.close': 'closed',
	'differential.action.commit': 'committed the revision',

	'accept': 'accepted',
	'reject': 'requested changes',
	'request-review': 'requested review',
	'resign': 'resigned as reviewer',
	'plan-changes': 'planned changes',
	'abandon': 'abandoned',
	'reclaim': 'reclaimed',

	'differential.revision.status': 'changed the status',
	'differential:status': 'changed the status',
	'status': 'changed the status',

	'reviewers.add': 'added reviewers',
	'reviewers.remove': 'removed reviewers',
	'reviewers.set': 'changed reviewers',
	'reviewers.replace': 'changed reviewers',
	'reviewers.update': 'updated reviewers',
	'differential.revision.reviewers': 'updated reviewers',

	'subscribers.add': 'subscribed',
	'subscribers.remove': 'unsubscribed',
	'subscribers.set': 'updated subscribers',

	'projects.add': 'tagged with projects',
	'projects.remove': 'untagged projects',

	'title': 'changed the title',
	'summary': 'changed the summary',
	'test-plan': 'changed the test plan',
	'update': 'updated the diff',

	'bugzilla.bug-id': 'changed the bug',
	'differential.revision.bugzilla': 'changed the bug',

	'differential.revision.repository': 'changed the repository',
	'space': 'changed the visibility space',
	'view': 'changed view policy',
	'edit': 'changed edit policy',
};

export function transactionLabel(type: string | null | undefined): string {
	if (!type) {
		return 'updated';
	}
	if (LABELS[type]) {
		return LABELS[type];
	}
	// fall back: 'differential.revision.foo-bar' → 'changed foo bar'
	const trimmed = type.replace(/^differential\.revision\.|^differential[.:]|^core:/, '');
	const humanised = trimmed.replace(/[._-]/g, ' ');
	return humanised || 'updated';
}
