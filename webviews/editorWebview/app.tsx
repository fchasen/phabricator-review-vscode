import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { ready, subscribe, request } from '../common/message';
import { Remarkup } from '../common/remarkup';
import { RemarkupComposer } from '../common/remarkupComposer';
import { transactionLabel } from '../common/txLabels';

interface ProjectTag {
	phid: string;
	displayName: string;
}

interface SnippetLine {
	type: 'context' | 'add' | 'remove';
	oldLine: number | null;
	newLine: number | null;
	text: string;
}

interface InlineAnchor {
	diffPHID: string;
	path: string;
	line: number;
	length: number;
	isNewFile: boolean;
	status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied';
	isOutdated: boolean;
	isDone: boolean;
	commentPHID: string | null;
	snippet: SnippetLine[];
}

interface TimelineEntry {
	id: string;
	type: string;
	authorPHID: string;
	authorName: string;
	dateCreated: number;
	comments: Array<{ phid: string; content: string; contentHtml: string }>;
	inline?: InlineAnchor;
}

interface OverviewPayload {
	id: number;
	monogram: string;
	uri: string;
	title: string;
	statusName: string;
	statusValue: string;
	authorName: string;
	bug: string | null;
	isAuthor: boolean;
	isReviewer: boolean;
	summary: string;
	summaryHtml: string;
	testPlan: string;
	testPlanHtml: string;
	reviewers: Array<{ phid: string; displayName: string; isProject: boolean; status: string; isBlocking: boolean }>;
	subscribers: string[];
	files: Array<{ path: string; status: string }>;
	projects: ProjectTag[];
	timeline: TimelineEntry[];
}

const REVIEWER_STATE_ICON: Record<string, string> = {
	'accepted': '✓',
	'accepted-prior': '✓',
	'rejected': '✗',
	'blocking': '⛔',
	'resigned': '↩',
	'added': '○',
};

const AVATAR_PALETTE = [
	'#3b82f6', '#8b5cf6', '#ec4899', '#f97316',
	'#10b981', '#14b8a6', '#0ea5e9', '#6366f1',
	'#a855f7', '#f43f5e', '#84cc16', '#06b6d4',
];

