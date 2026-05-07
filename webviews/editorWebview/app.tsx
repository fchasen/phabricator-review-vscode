import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ready, subscribe, request } from '../common/message';
import { Remarkup } from '../common/remarkup';
import { transactionLabel } from '../common/txLabels';
import { TxBody, TxIcon } from '../common/txBody';

const RemarkupComposer = lazy(() =>
	import('../common/remarkupComposer').then((m) => ({ default: m.RemarkupComposer })),
);

type PierreCore = typeof import('@pierre/diffs');
type PierreReact = typeof import('@pierre/diffs/react');
type PierreModule = { core: PierreCore; FileDiff: PierreReact['FileDiff'] };

let pierrePromise: Promise<PierreModule> | null = null;
function loadPierre(): Promise<PierreModule> {
	if (!pierrePromise) {
		pierrePromise = (async () => {
			const [core, react] = await Promise.all([
				import('@pierre/diffs'),
				import('@pierre/diffs/react'),
			]);
			// Preload themes so Pierre's first render produces a populated header
			// instead of an empty container while it lazily fetches them.
			try {
				await core.preloadHighlighter({
					themes: ['pierre-dark', 'pierre-light'],
					langs: [],
				});
			} catch {
				/* highlighter is fine without preload, just slightly delayed */
			}
			return { core, FileDiff: react.FileDiff };
		})();
	}
	return pierrePromise;
}

interface ProjectTag {
	phid: string;
	displayName: string;
}

interface FileInlineComment {
	commentPHID: string;
	line: number;
	length: number;
	isNewFile: boolean;
	isOutdated: boolean;
	isDone: boolean;
	authorName: string;
	authorPHID: string;
	dateCreated: number;
	content: string;
	contentHtml: string;
}

interface FileEntry {
	path: string;
	oldPath: string | null;
	status: string;
	unifiedDiff: string;
	oldContents: string;
	newContents: string;
	isBinary: boolean;
	addLines: number;
	delLines: number;
	inlineComments: FileInlineComment[];
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
	fields: Record<string, unknown>;
	comments: Array<{ phid: string; content: string; contentHtml: string }>;
	inline?: InlineAnchor;
}

interface StackEntry {
	id: number;
	phid: string;
	monogram: string;
	title: string;
	statusValue: string;
	statusName: string;
	uri: string;
}

interface StackInfo {
	parents: StackEntry[];
	children: StackEntry[];
}

interface OverviewPayload {
	id: number;
	monogram: string;
	uri: string;
	title: string;
	statusName: string;
	statusValue: string;
	authorName: string;
	activeDiffPHID: string | null;
	bug: string | null;
	isAuthor: boolean;
	isReviewer: boolean;
	stack: StackInfo | null;
	summary: string;
	summaryHtml: string;
	testPlan: string;
	testPlanHtml: string;
	reviewers: Array<{ phid: string; displayName: string; isProject: boolean; status: string; isBlocking: boolean }>;
	subscribers: string[];
	files: FileEntry[];
	projects: ProjectTag[];
	timeline: TimelineEntry[];
	phidNames: Record<string, string>;
}

const REVIEWER_STATE_ICON: Record<string, string> = {
	'accepted': 'check',
	'accepted-prior': 'check',
	'rejected': 'close',
	'blocking': 'circle-slash',
	'resigned': 'reply',
	'added': 'circle-large-outline',
};

const FILE_STATUS_ICON: Record<string, string> = {
	'added': 'diff-added',
	'removed': 'diff-removed',
	'modified': 'diff-modified',
	'renamed': 'diff-renamed',
	'copied': 'copy',
};

