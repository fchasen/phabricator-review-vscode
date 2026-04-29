import MarkdownIt from 'markdown-it';

const md: MarkdownIt = MarkdownIt({
	html: false,
	linkify: true,
	breaks: true,
	typographer: false,
});

export interface MarkdownProps {
	source: string;
	className?: string;
}

export function Markdown({ source, className }: MarkdownProps) {
	const html = md.render(source || '');
	return (
		<div className={`comment-body ${className || ''}`} dangerouslySetInnerHTML={{ __html: html }} />
	);
}
