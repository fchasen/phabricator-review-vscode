export interface MarkdownProps {
	source: string;
	className?: string;
}

export function Markdown({ source, className }: MarkdownProps) {
	return (
		<div className={`comment-body ${className || ''}`}>
			<pre className="remarkup-fallback">{source || ''}</pre>
		</div>
	);
}
