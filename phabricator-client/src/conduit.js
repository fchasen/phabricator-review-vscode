'use strict';

const { ConduitError } = require('./errors');

const DEFAULT_BASE_URL = 'https://phabricator.services.mozilla.com/api/';
const DEFAULT_USER_AGENT = 'phabricator-client (vanilla-js)';

/**
 * @typedef {Object} ConduitState
 * @property {string} token
 * @property {string} baseUrl
 * @property {typeof fetch} fetch
 * @property {string} userAgent
 * @property {(level: 'debug'|'info'|'warn'|'error', msg: string, meta?: object) => void} log
 */

/**
 * @param {import('./types').ClientOptions} opts
 * @returns {ConduitState}
 */
function createState(opts) {
	if (!opts || typeof opts.token !== 'string' || opts.token.length === 0) {
		throw new TypeError('PhabricatorClient: token is required');
	}
	const fetchImpl = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined);
	if (typeof fetchImpl !== 'function') {
		throw new TypeError('PhabricatorClient: a fetch implementation is required (Node 18+ or pass opts.fetch)');
	}
	let baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
	if (!baseUrl.endsWith('/')) {
		baseUrl += '/';
	}
	if (!baseUrl.endsWith('/api/')) {
		throw new TypeError(`PhabricatorClient: baseUrl must end with /api/ (got ${baseUrl})`);
	}
	return {
		token: opts.token,
		baseUrl,
		fetch: fetchImpl,
		userAgent: opts.userAgent || DEFAULT_USER_AGENT,
		log: opts.logger || (() => {}),
	};
}

/**
 * Form-encode a Conduit request body. Mozilla's Phabricator accepts
 * `params=<json>&output=json`; the JSON payload may carry the auth token
 * as `__conduit__: { token }`. We always set both `__conduit__` and the
 * top-level token field so legacy + modern endpoints stay happy.
 *
 * @param {string} token
 * @param {object} args
 * @returns {URLSearchParams}
 */
function encodeBody(token, args) {
	const auth = { token };
	const params = JSON.stringify({ ...args, __conduit__: auth });
	const body = new URLSearchParams();
	body.set('params', params);
	body.set('output', 'json');
	body.set('__conduit__', JSON.stringify(auth));
	return body;
}

/**
 * @template T
 * @param {ConduitState} state
 * @param {string} method
 * @param {object} [args]
 * @returns {Promise<T>}
 */
async function callConduit(state, method, args = {}) {
	const url = state.baseUrl + method;
	const body = encodeBody(state.token, args);
	state.log('debug', `POST ${method}`, { method });

	const response = await state.fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'User-Agent': state.userAgent,
			'Accept': 'application/json',
		},
		body,
	});

	if (!response.ok) {
		throw new ConduitError({
			code: 'HTTP_' + response.status,
			info: response.statusText || null,
			method,
			httpStatus: response.status,
		});
	}

	const text = await response.text();
	let payload;
	try {
		payload = JSON.parse(text);
	} catch (err) {
		throw new ConduitError({
			code: 'INVALID_JSON',
			info: `Conduit returned non-JSON body: ${text.slice(0, 200)}`,
			method,
			httpStatus: response.status,
		});
	}

	if (payload.error_code) {
		throw new ConduitError({
			code: payload.error_code,
			info: payload.error_info || null,
			method,
			httpStatus: response.status,
		});
	}

	return payload.result;
}

module.exports = {
	createState,
	callConduit,
	encodeBody,
	DEFAULT_BASE_URL,
};
