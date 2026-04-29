import { useEffect, useState } from 'react';
import { ready, subscribe, request } from '../common/message';

interface OverviewPayload {
	id: number;
	monogram: string;
	uri: string;
	title: string;
	statusName: string;
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
	}>;
}

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
			<header>
				<h1>
					<a href={payload.uri} target="_blank" rel="noreferrer">
						{payload.monogram}
					</a>
					: {payload.title}
				</h1>
				<div className="status">
					<span className={`badge status-${payload.statusName.toLowerCase().replace(/\s+/g, '-')}`}>
						{payload.statusName}
					</span>
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

			<section className="reviewers">
				<h2>Reviewers</h2>
				{payload.reviewers.length === 0 ? (
					<p>None</p>
				) : (
					<ul>
						{payload.reviewers.map((r) => (
							<li key={r.phid}>
								<span className={`reviewer-${r.status}`}>
									{r.isProject ? '#' : ''}
									{r.displayName}
								</span>
								<span className="reviewer-status">{r.status}</span>
								{r.isBlocking && <span className="badge badge-blocking">blocking</span>}
							</li>
						))}
					</ul>
				)}
			</section>

			{payload.summary && (
				<section className="summary">
					<h2>Summary</h2>
					<pre>{payload.summary}</pre>
				</section>
			)}

			{payload.testPlan && (
				<section className="test-plan">
					<h2>Test plan</h2>
					<pre>{payload.testPlan}</pre>
				</section>
			)}

			<section className="files">
				<h2>Files</h2>
				<ul>
					{payload.files.map((f) => (
						<li key={f.path}>
							<span className={`file-status file-status-${f.status}`}>{f.status[0].toUpperCase()}</span>
							{f.path}
						</li>
					))}
				</ul>
			</section>

			<section className="timeline">
				<h2>Timeline</h2>
				<ul>
					{payload.timeline.map((tx) => (
						<li key={tx.id} className={`tx tx-${tx.type}`}>
							<header>
								<strong>{tx.authorName}</strong>
								<time>{new Date(tx.dateCreated * 1000).toLocaleString()}</time>
								<em>{tx.type}</em>
							</header>
							{tx.comments.map((c) => (
								<pre key={c.phid}>{c.content}</pre>
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
		</div>
	);
}
