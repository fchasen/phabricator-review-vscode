'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PhabricatorClient } = require('../../src/client/client');
const { ConduitError } = require('../../src/client/errors');
const { mockFetch, decodeBody } = require('./_helpers');

test('whoami: posts form-encoded body with __conduit__ token', async () => {
	const { fetchImpl, calls } = mockFetch([
		{ body: { result: { phid: 'PHID-USER-abc', userName: 'me' }, error_code: null, error_info: null } },
	]);
	const client = new PhabricatorClient({
		token: 'cli-secret',
		baseUrl: 'https://example.test/api/',
		fetch: fetchImpl,
	});

	const me = await client.whoami();

	assert.equal(me.phid, 'PHID-USER-abc');
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'https://example.test/api/user.whoami');
	assert.equal(calls[0].headers['Content-Type'], 'application/x-www-form-urlencoded');

	const decoded = decodeBody(calls[0].body);
	assert.equal(decoded.raw.output, 'json');
	assert.deepEqual(decoded.conduit, { token: 'cli-secret' });
	assert.deepEqual(decoded.params.__conduit__, { token: 'cli-secret' });
});

test('non-null error_code becomes ConduitError', async () => {
	const { fetchImpl } = mockFetch([
		{ body: { result: null, error_code: 'ERR-INVALID-SESSION', error_info: 'token expired' } },
	]);
	const client = new PhabricatorClient({
		token: 'bad',
		fetch: fetchImpl,
	});

	await assert.rejects(client.whoami(), (err) => {
		assert.ok(err instanceof ConduitError);
		assert.equal(err.code, 'ERR-INVALID-SESSION');
		assert.equal(err.info, 'token expired');
		assert.equal(err.method, 'user.whoami');
		return true;
	});
});

test('HTTP error becomes ConduitError with HTTP_ code', async () => {
	const { fetchImpl } = mockFetch([
		{ status: 503, body: 'service unavailable' },
	]);
	const client = new PhabricatorClient({ token: 't', fetch: fetchImpl });

	await assert.rejects(client.whoami(), (err) => {
		assert.ok(err instanceof ConduitError);
		assert.equal(err.code, 'HTTP_503');
		assert.equal(err.httpStatus, 503);
		return true;
	});
});

test('non-JSON body becomes INVALID_JSON error', async () => {
	const { fetchImpl } = mockFetch([
		{ status: 200, body: '<html>nope</html>' },
	]);
	const client = new PhabricatorClient({ token: 't', fetch: fetchImpl });

	await assert.rejects(client.whoami(), (err) => {
		assert.ok(err instanceof ConduitError);
		assert.equal(err.code, 'INVALID_JSON');
		return true;
	});
});

test('rejects baseUrl that does not end with /api/', () => {
	assert.throws(
		() => new PhabricatorClient({ token: 't', baseUrl: 'https://example.test/', fetch: () => {} }),
		/end with \/api\//,
	);
});

test('rejects empty token', () => {
	assert.throws(
		() => new PhabricatorClient({ token: '', fetch: () => {} }),
		/token is required/,
	);
});
