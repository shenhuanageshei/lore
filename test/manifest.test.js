// test/manifest.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, deriveAxes } from '../lib/manifest.js';

test('parseFrontmatter extracts flat keys and body', () => {
  const md = [
    '---',
    'title: M3 NLP',
    'summary: entity extraction',
    'last_updated: 2026-05-28',
    'code_sha: def5678',
    'atoms: 8',
    'commits: 5',
    'stale: 3',
    '---',
    '',
    '# M3 NLP',
    'body line',
  ].join('\n');
  const { data, body } = parseFrontmatter(md);
  assert.equal(data.title, 'M3 NLP');
  assert.equal(data.summary, 'entity extraction');
  assert.equal(data.code_sha, 'def5678');
  assert.equal(data.atoms, 8);          // numeric coercion
  assert.equal(data.commits, 5);
  assert.equal(data.stale, 3);
  assert.equal(body.trim().startsWith('# M3 NLP'), true);
});

test('parseFrontmatter returns empty data when no front-matter', () => {
  const { data, body } = parseFrontmatter('# Just a title\ntext');
  assert.deepEqual(data, {});
  assert.equal(body.startsWith('# Just a title'), true);
});

test('parseFrontmatter ignores malformed lines without throwing', () => {
  const md = '---\ntitle: ok\ngarbage-no-colon\n---\nbody';
  const { data } = parseFrontmatter(md);
  assert.equal(data.title, 'ok');
  assert.equal('garbage-no-colon' in data, false);
});

test('parseFrontmatter handles CRLF line endings', () => {
  const md = '---\r\ntitle: Hello\r\nsummary: world\r\natoms: 8\r\n---\r\nbody';
  const { data, body } = parseFrontmatter(md);
  assert.equal(data.title, 'Hello');
  assert.equal(data.summary, 'world');
  assert.equal(data.atoms, 8);
  assert.equal(body.trim(), 'body');
});

test('parseFrontmatter coerces a non-numeric numeric-key to 0', () => {
  const md = '---\ntitle: X\nstale: broken\n---\nbody';
  const { data } = parseFrontmatter(md);
  assert.equal(data.stale, 0);
});

test('deriveAxes orders known axes and capitalizes labels', () => {
  const axes = deriveAxes(['theme', 'component', 'flow']);
  assert.deepEqual(axes, [
    { id: 'component', label: 'Component' },
    { id: 'flow', label: 'Flow' },
    { id: 'theme', label: 'Theme' },
  ]);
});

test('deriveAxes puts INDEX first and unknown axes last in given order', () => {
  const axes = deriveAxes(['custom', 'theme', 'INDEX']);
  assert.deepEqual(axes.map(a => a.id), ['INDEX', 'theme', 'custom']);
  assert.equal(axes[0].label, 'INDEX');
  assert.equal(axes[2].label, 'Custom');
});

// append to test/manifest.test.js
import { emitManifest } from '../lib/manifest.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeWiki() {
  const dir = mkdtempSync(join(tmpdir(), 'lore-wiki-'));
  mkdirSync(join(dir, 'component'), { recursive: true });
  mkdirSync(join(dir, 'theme'), { recursive: true });
  writeFileSync(join(dir, 'INDEX.md'),
    '---\ntitle: Index\nsummary: toc\nlast_updated: 2026-05-31\ncode_sha: abc1234\natoms: 33\ncommits: 21\n---\n# Index');
  writeFileSync(join(dir, 'component', 'm3_nlp.md'),
    '---\ntitle: M3 NLP\nsummary: extraction\nlast_updated: 2026-05-28\ncode_sha: def5678\natoms: 8\ncommits: 5\n---\n# M3 NLP');
  writeFileSync(join(dir, 'theme', 'quality.md'),
    '---\ntitle: Quality\nsummary: qa evolution\nlast_updated: 2026-05-31\ncode_sha: abc1234\natoms: 14\ncommits: 9\n---\n# Quality');
  return dir;
}

test('emitManifest builds axes->pages with stale + provenance', () => {
  const dir = makeWiki();
  try {
    const m = emitManifest({
      wikiDir: dir,
      currentSha: 'abc1234',
      countCommitsSince: (sha) => (sha === 'abc1234' ? 0 : 3),
      now: '2026-05-31T08:14:00Z',
    });
    assert.equal(m.generated, '2026-05-31T08:14:00Z');
    assert.equal(m.current_code_sha, 'abc1234');
    const comp = m.axes.find(a => a.id === 'component');
    const page = comp.pages.find(p => p.id === 'm3_nlp');
    assert.equal(page.title, 'M3 NLP');
    assert.equal(page.summary, 'extraction');
    assert.equal(page.path, 'component/m3_nlp.md');
    assert.equal(page.stale, 3);                  // def5678 != HEAD
    assert.equal(page.code_sha, 'def5678');
    assert.deepEqual(page.synthesized_from, { atoms: 8, commits: 5 });
    const theme = m.axes.find(a => a.id === 'theme');
    assert.equal(theme.pages[0].stale, 0);        // abc1234 == HEAD
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('emitManifest is deterministic for identical inputs (byte-identical)', () => {
  const dir = makeWiki();
  try {
    const args = {
      wikiDir: dir, currentSha: 'abc1234',
      countCommitsSince: () => 0, now: '2026-05-31T08:14:00Z',
    };
    const a = JSON.stringify(emitManifest(args));
    const b = JSON.stringify(emitManifest(args));
    assert.equal(a, b);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('emitManifest tolerates a page missing summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lore-wiki-'));
  try {
    mkdirSync(join(dir, 'component'), { recursive: true });
    writeFileSync(join(dir, 'component', 'bare.md'),
      '---\ntitle: Bare\ncode_sha: aaa\n---\n# Bare');
    const m = emitManifest({
      wikiDir: dir, currentSha: 'aaa',
      countCommitsSince: () => 0, now: 't',
    });
    const page = m.axes.find(a => a.id === 'component').pages[0];
    assert.equal(page.summary, '');               // graceful default
    assert.equal(page.title, 'Bare');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