const REVISION_STATUS_ICON: Record<string, { codicon: string; chartColor?: string }> = {
	'needs-review': { codicon: 'git-pull-request', chartColor: 'blue' },
	'needs-revision': { codicon: 'git-pull-request', chartColor: 'red' },
	'changes-planned': { codicon: 'edit', chartColor: 'yellow' },
	'accepted': { codicon: 'pass-filled', chartColor: 'green' },
	'published': { codicon: 'git-merge', chartColor: 'purple' },
	'abandoned': { codicon: 'circle-slash' },
	'draft': { codicon: 'git-pull-request-draft' },
};

interface StackCurrent {
	monogram: string;
	statusValue: string;
	statusName: string;
	title: string;
}

function StackRow({
	entry,
	dir,
	current,
	onOpen,
}: {
	entry: { monogram: string; title: string; statusValue: string; statusName: string };
	dir: 'up' | 'down' | 'self';
	current: boolean;
	onOpen?: () => void;
}) {
	const spec = REVISION_STATUS_ICON[entry.statusValue] || { codicon: 'git-pull-request' };
	const isClosed = entry.statusValue === 'abandoned' || entry.statusValue === 'published';
	const iconStyle = spec.chartColor
		? { color: `var(--vscode-charts-${spec.chartColor})` }
		: undefined;
	const className = `stack-row${current ? ' stack-row-current' : ''}${isClosed ? ' is-closed' : ''}`;
	const arrowGlyph = dir === 'self' ? '│' : null;
	const arrowIcon = dir !== 'self'
		? <i className={`codicon codicon-arrow-${dir}`} />
		: null;
	const inner = (
		<>
			<span className="stack-arrow" aria-hidden="true">
				{arrowGlyph || arrowIcon}
			</span>
			<span className="stack-status" aria-label={entry.statusName} style={iconStyle}>
				<i className={`codicon codicon-${spec.codicon}`} />
			</span>
			<span className="stack-monogram">{entry.monogram}</span>
			<span className="stack-title">{entry.title}</span>
		</>
	);
	if (current) {
		return <div className={className} title={`${entry.monogram}: ${entry.title}`}>{inner}</div>;
	}
	return (
		<button
			type="button"
			className={className}
			onClick={onOpen}
			title={`${entry.monogram}: ${entry.title} (${entry.statusName})`}
		>
			{inner}
		</button>
	);
}

function StackPanel({ stack, current }: { stack: StackInfo; current: StackCurrent }) {
	const open = (id: number) => request('openStackRevision', { id });
	return (
		<section className="stack">
			<h3>Stack</h3>
			<div className="stack-list">
				{stack.parents.map((p) => (
					<StackRow key={p.phid} entry={p} dir="up" current={false} onOpen={() => open(p.id)} />
				))}
				<StackRow
					entry={{ ...current, title: 'this revision' }}
					dir="self"
					current
				/>
				{stack.children.map((c) => (
					<StackRow key={c.phid} entry={c} dir="down" current={false} onOpen={() => open(c.id)} />
				))}
			</div>
		</section>
	);
}

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
						<i className={`codicon codicon-chevron-${collapsed ? 'right' : 'down'}`} />
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
						<i className={`codicon codicon-${done ? 'check' : 'circle-large-outline'}`} />
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

interface ReplyComposerProps {
	replyToCommentPHID: string;
	diffPHID: string;
	path: string;
	line: number;
	length: number;
	isNewFile: boolean;
	onClose: () => void;
}

