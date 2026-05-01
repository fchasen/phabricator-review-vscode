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
	label: '🔗',
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
				// Force a re-render so the toolbar's active states refresh.
				forceRender((n) => (n + 1) & 0xffff);
			},
			handleKeyDown: (v, ev) => {
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

	const exec = (cmd: Command) => {
		const view = viewRef.current;
		if (!view) return;
		cmd(view.state, view.dispatch, view);
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
			<div className="remarkup-composer-tabs">
				<button
					type="button"
					className={`tab${tab === 'write' ? ' is-active' : ''}`}
					onClick={() => switchTab('write')}
				>
					Write
				</button>
				<button
					type="button"
					className={`tab${tab === 'preview' ? ' is-active' : ''}`}
					onClick={() => switchTab('preview')}
				>
					Preview
				</button>
				<a
					className="remarkup-help"
					href="#"
					onClick={(e) => {
						e.preventDefault();
						request('openRemarkupHelp');
					}}
				>
					Remarkup help
				</a>
			</div>
			{tab === 'write' && (
				<div className="remarkup-toolbar">
					{buttons.map((b) => {
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
					<button
						type="button"
						className="tool"
						title={linkButton.title}
						onMouseDown={(e) => e.preventDefault()}
						onClick={() => viewRef.current && promptLink(viewRef.current)}
					>
						{linkButton.label}
					</button>
				</div>
			)}
			<div className="remarkup-composer-body">
				<div ref={editorRef} className="remarkup-editor-host" style={editorStyle}>
					{isEmpty && tab === 'write' && placeholder && (
						<div className="remarkup-placeholder" aria-hidden="true">{placeholder}</div>
					)}
				</div>
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

function promptLink(view: EditorView) {
	const { state } = view;
	const { from, to, empty } = state.selection;
	const selectedText = empty ? '' : state.doc.textBetween(from, to, ' ');
	const href = window.prompt(selectedText ? `Link target for "${selectedText}":` : 'Link target URL:', 'https://');
	if (!href) return;
	const linkMark = remarkupSchema.marks.link.create({ href });
	let tr = state.tr;
	if (empty) {
		const display = window.prompt('Link text:', href) || href;
		const node = state.schema.text(display, [linkMark]);
		tr = tr.replaceSelectionWith(node, false);
	} else {
		tr = tr.addMark(from, to, linkMark);
	}
	view.dispatch(tr);
	view.focus();
}

