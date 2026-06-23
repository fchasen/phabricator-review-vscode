'use strict';

/**
 * Sparse-checkout presets ported from fxy. Kept in JS (with JSDoc) so the node
 * test runner can require them without a TS compile step. Patterns are
 * gitignore-style, non-cone, last-match-wins.
 */

const fs = require('fs');
const path = require('path');

const BASE = [
	'/*',
	'!/testing/web-platform/tests/',
	'!/testing/web-platform/mozilla/tests/',
	'!/docs/',
];

const FRONTEND_EXTRA = [
	'!*.cpp',
	'!*.cc',
	'!*.cxx',
	'!*.c',
	'!*.h',
	'!*.hpp',
	'!*.hxx',
	'!*.rs',
	'!*.S',
	'!*.asm',
	'!*.m',
	'!*.mm',
];

const DESKTOP_EXTRA = ['!/mobile/'];

/**
 * @param {string[]} list
 * @returns {string[]}
 */
function dedupe(list) {
	const seen = new Set();
	const out = [];
	for (const item of list) {
		if (!seen.has(item)) {
			seen.add(item);
			out.push(item);
		}
	}
	return out;
}

/**
 * Resolve a concrete preset name to its pattern list. Returns null for the
 * `full`/`none` sentinels (no sparse checkout). Throws on unknown names.
 *
 * @param {string} name
 * @returns {string[] | null}
 */
function composePreset(name) {
	const key = String(name || '').trim().toLowerCase();
	switch (key) {
		case 'full':
		case 'none':
			return null;
		case 'base':
			return dedupe([...BASE]);
		case 'frontend':
		case 'artifact':
			return dedupe([...BASE, ...FRONTEND_EXTRA]);
		case 'desktop':
			return dedupe([...BASE, ...DESKTOP_EXTRA]);
		default:
			throw new Error(
				`Unknown sparse preset '${name}'. Available: base, frontend, artifact, desktop, full, none`,
			);
	}
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function mozconfigEnablesArtifact(text) {
	if (!text) {
		return false;
	}
	return text.split(/\r?\n/).some((line) => {
		const trimmed = line.trim();
		return !trimmed.startsWith('#') && trimmed.includes('--enable-artifact-build');
	});
}

/**
 * Candidate mozconfig paths in priority order: $MOZCONFIG, then <src>/mozconfig,
 * then <src>/.mozconfig.
 *
 * @param {string} sourcePath
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
function mozconfigCandidatePaths(sourcePath, env) {
	env = env || {};
	const out = [];
	const explicit = (env.MOZCONFIG || '').trim();
	if (explicit) {
		out.push(explicit);
	}
	out.push(path.join(sourcePath, 'mozconfig'));
	out.push(path.join(sourcePath, '.mozconfig'));
	return out;
}

/**
 * @param {string | undefined} mozconfigText
 * @returns {'frontend' | 'base'}
 */
function autodetectPreset(mozconfigText) {
	return mozconfigText && mozconfigEnablesArtifact(mozconfigText) ? 'frontend' : 'base';
}

/**
 * @param {string} sourcePath
 * @param {Record<string, string | undefined>} env
 * @param {(p: string) => string} readFile
 * @returns {string | undefined}
 */
function readMozconfig(sourcePath, env, readFile) {
	for (const candidate of mozconfigCandidatePaths(sourcePath, env)) {
		try {
			const text = readFile(candidate);
			if (typeof text === 'string') {
				return text;
			}
		} catch {
			// try the next candidate
		}
	}
	return undefined;
}

/**
 * Resolve a preset selection into the patterns to apply, or null for a full
 * checkout. `auto` introspects the source mozconfig. Filesystem reads are
 * injectable via opts for testing.
 *
 * @param {string} name
 * @param {string} sourcePath
 * @param {{ readFile?: (p: string) => string, env?: Record<string, string | undefined> }} [opts]
 * @returns {string[] | null}
 */
function resolvePreset(name, sourcePath, opts) {
	opts = opts || {};
	const env = opts.env || process.env;
	const readFile = opts.readFile || ((p) => fs.readFileSync(p, 'utf8'));
	const key = String(name || '').trim().toLowerCase();
	if (key === 'auto') {
		const text = readMozconfig(sourcePath, env, readFile);
		return composePreset(autodetectPreset(text));
	}
	return composePreset(key);
}

module.exports = {
	BASE,
	FRONTEND_EXTRA,
	DESKTOP_EXTRA,
	composePreset,
	mozconfigEnablesArtifact,
	mozconfigCandidatePaths,
	autodetectPreset,
	resolvePreset,
};