function ReplyComposer({ replyToCommentPHID, diffPHID, path, line, length, isNewFile, onClose }: ReplyComposerProps) {
	const [text, setText] = useState('');
	const [busy, setBusy] = useState(false);
	const submit = async () => {
		if (text.trim().length === 0 || busy) return;
		setBusy(true);
		try {
			const ok = await request<boolean>('submitInlineReply', {
				replyToCommentPHID,
				diffPHID,
				path,
				line,
				length,
				isNewFile,
				content: text,
			});
			if (ok) {
				setText('');
				onClose();
			}
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="inline-reply-composer">
			<Suspense fallback={<div className="composer-loading">Loading editor…</div>}>
				<RemarkupComposer onChange={setText} disabled={busy} />
			</Suspense>
			<div className="inline-reply-actions">
				<button
					type="button"
					className="action action-secondary"
					disabled={busy || text.trim().length === 0}
					onClick={submit}
				>
					<i className="codicon codicon-comment" />
					<span>Reply</span>
				</button>
				<button
					type="button"
					className="action action-link"
					disabled={busy}
					onClick={onClose}
				>
					<span>Cancel</span>
				</button>
			</div>
		</div>
	);
}

function isCommentLikeTx(tx: TimelineEntry): boolean {
	if (tx.inline) return true;
	return tx.comments && tx.comments.length > 0;
}

type ParsedFileDiff = import('@pierre/diffs').FileDiffMetadata;
type DiffLineAnnotation = import('@pierre/diffs').DiffLineAnnotation<AnnotationMetadata>;
interface AnnotationMetadata {
	comment: FileInlineComment;
	txId: string | null;
	onReply: () => void;
	onShowInActivity: () => void;
}

function renderInlineAnnotation(annotation: DiffLineAnnotation) {
	const { comment: c, txId, onReply, onShowInActivity } = annotation.metadata;
	return (
		<div
			className={`pierre-annotation${c.isOutdated ? ' is-outdated' : ''}${c.isDone ? ' is-done' : ''}`}
		>
			<div className="pierre-annotation-head">
				<Avatar phid={c.authorPHID} name={c.authorName} size={22} />
				<strong>{c.authorName}</strong>
				<time>{new Date(c.dateCreated * 1000).toLocaleString()}</time>
				{c.isOutdated && <span className="badge">Outdated</span>}
				{c.isDone && <span className="badge">Done</span>}
			</div>
			<Remarkup html={c.contentHtml} source={c.content} />
			<div className="pierre-annotation-actions">
				{!c.isOutdated && (
					<button type="button" className="annotation-action" onClick={onReply}>
						<i className="codicon codicon-reply" />
						<span>Reply</span>
					</button>
				)}
				{txId && (
					<button type="button" className="annotation-action" onClick={onShowInActivity}>
						<i className="codicon codicon-history" />
						<span>Show in activity</span>
					</button>
				)}
			</div>
		</div>
	);
}

function buildLineAnnotations(
	comments: FileInlineComment[],
	commentPhidToTxId: Map<string, string>,
	openReply: (txId: string | null) => void,
	onShowInActivity: (txId: string) => void,
): DiffLineAnnotation[] {
	return comments.map((c) => {
		const txId = commentPhidToTxId.get(c.commentPHID) || null;
		return {
			side: c.isNewFile ? 'additions' : 'deletions',
			lineNumber: c.line,
			metadata: {
				comment: c,
				txId,
				onReply: () => openReply(txId),
				onShowInActivity: () => txId && onShowInActivity(txId),
			},
		};
	});
}

interface FileChangeProps {
	file: FileEntry;
	commentPhidToTxId: Map<string, string>;
	openReply: (txId: string | null) => void;
	onShowInActivity: (txId: string) => void;
}

function FileChange({ file, commentPhidToTxId, openReply, onShowInActivity }: FileChangeProps) {
	const [expanded, setExpanded] = useState(false);
	const [pierre, setPierre] = useState<PierreModule | null>(null);
	const [parsed, setParsed] = useState<ParsedFileDiff | null>(null);
	const [parseError, setParseError] = useState<string | null>(null);
	const isParseable = !file.isBinary && file.unifiedDiff.length > 0;

	useEffect(() => {
		if (!isParseable || parsed || parseError) return;
		let cancelled = false;
		loadPierre()
			.then((m) => {
				if (cancelled) return;
				const trimmed = m.core.trimPatchContext(file.unifiedDiff, 10);
				const result = m.core.processFile(trimmed, {
					oldFile: { name: file.oldPath || file.path, contents: file.oldContents },
					newFile: { name: file.path, contents: file.newContents },
				});
				if (!result) {
					setParseError('Could not parse diff.');
					return;
				}
				setPierre(m);
				setParsed(result);
			})
			.catch((err) => {
				if (cancelled) return;
				setParseError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [isParseable, parsed, parseError, file.unifiedDiff, file.oldContents, file.newContents, file.oldPath, file.path]);

	const lineAnnotations = useMemo(
		() => buildLineAnnotations(
			file.inlineComments,
			commentPhidToTxId,
			openReply,
			onShowInActivity,
		),
		[file.inlineComments, commentPhidToTxId, openReply, onShowInActivity],
	);

	const renderHeaderPrefix = useCallback(
		() => (
			<button
				type="button"
				className="pierre-chevron"
				aria-label={expanded ? 'Collapse file' : 'Expand file'}
				aria-expanded={expanded}
				onClick={() => setExpanded((v) => !v)}
			>
				<i className={`codicon codicon-chevron-${expanded ? 'down' : 'right'}`} />
			</button>
		),
		[expanded],
	);

	const openInEditor = useCallback(
		() => request('openFileDiff', { path: file.path, status: file.status }),
		[file.path, file.status],
	);

	const renderHeaderMetadata = useCallback(
		() => (
			<>
				{file.inlineComments.length > 0 && (
					<span className="pierre-comment-badge" title={`${file.inlineComments.length} inline comments`}>
						<i className="codicon codicon-comment" />
						{file.inlineComments.length}
					</span>
				)}
				<button
					type="button"
					className="pierre-open-button"
					title="Open in editor"
					aria-label="Open in editor"
					onClick={openInEditor}
				>
					<i className="codicon codicon-link-external" />
				</button>
			</>
		),
		[file.inlineComments.length, openInEditor],
	);

	if (file.isBinary) {
		const { name } = splitFilePath(file.path);
		return (
			<li className="file-row file-row-static">
				<span className="file-status" aria-label={file.status}>
					<i className={`codicon codicon-${FILE_STATUS_ICON[file.status] || 'diff-modified'}`} />
				</span>
				<span className="file-name">{name}</span>
				<span className="muted">Binary file not shown.</span>
			</li>
		);
	}

	if (parseError) {
		return (
			<li className="file-row file-row-static">
				<span className="file-name">{file.path}</span>
				<span className="muted">Failed to load diff: {parseError}</span>
			</li>
		);
	}

	if (!parsed || !pierre) {
		return (
			<li className="file-row file-row-static">
				<span className="file-name">{file.path}</span>
				<span className="muted">Loading diff…</span>
			</li>
		);
	}

	const FileDiff = pierre.FileDiff;
	return (
		<li className="file-row">
			<FileDiff
				fileDiff={parsed}
				disableWorkerPool
				options={{
					themeType: 'system',
					diffStyle: 'unified',
					preferredHighlighter: 'shiki-js',
					overflow: 'wrap',
					collapsed: !expanded,
				}}
				lineAnnotations={lineAnnotations}
				renderAnnotation={renderInlineAnnotation}
				renderHeaderPrefix={renderHeaderPrefix}
				renderHeaderMetadata={renderHeaderMetadata}
			/>
		</li>
	);
}

function renderTitleWithBugLink(title: string) {
	const match = /^(Bug\s+(\d+))(\b.*)$/i.exec(title);
	if (!match) return title;
	const [, label, id, rest] = match;
	return (
		<>
			<a href={`https://bugzilla.mozilla.org/show_bug.cgi?id=${id}`} target="_blank" rel="noreferrer">
				{label}
			</a>
			{rest}
		</>
	);
}

function EditableTitle({ title, canEdit }: { title: string; canEdit: boolean }) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(title);
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const savedRef = useRef(false);

	useEffect(() => {
		if (!editing) setValue(title);
	}, [title, editing]);

	useEffect(() => {
		if (editing && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [editing]);

	const begin = () => {
		savedRef.current = false;
		setValue(title);
		setEditing(true);
	};
	const cancel = () => {
		savedRef.current = true;
		setEditing(false);
	};
	const save = async () => {
		if (savedRef.current) return;
		const trimmed = value.trim();
		if (trimmed.length === 0 || trimmed === title) {
			cancel();
			return;
		}
		savedRef.current = true;
		setBusy(true);
		try {
			const ok = await request<boolean>('editRevision', { title: trimmed });
			if (ok) setEditing(false);
			else savedRef.current = false;
		} finally {
			setBusy(false);
		}
	};

	if (!editing) {
		return (
			<div className="title-row">
				<h1>{renderTitleWithBugLink(title)}</h1>
				{canEdit && (
					<button
						type="button"
						className="title-edit-button"
						title="Edit title"
						aria-label="Edit title"
						onClick={begin}
					>
						<i className="codicon codicon-edit" />
					</button>
				)}
			</div>
		);
	}

	return (
		<div className="title-row title-row-editing">
			<input
				ref={inputRef}
				type="text"
				className="title-edit-input"
				value={value}
				disabled={busy}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						void save();
					} else if (e.key === 'Escape') {
						e.preventDefault();
						cancel();
					}
				}}
				onBlur={() => void save()}
			/>
		</div>
	);
}

function EditableMarkupSection({
	field,
	title,
	sectionClass,
	value,
	html,
	canEdit,
	emptyButtonLabel,
	emptyMessage,
	editTitle,
}: {
	field: 'summary' | 'testPlan';
	title: string;
	sectionClass: string;
	value: string;
	html: string;
	canEdit: boolean;
	emptyButtonLabel: string;
	emptyMessage: string;
	editTitle: string;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(value);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!editing) setDraft(value);
	}, [value, editing]);

	const begin = () => {
		setDraft(value);
		setEditing(true);
	};
	const cancel = () => setEditing(false);
	const save = async () => {
		if (draft === value) {
			cancel();
			return;
		}
		setBusy(true);
		try {
			const ok = await request<boolean>('editRevision', { [field]: draft });
			if (ok) setEditing(false);
		} finally {
			setBusy(false);
		}
	};

	if (!value && !canEdit) return null;

	return (
		<section className={sectionClass}>
			<div className="section-head">
				<h2>{title}</h2>
				{canEdit && !editing && (
					<button
						type="button"
						className={`section-edit-button${value ? '' : ' is-empty'}`}
						title={value ? editTitle : emptyButtonLabel}
						aria-label={value ? editTitle : emptyButtonLabel}
						onClick={begin}
					>
						<i className={`codicon codicon-${value ? 'edit' : 'add'}`} />
					</button>
				)}
			</div>
			{editing ? (
				<>
					<Suspense fallback={<div className="composer-loading">Loading editor…</div>}>
						<RemarkupComposer initialValue={value} onChange={setDraft} disabled={busy} escapePlainText={false} />
					</Suspense>
					<div className="section-edit-actions">
						<button
							type="button"
							className="action action-secondary"
							disabled={busy || draft === value}
							onClick={save}
						>
							<span>Save</span>
						</button>
						<button
							type="button"
							className="action action-link"
							disabled={busy}
							onClick={cancel}
						>
							<span>Cancel</span>
						</button>
					</div>
				</>
			) : value ? (
				<Remarkup html={html} source={value} />
			) : (
				<p className="section-empty muted">{emptyMessage}</p>
			)}
		</section>
	);
}

