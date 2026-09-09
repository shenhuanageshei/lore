// test/note.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { noteAtom } from '../lib/note.js';
import { readAllAtoms } from '../lib/journal.js';
import { init } from '../lib/init.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-note-')); }

test('noteAtom builds a decision atom (source=agent, enriched, commit=null)', () => {
  const a = noteAtom({ id: 'note:x', ts: '2026-06-03T08:00:00Z', title: 'use ZSET', why: 'range queries', component: ['lib'], flow: ['f'], theme: ['perf'], files: ['lib/a.js'] });
  assert.equal(a.id, 'note:x');
  assert.equal(a.kind, 'decision');
  assert.equal(a.commit, null);
  assert.equal(a.title, 'use ZSET');
  assert.equal(a.why, 'range queries');
  assert.equal(a.source, 'agent');
  assert.equal(a.enriched, true);
  assert.equal(a.confidence, 'EXTRACTED');
  assert.equal(a.what_changed, '');
  assert.deepEqual(a.facets, { component: ['lib'], flow: ['f'], theme: ['perf'] });
  assert.deepEqual(a.refs, { files: ['lib/a.js'], pitfall: null, related: [] });
});

test('noteAtom: 纯 trailer / 空 why → 不写 why 键（写入侧纪律，不变量⑦）', () => {
  for (const why of ['Co-Authored-By: Bot <b@x.com>', '🤖 Generated with [Claude Code](https://x)', '', '   ']) {
    const a = noteAtom({ id: 'note:t', ts: '2026-06-03T08:00:00Z', title: 't', why });
    assert.equal('why' in a, false, JSON.stringify(why));
  }
  const a = noteAtom({ id: 'note:t', ts: '2026-06-03T08:00:00Z', title: 't', why: 'real\nSigned-off-by: D <d@x.com>\nGenerated with Codex' });
  assert.equal(a.why, 'real');
});

test('noteAtom defaults facets/refs to empty', () => {
  const a = noteAtom({ id: 'note:y', ts: '2026-06-03T08:00:00Z', title: 't', why: 'w' });
  assert.deepEqual(a.facets, { component: [], flow: [], theme: [] });
  assert.deepEqual(a.refs.files, []);
});

