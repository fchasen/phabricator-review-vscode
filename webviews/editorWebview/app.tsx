import { useEffect, useState } from 'react';
import { ready, subscribe, request } from '../common/message';
import { Markdown } from '../common/markdown';
import { transactionLabel } from '../common/txLabels';

interface OverviewPayload {
	id: number;
	monogram: string;
	uri: string;
	title: string;
	statusName: string;
	statusValue: string;
	authorName: string;
	bug: string | null;
	summary: string;
	testPlan: string;
	reviewers: Array<{ phid: string; displayName: string; isProject: boolean; status: string; isBlocking: boolean }>;
	subscribers: string[];
	files: Array<{ path: string; status: string }>;
	timeline: Array<{
		id: string;
		type: string;
		authorName: string;
		dateCreated: number;
		comments: Array<{ phid: string; content: string }>;
		inline?: {
			diffPHID: string;
			path: string;
			line: number;
			length: number;
			isNewFile: boolean;
			status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied';
		};
	}>;
}

const REVIEWER_STATE_ICON: Record<string, string> = {
	'accepted': '✓',
	'accepted-prior': '✓',
	'rejected': '✗',
	'blocking': '⚠',
	'resigned': '↩',
	'added': '○',
};

export function App() {
	const [payload, setPayload] = useState<OverviewPayload | undefined>();
	const [comment, setComment] = useState('');
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		const dispose = subscribe((message) => {
			if (message?.res?.command === 'overview') {
				setPayload(message.res.payload);
			}
		});
		ready();
		return dispose;
	}, []);

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

	return (
		<div className="overview">
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

			<div className="grid">
				<main className="main-col">
					{payload.summary && (
						<section className="summary">
							<h2>Summary</h2>
							<Markdown source={payload.summary} />
						</section>
					)}

					{payload.testPlan && (
						<section className="test-plan">
							<h2>Test plan</h2>
							<Markdown source={payload.testPlan} />
						</section>
					)}

					<section className="timeline">
						<h2>Timeline</h2>
						<ul>
							{payload.timeline.map((tx) => (
								<li key={tx.id} className={`tx tx-${String(tx.type || 'unknown').replace(/[.:]/g, '-')}`}>
									<header>
										<strong>{tx.authorName}</strong>
										<em>{transactionLabel(tx.type)}</em>
										<time>{new Date(tx.dateCreated * 1000).toLocaleString()}</time>
									</header>
									{tx.inline && (
										<button
											className="inline-link"
											onClick={() => request('revealInlineComment', tx.inline)}
											title="Open the diff at this line"
										>
											{tx.inline.path}:{tx.inline.line}
										</button>
									)}
									{tx.comments.map((c) => (
										<Markdown key={c.phid} source={c.content} />
									))}
								</li>
							))}
						</ul>
					</section>

					<section className="actions">
						<textarea
							value={comment}
							onChange={(e) => setComment(e.target.value)}
							placeholder="Leave a comment…"
							rows={4}
						/>
						<div className="buttons">
							<button disabled={busy} onClick={() => submit('comment')}>
								Comment
							</button>
							<button disabled={busy} onClick={() => submit('accept')}>
								Accept
							</button>
							<button disabled={busy || comment.trim().length === 0} onClick={() => submit('requestChanges')}>
								Request changes
							</button>
						</div>
					</section>
				</main>

				<aside className="sidebar">
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

					<section className="files">
						<h3>Files ({payload.files.length})</h3>
						<ul>
							{payload.files.map((f) => (
								<li key={f.path}>
									<span className={`file-status file-status-${f.status}`}>
										{f.status[0].toUpperCase()}
									</span>
									<span className="file-path">{f.path}</span>
								</li>
							))}
						</ul>
					</section>
				</aside>
			</div>
		</div>
	);
}
