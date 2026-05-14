import type { Project } from '../client';

export const TESTING_TAG_SLUGS = [
	'testing-approved',
	'testing-exception-unchanged',
	'testing-exception-ui',
	'testing-exception-elsewhere',
	'testing-exception-other',
] as const;

export type TestingTagSlug = (typeof TESTING_TAG_SLUGS)[number];

export type TestingTagTone = 'approved' | 'warn';

export interface TestingTagMeta {
	slug: TestingTagSlug;
	title: string;
	codicon: string;
	tone: TestingTagTone;
}

export const TESTING_TAGS: readonly TestingTagMeta[] = [
	{ slug: 'testing-approved', title: 'Tests approved', codicon: 'pass-filled', tone: 'approved' },
	{ slug: 'testing-exception-unchanged', title: 'No behavior change', codicon: 'circle-slash', tone: 'warn' },
	{ slug: 'testing-exception-ui', title: 'UI only', codicon: 'device-desktop', tone: 'warn' },
	{ slug: 'testing-exception-elsewhere', title: 'Tested elsewhere', codicon: 'link-external', tone: 'warn' },
	{ slug: 'testing-exception-other', title: 'Exception (other)', codicon: 'question', tone: 'warn' },
];

export function getTestingTagMeta(slug: TestingTagSlug): TestingTagMeta {
	return TESTING_TAGS.find((t) => t.slug === slug) as TestingTagMeta;
}

export function matchTestingTag(project: Pick<Project, 'fields'>): TestingTagSlug | null {
	const name = project.fields?.name || '';
	const slug = project.fields?.slug || '';
	for (const tag of TESTING_TAG_SLUGS) {
		if (name === tag || name.startsWith(tag + ' ')) return tag;
		if (slug && (slug === tag || slug.startsWith(tag + '_'))) return tag;
	}
	return null;
}

export function isTestingTagSlug(value: string): value is TestingTagSlug {
	return (TESTING_TAG_SLUGS as readonly string[]).includes(value);
}