export function App() {
	const [payload, setPayload] = useState<OverviewPayload | undefined>();
	const [comment, setComment] = useState('');
	const [composerKey, setComposerKey] = useState(0);
	const [busy, setBusy] = useState(false);
	const [commentsOnly, setCommentsOnly] = useState(true);
	const [activeReplyTxId, setActiveReplyTxId] = useState<string | null>(null);

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

	const commentPhidToTxId = useMemo(() => {
		const map = new Map<string, string>();
		for (const tx of payload?.timeline || []) {
			for (const c of tx.comments) {
				map.set(c.phid, tx.id);
			}
		}
		return map;
	}, [payload]);

	const nameOf = useCallback(
		(phid: string) => payload?.phidNames?.[phid] || phid,
		[payload],
	);

	const openReply = useCallback((txId: string | null) => {
		if (!txId) return;
		setActiveReplyTxId(txId);
		requestAnimationFrame(() => {
			const node = document.getElementById(`tx-${txId}`);
			if (node) {
				node.scrollIntoView({ behavior: 'smooth', block: 'center' });
				node.classList.add('tx-flash');
				setTimeout(() => node.classList.remove('tx-flash'), 1200);
			}
		});
	}, []);

	const handleShowInActivity = useCallback((txId: string) => {
		const node = document.getElementById(`tx-${txId}`);
		if (node) {
			node.scrollIntoView({ behavior: 'smooth', block: 'center' });
			node.classList.add('tx-flash');
			setTimeout(() => node.classList.remove('tx-flash'), 1200);
		}
	}, []);

	const closeReply = useCallback(() => setActiveReplyTxId(null), []);

	if (!payload) {
		return <div className="loading">Loading…</div>;
	}

	const submit = async (verb: 'comment' | 'accept' | 'requestChanges') => {
		setBusy(true);
		try {
			await request(verb, comment);
			setComment('');
			setComposerKey((k) => k + 1);
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
						<EditableTitle title={payload.title} canEdit={payload.isAuthor} />
						<div className="status">
							<span className={`badge status-${payload.statusValue}`}>{payload.statusName}</span>
							<span className="monogram">
								<a href={payload.uri} target="_blank" rel="noreferrer">
									{payload.monogram}
								</a>
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
					<EditableMarkupSection
						field="summary"
						title="Summary"
						sectionClass="summary"
						value={payload.summary}
						html={payload.summaryHtml}
						canEdit={payload.isAuthor}
						emptyButtonLabel="Add summary"
						emptyMessage="No summary yet."
						editTitle="Edit summary"
					/>
					<EditableMarkupSection
						field="testPlan"
						title="Test plan"
						sectionClass="test-plan"
						value={payload.testPlan}
						html={payload.testPlanHtml}
						canEdit={payload.isAuthor}
						emptyButtonLabel="Add test plan"
						emptyMessage="No test plan yet."
						editTitle="Edit test plan"
					/>

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
									const inline = tx.inline;
									const headComment = tx.comments.find((c) => c.phid);
									const canReplyHere = !!(inline && !inline.isOutdated && headComment && payload.activeDiffPHID);
									const isReplying = activeReplyTxId === tx.id;
									return (
										<li
											key={tx.id}
											id={`tx-${tx.id}`}
											className={`tx tx-${String(tx.type || 'unknown').replace(/[.:]/g, '-')} ${isComment ? 'tx-card' : 'tx-event'}`}
										>
											<header>
												{isComment ? (
													<Avatar phid={tx.authorPHID} name={tx.authorName} size={28} />
												) : (
													<span className="tx-icon" aria-hidden="true">
														<TxIcon type={tx.type} fields={tx.fields} />
													</span>
												)}
												<strong>{tx.authorName}</strong>
												<em>{transactionLabel(tx.type)}</em>
												{!isComment && (
													<TxBody type={tx.type} fields={tx.fields} nameOf={nameOf} />
												)}
												<time>{new Date(tx.dateCreated * 1000).toLocaleString()}</time>
												{canReplyHere && !isReplying && (
													<button
														type="button"
														className="tx-reply-button"
														onClick={() => openReply(tx.id)}
													>
														<i className="codicon codicon-reply" />
														<span>Reply</span>
													</button>
												)}
											</header>
											{inline && <InlineSnippet inline={inline} canEdit={payload.isAuthor} />}
											{tx.comments.map((c) => (
												<Remarkup key={c.phid} html={c.contentHtml} source={c.content} />
											))}
											{canReplyHere && isReplying && headComment && inline && (
												<ReplyComposer
													replyToCommentPHID={headComment.phid}
													diffPHID={payload.activeDiffPHID!}
													path={inline.path}
													line={inline.line}
													length={inline.length}
													isNewFile={inline.isNewFile}
													onClose={closeReply}
												/>
											)}
										</li>
									);
								})}
							</ul>
						)}
					</section>

					<section className="composer">
						<h2>Comment</h2>
						<Suspense fallback={<div className="composer-loading">Loading editor…</div>}>
							<RemarkupComposer key={composerKey} onChange={setComment} disabled={busy} />
						</Suspense>
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

					<section className="files-main">
						<h2>Files ({payload.files.length})</h2>
						{payload.files.length === 0 ? (
							<p className="muted">No file changes.</p>
						) : (
							<ul>
								{payload.files.map((f) => (
									<FileChange
										key={f.path}
										file={f}
										commentPhidToTxId={commentPhidToTxId}
										openReply={openReply}
										onShowInActivity={handleShowInActivity}
									/>
								))}
							</ul>
						)}
					</section>
				</main>

				<aside className="sidebar">
					<div className="external-links">
						<button
							className="open-in-browser"
							onClick={() => request('openInBrowser')}
							title={`Open ${payload.monogram} on Phabricator`}
						>
							<i className="codicon codicon-link-external" />
							<span>Open in Phabricator</span>
						</button>
						<button
							className="open-in-browser"
							onClick={() => request('openLando')}
							title={`Open ${payload.monogram} in Lando`}
						>
							<span className="codicon-link">↗</span>
							<span>View in Lando</span>
						</button>
					</div>

					<section className="actions">
						<h3>Review</h3>
						{!payload.isAuthor && (
							<>
								<button
									className="action action-primary action-accept"
									disabled={busy}
									onClick={() => submit('accept')}
									title="Accept this revision (publishes any draft inline comments)"
								>
									<span className="action-icon"><i className="codicon codicon-check" /></span>
									<span>Accept</span>
								</button>
								<button
									className="action action-warn"
									disabled={busy}
									onClick={() => submit('requestChanges')}
									title="Block on changes"
								>
									<span className="action-icon"><i className="codicon codicon-warning" /></span>
									<span>Request changes</span>
								</button>
							</>
						)}

						<div className="actions-destructive">
							{payload.isAuthor && (
								<button
									className="action action-destructive"
									disabled={busy}
									onClick={() => submitDestructive('abandon')}
									title="Mark this revision as abandoned (you can reclaim later)"
								>
									<span className="action-icon"><i className="codicon codicon-close" /></span>
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
									<span className="action-icon"><i className="codicon codicon-arrow-swap" /></span>
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
									<span className="action-icon"><i className="codicon codicon-discard" /></span>
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
											<i className={`codicon codicon-${REVIEWER_STATE_ICON[r.status] || 'circle'}`} />
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
							<button className="link-button" onClick={editProjects} title="Add a project tag">
								Add
							</button>
						</div>
						{payload.projects.length === 0 ? (
							<p className="muted">No tags</p>
						) : (
							<ul className="tags">
								{payload.projects.map((p) => (
									<li key={p.phid} className="tag" title={p.displayName}>#{p.displayName}</li>
								))}
							</ul>
						)}
					</section>

					{payload.stack && (payload.stack.parents.length > 0 || payload.stack.children.length > 0) && (
						<StackPanel
							stack={payload.stack}
							current={{
								monogram: payload.monogram,
								statusValue: payload.statusValue,
								statusName: payload.statusName,
								title: payload.title,
							}}
						/>
					)}

				</aside>
			</div>
		</div>
	);
}
