// test/manifest.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, deriveAxes, runManifestCli } from '../lib/manifest.js';

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

import { emitManifest } from '../lib/manifest.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

test('deriveAxes sorts unknown axes alphabetically (cross-platform determinism)', () => {
  const axes = deriveAxes(['zebra', 'component', 'apple', 'theme']);
  assert.deepEqual(axes.map(a => a.id), ['component', 'theme', 'apple', 'zebra']);
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

test('runManifestCli throws a clear error when not a git repo', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-nogit-'));
  try {
    mkdirSync(join(root, '.lore', 'wiki'), { recursive: true });
    assert.throws(
      () => runManifestCli(join(root, '.lore'), 't'),
      /git rev-parse failed/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('manifest CLI writes .manifest.json into wiki dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-cli-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    const wiki = join(root, '.lore', 'wiki', 'component');
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(root, '.lore', 'wiki', 'component', 'x.md'),
      '---\ntitle: X\nsummary: s\ncode_sha: deadbee\n---\n# X');
    writeFileSync(join(root, 'f.txt'), 'hi');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });

    execFileSync('node', ['lib/manifest.js', join(root, '.lore')],
      { cwd: process.cwd() });

    const out = join(root, '.lore', 'wiki', '.manifest.json');
    assert.equal(existsSync(out), true);
    const m = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(m.axes.find(a => a.id === 'component').pages[0].title, 'X');
    assert.equal(typeof m.current_code_sha, 'string');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('emitManifest: docs axis pages sorted by last_updated desc (other axes stay alpha)', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mf-docs-'));
  try {
    const wiki = join(root, 'wiki');
    mkdirSync(join(wiki, 'docs'), { recursive: true });
    const page = (d) => `---\ntitle: ${d}\nsummary: s\nlast_updated: ${d}\n---\nbody`;
    writeFileSync(join(wiki, 'docs', 'old.md'), page('2026-06-01'));
    writeFileSync(join(wiki, 'docs', 'new.md'), page('2026-06-10'));
    writeFileSync(join(wiki, 'docs', 'mid.md'), page('2026-06-05'));
    mkdirSync(join(wiki, 'component'), { recursive: true });
    writeFileSync(join(wiki, 'component', 'aaa.md'), page('2026-06-01'));   // alpha-first but oldest
    writeFileSync(join(wiki, 'component', 'bbb.md'), page('2026-06-10'));   // alpha-last but newest
    const m = emitManifest({ wikiDir: wiki, currentSha: 'abc', countCommitsSince: () => 0, now: 'now' });
    const docs = m.axes.find(a => a.id === 'docs');
    assert.deepEqual(docs.pages.map(p => p.id), ['new', 'mid', 'old']);   // date desc, not alpha (mid/new/old)
    const comp = m.axes.find(a => a.id === 'component');
    assert.deepEqual(comp.pages.map(p => p.id), ['aaa', 'bbb']);   // alphabetical, NOT date-desc → sort is docs-only
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { gitCurrentSha, makeCountCommitsSince } from '../lib/manifest.js';

test('gitCurrentSha + makeCountCommitsSince are exported and work', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mf-git-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), '1');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'c1'], { cwd: root });
    const sha1 = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
    writeFileSync(join(root, 'b.txt'), '2');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'c2'], { cwd: root });

    assert.match(gitCurrentSha(root), /^[0-9a-f]{7,}$/);
    assert.equal(makeCountCommitsSince(root)(sha1), 1);   // 1 commit (c2) since c1
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('emitManifest includes HOME before INDEX when HOME.md exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-home-mf-'));
  try {
    const wiki = join(root, 'wiki');
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, 'HOME.md'), '---\ntitle: Home\nsummary: orient\n---\n# Home');
    writeFileSync(join(wiki, 'INDEX.md'), '---\ntitle: Index\nsummary: toc\n---\n# Index');
    const m = emitManifest({ wikiDir: wiki, currentSha: 'abc', countCommitsSince: () => 0, now: 'now' });
    assert.deepEqual(m.axes.slice(0, 2).map(a => a.id), ['HOME', 'INDEX']);
    assert.equal(m.axes[0].pages[0].path, 'HOME.md');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('emitManifest attaches language metadata and hides translation sidecars', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-lang-mf-'));
  try {
    const wiki = join(root, 'wiki');
    mkdirSync(join(wiki, 'component'), { recursive: true });
    const source = '---\ntitle: Lib\nsummary: core\n---\n# Lib\n正文';
    writeFileSync(join(wiki, 'component', 'lib.md'), source);
    writeFileSync(join(wiki, 'component', 'lib.en.md'),
      '---\nlang: en\ntranslation_of: component/lib.md\ntranslation_source_hash: sha256:bad\n---\n# Lib\nEnglish');
    const m = emitManifest({
      wikiDir: wiki,
      currentSha: 'abc',
      countCommitsSince: () => 0,
      now: 'now',
      language: { default: 'zh', available: ['zh', 'en'] },
      preferences: { language: 'en' },
    });
    assert.deepEqual(m.language, { default: 'zh', available: ['zh', 'en'] });
    assert.deepEqual(m.user_preferences, { language: 'en' });
    const comp = m.axes.find(a => a.id === 'component');
    assert.deepEqual(comp.pages.map(p => p.id), ['lib']);
    assert.equal(comp.pages[0].lang, 'zh');
    assert.equal(comp.pages[0].translations[0].lang, 'en');
    assert.equal(comp.pages[0].translations[0].path, 'component/lib.en.md');
    assert.equal(comp.pages[0].translations[0].stale, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runManifestCli reads language config and user preferences', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mf-lang-cli-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    mkdirSync(join(root, '.lore', 'wiki'), { recursive: true });
    mkdirSync(join(root, '.lore', '.state'), { recursive: true });
    writeFileSync(join(root, '.lore', 'config.yml'), 'language:\n  default: zh\n  available: [zh, en]\n');
    writeFileSync(join(root, '.lore', '.state', 'preferences.json'), '{"language":"en"}\n');
    writeFileSync(join(root, '.lore', 'wiki', 'HOME.md'), '---\ntitle: Home\nsummary: h\n---\n# Home');
    writeFileSync(join(root, 'f.txt'), 'hi');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });

    runManifestCli(join(root, '.lore'), 'now');
    const m = JSON.parse(readFileSync(join(root, '.lore', 'wiki', '.manifest.json'), 'utf8'));
    assert.deepEqual(m.language, { default: 'zh', available: ['zh', 'en'] });
    assert.deepEqual(m.user_preferences, { language: 'en' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runManifestCli returns { manifestPath, manifest }', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mani-ret-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki', 'component'), { recursive: true });
    writeFileSync(join(lore, 'wiki', 'component', 'lib.md'),
      '---\ntitle: Lib\nsummary: s\ncode_sha: abc\n---\n# component: lib\n');
    const r = runManifestCli(lore, '2026-06-06T00:00:00Z');
    assert.equal(typeof r.manifestPath, 'string');
    assert.ok(r.manifest && Array.isArray(r.manifest.axes), 'returns manifest object with axes');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pageEntry: manifest pages carry their axis', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-axis-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki', 'component'), { recursive: true });
    writeFileSync(join(lore, 'wiki', 'component', 'lib.md'), '---\ntitle: Lib\nsummary: s\ncode_sha: abc\n---\n# component: lib\n');
    const { manifest } = runManifestCli(lore, 'now');
    const comp = manifest.axes.find(a => a.id === 'component');
    assert.equal(comp.pages[0].axis, 'component');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// makeCountCommitsSince already imported above (line ~216) — reuse fs/os/path/child_process imports too.
