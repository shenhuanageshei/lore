// test/config.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigCodeRoots } from '../lib/config.js';

test('parseConfigCodeRoots: single-line list', () => {
  assert.deepEqual(parseConfigCodeRoots('axes:\n  component:\n    code_roots: [lib, site]\n'), ['lib', 'site']);
});

test('parseConfigCodeRoots: dequotes entries with special chars', () => {
  assert.deepEqual(parseConfigCodeRoots("    code_roots: ['a b', m1, \"x\"]\n"), ['a b', 'm1', 'x']);
});

test('parseConfigCodeRoots: empty list', () => {
  assert.deepEqual(parseConfigCodeRoots('    code_roots: []\n'), []);
});

test('parseConfigCodeRoots: missing line yields []', () => {
  assert.deepEqual(parseConfigCodeRoots('axes: {}\n'), []);
});

import { parseConfigThemes } from '../lib/config.js';

test('parseConfigThemes: commented example → []', () => {
  assert.deepEqual(parseConfigThemes('  theme:\n    values: []\n    # - { id: quality, match: [质量, accuracy] }\n'), []);
});

test('parseConfigThemes: uncommented themes (field order independent)', () => {
  const cfg = '  theme:\n    values:\n    - { id: quality, desc: "质量", match: [质量, accuracy, 误报] }\n    - { match: [性能, latency], id: perf }\n';
  assert.deepEqual(parseConfigThemes(cfg), [
    { id: 'quality', match: ['质量', 'accuracy', '误报'] },
    { id: 'perf', match: ['性能', 'latency'] },
  ]);
});

test('parseConfigThemes: ignores flow items (spans, no match)', () => {
  assert.deepEqual(parseConfigThemes('    - { id: f1, spans: [lib] }\n    - { id: x, match: [a] }\n'), [{ id: 'x', match: ['a'] }]);
});

import { parseConfigFlows } from '../lib/config.js';

test('parseConfigFlows: commented example → []', () => {
  assert.deepEqual(parseConfigFlows('  flow:\n    values: []\n    # - { id: article-pipeline, spans: [lib] }\n'), []);
});

test('parseConfigFlows: uncommented flows (field order independent)', () => {
  const cfg = '  flow:\n    values:\n    - { id: pipeline, spans: [m1, m3, shared] }\n    - { spans: [lib], id: dedup }\n';
  assert.deepEqual(parseConfigFlows(cfg), [
    { id: 'pipeline', spans: ['m1', 'm3', 'shared'] },
    { id: 'dedup', spans: ['lib'] },
  ]);
});

test('parseConfigFlows: ignores theme items (match, no spans)', () => {
  assert.deepEqual(parseConfigFlows('    - { id: quality, match: [a] }\n    - { id: f1, spans: [lib] }\n'), [{ id: 'f1', spans: ['lib'] }]);
});
