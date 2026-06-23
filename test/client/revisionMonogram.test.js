'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRevisionNumber } = require('../../src/phabricator/revisionMonogram');

test('parseRevisionNumber: accepts D-prefixed monogram', () => {
	assert.equal(parseRevisionNumber('D123456'), 123456);
});

test('parseRevisionNumber: accepts lowercase d', () => {
	assert.equal(parseRevisionNumber('d123'), 123);
});

test('parseRevisionNumber: accepts bare digits', () => {
	assert.equal(parseRevisionNumber('123456'), 123456);
});

test('parseRevisionNumber: accepts a number', () => {
	assert.equal(parseRevisionNumber(123), 123);
});

test('parseRevisionNumber: trims surrounding whitespace', () => {
	assert.equal(parseRevisionNumber('  D42  '), 42);
});

test('parseRevisionNumber: rejects garbage', () => {
	assert.throws(() => parseRevisionNumber(''));
	assert.throws(() => parseRevisionNumber('D'));
	assert.throws(() => parseRevisionNumber('Dabc'));
	assert.throws(() => parseRevisionNumber('foo123'));
	assert.throws(() => parseRevisionNumber(0));
	assert.throws(() => parseRevisionNumber(-5));
});
