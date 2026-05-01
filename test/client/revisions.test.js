'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PhabricatorClient } = require('../../src/client/client');
const { mockFetch, decodeBody } = require('./_helpers');

test('searchRevisions flattens constraints into params', async () => {
	const { fetchImpl, calls } = mockFetch([
		{
			body: {
				result: {
					data: [
						{ id: 1, type: 'DREV', phid: 'PHID-DREV-1', fields: { title: 'one' }, attachments: {} },
					],
					cursor: { after: null },
				},
				error_code: null,
				error_info: null,
			},
		},
	]);
	const client = new PhabricatorClient({ token: 't', fetch: fetchImpl });

	const out = [];
	for await (const r of client.searchRevisions(
		{ authorPHIDs: ['PHID-USER-me'], statuses: ['needs-review'] },
		{ reviewers: true },
	)) {
		out.push(r);
	}

	assert.equal(out.length, 1);
	assert.equal(out[0].phid, 'PHID-DREV-1');

	const decoded = decodeBody(calls[0].body);
	assert.equal(calls[0].url.endsWith('differential.revision.search'), true);
	assert.deepEqual(decoded.params.constraints.authorPHIDs, ['PHID-USER-me']);
	assert.deepEqual(decoded.params.constraints.statuses, ['needs-review']);
	assert.deepEqual(decoded.params.attachments, { reviewers: true });
});

test('comment posts a single comment transaction', async () => {
	const { fetchImpl, calls } = mockFetch([
		{ body: { result: { object: 'PHID-DREV-1', transactions: [] }, error_code: null, error_info: null } },
	]);
	const client = new PhabricatorClient({ token: 't', fetch: fetchImpl });

	await client.comment('D1', 'looks good');

	const decoded = decodeBody(calls[0].body);
	assert.equal(calls[0].url.endsWith('differential.revision.edit'), true);
	assert.equal(decoded.params.objectIdentifier, 'D1');
	assert.deepEqual(decoded.params.transactions, [{ type: 'comment', value: 'looks good' }]);
});

test('accept posts an accept transaction with optional comment', async () => {
	const { fetchImpl, calls } = mockFetch([
		{ body: { result: { object: 'PHID-DREV-1', transactions: [] }, error_code: null, error_info: null } },
		{ body: { result: { object: 'PHID-DREV-1', transactions: [] }, error_code: null, error_info: null } },
	]);
	const client = new PhabricatorClient({ token: 't', fetch: fetchImpl });

	await client.accept('D1');
	await client.accept('D1', 'r=me');

	const first = decodeBody(calls[0].body);
	const second = decodeBody(calls[1].body);

	assert.deepEqual(first.params.transactions, [{ type: 'accept', value: true }]);
	assert.deepEqual(second.params.transactions, [
		{ type: 'accept', value: true },
		{ type: 'comment', value: 'r=me' },
	]);
});

test('createInline calls differential.createinline with translated lineLength', async () => {
	const { fetchImpl, calls } = mockFetch([
		{ body: { result: { phid: 'PHID-XACT-inline-new' }, error_code: null, error_info: null } },
	]);
	const client = new PhabricatorClient({ token: 't', fetch: fetchImpl });

	await client.createInline({
		diffId: 17,
		path: 'js/util.js',
		line: 42,
		length: 1,
		isNewFile: true,
		content: 'nit: typo',
	});

	const decoded = decodeBody(calls[0].body);
	assert.equal(calls[0].url.endsWith('differential.createinline'), true);
	assert.equal(decoded.params.diffID, 17);
	assert.equal(decoded.params.filePath, 'js/util.js');
	assert.equal(decoded.params.lineNumber, 42);
	assert.equal(decoded.params.lineLength, 0); // length=1 → lineLength=0
	assert.equal(decoded.params.isNewFile, true);
	assert.equal(decoded.params.content, 'nit: typo');
});

test('createInline lineLength is length-1 for multi-line ranges', async () => {
	const { fetchImpl, calls } = mockFetch([
		{ body: { result: { phid: 'p' }, error_code: null, error_info: null } },
	]);
	const client = new PhabricatorClient({ token: 't', fetch: fetchImpl });
	await client.createInline({
		diffId: 1,
		path: 'a',
		line: 1,
		length: 4,
		isNewFile: false,
		content: 'x',
	});
	const decoded = decodeBody(calls[0].body);
	assert.equal(decoded.params.lineLength, 3);
});

test('createRevision builds the expected transaction sequence', async () => {
	const { fetchImpl, calls } = mockFetch([
		{ body: { result: { object: 'PHID-DREV-NEW', transactions: [] }, error_code: null, error_info: null } },
	]);
	const client = new PhabricatorClient({ token: 't', fetch: fetchImpl });

	await client.createRevision({
		diffPHID: 'PHID-DIFF-1',
		title: 'Add widget',
		summary: 'Adds widget.',
		testPlan: 'mach test',
		reviewerPHIDs: ['PHID-USER-r1'],
		bug: 1234567,
	});

	const decoded = decodeBody(calls[0].body);
	const types = decoded.params.transactions.map((t) => t.type);
	assert.deepEqual(types, ['update', 'title', 'summary', 'test-plan', 'reviewers.add', 'bugzilla.bug-id']);
	assert.equal(decoded.params.objectIdentifier, undefined);
	const bug = decoded.params.transactions.find((t) => t.type === 'bugzilla.bug-id');
	assert.equal(bug.value, '1234567');
});

test('updateRevision passes objectIdentifier and only included fields', async () => {
	const { fetchImpl, calls } = mockFetch([
		{ body: { result: { object: 'PHID-DREV-1', transactions: [] }, error_code: null, error_info: null } },
	]);
	const client = new PhabricatorClient({ token: 't', fetch: fetchImpl });

	await client.updateRevision(42, { diffPHID: 'PHID-DIFF-2', message: 'rebased' });

	const decoded = decodeBody(calls[0].body);
	assert.equal(decoded.params.objectIdentifier, 42);
	const types = decoded.params.transactions.map((t) => t.type);
	assert.deepEqual(types, ['update', 'comment']);
});
