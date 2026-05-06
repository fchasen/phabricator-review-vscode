import {
	InputRule,
	inputRules,
	textblockTypeInputRule,
	wrappingInputRule,
} from 'prosemirror-inputrules';
import type { MarkType, Schema } from 'prosemirror-model';
import type { Plugin } from 'prosemirror-state';

function markInputRule(regex: RegExp, markType: MarkType): InputRule {
	return new InputRule(regex, (state, match, start, end) => {
		const captured = match[1];
		if (!captured) return null;
		const tr = state.tr;
		const matchStart = start + match[0].indexOf(captured);
		const matchEnd = matchStart + captured.length;
		if (matchEnd < end) tr.delete(matchEnd, end);
		if (matchStart > start) tr.delete(start, matchStart);
		tr.addMark(start, start + captured.length, markType.create());
		tr.removeStoredMark(markType);
		return tr;
	});
}

export function buildInputRulesPlugin(schema: Schema): Plugin {
	const rules: InputRule[] = [
		textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading, (match) => ({
			level: match[1].length,
		})),
		textblockTypeInputRule(/^```$/, schema.nodes.code_block),
		wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
		wrappingInputRule(/^\s*[-+*]\s$/, schema.nodes.bullet_list),
		wrappingInputRule(
			/^(\d+)\.\s$/,
			schema.nodes.ordered_list,
			(match) => ({ start: Number(match[1]) }),
			(match, node) => node.childCount + node.attrs.start === Number(match[1]),
		),
		markInputRule(/`([^`]+)`$/, schema.marks.code),
		markInputRule(/\*\*([^*\n]+)\*\*$/, schema.marks.bold),
		markInputRule(/(?<![*\w])\*([^*\n]+)\*$/, schema.marks.italic),
		markInputRule(/(?<![_\w])_([^_\n]+)_$/, schema.marks.italic),
		markInputRule(/~~([^~\n]+)~~$/, schema.marks.strike),
	];
	return inputRules({ rules });
}
