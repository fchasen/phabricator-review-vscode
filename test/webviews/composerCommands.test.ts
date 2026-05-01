import test from 'node:test';
import assert from 'node:assert/strict';

import { EditorState, TextSelection, type Command, type Transaction } from 'prosemirror-state';
import { toggleMark, wrapIn, setBlockType } from 'prosemirror-commands';
import type { Node as PmNode } from 'prosemirror-model';

import { remarkupSchema } from '../../webviews/common/remarkupSchema';
import {
	applyLink,
	buildToolbarItems,
	isCodeBlockActive,
	isHeadingActive,
	isListActive,
	isMarkActive,
	toggleHeading,
	toggleList,
} from '../../webviews/common/composerCommands';
import { pmDocToRemarkup } from '../../webviews/common/remarkupSerialize';

function paragraph(text?: string): PmNode {
	const content = text ? [remarkupSchema.text(text)] : [];
	return remarkupSchema.nodes.paragraph.create(null, content);
}

function listItem(text: string): PmNode {
	return remarkupSchema.nodes.list_item.create(null, paragraph(text));
}

function docOf(nodes: PmNode[]): PmNode {
	return remarkupSchema.nodes.doc.create(null, nodes);
}

function makeState(doc: PmNode, selectionAt: 'start' | 'end' = 'end'): EditorState {
	let state = EditorState.create({ schema: remarkupSchema, doc });
	const sel = selectionAt === 'end'
		? TextSelection.atEnd(state.doc)
		: TextSelection.atStart(state.doc);
	state = state.apply(state.tr.setSelection(sel));
	return state;
}

function selectRange(state: EditorState, from: number, to: number): EditorState {
	const sel = TextSelection.create(state.doc, from, to);
	return state.apply(state.tr.setSelection(sel));
}

function runCommand(state: EditorState, cmd: Command): { ok: boolean; next: EditorState } {
	let captured: Transaction | null = null;
	const ok = cmd(state, (tr) => { captured = tr; });
	const next = captured ? state.apply(captured) : state;
	return { ok, next };
}

function topNode(doc: PmNode): PmNode | null {
	return doc.childCount === 0 ? null : doc.firstChild;
}

// ---------------------------------------------------------------- list toggle

test('toggleList wraps an empty paragraph in a bullet list', () => {
	const state = makeState(docOf([paragraph()]));
	const { ok, next } = runCommand(state, toggleList(remarkupSchema.nodes.bullet_list));

	assert.equal(ok, true);
	const top = topNode(next.doc);
	assert.equal(top!.type.name, 'bullet_list');
	assert.equal(top!.firstChild!.type.name, 'list_item');
});

test('toggleList wraps a paragraph with text in a bullet list', () => {
	const state = makeState(docOf([paragraph('hello world')]));
	const { ok, next } = runCommand(state, toggleList(remarkupSchema.nodes.bullet_list));

	assert.equal(ok, true);
	assert.equal(topNode(next.doc)!.firstChild!.textContent, 'hello world');
	assert.equal(pmDocToRemarkup(next.doc), '- hello world');
});

test('toggleList on an existing bullet item lifts it back to a paragraph', () => {
	const list = remarkupSchema.nodes.bullet_list.create(null, [listItem('one')]);
	const state = makeState(docOf([list]));
	const { ok, next } = runCommand(state, toggleList(remarkupSchema.nodes.bullet_list));

	assert.equal(ok, true);
	assert.equal(topNode(next.doc)!.type.name, 'paragraph');
	assert.equal(topNode(next.doc)!.textContent, 'one');
});

test('toggleList wraps a paragraph in an ordered list', () => {
	const state = makeState(docOf([paragraph('first')]));
	const { ok, next } = runCommand(state, toggleList(remarkupSchema.nodes.ordered_list));

	assert.equal(ok, true);
	assert.equal(topNode(next.doc)!.type.name, 'ordered_list');
	assert.equal(pmDocToRemarkup(next.doc), '1. first');
});

// ---------------------------------------------------------------- mark toggles

test('bold mark wraps the selected range and serializes as **text**', () => {
	let state = makeState(docOf([paragraph('hello world')]));
	state = selectRange(state, 1, 6);

	const { ok, next } = runCommand(state, toggleMark(remarkupSchema.marks.bold));
	assert.equal(ok, true);
	assert.equal(pmDocToRemarkup(next.doc), '**hello** world');
});

test('italic mark wraps the selected range and serializes as //text//', () => {
	let state = makeState(docOf([paragraph('hello world')]));
	state = selectRange(state, 1, 6);

	const { ok, next } = runCommand(state, toggleMark(remarkupSchema.marks.italic));
	assert.equal(ok, true);
	assert.equal(pmDocToRemarkup(next.doc), '//hello// world');
});

test('inline code mark wraps the selected range and serializes as `text`', () => {
	let state = makeState(docOf([paragraph('hello world')]));
	state = selectRange(state, 1, 6);

	const { ok, next } = runCommand(state, toggleMark(remarkupSchema.marks.code));
	assert.equal(ok, true);
	assert.equal(pmDocToRemarkup(next.doc), '`hello` world');
});

test('isMarkActive reflects whether the selection has a mark', () => {
	let state = makeState(docOf([paragraph('hello world')]));
	state = selectRange(state, 1, 6);
	assert.equal(isMarkActive(state, remarkupSchema.marks.bold), false);

	const { next } = runCommand(state, toggleMark(remarkupSchema.marks.bold));
	const inside = selectRange(next, 2, 5);
	assert.equal(isMarkActive(inside, remarkupSchema.marks.bold), true);
});

// ---------------------------------------------------------------- heading

