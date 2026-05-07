import { type ReactNode } from 'react';

const ICONS: Record<string, string> = {
	'core:create': 'new-file',
	'core:edit': 'edit',
	'core:comment': 'comment',
	'core:subscribe': 'eye',
	'core:columns': 'project',
	'comment': 'comment',
	'inline': 'comment',
	'differential.inline': 'comment',
	'differential:inline': 'comment',

	'differential.action.accept': 'check',
	'differential.action.reject': 'circle-slash',
	'differential.action.comment': 'comment',
	'differential.action.update': 'git-commit',
	'differential.action.abandon': 'archive',
	'differential.action.reclaim': 'arrow-up',
	'differential.action.reopen': 'arrow-up',
	'differential.action.rethink': 'tools',
	'differential.action.request': 'eye',
	'differential.action.resign': 'reply',
	'differential.action.close': 'pass',
	'differential.action.commit': 'git-commit',

	'accept': 'check',
	'reject': 'circle-slash',
	'request-review': 'eye',
	'resign': 'reply',
	'plan-changes': 'tools',
	'abandon': 'archive',
	'reclaim': 'arrow-up',

	'differential.revision.status': 'info',
	'differential:status': 'info',
	'status': 'info',

	'reviewers.add': 'person-add',
	'reviewers.remove': 'person',
	'reviewers.set': 'person',
	'reviewers.replace': 'person',
	'reviewers.update': 'person',
	'differential.revision.reviewers': 'person',

	'subscribers.add': 'eye',
	'subscribers.remove': 'eye-closed',
	'subscribers.set': 'eye',

	'projects.add': 'tag',
	'projects.remove': 'tag',
	'projects.set': 'tag',

	'title': 'edit',
	'summary': 'book',
	'test-plan': 'beaker',
	'update': 'git-commit',

	'bugzilla.bug-id': 'bug',
	'differential.revision.bugzilla': 'bug',

	'differential.revision.repository': 'repo',
	'space': 'globe',
	'view': 'eye',
	'edit': 'key',

	'harbormaster:buildable': 'rocket',
	'harbormaster.buildable': 'rocket',
	'harbormaster:status': 'rocket',
};

const BUILD_STATUSES: Record<string, { label: string; tone: 'pass' | 'fail' | 'warn' | 'progress' | 'neutral' }> = {
	'0': { label: 'Preparing', tone: 'progress' },
	'1': { label: 'Building', tone: 'progress' },
	'2': { label: 'Passed', tone: 'pass' },
	'3': { label: 'Failed', tone: 'fail' },
	'4': { label: 'Aborted', tone: 'warn' },
	'5': { label: 'Error', tone: 'fail' },
	'6': { label: 'Paused', tone: 'warn' },
	'7': { label: 'Deadlocked', tone: 'fail' },
	'preparing': { label: 'Preparing', tone: 'progress' },
	'building': { label: 'Building', tone: 'progress' },
	'passed': { label: 'Passed', tone: 'pass' },
	'failed': { label: 'Failed', tone: 'fail' },
	'aborted': { label: 'Aborted', tone: 'warn' },
	'error': { label: 'Error', tone: 'fail' },
	'paused': { label: 'Paused', tone: 'warn' },
	'deadlocked': { label: 'Deadlocked', tone: 'fail' },
};

function buildStatus(value: unknown): { label: string; tone: string } {
	const key = value === null || value === undefined ? '' : String(value).toLowerCase();
	return BUILD_STATUSES[key] || { label: key || 'unknown', tone: 'neutral' };
}

export function txIconName(type: string | null | undefined): string {
	if (!type) return 'circle-small';
	return ICONS[type] || 'circle-small';
}

const BUILD_TONE_ICONS: Record<string, string> = {
	pass: 'pass',
	fail: 'error',
	warn: 'warning',
	progress: 'sync',
	neutral: 'rocket',
};

function isBuildableType(type: string | null | undefined): boolean {
	return type === 'harbormaster:buildable' || type === 'harbormaster.buildable' || type === 'harbormaster:status';
}

export function TxIcon({ type, fields }: { type: string | null | undefined; fields?: Record<string, unknown> | null }) {
	let iconName = txIconName(type);
	let toneClass = '';
	if (isBuildableType(type)) {
		const status = buildStatus((fields || {}).new);
		iconName = BUILD_TONE_ICONS[status.tone] || iconName;
		toneClass = ` tx-build-icon-${status.tone}`;
	}
	return <i className={`codicon codicon-${iconName}${toneClass}`} aria-hidden="true" />;
}

interface TxBodyProps {
	type: string;
	fields: Record<string, unknown> | null | undefined;
	nameOf: (phid: string) => string;
}

interface ReviewerOp {
	operation?: string;
	phid?: string;
	oldStatus?: string;
	newStatus?: string;
	isBlocking?: boolean;
}

function isPhid(s: unknown): s is string {
	return typeof s === 'string' && s.startsWith('PHID-');
}

function asString(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	if (typeof v === 'string') return v;
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	return null;
}

function joinNames(phids: string[], nameOf: (phid: string) => string): ReactNode {
	if (phids.length === 0) return null;
	return phids.map((p, i) => (
		<span key={p}>
			{i > 0 && ', '}
			<span className="tx-mention">@{nameOf(p)}</span>
		</span>
	));
}

