import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { EditorState, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { history, undo, redo } from 'prosemirror-history';
import { baseKeymap, toggleMark, wrapIn, setBlockType, chainCommands, exitCode } from 'prosemirror-commands';
import { wrapInList, splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import type { MarkType } from 'prosemirror-model';

import { remarkupSchema } from './remarkupSchema';
import { pmDocToRemarkup } from './remarkupSerialize';
import { request } from './message';

interface Props {
	onChange?: (text: string) => void;
	disabled?: boolean;
	placeholder?: string;
}

const PREVIEW_DEBOUNCE_MS = 400;
const AUTOCOMPLETE_DEBOUNCE_MS = 200;
const AUTOCOMPLETE_MIN_CHARS = 1;

type AutocompleteKind = 'user' | 'project';

interface AutocompleteItem {
	insertText: string;
	primary: string;
	secondary?: string;
}

interface AutocompleteState {
	kind: AutocompleteKind;
	triggerPos: number;
	query: string;
	queryToken: number;
	items: AutocompleteItem[];
	selected: number;
	loading: boolean;
}

interface UserResult { phid: string; fields?: { username?: string; realName?: string } }
interface ProjectResult { phid: string; fields?: { name?: string; slug?: string } }

function mapResults(kind: AutocompleteKind, raw: Array<UserResult | ProjectResult>): AutocompleteItem[] {
	if (kind === 'user') {
		return (raw as UserResult[]).map((u) => {
			const username = u.fields?.username || '';
			const real = u.fields?.realName || '';
			return {
				insertText: '@' + username,
				primary: username,
				secondary: real || undefined,
			};
		}).filter((i) => i.primary.length > 0);
	}
	return (raw as ProjectResult[]).map((p) => {
		const name = p.fields?.name || '';
		const slug = p.fields?.slug || name.toLowerCase().replace(/\s+/g, '_');
		return {
			insertText: '#' + slug,
			primary: name,
			secondary: '#' + slug,
		};
	}).filter((i) => i.primary.length > 0);
}

function detectTrigger(state: EditorState): { kind: AutocompleteKind; triggerPos: number; query: string } | null {
	const sel = state.selection;
	if (!sel.empty) return null;
	const $from = sel.$from;
	const text = $from.parent.textBetween(0, $from.parentOffset, '\n', '￼');
	let i = text.length - 1;
	while (i >= 0) {
		const ch = text[i];
		if (ch === '@' || ch === '#') {
			const before = i === 0 ? '' : text[i - 1];
			if (i !== 0 && !/\s/.test(before)) return null;
			const query = text.slice(i + 1);
			if (!/^[A-Za-z0-9._\-]*$/.test(query)) return null;
			return {
				kind: ch === '@' ? 'user' : 'project',
				triggerPos: $from.start() + i,
				query,
			};
		}
		if (/\s/.test(ch)) return null;
		i--;
	}
	return null;
}

function isMarkActive(state: EditorState, type: MarkType): boolean {
	const { from, $from, to, empty } = state.selection;
	if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
	return state.doc.rangeHasMark(from, to, type);
}

function setHeading(level: number): Command {
	return setBlockType(remarkupSchema.nodes.heading, { level });
}

function clearHeading(): Command {
	return setBlockType(remarkupSchema.nodes.paragraph);
}

function toggleHeading(level: number): Command {
	return (state, dispatch, view) => {
		const block = state.selection.$from.parent;
		if (block.type.name === 'heading' && block.attrs.level === level) {
			return clearHeading()(state, dispatch, view);
		}
		return setHeading(level)(state, dispatch, view);
	};
}

function buildKeymap() {
	const km: Record<string, Command> = {
		'Mod-z': undo,
		'Mod-y': redo,
		'Mod-Shift-z': redo,
		'Mod-b': toggleMark(remarkupSchema.marks.bold),
		'Mod-i': toggleMark(remarkupSchema.marks.italic),
		'Mod-`': toggleMark(remarkupSchema.marks.code),
		'Mod-Shift-c': wrapIn(remarkupSchema.nodes.blockquote),
		'Tab': sinkListItem(remarkupSchema.nodes.list_item),
		'Shift-Tab': liftListItem(remarkupSchema.nodes.list_item),
		'Enter': splitListItem(remarkupSchema.nodes.list_item),
	};
	const ctrlEnter = chainCommands(exitCode, (state, dispatch) => {
		if (!dispatch) return false;
		dispatch(state.tr.replaceSelectionWith(remarkupSchema.nodes.hard_break.create()).scrollIntoView());
		return true;
	});
	km['Mod-Enter'] = ctrlEnter;
	km['Shift-Enter'] = ctrlEnter;
	return km;
}

interface ToolButton {
	label: string;
	title: string;
	command: Command;
	isActive?: (state: EditorState) => boolean;
}

function buildButtons(): ToolButton[] {
	return [
		{
			label: 'B',
			title: 'Bold (⌘B)',
			command: toggleMark(remarkupSchema.marks.bold),
			isActive: (s) => isMarkActive(s, remarkupSchema.marks.bold),
		},
		{
			label: 'I',
			title: 'Italic (⌘I)',
			command: toggleMark(remarkupSchema.marks.italic),
			isActive: (s) => isMarkActive(s, remarkupSchema.marks.italic),
		},
		{
			label: '<>',
			title: 'Inline code (⌘`)',
			command: toggleMark(remarkupSchema.marks.code),
			isActive: (s) => isMarkActive(s, remarkupSchema.marks.code),
		},
		{
			label: 'H',
			title: 'Heading',
			command: toggleHeading(2),
			isActive: (s) => s.selection.$from.parent.type.name === 'heading',
		},
		{
			label: '“”',
			title: 'Quote',
			command: wrapIn(remarkupSchema.nodes.blockquote),
		},
		{
			label: '•',
			title: 'Bulleted list',
			command: wrapInList(remarkupSchema.nodes.bullet_list),
		},
		{
			label: '1.',
			title: 'Numbered list',
			command: wrapInList(remarkupSchema.nodes.ordered_list),
		},
		{
			label: '{ }',
			title: 'Code block',
			command: setBlockType(remarkupSchema.nodes.code_block),
			isActive: (s) => s.selection.$from.parent.type.name === 'code_block',
		},
	];
}

const linkButton = {
	label: '↗',
	title: 'Link (⌘K)',
};

export function RemarkupComposer({ onChange, disabled, placeholder }: Props) {
	const editorRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const [tab, setTab] = useState<'write' | 'preview'>('write');
	const [previewHtml, setPreviewHtml] = useState('');
	const [previewLoading, setPreviewLoading] = useState(false);
	const [, forceRender] = useState(0);
	const previewDebounce = useRef<number | undefined>();
	const lastPreviewedText = useRef<string>('');
	const [autocomplete, setAutocomplete] = useState<AutocompleteState | null>(null);
	const autocompleteRef = useRef<AutocompleteState | null>(null);
	const queryToken = useRef(0);
	const acDebounce = useRef<number | undefined>();

	useEffect(() => {
		autocompleteRef.current = autocomplete;
	}, [autocomplete]);

	const insertAutocomplete = (item: AutocompleteItem) => {
		const view = viewRef.current;
		const ac = autocompleteRef.current;
		if (!view || !ac) return;
		const tr = view.state.tr;
		const from = ac.triggerPos;
		const to = view.state.selection.from;
		tr.insertText(item.insertText + ' ', from, to);
		view.dispatch(tr);
		setAutocomplete(null);
		view.focus();
	};

	useEffect(() => {
		if (!editorRef.current) return;
		const state = EditorState.create({
			schema: remarkupSchema,
			plugins: [history(), keymap(buildKeymap()), keymap(baseKeymap)],
		});
		const view = new EditorView(editorRef.current, {
			state,
			dispatchTransaction: (tr) => {
				const next = view.state.apply(tr);
				view.updateState(next);
				if (tr.docChanged && onChange) {
					onChange(pmDocToRemarkup(next.doc));
				}
				const trigger = detectTrigger(next);
				if (trigger) {
					const prev = autocompleteRef.current;
					if (!prev || prev.kind !== trigger.kind || prev.query !== trigger.query || prev.triggerPos !== trigger.triggerPos) {
						const token = ++queryToken.current;
						setAutocomplete({
							kind: trigger.kind,
							triggerPos: trigger.triggerPos,
							query: trigger.query,
							queryToken: token,
							items: prev && prev.kind === trigger.kind ? prev.items : [],
							selected: 0,
							loading: trigger.query.length >= AUTOCOMPLETE_MIN_CHARS,
						});
					}
				} else if (autocompleteRef.current) {
					setAutocomplete(null);
				}
				forceRender((n) => (n + 1) & 0xffff);
			},
			handleKeyDown: (v, ev) => {
				const ac = autocompleteRef.current;
				if (ac && ac.items.length > 0) {
					if (ev.key === 'ArrowDown') {
						ev.preventDefault();
						setAutocomplete({ ...ac, selected: (ac.selected + 1) % ac.items.length });
						return true;
					}
					if (ev.key === 'ArrowUp') {
						ev.preventDefault();
						setAutocomplete({ ...ac, selected: (ac.selected - 1 + ac.items.length) % ac.items.length });
						return true;
					}
					if (ev.key === 'Enter' || ev.key === 'Tab') {
						ev.preventDefault();
						insertAutocomplete(ac.items[ac.selected]);
						return true;
					}
					if (ev.key === 'Escape') {
						ev.preventDefault();
						setAutocomplete(null);
						return true;
					}
				}
				const isCmdK = (ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k';
				if (isCmdK) {
					ev.preventDefault();
					promptLink(v);
					return true;
				}
				return false;
			},
			attributes: { class: 'remarkup-composer-editor' },
		});
		viewRef.current = view;
		return () => {
			view.destroy();
			viewRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		if (!autocomplete) return;
		const { kind, query, queryToken: token } = autocomplete;
		if (query.length < AUTOCOMPLETE_MIN_CHARS) return;
		if (acDebounce.current) window.clearTimeout(acDebounce.current);
		acDebounce.current = window.setTimeout(async () => {
			try {
				const results = kind === 'user'
					? await request<UserResult[]>('searchUsers', { query })
					: await request<ProjectResult[]>('searchProjects', { query });
				if (token !== queryToken.current) return;
				const items = mapResults(kind, Array.isArray(results) ? results : []);
				setAutocomplete((cur) => (cur && cur.queryToken === token
					? { ...cur, items, selected: 0, loading: false }
					: cur));
			} catch {
				if (token !== queryToken.current) return;
				setAutocomplete((cur) => (cur && cur.queryToken === token
					? { ...cur, items: [], loading: false }
					: cur));
			}
		}, AUTOCOMPLETE_DEBOUNCE_MS);
		return () => {
			if (acDebounce.current) window.clearTimeout(acDebounce.current);
		};
	}, [autocomplete?.queryToken, autocomplete?.query, autocomplete?.kind]);

	const exec = (cmd: Command) => {
		const view = viewRef.current;
		if (!view) return;
		cmd(view.state, (tr) => view.dispatch(tr), view);
		view.focus();
	};

	const switchTab = (next: 'write' | 'preview') => {
		if (next === tab) return;
		setTab(next);
		if (next === 'preview') {
			runPreview();
		}
	};

	const runPreview = () => {
		if (!viewRef.current) return;
		const text = pmDocToRemarkup(viewRef.current.state.doc);
		if (text === lastPreviewedText.current && previewHtml) return;
		lastPreviewedText.current = text;
		if (previewDebounce.current) window.clearTimeout(previewDebounce.current);
		setPreviewLoading(true);
		previewDebounce.current = window.setTimeout(async () => {
			try {
				const html = await request<string>('renderRemarkup', text);
				setPreviewHtml(typeof html === 'string' ? html : '');
			} catch {
				setPreviewHtml('<p class="muted">Preview unavailable.</p>');
			} finally {
				setPreviewLoading(false);
			}
		}, PREVIEW_DEBOUNCE_MS);
	};

	const buttons = buildButtons();
	const editorState = viewRef.current?.state;
	const isEmpty = editorState ? editorState.doc.childCount === 1 && editorState.doc.firstChild?.type.name === 'paragraph' && editorState.doc.firstChild.content.size === 0 : true;

	const editorStyle: CSSProperties = tab === 'write' ? {} : { display: 'none' };

	return (
		<div className={`remarkup-composer${disabled ? ' is-disabled' : ''}`}>
			<div className="remarkup-toolbar">
				{tab === 'write' && buttons.map((b) => {
					const active = editorState && b.isActive ? b.isActive(editorState) : false;
					return (
						<button
							key={b.label}
							type="button"
							className={`tool${active ? ' is-active' : ''}`}
							title={b.title}
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => exec(b.command)}
						>
							{b.label}
						</button>
					);
				})}
				{tab === 'write' && (
					<button
						type="button"
						className="tool"
						title={linkButton.title}
						onMouseDown={(e) => e.preventDefault()}
						onClick={() => viewRef.current && promptLink(viewRef.current)}
					>
						{linkButton.label}
					</button>
				)}
				<button
					type="button"
					className={`tool tool-mode${tab === 'write' ? ' is-active' : ''}`}
					title="Write"
					style={{ marginLeft: 'auto' }}
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => switchTab('write')}
				>
					✎
				</button>
				<button
					type="button"
					className={`tool tool-mode${tab === 'preview' ? ' is-active' : ''}`}
					title="Preview"
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => switchTab('preview')}
				>
					👁
				</button>
			</div>
			<div className="remarkup-composer-body">
				<div ref={editorRef} className="remarkup-editor-host" style={editorStyle}>
					{isEmpty && tab === 'write' && placeholder && (
						<div className="remarkup-placeholder" aria-hidden="true">{placeholder}</div>
					)}
				</div>
				{tab === 'write' && autocomplete && autocomplete.query.length >= AUTOCOMPLETE_MIN_CHARS && (
					<div className="remarkup-autocomplete">
						{autocomplete.loading && autocomplete.items.length === 0 ? (
							<div className="remarkup-autocomplete-empty">Searching…</div>
						) : autocomplete.items.length === 0 ? (
							<div className="remarkup-autocomplete-empty">
								No {autocomplete.kind === 'user' ? 'users' : 'projects'} matching "{autocomplete.query}"
							</div>
						) : (
							<ul role="listbox">
								{autocomplete.items.map((item, i) => (
									<li
										key={item.insertText}
										role="option"
										aria-selected={i === autocomplete.selected}
										className={`remarkup-autocomplete-item${i === autocomplete.selected ? ' is-selected' : ''}`}
										onMouseDown={(e) => {
											e.preventDefault();
											insertAutocomplete(item);
										}}
										onMouseEnter={() => setAutocomplete((cur) => (cur ? { ...cur, selected: i } : cur))}
									>
										<span className="remarkup-autocomplete-primary">{item.primary}</span>
										{item.secondary && <span className="remarkup-autocomplete-secondary">{item.secondary}</span>}
									</li>
								))}
							</ul>
						)}
					</div>
				)}
				{tab === 'preview' && (
					<div className="remarkup-preview">
						{previewLoading ? (
							<p className="muted">Rendering preview…</p>
						) : previewHtml ? (
							<div className="comment-body remarkup" dangerouslySetInnerHTML={{ __html: previewHtml }} />
						) : (
							<p className="muted">Nothing to preview.</p>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

async function promptLink(view: EditorView) {
	const initial = view.state.selection;
	const { from, to, empty } = initial;
	const selectedText = empty ? '' : view.state.doc.textBetween(from, to, ' ');
	const href = await request<string | null>('promptInput', {
		prompt: selectedText ? `Link target for "${selectedText}"` : 'Link target URL',
		value: 'https://',
		placeHolder: 'https://example.com',
	});
	if (!href || typeof href !== 'string') return;
	const linkMark = remarkupSchema.marks.link.create({ href });
	const state = view.state;
	let tr = state.tr;
	if (empty) {
		const display = await request<string | null>('promptInput', {
			prompt: 'Link text',
			value: href,
		}) || href;
		const node = state.schema.text(display, [linkMark]);
		tr = tr.replaceRangeWith(from, to, node);
	} else {
		tr = tr.addMark(from, to, linkMark);
	}
	view.dispatch(tr);
	view.focus();
}

