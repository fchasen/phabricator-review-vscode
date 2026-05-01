'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PhabricatorClient } = require('../../src/client/client');
const { mockFetch, decodeBody } = require('./_helpers');

test('searchUsers posts user.search with nameLike + isDisabled and a limit', async () => {
	const { fetchImpl, calls } = mockFetch([
		{
			body: {
				result: {
					data: [
						{ phid: 'PHID-USER-1', fields: { username: 'fred', realName: 'Fred C' } },
					],
					cursor: { after: null },
				},
				error_code: null,
				error_info: null,
			},
		},
	]);
	const client = new PhabricatorClient({ token: 't', fetch: fetchImpl });

	const out = await client.searchUsers({ query: 'fre' });

	assert.equal(out.length, 1);
	assert.equal(out[0].phid, 'PHID-USER-1');

	const decoded = decodeBody(calls[0].body);
	assert.equal(calls[0].url.endsWith('user.search'), true);
	assert.equal(decoded.params.constraints.nameLike, 'fre');
	assert.equal(decoded.params.constraints.isDisabled, false);
	assert.equal(decoded.params.limit, 8);
});

test('searchUsers returns [] without making a call for empty query', async () => {
	const { fetchImpl, calls } = mockFetch([]);
	const client = new PhabricatorClient({ token: 't', fetch: fetchImpl });
	const out = await client.searchUsers({ query: '   ' });
	assert.deepEqual(out, []);
	assert.equal(calls.length, 0);
});

test('searchUsers clamps the limit', async () => {
	const { fetchImpl, calls } = mockFetch([
		{ body: { result: { data: [], cursor: { after: null } }, error_code: null, error_info: null } },
		{ body: { result: { data: [], cursor: { after: null } }, error_code: null, error_info: null } },
	]);
	const client = new PhabricatorClient({ token: 't', fetch: fetchImpl });
	await client.searchUsers({ query: 'x', limit: 999 });
	await client.searchUsers({ query: 'x', limit: 0 });
	assert.equal(decodeBody(calls[0].body).params.limit, 50);
	assert.equal(decodeBody(calls[1].body).params.limit, 1);
});

test('searchProjects posts project.search with query + active statuses', async () => {
	const { fetchImpl, calls } = mockFetch([
		{
			body: {
				result: {
					data: [
						{ phid: 'PHID-PROJ-1', fields: { name: 'Security' } },
					],
					cursor: { after: null },
				},
				error_code: null,
				error_info: null,
			},
		},
	]);
	const client = new PhabricatorClient({ token: 't', fetch: fetchImpl });

	const out = await client.searchProjects({ query: 'sec' });

	assert.equal(out[0].phid, 'PHID-PROJ-1');

	const decoded = decodeBody(calls[0].body);
	assert.equal(calls[0].url.endsWith('project.search'), true);
	assert.equal(decoded.params.constraints.query, 'sec');
	assert.deepEqual(decoded.params.constraints.statuses, ['active']);
	assert.equal(decoded.params.limit, 8);
});

test('searchProjects returns [] without making a call for empty query', async () => {
	const { fetchImpl, calls } = mockFetch([]);
	const client = new PhabricatorClient({ token: 't', fetch: fetchImpl });
	const out = await client.searchProjects({ query: '' });
	assert.deepEqual(out, []);
	assert.equal(calls.length, 0);
});