test('CLI: note flags → decision atom in journal', () => {
  const root = tmpDir();
  try {
    const out = execFileSync('node', ['lib/note.js', root, '--title', 'use ZSET', '--why', 'range queries O(logN)', '--component', 'lib', '--files', 'lib/a.js,lib/b.js'], { cwd: process.cwd() }).toString();
    assert.match(out, /noted decision atom note:/);
    const atoms = readAllAtoms(join(root, '.lore', 'journal'));
    assert.equal(atoms.length, 1);
    assert.equal(atoms[0].kind, 'decision');
    assert.equal(atoms[0].title, 'use ZSET');
    assert.equal(atoms[0].why, 'range queries O(logN)');
    assert.equal(atoms[0].source, 'agent');
    assert.deepEqual(atoms[0].facets.component, ['lib']);
    assert.deepEqual(atoms[0].refs.files, ['lib/a.js', 'lib/b.js']);
    assert.match(atoms[0].id, /^note:/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function gitRepo() {
  const root = tmpDir();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  writeFileSync(join(root, 'f.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  return root;
}

function tokenPage(title, summary) {
  return `---\ntitle: ${title}\nsummary: ${summary}\n---\n# component: ${title}\n\n` +
    `## Current architecture\n\narch\n\n## Decision history\n\n{{LORE_JOURNAL}}\n\n## Cross-links\n\n- [[x]]\n`;
}

// --- enrich 骨架（母 §4② 后半）：同 commit:<hash> append 补 why，append-only，fold 层合并 ---
import { enrichAtom } from '../lib/note.js';
import { foldAtoms } from '../lib/fold.js';

test('enrichAtom: 同 id 的 enriched commit 原子（补 why 不带 title）', () => {
  const a = enrichAtom({ sha: 'abc123full', ts: '2026-06-10T01:00:00Z', why: '当时没写清楚：其实是为了 O(logN)' });
  assert.equal(a.id, 'commit:abc123full');        // 与骨架同 id → fold 合并
  assert.equal(a.kind, 'commit');
  assert.equal(a.commit, 'abc123full');
  assert.equal(a.enriched, true);                  // mergeGroup 只追加 enriched 原子的 why
  assert.equal(a.title, '');                       // 不抢骨架 title（firstNonEmpty 基底优先）
  assert.equal(a.why, '当时没写清楚：其实是为了 O(logN)');
  assert.equal(a.source, 'agent');
});

test('integration: mine 骨架 → enrich 短 sha → fold 后 why 演化追加（append-only 两条原子）', () => {
  const root = gitRepo();
  try {
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'a.js'), 'export const x = 1;');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'feat: add a'], { cwd: root });
    const lore = join(root, '.lore');
    mkdirSync(join(lore), { recursive: true });
    writeFileSync(join(lore, 'config.yml'), 'axes:\n  component:\n    code_roots: [lib]\n');
    // mine 骨架
    execFileSync('node', ['lib/mine.js', root], { cwd: process.cwd() });
    const shortSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
    const fullSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
    // enrich（短 sha → CLI 内部 rev-parse 展开成全 sha 对齐骨架 id）
    const out = execFileSync('node', ['lib/note.js', root, '--enrich', shortSha, '--why', '补记：为了演示 enrich'], { cwd: process.cwd() }).toString();
    assert.match(out, /enriched commit:/);
    // journal 里同 id 两条（append-only）
    const atoms = readAllAtoms(join(lore, 'journal')).filter(a => a.id === `commit:${fullSha}`);
    assert.equal(atoms.length, 2);
    assert.equal(atoms.filter(a => a.enriched).length, 1);
    // fold 合并：why 演化追加、骨架 title 保留
    const folded = foldAtoms(atoms);
    assert.equal(folded.length, 1);
    assert.match(folded[0].why, /补记：为了演示 enrich/);
    assert.equal(folded[0].title, 'feat: add a');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('enrichAtom: 纯 trailer why → 不写 why 键', () => {
  const a = enrichAtom({ sha: 'abc123full', ts: '2026-06-10T01:00:00Z', why: 'Co-Authored-By: Bot <b@x.com>' });
  assert.equal('why' in a, false);
  assert.equal(a.id, 'commit:abc123full');            // 其余字段不变
});

test('CLI: note --why 只有 trailer → 落库原子无 why 键', () => {
  const root = tmpDir();
  try {
    const out = execFileSync('node', ['lib/note.js', root, '--title', 'trailer only', '--why', 'Co-Authored-By: Bot <b@x.com>'], { cwd: process.cwd() }).toString();
    assert.match(out, /noted decision atom note:/);
    const atoms = readAllAtoms(join(root, '.lore', 'journal'));
    assert.equal(atoms.length, 1);
    assert.equal('why' in atoms[0], false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('integration: note → sync folds the decision atom into the component page', () => {
  const root = gitRepo();
  try {
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'a.js'), 'export const x = 1;');
    init({ repoRoot: root, srcSiteDir: join(process.cwd(), 'site') });   // config code_roots:[lib]
    const lore = join(root, '.lore');
    const compDir = join(lore, 'wiki', 'component');
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, 'lib.md'), tokenPage('Lib', 'core'));

    execFileSync('node', ['lib/note.js', root, '--title', 'use ZSET', '--why', 'range queries', '--component', 'lib'], { cwd: process.cwd() });
    execFileSync('node', ['lib/sync.js', 'finalize', lore], { cwd: process.cwd() });

    const page = readFileSync(join(compDir, 'lib.md'), 'utf8');
    assert.match(page, /use ZSET/);          // decision title in the page
    assert.match(page, /range queries/);     // why
    assert.doesNotMatch(page, /\{\{LORE_JOURNAL\}\}/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
