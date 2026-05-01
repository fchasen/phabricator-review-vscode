'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PhabricatorClient } = require('../src/client');
const { mockFetch, decodeBody } = require('./_helpers');

test('processRemarkup posts contents and returns HTML strings', async () => {
	const { fetchImpl, calls } = mockFetch([
		{
			body: {
				result: [
					{ content: '<p><strong>hi</strong></p>', attached: {} },
					{ content: '<p>two</p>', attached: {} },
				],
				error_code: null,
				error_info: null,
			},
		},
	]);
	const client = new PhabricatorClient({ token: 't', fetch: fetchImpl });

	const out = await client.processRemarkup(['**hi**', 'two']);

	assert.deepEqual(out, ['<p><strong>hi</strong></p>', '<p>two</p>']);

	const decoded = decodeBody(calls[0].body);
	assert.equal(calls[0].url.endsWith('remarkup.process'), true);
	assert.deepEqual(decoded.params.contents, ['**hi**', 'two']);
	assert.equal(decoded.params.context, 'differential');
});

test('processRemarkup forwards a custom engine context', async () => {
	const { fetchImpl, calls } = mockFetch([
		{
			body: {
				result: [{ content: '<p>x</p>' }],
				error_code: null,
				error_info: null,
			},
		},
	]);
	const client = new PhabricatorClient({ token: 't', fetch: fetchImpl });

	await client.processRemarkup(['x'], { context: 'phriction' });

	const decoded = decodeBody(calls[0].body);
	assert.equal(decoded.params.context, 'phriction');
});

test('processRemarkup returns empty array without making a call when input is empty', async () => {
	const { fetchImpl, calls } = mockFetch([]);
	const client = new PhabricatorClient({ token: 't', fetch: fetchImpl });

	const out = await client.processRemarkup([]);

	assert.deepEqual(out, []);
	assert.equal(calls.length, 0);
});

test('processRemarkup tolerates entries that are plain strings', async () => {
	const { fetchImpl } = mockFetch([
		{
			body: {
				result: ['<p>a</p>', '<p>b</p>'],
				error_code: null,
				error_info: null,
			},
		},
	]);
	const client = new PhabricatorClient({ token: 't', fetch: fetchImpl });
	const out = await client.processRemarkup(['a', 'b']);
	assert.deepEqual(out, ['<p>a</p>', '<p>b</p>']);
});
