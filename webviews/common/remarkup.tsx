import { Markdown } from './markdown';

export interface RemarkupProps {
	html: string;
	source: string;
	className?: string;
}

/**
 * Render Phabricator-rendered Remarkup HTML produced host-side via
 * `remarkup.process`. Falls back to a markdown-it pass on the raw source
 * when the host could not render (offline, endpoint missing, etc.).
 */
export function Remarkup({ html, source, className }: RemarkupProps) {
	if (html && html.length > 0) {
		return (
			<div className={`comment-body remarkup ${className || ''}`} dangerouslySetInnerHTML={{ __html: html }} />
		);
	}
	return <Markdown source={source} className={className} />;
}
