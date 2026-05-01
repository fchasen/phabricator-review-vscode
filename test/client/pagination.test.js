'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { paginate, collect } = require('../../src/client/pagination');

test('paginate: walks two pages and exhausts', async () => {
	const pages = [
		{ data: [{ id: 1 }, { id: 2 }], cursor: { after: 'page-2', before: null, limit: 100, order: null } },
		{ data: [{ id: 3 }], cursor: { after: null, before: null, limit: 100, order: null } },
	];
	let i = 0;
	const seen = [];
	const iter = paginate(async (cursor) => {
		seen.push(cursor);
		return pages[i++];
	});

	const out = [];
	for await (const item of iter) {
		out.push(item.id);
	}

	assert.deepEqual(out, [1, 2, 3]);
	assert.deepEqual(seen, [null, 'page-2']);
});

test('paginate: handles a single empty page', async () => {
	const iter = paginate(async () => ({ data: [], cursor: { after: null } }));
	const out = await collect(iter);
	assert.deepEqual(out, []);
});

test('collect: respects limit', async () => {
	const iter = paginate(async (cursor) => {
		if (cursor === null) {
			return { data: [{ id: 1 }, { id: 2 }, { id: 3 }], cursor: { after: 'next' } };
		}
		return { data: [{ id: 4 }], cursor: { after: null } };
	});
	const out = await collect(iter, 2);
	assert.deepEqual(out.map((r) => r.id), [1, 2]);
});
