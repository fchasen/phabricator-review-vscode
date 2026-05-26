/**
 * Helpers for auto-detecting submit-flow context from a local git commit:
 *  - parsing reviewer/project mentions out of a Mozilla-style commit message,
 *  - picking up a `Differential Revision:` trailer for update flows.
 */

const BUG_RE = /^Bug\s+(\d{5,8})/im;
const DIFFERENTIAL_RE = /^Differential Revision:\s*\S*?\/(D\d+)\s*$/im;

const SUBJECT_REVIEWERS_RE = /(?:^|[\s,;])(r[=?!])([A-Za-z0-9_.#!,-]+)/g;
const REVIEWERS_TRAILER_RE = /^Reviewers?:\s*(.+)$/im;

export interface ParsedReviewers {
	usernames: string[];
	projectSlugs: string[];
}

export interface ParsedCommitMetadata {
	bug?: string;
	reviewers: ParsedReviewers;
	differentialMonogram?: string;
}

export function parseCommitMetadata(subject: string, body: string): ParsedCommitMetadata {
	const text = `${subject}\n${body}`;
	const bugMatch = BUG_RE.exec(text);
	const diffMatch = DIFFERENTIAL_RE.exec(body);
	return {
		bug: bugMatch ? bugMatch[1] : undefined,
		reviewers: parseReviewers(subject, body),
		differentialMonogram: diffMatch ? diffMatch[1] : undefined,
	};
}

export function parseReviewers(subject: string, body: string): ParsedReviewers {
	const tokens = new Set<string>();

	for (const match of subject.matchAll(SUBJECT_REVIEWERS_RE)) {
		for (const tok of match[2].split(',')) {
			const cleaned = tok.replace(/!+$/, '').trim();
			if (cleaned.length > 0) {
				tokens.add(cleaned);
			}
		}
	}

	const trailerMatch = REVIEWERS_TRAILER_RE.exec(body);
	if (trailerMatch) {
		for (const tok of trailerMatch[1].split(',')) {
			const cleaned = tok.replace(/!+$/, '').trim();
			if (cleaned.length > 0) {
				tokens.add(cleaned);
			}
		}
	}

	const usernames: string[] = [];
	const projectSlugs: string[] = [];
	for (const tok of tokens) {
		if (tok.startsWith('#')) {
			const slug = tok.slice(1);
			if (slug.length > 0) {
				projectSlugs.push(slug);
			}
		} else {
			usernames.push(tok);
		}
	}
	return { usernames, projectSlugs };
}