function trimText(s: string, max = 80): string {
	if (s.length <= max) return s;
	return s.slice(0, max).trimEnd() + '…';
}

function OldNew({ oldVal, newVal }: { oldVal: string; newVal: string }) {
	return (
		<span className="tx-oldnew">
			<span className="tx-old">{trimText(oldVal)}</span>
			<i className="codicon codicon-arrow-right" aria-hidden="true" />
			<span className="tx-new">{trimText(newVal)}</span>
		</span>
	);
}

function partitionReviewerOps(ops: ReviewerOp[]) {
	const added: ReviewerOp[] = [];
	const removed: ReviewerOp[] = [];
	const changed: ReviewerOp[] = [];
	for (const op of ops) {
		const kind = (op.operation || '').toLowerCase();
		if (kind === 'add' || kind === '+') added.push(op);
		else if (kind === 'remove' || kind === '-') removed.push(op);
		else changed.push(op);
	}
	return { added, removed, changed };
}

export function TxBody({ type, fields, nameOf }: TxBodyProps): ReactNode {
	const f = (fields || {}) as Record<string, unknown>;

	switch (type) {
		case 'title': {
			const oldVal = asString(f.old);
			const newVal = asString(f.new);
			if (oldVal === null || newVal === null) return null;
			return <OldNew oldVal={oldVal} newVal={newVal} />;
		}

		case 'bugzilla.bug-id':
		case 'differential.revision.bugzilla': {
			const oldVal = asString(f.old) || '—';
			const newVal = asString(f.new) || '—';
			return <OldNew oldVal={oldVal} newVal={newVal} />;
		}

		case 'differential.revision.status':
		case 'differential:status':
		case 'status': {
			const oldVal = asString(f.old);
			const newVal = asString(f.new);
			if (oldVal === null && newVal === null) return null;
			return <OldNew oldVal={oldVal || '—'} newVal={newVal || '—'} />;
		}

		case 'reviewers.add':
		case 'reviewers.remove':
		case 'reviewers.set':
		case 'reviewers.replace':
		case 'reviewers.update':
		case 'differential.revision.reviewers': {
			const ops = (f.operations as ReviewerOp[]) || [];
			if (ops.length === 0) return null;
			const { added, removed, changed } = partitionReviewerOps(ops);
			const parts: ReactNode[] = [];
			if (added.length > 0) {
				const blocking = added.some((o) => o.isBlocking);
				parts.push(
					<span key="add" className="tx-frag">
						<span className="tx-frag-label">added</span>{' '}
						{joinNames(
							added.filter((o) => isPhid(o.phid)).map((o) => o.phid as string),
							nameOf,
						)}
						{blocking && <span className="tx-badge">blocking</span>}
					</span>,
				);
			}
			if (removed.length > 0) {
				parts.push(
					<span key="remove" className="tx-frag">
						<span className="tx-frag-label">removed</span>{' '}
						{joinNames(
							removed.filter((o) => isPhid(o.phid)).map((o) => o.phid as string),
							nameOf,
						)}
					</span>,
				);
			}
			if (changed.length > 0) {
				parts.push(
					<span key="changed" className="tx-frag">
						<span className="tx-frag-label">updated</span>{' '}
						{joinNames(
							changed.filter((o) => isPhid(o.phid)).map((o) => o.phid as string),
							nameOf,
						)}
					</span>,
				);
			}
			if (parts.length === 0) return null;
			return <span className="tx-frags">{parts}</span>;
		}

		case 'subscribers.add':
		case 'subscribers.remove':
		case 'subscribers.set':
		case 'core:subscribe': {
			const ops = (f.operations as ReviewerOp[]) || [];
			const phids = ops.map((o) => o.phid).filter(isPhid);
			if (phids.length === 0) return null;
			return <span className="tx-frag">{joinNames(phids, nameOf)}</span>;
		}

		case 'projects.add':
		case 'projects.remove':
		case 'projects.set': {
			const ops = (f.operations as ReviewerOp[]) || [];
			const phids = ops.map((o) => o.phid).filter(isPhid);
			if (phids.length === 0) return null;
			return (
				<span className="tx-frag">
					{phids.map((p, i) => (
						<span key={p}>
							{i > 0 && ', '}
							<span className="tx-tag">#{nameOf(p)}</span>
						</span>
					))}
				</span>
			);
		}

		case 'harbormaster:buildable':
		case 'harbormaster.buildable':
		case 'harbormaster:status': {
			const oldVal = buildStatus(f.old);
			const newVal = buildStatus(f.new);
			return (
				<span className="tx-build">
					{oldVal.label && oldVal.label !== newVal.label && (
						<>
							<span className={`tx-build-status tx-build-${oldVal.tone}`}>{oldVal.label}</span>
							<i className="codicon codicon-arrow-right" aria-hidden="true" />
						</>
					)}
					<span className={`tx-build-status tx-build-${newVal.tone}`}>{newVal.label}</span>
				</span>
			);
		}

		case 'core:columns': {
			const boards = (f.boards as Record<string, unknown>) || {};
			const labels: string[] = [];
			for (const board of Object.values(boards)) {
				const b = board as { columns?: Array<{ name?: string }> };
				for (const col of b.columns || []) {
					if (col?.name) labels.push(col.name);
				}
			}
			if (labels.length === 0) return null;
			return <span className="tx-frag muted">→ {labels.join(', ')}</span>;
		}

		default:
			return null;
	}
}
