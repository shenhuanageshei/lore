import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathComponent, parseGitLog, commitAtom, mineCommits, mine } from '../lib/mine.js';
import { init } from '../lib/init.js';
import { readAllAtoms } from '../lib/journal.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-mine-')); }

test('pathComponent: prefix match → last segment', () => {
  assert.equal(pathComponent('lib/sync.js', ['lib', 'site']), 'lib');
  assert.equal(pathComponent('site/shell.mjs', ['lib', 'site']), 'site');
});

test('pathComponent: longest match wins, last segment name', () => {
  assert.equal(pathComponent('src/pkg/core.py', ['src', 'src/pkg']), 'pkg');
});

test('pathComponent: no match → null (and prefix-of-name does not falsely match)', () => {
  assert.equal(pathComponent('README.md', ['lib', 'site']), null);
  assert.equal(pathComponent('libfoo/x.js', ['lib']), null);
});

test('parseGitLog parses commits with multi-line body and files', () => {
  const RS = '\x1e', US = '\x1f';
  const stdout =
    `${RS}abc123${US}2026-06-01T08:00:00Z${US}fix bug${US}body line1\nbody line2${US}\n\nlib/a.js\nlib/b.js\n` +
    `${RS}def456${US}2026-05-30T10:00:00+09:00${US}add feature${US}${US}\n\nsite/x.mjs\n`;
  const commits = parseGitLog(stdout);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0], {
    sha: 'abc123', ts: '2026-06-01T08:00:00Z', subject: 'fix bug',
    body: 'body line1\nbody line2', files: ['lib/a.js', 'lib/b.js'],
  });
  assert.deepEqual(commits[1], {
    sha: 'def456', ts: '2026-05-30T10:00:00+09:00', subject: 'add feature',
    body: '', files: ['site/x.mjs'],
  });
});

test('parseGitLog: empty stdout → []', () => {
  assert.deepEqual(parseGitLog(''), []);
});

test('commitAtom builds full-schema atom with component facets', () => {
  const raw = {
    sha: 'abc123def', ts: '2026-06-01T08:00:00Z', subject: 'fix crawler',
    body: 'why text', files: ['m1_crawler/fetch.py', 'shared/util.py', 'README.md'],
  };
  const atom = commitAtom(raw, ['m1_crawler', 'shared']);
  assert.equal(atom.id, 'commit:abc123def');
  assert.equal(atom.ts, '2026-06-01T08:00:00Z');
  assert.equal(atom.kind, 'commit');
  assert.equal(atom.commit, 'abc123def');
  assert.equal(atom.title, 'fix crawler');
  assert.equal(atom.why, 'why text');
  assert.equal(atom.what_changed, '');
  assert.deepEqual(atom.facets.component, ['m1_crawler', 'shared']); // sorted, deduped, README excluded
  assert.deepEqual(atom.facets.flow, []);
  assert.deepEqual(atom.facets.theme, []);
  assert.deepEqual(atom.refs.files, ['m1_crawler/fetch.py', 'shared/util.py', 'README.md']);
  assert.equal(atom.refs.pitfall, null);
  assert.deepEqual(atom.refs.related, []);
  assert.equal(atom.source, 'miner:commits');
  assert.equal(atom.enriched, false);
  assert.equal(atom.confidence, 'EXTRACTED');
});

test('commitAtom: no matching component → empty component facet', () => {
  const atom = commitAtom(
    { sha: 'x', ts: '2026-06-01T08:00:00Z', subject: 's', body: '', files: ['README.md'] },
    ['lib'],
  );
  assert.deepEqual(atom.facets.component, []);
});

function gitRepo() {
  const root = tmpDir();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  return root;
}

