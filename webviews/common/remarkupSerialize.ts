import type { Node, Mark } from 'prosemirror-model';

interface State {
	out: string;
	prefix: string;
	listStack: Array<{ kind: 'bullet' | 'ordered'; index: number }>;
	escapePlainText: boolean;
}

interface SerializeOptions {
	escapePlainText?: boolean;
}

function withPrefix(state: State, prefix: string, fn: () => void): void {
	const prev = state.prefix;
	state.prefix = prev + prefix;
	fn();
	state.prefix = prev;
}

function emitBlock(state: State, body: string): void {
	const lines = body.split('\n');
	for (let i = 0; i < lines.length; i++) {
		state.out += state.prefix + lines[i];
		if (i < lines.length - 1) state.out += '\n';
	}
}

function escapeText(text: string): string {
	return text.replace(/([*_`~[\]\\])/g, '\\$1');
}

function inlineToRemarkup(state: State, node: Node): string {
	if (node.isText) {
		const raw = node.text || '';
		const escaped = state.escapePlainText ? escapeText(raw) : raw;
		return wrapWithMarks(escaped, node.marks);
	}
	if (node.type.name === 'hard_break') {
		return '\n';
	}
	return '';
}

function wrapWithMarks(text: string, marks: readonly Mark[]): string {
	let out = text;
	const ordered = [...marks].sort((a, b) => markOrder(a) - markOrder(b));
	for (const mark of ordered) {
		out = wrapOneMark(out, mark);
	}
	return out;
}

function markOrder(mark: Mark): number {
	switch (mark.type.name) {
		case 'code': return 0;
		case 'link': return 1;
		case 'italic': return 2;
		case 'bold': return 3;
		case 'strike': return 4;
		default: return 99;
	}
}

function wrapOneMark(text: string, mark: Mark): string {
	switch (mark.type.name) {
		case 'bold': return `**${text}**`;
		case 'italic': return `//${text}//`;
		case 'code': return `\`${text}\``;
		case 'strike': return `~~${text}~~`;
		case 'link': {
			const href = mark.attrs.href || '';
			return `[[ ${href} | ${text} ]]`;
		}
		default: return text;
	}
}

function inlineChildren(state: State, node: Node): string {
	let out = '';
	node.forEach((child) => {
		out += inlineToRemarkup(state, child);
	});
	return out;
}

function blockToRemarkup(state: State, node: Node, isFirstSibling: boolean): void {
	if (!isFirstSibling) state.out += '\n\n';

	switch (node.type.name) {
		case 'paragraph': {
			emitBlock(state, inlineChildren(state, node));
			break;
		}
		case 'heading': {
			const level = Math.max(1, Math.min(6, node.attrs.level || 1));
			emitBlock(state, '#'.repeat(level) + ' ' + inlineChildren(state, node));
			break;
		}
		case 'blockquote': {
			withPrefix(state, '> ', () => {
				let first = true;
				node.forEach((child) => {
					blockToRemarkup(state, child, first);
					first = false;
				});
			});
			break;
		}
		case 'code_block': {
			const lang = node.attrs.lang || '';
			const fence = '```' + (lang ? lang : '');
			emitBlock(state, fence + '\n' + (node.textContent || '') + '\n```');
			break;
		}
		case 'bullet_list': {
			state.listStack.push({ kind: 'bullet', index: 1 });
			let first = true;
			node.forEach((item) => {
				blockToRemarkup(state, item, first);
				first = false;
			});
			state.listStack.pop();
			break;
		}
		case 'ordered_list': {
			state.listStack.push({ kind: 'ordered', index: node.attrs.start || 1 });
			let first = true;
			node.forEach((item) => {
				blockToRemarkup(state, item, first);
				first = false;
			});
			state.listStack.pop();
			break;
		}
		case 'list_item': {
			const top = state.listStack[state.listStack.length - 1];
			const marker = top?.kind === 'ordered' ? `${top.index}. ` : '- ';
			if (top?.kind === 'ordered') top.index++;
			const indent = ' '.repeat(marker.length);
			let first = true;
			const wrap: State = {
				out: '',
				prefix: '',
				listStack: state.listStack,
				escapePlainText: state.escapePlainText,
			};
			node.forEach((child) => {
				blockToRemarkup(wrap, child, first);
				first = false;
			});
			const bodyOut = wrap.out;
			const lines = bodyOut.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (i === 0) {
					state.out += state.prefix + marker + line;
				} else {
					state.out += '\n' + state.prefix + (line ? indent + line : '');
				}
			}
			break;
		}
		case 'horizontal_rule': {
			emitBlock(state, '---');
			break;
		}
		default: {
			emitBlock(state, inlineChildren(state, node));
			break;
		}
	}
}

/**
 * Serialize a ProseMirror document to Remarkup source text.
 *
 * Emits Remarkup-flavored syntax: `**bold**`, `//italic//`, `[[ url | name ]]`
 * for links. Falls through to standard Markdown-ish forms for headers, lists,
 * blockquotes, fenced code, and HRs (Phabricator's renderer accepts those
 * forms identically).
 */
export function pmDocToRemarkup(doc: Node, options: SerializeOptions = {}): string {
	const state: State = {
		out: '',
		prefix: '',
		listStack: [],
		escapePlainText: options.escapePlainText !== false,
	};
	let first = true;
	doc.forEach((child) => {
		blockToRemarkup(state, child, first);
		first = false;
	});
	return state.out.replace(/\n+$/, '');
}
