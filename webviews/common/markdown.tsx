import MarkdownIt from 'markdown-it';

let md: MarkdownIt | undefined;

function getMarkdown(): MarkdownIt {
	if (md) {
		return md;
	}
	// `new` works whether MarkdownIt is exported as a class, factory, or
	// default-export wrapper.
	md = new MarkdownIt({ html: false, linkify: true, breaks: true });
	return md;
}

export interface MarkdownProps {
	source: string;
	className?: string;
}

export function Markdown({ source, className }: MarkdownProps) {
	let html: string;
	try {
		html = getMarkdown().render(source || '');
	} catch (err) {
		console.error('markdown render failed', err);
		const escaped = (source || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
		html = `<pre>${escaped}</pre>`;
	}
	return (
		<div className={`comment-body ${className || ''}`} dangerouslySetInnerHTML={{ __html: html }} />
	);
}
