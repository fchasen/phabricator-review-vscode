import { useEffect, useRef, useState } from 'react';
import { EditorState, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { history, undo, redo } from 'prosemirror-history';
import { baseKeymap, toggleMark, wrapIn, chainCommands, exitCode } from 'prosemirror-commands';
import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';

import { remarkupSchema } from './remarkupSchema';
import { pmDocToRemarkup } from './remarkupSerialize';
import { applyLink, buildToolbarItems, linkToolbarItem } from './composerCommands';
import { request } from './message';

interface Props {
	onChange?: (text: string) => void;
	disabled?: boolean;
	placeholder?: string;
}

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

export function RemarkupComposer({ onChange, disabled, placeholder }: Props) {
	const editorRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const [, forceRender] = useState(0);
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
				const isCmdF = (ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'f';
				if (isCmdF) {
					ev.preventDefault();
					promptSearchfoxPath(v);
					return true;
				}
				return false;
			},
			attributes: {
				class: 'remarkup-composer-editor',
				spellcheck: 'true',
				autocorrect: 'on',
				autocapitalize: 'sentences',
			},
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
		if (!view) {
			console.log('[exec] no view');
			return;
		}
		const result = cmd(view.state, (tr) => view.dispatch(tr), view);
		console.log('[exec] command returned', result);
		view.focus();
	};

	const buttons = buildToolbarItems();
	const editorState = viewRef.current?.state;
	const isEmpty = editorState
		? editorState.doc.childCount === 1
			&& editorState.doc.firstChild?.type.name === 'paragraph'
			&& editorState.doc.firstChild.content.size === 0
		: true;

	return (
		<div className={`remarkup-composer${disabled ? ' is-disabled' : ''}`}>
			<div className="remarkup-toolbar">
				{buttons.map((b) => {
					const active = editorState && b.isActive ? b.isActive(editorState) : false;
					return (
						<button
							key={b.icon}
							type="button"
							className={`tool${active ? ' is-active' : ''}`}
							title={b.title}
							aria-label={b.title}
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => exec(b.command)}
						>
							<i className={`codicon codicon-${b.icon}`} />
						</button>
					);
				})}
				<button
					type="button"
					className="tool"
					title={linkToolbarItem.title}
					aria-label={linkToolbarItem.title}
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => viewRef.current && promptLink(viewRef.current)}
				>
					<i className={`codicon codicon-${linkToolbarItem.icon}`} />
				</button>
				<button
					type="button"
					className="tool tool-trailing"
					title="Insert Searchfox file link (⌘F)"
					aria-label="Insert Searchfox file link"
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => viewRef.current && promptSearchfoxPath(viewRef.current)}
				>
					<i className="codicon codicon-search" />
				</button>
				<button
					type="button"
					className="tool"
					title="Insert Searchfox symbol link"
					aria-label="Insert Searchfox symbol link"
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => viewRef.current && promptSearchfoxSymbol(viewRef.current)}
				>
					<i className="codicon codicon-symbol-method" />
				</button>
			</div>
			<div className="remarkup-composer-body">
				<div ref={editorRef} className="remarkup-editor-host" />
				{isEmpty && placeholder && (
					<div className="remarkup-placeholder" aria-hidden="true">{placeholder}</div>
				)}
				{autocomplete && autocomplete.query.length >= AUTOCOMPLETE_MIN_CHARS && (
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
			</div>
		</div>
	);
}

async function promptLink(view: EditorView) {
	const { from, to, empty } = view.state.selection;
	const selectedText = empty ? '' : view.state.doc.textBetween(from, to, ' ');
	const href = await request<string | null>('promptInput', {
		prompt: selectedText ? `Link target for "${selectedText}"` : 'Link target URL',
		value: 'https://',
		placeHolder: 'https://example.com',
	});
	if (!href || typeof href !== 'string') return;
	const display = empty
		? (await request<string | null>('promptInput', { prompt: 'Link text', value: href })) || href
		: undefined;
	applyLink(href, display)(view.state, (tr) => view.dispatch(tr), view);
	view.focus();
}

async function promptSearchfoxPath(view: EditorView) {
	const result = await request<{ url: string; text: string } | null>('searchfoxPickPath');
	if (!result || typeof result !== 'object' || !result.url) return;
	const { empty } = view.state.selection;
	applyLink(result.url, empty ? result.text : undefined)(view.state, (tr) => view.dispatch(tr), view);
	view.focus();
}

async function promptSearchfoxSymbol(view: EditorView) {
	const result = await request<{ url: string; text: string } | null>('searchfoxPickSymbol');
	if (!result || typeof result !== 'object' || !result.url) return;
	const { empty } = view.state.selection;
	applyLink(result.url, empty ? result.text : undefined)(view.state, (tr) => view.dispatch(tr), view);
	view.focus();
}
