import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseConfigCodeRoots, planSync, stampFrontmatter, buildIndex } from '../lib/sync.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-sync-')); }

test('parseConfigCodeRoots: single-line list', () => {
  assert.deepEqual(
    parseConfigCodeRoots('axes:\n  component:\n    code_roots: [lib, site]\n'),
    ['lib', 'site']
  );
});

test('parseConfigCodeRoots: dequotes entries with special chars', () => {
  assert.deepEqual(
    parseConfigCodeRoots("    code_roots: ['a b', m1, \"x\"]\n"),
    ['a b', 'm1', 'x']
  );
});

test('parseConfigCodeRoots: empty list', () => {
  assert.deepEqual(parseConfigCodeRoots('    code_roots: []\n'), []);
});

test('parseConfigCodeRoots: missing line yields []', () => {
  assert.deepEqual(parseConfigCodeRoots('axes: {}\n'), []);
});

test('planSync builds worklist from config code_roots', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki', 'component'), { recursive: true });
    writeFileSync(join(lore, 'config.yml'), 'axes:\n  component:\n    code_roots: [lib, src/pkg]\n');
    writeFileSync(join(lore, 'wiki', 'component', 'lib.md'), 'x');   // makes priorExists true for lib
    const { codeRoots, worklist } = planSync(lore);
    assert.deepEqual(codeRoots, ['lib', 'src/pkg']);
    assert.deepEqual(worklist, [
      { component: 'lib', codeRoot: 'lib', path: 'component/lib.md', priorExists: true },
      { component: 'pkg', codeRoot: 'src/pkg', path: 'component/pkg.md', priorExists: false },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('planSync returns empty when config missing', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    assert.deepEqual(planSync(lore), { codeRoots: [], worklist: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stampFrontmatter merges mechanical fields, preserves title/summary + body', () => {
  const page =
    '---\ntitle: M3 NLP\nsummary: entity extraction\n---\n' +
    '# component: m3_nlp\n\n## Current architecture\n\nprose\n';
  const out = stampFrontmatter(page, { codeSha: 'abc1234', lastUpdated: '2026-06-01', commits: 0, atoms: 0 });
  assert.match(out, /^---\n/);
  assert.match(out, /title: M3 NLP/);
  assert.match(out, /summary: entity extraction/);
  assert.match(out, /last_updated: 2026-06-01/);
  assert.match(out, /code_sha: abc1234/);
  assert.match(out, /atoms: 0/);
  assert.match(out, /commits: 0/);
  // body preserved
  assert.match(out, /# component: m3_nlp/);
  assert.match(out, /## Current architecture/);
  assert.match(out, /prose/);
});

test('buildIndex renders TOC with half front-matter and component links', () => {
  const out = buildIndex([{ id: 'm3_nlp', title: 'M3 NLP' }, { id: 'lib', title: 'Lib' }]);
  assert.match(out, /title: Index/);
  assert.match(out, /summary: table of contents/);
  assert.match(out, /# lore wiki — index/);
  assert.match(out, /## Component/);
  assert.match(out, /- \[\[m3_nlp\]\]/);
  assert.match(out, /- \[\[lib\]\]/);
});
