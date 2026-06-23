'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
	composePreset,
	mozconfigEnablesArtifact,
	mozconfigCandidatePaths,
	autodetectPreset,
	resolvePreset,
} = require('../../src/phabricator/sparsePresets');

test('composePreset: base starts with /* and excludes WPT + docs', () => {
	const base = composePreset('base');
	assert.equal(base[0], '/*');
	assert.ok(base.includes('!/testing/web-platform/tests/'));
	assert.ok(base.includes('!/testing/web-platform/mozilla/tests/'));
	assert.ok(base.includes('!/docs/'));
});

test('composePreset: frontend includes base then file-extension excludes', () => {
	const fe = composePreset('frontend');
	assert.equal(fe[0], '/*');
	assert.ok(fe.includes('!*.h'));
	assert.ok(fe.includes('!*.rs'));
	const wptIdx = fe.indexOf('!/testing/web-platform/tests/');
	const cppIdx = fe.indexOf('!*.cpp');
	assert.ok(wptIdx >= 0 && cppIdx >= 0 && wptIdx < cppIdx);
});

test('composePreset: artifact is an alias for frontend', () => {
	assert.deepEqual(composePreset('artifact'), composePreset('frontend'));
});

test('composePreset: desktop includes base then !/mobile/', () => {
	const d = composePreset('desktop');
	assert.equal(d[0], '/*');
	assert.ok(d.includes('!/mobile/'));
});

test('composePreset: full and none return null', () => {
	assert.equal(composePreset('full'), null);
	assert.equal(composePreset('none'), null);
});

test('composePreset: is case-insensitive', () => {
	assert.deepEqual(composePreset('FRONTEND'), composePreset('frontend'));
});

test('composePreset: unknown preset throws', () => {
	assert.throws(() => composePreset('nope'), /Unknown sparse preset/);
});

test('composePreset: no duplicate patterns across composition', () => {
	const fe = composePreset('frontend');
	assert.equal(new Set(fe).size, fe.length);
});

test('mozconfigEnablesArtifact: true for uncommented option', () => {
	assert.equal(mozconfigEnablesArtifact('ac_add_options --enable-artifact-builds\n'), true);
	assert.equal(mozconfigEnablesArtifact('ac_add_options --enable-artifact-build'), true);
});

test('mozconfigEnablesArtifact: false for commented or absent', () => {
	assert.equal(mozconfigEnablesArtifact('# ac_add_options --enable-artifact-build'), false);
	assert.equal(mozconfigEnablesArtifact('ac_add_options --enable-debug\n'), false);
	assert.equal(mozconfigEnablesArtifact(''), false);
});

test('autodetectPreset: frontend when artifact, base otherwise', () => {
	assert.equal(autodetectPreset('ac_add_options --enable-artifact-build'), 'frontend');
	assert.equal(autodetectPreset('ac_add_options --enable-debug'), 'base');
	assert.equal(autodetectPreset(undefined), 'base');
});

test('mozconfigCandidatePaths: prepends $MOZCONFIG when set', () => {
	assert.deepEqual(mozconfigCandidatePaths('/src', { MOZCONFIG: '/x/mozconfig' }), [
		'/x/mozconfig',
		'/src/mozconfig',
		'/src/.mozconfig',
	]);
	assert.deepEqual(mozconfigCandidatePaths('/src', {}), ['/src/mozconfig', '/src/.mozconfig']);
});

test('resolvePreset: auto picks frontend for artifact mozconfig', () => {
	const readFile = () => 'ac_add_options --enable-artifact-build';
	assert.deepEqual(resolvePreset('auto', '/src', { readFile, env: {} }), composePreset('frontend'));
});

test('resolvePreset: auto picks base for non-artifact mozconfig', () => {
	const readFile = () => 'ac_add_options --enable-debug';
	assert.deepEqual(resolvePreset('auto', '/src', { readFile, env: {} }), composePreset('base'));
});

test('resolvePreset: auto falls back to base when no mozconfig readable', () => {
	const readFile = () => {
		throw new Error('ENOENT');
	};
	assert.deepEqual(resolvePreset('auto', '/src', { readFile, env: {} }), composePreset('base'));
});

test('resolvePreset: full returns null', () => {
	assert.equal(resolvePreset('full', '/src', { env: {} }), null);
});
