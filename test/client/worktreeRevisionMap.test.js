'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
	extractRevisionId,
	isBugSubject,
	deriveSubtitle,
} = require('../../src/phabricator/unsubmittedCommitParse');

test('extractRevisionId: parses https Differential trailer', () => {
	const msg = `Bug 1 - foo r=me\n\nDifferential Revision: https://phabricator.services.mozilla.com/D12345`;
	assert.equal(extractRevisionId(msg), 12345);
});

test('extractRevisionId: parses http variant', () => {
	const msg = `Bug 1 - foo\n\nDifferential Revision: http://phabricator.services.mozilla.com/D7`;
	assert.equal(extractRevisionId(msg), 7);
});

test('extractRevisionId: parses trailing-slash variant', () => {
	const msg = `Bug 1 - foo\n\nDifferential Revision: https://phabricator.services.mozilla.com/D42/`;
	assert.equal(extractRevisionId(msg), 42);
});

test('extractRevisionId: returns first when multiple appear', () => {
	const msg = `subject\n\nDifferential Revision: https://example/D10\nDifferential Revision: https://example/D20`;
	assert.equal(extractRevisionId(msg), 10);
});

test('extractRevisionId: missing trailer returns undefined', () => {
	assert.equal(extractRevisionId('Bug 1 - foo'), undefined);
	assert.equal(extractRevisionId(''), undefined);
});

test('extractRevisionId: ignores text mentioning D123 without trailer prefix', () => {
	const msg = `Bug 1 - rename D1234 to D5678`;
	assert.equal(extractRevisionId(msg), undefined);
});

test('extractRevisionId: multi-line body keeps matching', () => {
	const msg = [
		'Bug 1 - thing r=me',
		'',
		'Adds the widget.',
		'',
		'Differential Revision: https://phabricator.services.mozilla.com/D99',
	].join('\n');
	assert.equal(extractRevisionId(msg), 99);
});

test('isBugSubject: accepts canonical Mozilla bug subjects', () => {
	assert.equal(isBugSubject('Bug 123 - foo'), true);
	assert.equal(isBugSubject('Bug 1234567: foo'), true);
	assert.equal(isBugSubject('Bug  42 - extra space'), true);
});

test('isBugSubject: rejects WIP and lowercase variants', () => {
	assert.equal(isBugSubject('WIP foo'), false);
	assert.equal(isBugSubject('bug 123 - lower'), false);
	assert.equal(isBugSubject('Add bug fix'), false);
	assert.equal(isBugSubject(''), false);
});

test('deriveSubtitle: prefers branch name when present', () => {
	assert.equal(deriveSubtitle('feature/foo', '0123456789abcdef'), 'feature/foo');
});

test('deriveSubtitle: falls back to 7-char short SHA on detached HEAD', () => {
	assert.equal(deriveSubtitle(undefined, '0123456789abcdef'), '0123456');
});
