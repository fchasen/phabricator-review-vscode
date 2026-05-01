import type { Command, EditorState } from 'prosemirror-state';
import type { MarkType, NodeType, Node as PmNode, ResolvedPos } from 'prosemirror-model';
import { setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { liftListItem } from 'prosemirror-schema-list';

import { remarkupSchema } from './remarkupSchema';

export function isMarkActive(state: EditorState, type: MarkType): boolean {
	const { from, $from, to, empty } = state.selection;
	if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
	return state.doc.rangeHasMark(from, to, type);
}

export function isHeadingActive(state: EditorState, level: number): boolean {
	const block = state.selection.$from.parent;
	return block.type === remarkupSchema.nodes.heading && block.attrs.level === level;
}

export function isCodeBlockActive(state: EditorState): boolean {
	return state.selection.$from.parent.type === remarkupSchema.nodes.code_block;
}

export function findListAncestor($pos: ResolvedPos): { depth: number; node: PmNode } | null {
	for (let d = $pos.depth; d > 0; d--) {
		const n = $pos.node(d);
		if (n.type === remarkupSchema.nodes.bullet_list || n.type === remarkupSchema.nodes.ordered_list) {
			return { depth: d, node: n };
		}
	}
	return null;
}

export function isListActive(state: EditorState, listType: NodeType): boolean {
	const a = findListAncestor(state.selection.$from);
	return !!a && a.node.type === listType;
}

export function toggleHeading(level: number): Command {
	return (state, dispatch, view) => {
		if (isHeadingActive(state, level)) {
			return setBlockType(remarkupSchema.nodes.paragraph)(state, dispatch, view);
		}
		return setBlockType(remarkupSchema.nodes.heading, { level })(state, dispatch, view);
	};
}

export function toggleList(listType: NodeType): Command {
	return (state, dispatch) => {
		const { $from, $to } = state.selection;
		const range = $from.blockRange($to);
		if (!range) return false;
		const ancestor = findListAncestor($from);

		if (ancestor && ancestor.node.type === listType) {
			return liftListItem(remarkupSchema.nodes.list_item)(state, dispatch);
		}

		if (!dispatch) return true;

		const items: PmNode[] = [];
		for (let i = range.startIndex; i < range.endIndex; i++) {
			const child = range.parent.child(i);
			const inner = child.type === remarkupSchema.nodes.paragraph
				? child
				: remarkupSchema.nodes.paragraph.create(null, child.content);
			items.push(remarkupSchema.nodes.list_item.create(null, inner));
		}
		const list = listType.create(null, items);
		const tr = state.tr.replaceWith(range.start, range.end, list);
		dispatch(tr.scrollIntoView());
		return true;
	};
}

export function applyLink(href: string, displayIfEmpty?: string): Command {
	return (state, dispatch) => {
		const { from, to, empty } = state.selection;
		if (empty && !displayIfEmpty) return false;
		if (!dispatch) return true;
		const linkMark = remarkupSchema.marks.link.create({ href });
		let tr = state.tr;
		if (empty) {
			const node = state.schema.text(displayIfEmpty!, [linkMark]);
			tr = tr.replaceRangeWith(from, to, node);
		} else {
			tr = tr.addMark(from, to, linkMark);
		}
		dispatch(tr);
		return true;
	};
}

export interface ToolbarItem {
	icon: string;
	label: string;
	title: string;
	command: Command;
	isActive?: (state: EditorState) => boolean;
}

export function buildToolbarItems(): ToolbarItem[] {
	return [
		{
			icon: 'bold',
			label: 'Bold',
			title: 'Bold (⌘B)',
			command: toggleMark(remarkupSchema.marks.bold),
			isActive: (s) => isMarkActive(s, remarkupSchema.marks.bold),
		},
		{
			icon: 'italic',
			label: 'Italic',
			title: 'Italic (⌘I)',
			command: toggleMark(remarkupSchema.marks.italic),
			isActive: (s) => isMarkActive(s, remarkupSchema.marks.italic),
		},
		{
			icon: 'code',
			label: 'Code',
			title: 'Inline code (⌘`)',
			command: toggleMark(remarkupSchema.marks.code),
			isActive: (s) => isMarkActive(s, remarkupSchema.marks.code),
		},
		{
			icon: 'text-size',
			label: 'Heading',
			title: 'Heading',
			command: toggleHeading(2),
			isActive: (s) => isHeadingActive(s, 2),
		},
		{
			icon: 'quote',
			label: 'Quote',
			title: 'Quote',
			command: wrapIn(remarkupSchema.nodes.blockquote),
		},
		{
			icon: 'list-unordered',
			label: 'Bullets',
			title: 'Bulleted list',
			command: toggleList(remarkupSchema.nodes.bullet_list),
			isActive: (s) => isListActive(s, remarkupSchema.nodes.bullet_list),
		},
		{
			icon: 'list-ordered',
			label: 'Numbered',
			title: 'Numbered list',
			command: toggleList(remarkupSchema.nodes.ordered_list),
			isActive: (s) => isListActive(s, remarkupSchema.nodes.ordered_list),
		},
		{
			icon: 'symbol-namespace',
			label: 'Code block',
			title: 'Code block',
			command: setBlockType(remarkupSchema.nodes.code_block),
			isActive: isCodeBlockActive,
		},
	];
}

export const linkToolbarItem = { icon: 'link', label: 'Link', title: 'Link (⌘K)' };
