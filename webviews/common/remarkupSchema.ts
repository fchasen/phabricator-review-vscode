import { Schema } from 'prosemirror-model';
import type { NodeSpec, MarkSpec } from 'prosemirror-model';

const nodes: { [name: string]: NodeSpec } = {
	doc: { content: 'block+' },

	paragraph: {
		content: 'inline*',
		group: 'block',
		parseDOM: [{ tag: 'p' }],
		toDOM: () => ['p', 0],
	},

	heading: {
		attrs: { level: { default: 1 } },
		content: 'inline*',
		group: 'block',
		defining: true,
		parseDOM: [
			{ tag: 'h1', attrs: { level: 1 } },
			{ tag: 'h2', attrs: { level: 2 } },
			{ tag: 'h3', attrs: { level: 3 } },
			{ tag: 'h4', attrs: { level: 4 } },
			{ tag: 'h5', attrs: { level: 5 } },
			{ tag: 'h6', attrs: { level: 6 } },
		],
		toDOM: (node) => [`h${node.attrs.level}`, 0],
	},

	blockquote: {
		content: 'block+',
		group: 'block',
		defining: true,
		parseDOM: [{ tag: 'blockquote' }],
		toDOM: () => ['blockquote', 0],
	},

	code_block: {
		attrs: { lang: { default: '' } },
		content: 'text*',
		group: 'block',
		code: true,
		defining: true,
		marks: '',
		parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
		toDOM: (node) => ['pre', { 'data-lang': node.attrs.lang || null, spellcheck: 'false' }, ['code', 0]],
	},

	bullet_list: {
		content: 'list_item+',
		group: 'block',
		parseDOM: [{ tag: 'ul' }],
		toDOM: () => ['ul', 0],
	},

	ordered_list: {
		attrs: { start: { default: 1 } },
		content: 'list_item+',
		group: 'block',
		parseDOM: [{ tag: 'ol' }],
		toDOM: (node) => (node.attrs.start === 1 ? ['ol', 0] : ['ol', { start: node.attrs.start }, 0]),
	},

	list_item: {
		content: 'paragraph block*',
		defining: true,
		parseDOM: [{ tag: 'li' }],
		toDOM: () => ['li', 0],
	},

	horizontal_rule: {
		group: 'block',
		parseDOM: [{ tag: 'hr' }],
		toDOM: () => ['hr'],
	},

	hard_break: {
		inline: true,
		group: 'inline',
		selectable: false,
		parseDOM: [{ tag: 'br' }],
		toDOM: () => ['br'],
	},

	text: { group: 'inline' },
};

const marks: { [name: string]: MarkSpec } = {
	bold: {
		parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
		toDOM: () => ['strong', 0],
	},
	italic: {
		parseDOM: [{ tag: 'em' }, { tag: 'i' }],
		toDOM: () => ['em', 0],
	},
	code: {
		parseDOM: [{ tag: 'code' }],
		toDOM: () => ['code', { spellcheck: 'false' }, 0],
	},
	link: {
		attrs: { href: { default: '' }, title: { default: null } },
		inclusive: false,
		parseDOM: [{
			tag: 'a[href]',
			getAttrs: (dom) => ({
				href: (dom as HTMLAnchorElement).getAttribute('href') || '',
				title: (dom as HTMLAnchorElement).getAttribute('title'),
			}),
		}],
		toDOM: (mark) => ['a', { href: mark.attrs.href, title: mark.attrs.title || null }, 0],
	},
};

export const remarkupSchema = new Schema({ nodes, marks });

export type RemarkupSchema = typeof remarkupSchema;
