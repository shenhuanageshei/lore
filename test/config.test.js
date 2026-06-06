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
import { parseConfigDocsAxis } from '../lib/config.js';

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

test('parseConfigDocsAxis reads sources + docs_glob', () => {
  const cfg = `axes:\n  docs:\n    sources: [docs, changelog, claude_md_pitfalls]\n    docs_glob: docs/**/*.md\n`;
  const r = parseConfigDocsAxis(cfg);
  assert.deepEqual(r.sources, ['docs', 'changelog', 'claude_md_pitfalls']);
  assert.equal(r.docsGlob, 'docs/**/*.md');
});

test('parseConfigDocsAxis defaults docs_glob when omitted', () => {
  const r = parseConfigDocsAxis(`axes:\n  docs:\n    sources: [docs]\n`);
  assert.deepEqual(r.sources, ['docs']);
  assert.equal(r.docsGlob, 'docs/**/*.md');
});

test('parseConfigDocsAxis returns null when axes.docs absent', () => {
  assert.equal(parseConfigDocsAxis(`axes:\n  component:\n    code_roots: [lib]\n`), null);
});

test('parseConfigDocsAxis dequotes quoted source entries', () => {
  const r = parseConfigDocsAxis(`axes:\n  docs:\n    sources: ['docs', "changelog"]\n`);
  assert.deepEqual(r.sources, ['docs', 'changelog']);
});

test('parseConfigDocsAxis returns null for empty sources list', () => {
  assert.equal(parseConfigDocsAxis(`axes:\n  docs:\n    sources: []\n`), null);
});

import { parseConfigLanguage } from '../lib/config.js';

test('parseConfigLanguage: defaults to English when block is absent', () => {
  assert.deepEqual(parseConfigLanguage('axes:\n  component:\n    code_roots: [lib]\n'), {
    default: 'en',
    available: ['en'],
  });
});

test('parseConfigLanguage: reads default and available languages', () => {
  const cfg = 'language:\n  default: zh\n  available: [zh, en]\n';
  assert.deepEqual(parseConfigLanguage(cfg), {
    default: 'zh',
    available: ['zh', 'en'],
  });
});

test('parseConfigLanguage: dequotes, dedupes, and keeps default available', () => {
  const cfg = 'language:\n  default: "zh"\n  available: [en, zh, en]\n';
  assert.deepEqual(parseConfigLanguage(cfg), {
    default: 'zh',
    available: ['zh', 'en'],
  });
});

test('parseConfigLanguage: invalid default falls back to en', () => {
  const cfg = 'language:\n  default: ???\n  available: []\n';
  assert.deepEqual(parseConfigLanguage(cfg), {
    default: 'en',
    available: ['en'],
  });
});

test('parseConfigLanguage: only reads the language block, not stray default: keys', () => {
  const cfg = 'axes:\n  component:\n    default: en\nlanguage:\n  default: zh\n  available: [zh, en]\n';
  assert.deepEqual(parseConfigLanguage(cfg), { default: 'zh', available: ['zh', 'en'] });
});

test('parseConfigLanguage: tolerates a trailing comment and CRLF on the language: line', () => {
  // init-generated configs put a comment after `language:`; Windows checkouts use CRLF.
  const cfg = 'language:                # wiki language (human home + sidecars)\r\n  default: zh\r\n  available: [zh, en]\r\n';
  assert.deepEqual(parseConfigLanguage(cfg), { default: 'zh', available: ['zh', 'en'] });
});
