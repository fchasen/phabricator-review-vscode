'use strict';

/**
 * Build a fake fetch impl that records calls and returns canned responses.
 *
 * @param {Array<{ status?: number, body: any } | ((req: { url: string, body: string }) => { status?: number, body: any })>} responses
 */
function mockFetch(responses) {
	const calls = /** @type {Array<{ url: string, body: string, headers: Record<string,string> }>} */ ([]);
	let i = 0;
	const fetchImpl = async (url, init) => {
		const body = init && typeof init.body === 'object' && init.body !== null
			? init.body.toString()
			: (init && init.body) || '';
		const headers = (init && init.headers) || {};
		calls.push({ url: String(url), body, headers });
		const response = responses[i++];
		const resolved = typeof response === 'function' ? response({ url: String(url), body }) : response;
		if (!resolved) {
			throw new Error(`mockFetch: no canned response at index ${i - 1}`);
		}
		const status = resolved.status === undefined ? 200 : resolved.status;
		const text = typeof resolved.body === 'string' ? resolved.body : JSON.stringify(resolved.body);
		return {
			ok: status >= 200 && status < 300,
			status,
			statusText: status === 200 ? 'OK' : 'ERROR',
			text: async () => text,
		};
	};
	return { fetchImpl, calls };
}

/**
 * Parse a Conduit form-encoded body back into the JSON params payload.
 * @param {string} body
 */
function decodeBody(body) {
	const params = new URLSearchParams(body);
	const out = {};
	for (const [k, v] of params) {
		out[k] = v;
	}
	return {
		raw: out,
		params: out.params ? JSON.parse(out.params) : null,
		conduit: out.__conduit__ ? JSON.parse(out.__conduit__) : null,
	};
}

module.exports = { mockFetch, decodeBody };