test('toggleHeading promotes a paragraph to a heading at the requested level', () => {
	const state = makeState(docOf([paragraph('Title')]));
	const { ok, next } = runCommand(state, toggleHeading(2));

	assert.equal(ok, true);
	assert.equal(topNode(next.doc)!.type.name, 'heading');
	assert.equal(topNode(next.doc)!.attrs.level, 2);
	assert.equal(pmDocToRemarkup(next.doc), '## Title');
});

test('toggleHeading at the same level toggles back to a paragraph', () => {
	const heading = remarkupSchema.nodes.heading.create({ level: 2 }, [remarkupSchema.text('Title')]);
	const state = makeState(docOf([heading]));
	const { ok, next } = runCommand(state, toggleHeading(2));

	assert.equal(ok, true);
	assert.equal(topNode(next.doc)!.type.name, 'paragraph');
	assert.equal(pmDocToRemarkup(next.doc), 'Title');
});

test('isHeadingActive returns true only at the matching level', () => {
	const heading = remarkupSchema.nodes.heading.create({ level: 2 }, [remarkupSchema.text('Title')]);
	const state = makeState(docOf([heading]));
	assert.equal(isHeadingActive(state, 2), true);
	assert.equal(isHeadingActive(state, 3), false);
});

// ---------------------------------------------------------------- blockquote

test('wrapIn(blockquote) wraps the current paragraph', () => {
	const state = makeState(docOf([paragraph('quote me')]));
	const { ok, next } = runCommand(state, wrapIn(remarkupSchema.nodes.blockquote));

	assert.equal(ok, true);
	assert.equal(topNode(next.doc)!.type.name, 'blockquote');
	assert.equal(pmDocToRemarkup(next.doc), '> quote me');
});

// ---------------------------------------------------------------- code block

test('setBlockType(code_block) converts a paragraph into a code block', () => {
	const state = makeState(docOf([paragraph('let x = 1;')]));
	const { ok, next } = runCommand(state, setBlockType(remarkupSchema.nodes.code_block));

	assert.equal(ok, true);
	assert.equal(topNode(next.doc)!.type.name, 'code_block');
	assert.equal(topNode(next.doc)!.textContent, 'let x = 1;');
});

test('isCodeBlockActive is true inside a code block, false otherwise', () => {
	const cb = remarkupSchema.nodes.code_block.create(null, [remarkupSchema.text('x')]);
	assert.equal(isCodeBlockActive(makeState(docOf([cb]))), true);
	assert.equal(isCodeBlockActive(makeState(docOf([paragraph('x')]))), false);
});

// ---------------------------------------------------------------- list isActive

test('isListActive distinguishes bullet vs ordered ancestors', () => {
	const bullet = remarkupSchema.nodes.bullet_list.create(null, [listItem('a')]);
	const ordered = remarkupSchema.nodes.ordered_list.create(null, [listItem('a')]);

	const inBullet = makeState(docOf([bullet]));
	const inOrdered = makeState(docOf([ordered]));
	const inPara = makeState(docOf([paragraph('a')]));

	assert.equal(isListActive(inBullet, remarkupSchema.nodes.bullet_list), true);
	assert.equal(isListActive(inBullet, remarkupSchema.nodes.ordered_list), false);
	assert.equal(isListActive(inOrdered, remarkupSchema.nodes.ordered_list), true);
	assert.equal(isListActive(inPara, remarkupSchema.nodes.bullet_list), false);
});

// ---------------------------------------------------------------- link

test('applyLink adds a link mark over a non-empty selection', () => {
	let state = makeState(docOf([paragraph('hello world')]));
	state = selectRange(state, 1, 6);

	const { ok, next } = runCommand(state, applyLink('https://example.com'));
	assert.equal(ok, true);
	assert.equal(pmDocToRemarkup(next.doc), '[[ https://example.com | hello ]] world');
});

test('applyLink with an empty selection inserts the display text and link', () => {
	const state = makeState(docOf([paragraph('')]));

	const { ok, next } = runCommand(state, applyLink('https://example.com', 'click here'));
	assert.equal(ok, true);
	assert.equal(pmDocToRemarkup(next.doc), '[[ https://example.com | click here ]]');
});

test('applyLink with empty selection and no display returns false (nothing to mark)', () => {
	const state = makeState(docOf([paragraph('')]));

	const { ok, next } = runCommand(state, applyLink('https://example.com'));
	assert.equal(ok, false);
	assert.equal(pmDocToRemarkup(next.doc), '');
});

// ---------------------------------------------------------------- toolbar shape

test('buildToolbarItems exposes the expected eight buttons', () => {
	const items = buildToolbarItems();
	const icons = items.map((i) => i.icon);
	assert.deepEqual(icons, [
		'bold',
		'italic',
		'code',
		'text-size',
		'quote',
		'list-unordered',
		'list-ordered',
		'symbol-namespace',
	]);
	for (const item of items) {
		assert.equal(typeof item.command, 'function', `${item.icon} should have a command`);
		assert.equal(typeof item.title, 'string');
		assert.ok(item.label && item.label.length > 0, `${item.icon} should have a non-empty label`);
	}
});

test('buildToolbarItems items report isActive correctly inside a heading', () => {
	const heading = remarkupSchema.nodes.heading.create({ level: 2 }, [remarkupSchema.text('h')]);
	const state = makeState(docOf([heading]));
	const items = buildToolbarItems();

	const headingItem = items.find((i) => i.label === 'Heading')!;
	const bulletItem = items.find((i) => i.label === 'Bullets')!;
	assert.equal(headingItem.isActive!(state), true);
	assert.equal(bulletItem.isActive!(state), false);
});
