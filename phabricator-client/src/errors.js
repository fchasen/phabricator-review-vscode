'use strict';

class ConduitError extends Error {
	/**
	 * @param {{ code: string|null, info: string|null, method: string, httpStatus?: number }} args
	 */
	constructor({ code, info, method, httpStatus }) {
		super(`${method}: ${code || 'error'}${info ? ` — ${info}` : ''}`);
		this.name = 'ConduitError';
		/** @type {string|null} */
		this.code = code;
		/** @type {string|null} */
		this.info = info;
		/** @type {string} */
		this.method = method;
		/** @type {number|undefined} */
		this.httpStatus = httpStatus;
	}
}

module.exports = { ConduitError };