function avatarColor(seed: string): string {
	let hash = 0;
	for (let i = 0; i < seed.length; i++) {
		hash = (hash * 31 + seed.charCodeAt(i)) | 0;
	}
	return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

function avatarInitials(name: string): string {
	const trimmed = (name || '').trim();
	if (!trimmed) return '?';
	const parts = trimmed.split(/[\s._-]+/).filter(Boolean);
	if (parts.length === 0) return trimmed.slice(0, 2).toUpperCase();
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
	return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function Avatar({ phid, name, size = 24 }: { phid: string; name: string; size?: number }) {
	const style = {
		width: size,
		height: size,
		fontSize: Math.max(9, Math.round(size * 0.42)),
		background: avatarColor(phid || name),
	};
	return (
		<span className="avatar" style={style} aria-hidden="true" title={name}>
			{avatarInitials(name)}
		</span>
	);
}

function basename(path: string): string {
	const idx = path.lastIndexOf('/');
	return idx === -1 ? path : path.slice(idx + 1);
}

function InlineSnippet({ inline, canEdit }: { inline: InlineAnchor; canEdit: boolean }) {
	const [collapsed, setCollapsed] = useState(false);
	const [done, setDone] = useState(inline.isDone);
	const [pending, setPending] = useState(false);
	useEffect(() => {
		setDone(inline.isDone);
	}, [inline.isDone]);
	const open = () => request('revealInlineComment', inline);
	const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			open();
		}
	};
	const toggleDone = async () => {
		if (!inline.commentPHID || pending) return;
		const next = !done;
		setDone(next);
		setPending(true);
		try {
			const ok = await request<boolean>('markInlineDone', {
				commentPHID: inline.commentPHID,
				done: next,
			});
			if (!ok) setDone(!next);
		} catch {
			setDone(!next);
		} finally {
			setPending(false);
		}
	};
	const hasSnippet = inline.snippet.length > 0;
	const hasComment = !!inline.commentPHID;
	return (
		<div className={`inline-snippet${done ? ' inline-snippet-done' : ''}`}>
			<div className="inline-snippet-head">
				{hasSnippet && (
					<button
						type="button"
						className="inline-snippet-toggle"
						aria-label={collapsed ? 'Expand snippet' : 'Collapse snippet'}
						onClick={() => setCollapsed((v) => !v)}
					>
						{collapsed ? '▸' : '▾'}
					</button>
				)}
				<button
					type="button"
					className="inline-snippet-path"
					onClick={open}
					title={`${inline.path}:${inline.line}`}
				>
					{basename(inline.path)}
				</button>
				{inline.isOutdated && <span className="inline-snippet-badge">Outdated</span>}
				{hasComment && canEdit && (
					<label className="inline-snippet-done-toggle" title={done ? 'Mark as not done' : 'Mark as done'}>
						<input
							type="checkbox"
							checked={done}
							disabled={pending}
							onChange={toggleDone}
						/>
						<span>Done</span>
					</label>
				)}
				{hasComment && !canEdit && (
					<span
						className={`inline-snippet-done-icon${done ? ' is-done' : ''}`}
						title={done ? 'Marked done' : 'Not done'}
						aria-label={done ? 'Marked done' : 'Not done'}
					>
						{done ? '✓' : '○'}
					</span>
				)}
			</div>
			{hasSnippet && !collapsed && (
				<div
					className="inline-snippet-body"
					role="button"
					tabIndex={0}
					onClick={open}
					onKeyDown={onKey}
					title="Open the diff at this line"
				>
					<table>
						<tbody>
							{inline.snippet.map((ln, i) => (
								<tr key={i} className={`snippet-row snippet-${ln.type}`}>
									<td className="snippet-num snippet-num-old">{ln.oldLine ?? ''}</td>
									<td className="snippet-num snippet-num-new">{ln.newLine ?? ''}</td>
									<td className="snippet-sign">
										{ln.type === 'add' ? '+' : ln.type === 'remove' ? '-' : ' '}
									</td>
									<td className="snippet-code">{ln.text}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

function splitFilePath(path: string): { dir: string; name: string } {
	const idx = path.lastIndexOf('/');
	if (idx === -1) return { dir: '', name: path };
	return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
}

function isCommentLikeTx(tx: TimelineEntry): boolean {
	if (tx.inline) return true;
	return tx.comments && tx.comments.length > 0;
}

export function App() {
	const [payload, setPayload] = useState<OverviewPayload | undefined>();
	const [comment, setComment] = useState('');
	const [busy, setBusy] = useState(false);
	const [commentsOnly, setCommentsOnly] = useState(true);

	useEffect(() => {
		const dispose = subscribe((message) => {
			if (message?.res?.command === 'overview') {
				setPayload(message.res.payload);
			}
		});
		ready();
		return dispose;
	}, []);

	const visibleTimeline = useMemo(() => {
		if (!payload) return [];
		return commentsOnly ? payload.timeline.filter(isCommentLikeTx) : payload.timeline;
	}, [payload, commentsOnly]);

	if (!payload) {
		return <div className="loading">Loading…</div>;
	}

	const submit = async (verb: 'comment' | 'accept' | 'requestChanges') => {
		setBusy(true);
		try {
			await request(verb, comment);
			setComment('');
		} finally {
			setBusy(false);
		}
	};

	const submitDestructive = async (verb: 'commandeer' | 'resign' | 'abandon') => {
		setBusy(true);
		try {
			const ok = await request<boolean>(verb, comment);
			if (ok) {
				setComment('');
			}
		} finally {
			setBusy(false);
		}
	};

	const editProjects = () => {
		request('editProjects');
	};

	return (
		<div className="overview">
			<div className="grid">
				<main className="main-col">
					<header className="overview-header">
						<h1>
							<a href={payload.uri} target="_blank" rel="noreferrer">
								{payload.monogram}
							</a>
							: {payload.title}
						</h1>
						<div className="status">
							<span className={`badge status-${payload.statusValue}`}>{payload.statusName}</span>
							<span className="author">by {payload.authorName}</span>
							{payload.bug && (
								<span className="bug">
									<a
										href={`https://bugzilla.mozilla.org/show_bug.cgi?id=${payload.bug}`}
										target="_blank"
										rel="noreferrer"
									>
										Bug {payload.bug}
									</a>
								</span>
							)}
						</div>
					</header>
					{payload.summary && (
						<section className="summary">
							<h2>Summary</h2>
							<Remarkup html={payload.summaryHtml} source={payload.summary} />
						</section>
					)}

					{payload.testPlan && (
						<section className="test-plan">
							<h2>Test plan</h2>
							<Remarkup html={payload.testPlanHtml} source={payload.testPlan} />
						</section>
					)}

					<section className="timeline">
						<div className="section-head">
							<h2>Activity</h2>
							<label className="toggle">
								<input
									type="checkbox"
									checked={commentsOnly}
									onChange={(e) => setCommentsOnly(e.target.checked)}
								/>
								<span>Comments only</span>
							</label>
						</div>
						{visibleTimeline.length === 0 ? (
							<p className="muted">{commentsOnly ? 'No comments yet.' : 'No activity.'}</p>
						) : (
							<ul>
								{visibleTimeline.map((tx) => {
									const isComment = isCommentLikeTx(tx);
									return (
										<li key={tx.id} className={`tx tx-${String(tx.type || 'unknown').replace(/[.:]/g, '-')}`}>
											<header>
												{isComment && <Avatar phid={tx.authorPHID} name={tx.authorName} size={28} />}
												<strong>{tx.authorName}</strong>
												<em>{transactionLabel(tx.type)}</em>
												<time>{new Date(tx.dateCreated * 1000).toLocaleString()}</time>
											</header>
											{tx.inline && <InlineSnippet inline={tx.inline} canEdit={payload.isAuthor} />}
											{tx.comments.map((c) => (
												<Remarkup key={c.phid} html={c.contentHtml} source={c.content} />
											))}
										</li>
									);
								})}
							</ul>
						)}
					</section>

					<section className="composer">
						<h2>Reply</h2>
						<RemarkupComposer onChange={setComment} disabled={busy} />
						<div className="composer-actions">
							<button
								className="action action-secondary"
								disabled={busy || comment.trim().length === 0}
								onClick={() => submit('comment')}
								title="Post a comment without changing review state"
							>
								<i className="codicon codicon-comment" />
								<span>Comment</span>
							</button>
						</div>
					</section>
				</main>

				<aside className="sidebar">
					<button
						className="open-in-browser"
						onClick={() => request('openInBrowser')}
						title={`Open ${payload.monogram} on Phabricator`}
					>
						<span className="codicon-link">↗</span>
						<span>Open in browser</span>
					</button>

					<section className="actions">
						<h3>Review</h3>
						<button
							className="action action-primary action-accept"
							disabled={busy}
							onClick={() => submit('accept')}
							title="Accept this revision (publishes any draft inline comments)"
						>
							<span className="action-icon">✓</span>
							<span>Accept</span>
						</button>
						<button
							className="action action-warn"
							disabled={busy || comment.trim().length === 0}
							onClick={() => submit('requestChanges')}
							title="Block on changes (requires a comment)"
						>
							<span className="action-icon">!</span>
							<span>Request changes</span>
						</button>

						<div className="actions-destructive">
							{payload.isAuthor && (
								<button
									className="action action-destructive"
									disabled={busy}
									onClick={() => submitDestructive('abandon')}
									title="Mark this revision as abandoned (you can reclaim later)"
								>
									<span className="action-icon">✕</span>
									<span>Abandon…</span>
								</button>
							)}
							{!payload.isAuthor && (
								<button
									className="action action-destructive"
									disabled={busy}
									onClick={() => submitDestructive('commandeer')}
									title="Take ownership of this revision from its current author"
								>
									<span className="action-icon">⇄</span>
									<span>Commandeer…</span>
								</button>
							)}
							{!payload.isAuthor && payload.isReviewer && (
								<button
									className="action action-destructive"
									disabled={busy}
									onClick={() => submitDestructive('resign')}
									title="Remove yourself as a reviewer on this revision"
								>
									<span className="action-icon">↩</span>
									<span>Resign…</span>
								</button>
							)}
						</div>
					</section>

					<section className="reviewers">
						<h3>Reviewers</h3>
						{payload.reviewers.length === 0 ? (
							<p className="muted">None</p>
						) : (
							<ul>
								{payload.reviewers.map((r) => (
									<li key={r.phid} className={`reviewer reviewer-state-${r.status}`}>
										<span className="reviewer-state" aria-label={r.status}>
											{REVIEWER_STATE_ICON[r.status] || '•'}
										</span>
										<span className="reviewer-name">
											{r.isProject ? '#' : ''}
											{r.displayName}
										</span>
										{r.isBlocking && <span className="badge badge-blocking">blocking</span>}
									</li>
								))}
							</ul>
						)}
					</section>

					<section className="projects">
						<div className="section-head">
							<h3>Projects ({payload.projects.length})</h3>
							<button className="link-button" onClick={editProjects} title="Add or remove project tags">
								Edit
							</button>
						</div>
						{payload.projects.length === 0 ? (
							<p className="muted">No tags</p>
						) : (
							<ul className="tags">
								{payload.projects.map((p) => (
									<li key={p.phid} className="tag">#{p.displayName}</li>
								))}
							</ul>
						)}
					</section>

					<section className="files">
						<h3>Files ({payload.files.length})</h3>
						<ul>
							{payload.files.map((f) => {
								const { dir, name } = splitFilePath(f.path);
								return (
									<li key={f.path} className={`file-row file-status-${f.status}`} title={f.path}>
										<span className="file-status" aria-label={f.status}>
											{f.status[0].toUpperCase()}
										</span>
										<span className="file-name">{name}</span>
										{dir && <span className="file-dir">{dir}</span>}
									</li>
								);
							})}
						</ul>
					</section>
				</aside>
			</div>
		</div>
	);
}