test('countCommitsSince scopes to a pathspec', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-ccs-'));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root, stdio: 'pipe' });
    const base = git('rev-parse', '--short', 'HEAD').toString().trim();
    // 一个 commit 动 a/，一个动 b/
    execFileSync('bash', ['-c', 'mkdir -p a b && echo x > a/f && git add a/f && git commit -q -m a'], { cwd: root, stdio: 'pipe' });
    execFileSync('bash', ['-c', 'echo y > b/f && git add b/f && git commit -q -m b'], { cwd: root, stdio: 'pipe' });
    const count = makeCountCommitsSince(root);
    assert.equal(count(base), 2);              // 全仓：2 个 commit
    assert.equal(count(base, ['a']), 1);       // 只数动过 a/ 的：1
    assert.equal(count(base, ['b']), 1);       // 只数动过 b/ 的：1
    assert.equal(count(base, ['a', 'b']), 2);  // 并集：2
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// emitManifest already imported above — reuse it + fs/os/path imports.
test('emitManifest uses staleScopes to scope per-page stale', () => {
  const wiki = mkdtempSync(join(tmpdir(), 'lore-ss-'));
  try {
    mkdirSync(join(wiki, 'component'), { recursive: true });
    const page = (id, sha) => `---\ntitle: ${id}\ncode_sha: ${sha}\natoms: 0\ncommits: 0\n---\n# ${id}\n`;
    writeFileSync(join(wiki, 'component', 'a.md'), page('a', 'OLD'));
    writeFileSync(join(wiki, 'component', 'b.md'), page('b', 'OLD'));
    // 假 countCommitsSince：动过 'a' 算 5，动过 'b' 算 0
    const count = (sha, pathspec) => (pathspec && pathspec.includes('a')) ? 5 : 0;
    const m = emitManifest({
      wikiDir: wiki, currentSha: 'NEW', countCommitsSince: count, now: 't',
      staleScopes: { 'component/a.md': ['a'], 'component/b.md': ['b'] },
    });
    const comp = m.axes.find(x => x.id === 'component');
    assert.equal(comp.pages.find(p => p.id === 'a').stale, 5);
    assert.equal(comp.pages.find(p => p.id === 'b').stale, 0);
  } finally { rmSync(wiki, { recursive: true, force: true }); }
});