function commitFile(root, relpath, content, msg) {
  const p = join(root, relpath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', msg], { cwd: root });
}

test('mineCommits returns commit atoms with component facets from a real repo', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'x', 'add lib');
    commitFile(root, 'site/b.mjs', 'y', 'add site');
    const atoms = mineCommits(root, ['lib', 'site']);
    assert.equal(atoms.length, 2);
    const byTitle = Object.fromEntries(atoms.map(a => [a.title, a]));
    assert.deepEqual(byTitle['add lib'].facets.component, ['lib']);
    assert.deepEqual(byTitle['add site'].facets.component, ['site']);
    assert.equal(byTitle['add lib'].kind, 'commit');
    assert.match(byTitle['add lib'].id, /^commit:[0-9a-f]{40}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mine appends new atoms; re-run is idempotent (dedup by id)', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'x', 'c1');
    commitFile(root, 'lib/b.js', 'y', 'c2');
    const journalDir = join(root, '.lore', 'journal');
    const r1 = mine({ repoRoot: root, journalDir, codeRoots: ['lib'] });
    assert.deepEqual(r1, { scanned: 2, added: 2, skipped: 0 });
    const r2 = mine({ repoRoot: root, journalDir, codeRoots: ['lib'] });
    assert.deepEqual(r2, { scanned: 2, added: 0, skipped: 2 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('commitAtom: source param overrides default', () => {
  const raw = { sha: 'abc', ts: '2026-06-01T08:00:00Z', subject: 's', body: '', files: [] };
  assert.equal(commitAtom(raw, []).source, 'miner:commits');         // default unchanged
  assert.equal(commitAtom(raw, [], 'hook').source, 'hook');          // override
});

test('CLI integration: init + mine populates journal with component facets, idempotent', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'export const x = 1;', 'add lib module');
    // real init writes .lore/config.yml (discovers lib/ → code_roots: [lib]) + shell
    init({ repoRoot: root, srcSiteDir: join(process.cwd(), 'site') });
    const journalDir = join(root, '.lore', 'journal');

    const out = execFileSync('node', ['lib/mine.js', root], { cwd: process.cwd() }).toString();
    assert.match(out, /mined 1 new commit atom/);

    const atoms = readAllAtoms(journalDir);
    assert.equal(atoms.length, 1);
    assert.equal(atoms[0].title, 'add lib module');
    assert.deepEqual(atoms[0].facets.component, ['lib']);
    assert.equal(atoms[0].source, 'miner:commits');

    // idempotent re-run via CLI
    const out2 = execFileSync('node', ['lib/mine.js', root], { cwd: process.cwd() }).toString();
    assert.match(out2, /mined 0 new commit atom/);
    assert.equal(readAllAtoms(journalDir).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { tagThemes } from '../lib/mine.js';

const THEMES = [{ id: 'quality', match: ['质量', 'accuracy'] }, { id: 'perf', match: ['性能', 'latency'] }];

test('tagThemes: substring case-insensitive, sorted unique', () => {
  assert.deepEqual(tagThemes('fix Accuracy and 性能 issue', THEMES), ['perf', 'quality']);
  assert.deepEqual(tagThemes('improve LATENCY', THEMES), ['perf']);
  assert.deepEqual(tagThemes('unrelated change', THEMES), []);
});

test('tagThemes: empty text / does not mutate input', () => {
  assert.deepEqual(tagThemes('', THEMES), []);
  const t = [{ id: 'a', match: ['x'] }];
  tagThemes('x', t);
  assert.equal(t.length, 1);
});

test('commitAtom: themes param tags facets.theme; default empty', () => {
  const raw = { sha: 'a', ts: '2026-06-03T00:00:00Z', subject: 'fix accuracy bug', body: 'better 质量', files: [] };
  assert.deepEqual(commitAtom(raw, [], 'miner:commits', [{ id: 'quality', match: ['accuracy', '质量'] }]).facets.theme, ['quality']);
  assert.deepEqual(commitAtom(raw, []).facets.theme, []);          // default no themes
  assert.equal(commitAtom(raw, []).source, 'miner:commits');       // 3-arg default still works
});

test('mineCommits: passes themes → commit atoms get facets.theme', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'x', 'improve accuracy');
    const atoms = mineCommits(root, ['lib'], [{ id: 'quality', match: ['accuracy'] }]);
    assert.deepEqual(atoms[0].facets.theme, ['quality']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mine CLI reads config themes', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'x', 'fix latency');
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib]\n  theme:\n    values:\n    - { id: perf, match: [latency] }\n');
    execFileSync('node', ['lib/mine.js', root], { cwd: process.cwd() });
    const atoms = readAllAtoms(join(lore, 'journal'));
    const a = atoms.find(x => x.title === 'fix latency');
    assert.deepEqual(a.facets.theme, ['perf']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
