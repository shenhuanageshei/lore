// test/note.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendNote, noteAtom } from '../lib/note.js';
import { AtomRejected, readAllAtoms } from '../lib/journal.js';
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

// ---------- S8：agent 代捕获约定（--draft ⇒ status:'draft'，过 S1 的「机器来源 ⇒ draft」规则） ----------
import { normalizeAtom, validateAtom } from '../lib/atom.js';
import { main as cliMain } from '../lib/cli.js';

test('noteAtom 默认不加 status（默认行为不变）', () => {
  const a = noteAtom({ id: 'note:d0', ts: '2026-09-09T08:00:00Z', title: 't', why: 'w' });
  assert.equal('status' in a, false);
  assert.equal(normalizeAtom(a).atom.status, 'draft');    // S1 归一化仍按机器来源补 draft
});

test("noteAtom draft:true → status:'draft'，且过 S1 校验（机器来源只能是草稿）", () => {
  const a = noteAtom({ id: 'note:d1', ts: '2026-09-09T08:00:00Z', title: '选 X 弃 Y', why: '因为 Z', draft: true });
  assert.equal(a.status, 'draft');
  assert.equal(a.source, 'agent');                        // 机器来源
  assert.equal(validateAtom(a).ok, true, JSON.stringify(validateAtom(a).errors));
  const norm = normalizeAtom(a);
  assert.equal(norm.ok, true);
  assert.equal(norm.atom.status, 'draft');
  assert.equal(validateAtom({ ...a, status: 'confirmed' }).ok, false);   // 机器来源不可能是 confirmed（无 confirmed_by）
});

test('noteAtom anchors: 非空才写 refs.anchors（空数组不写，refs 形状不漂移）', () => {
  const withAnchors = noteAtom({ id: 'note:a1', ts: '2026-09-09T08:00:00Z', title: 't', why: 'w', anchors: ['runAuto @ lib/runner.js:77'] });
  assert.deepEqual(withAnchors.refs.anchors, ['runAuto @ lib/runner.js:77']);
  assert.equal(validateAtom(withAnchors).ok, true);
  const empty = noteAtom({ id: 'note:a2', ts: '2026-09-09T08:00:00Z', title: 't', why: 'w' });
  assert.equal('anchors' in empty.refs, false);
  assert.deepEqual(empty.refs, { files: [], pitfall: null, related: [] });   // 与既有形状逐字一致
});

test('CLI: node lib/note.js --draft --anchors → 原子 status:draft + 源码锚点', () => {
  const root = tmpDir();
  try {
    const out = execFileSync('node', ['lib/note.js', root, '--title', '选 X 弃 Y', '--why', '因为 Z', '--draft',
      '--anchors', 'runAuto @ lib/runner.js:77,planSync @ lib/sync.js:12'], { cwd: process.cwd() }).toString();
    assert.match(out, /noted decision atom note:.*\(draft\)/);
    const atoms = readAllAtoms(join(root, '.lore', 'journal'));
    assert.equal(atoms.length, 1);
    assert.equal(atoms[0].status, 'draft');
    assert.deepEqual(atoms[0].refs.anchors, ['runAuto @ lib/runner.js:77', 'planSync @ lib/sync.js:12']);
    assert.equal(validateAtom(atoms[0]).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lore note --draft（统一 CLI）：status:draft 落库；默认（无 --draft）落盘同样是 draft；未 init → exit 1 不写散文件', () => {
  const root = tmpDir();
  try {
    // 未 init → 明确报错，不静默写散文件
    const sink = [];
    assert.equal(cliMain(['note', '--title', 't', '--why', 'w', '--draft', '--root', root],
      { cwd: process.cwd(), out: s => sink.push(s), err: s => sink.push(s) }), 1);
    assert.match(sink.join('\n'), /no \.lore at/);
    assert.equal(existsSync(join(root, '.lore')), false);

    mkdirSync(join(root, '.lore'), { recursive: true });
    const ok = [];
    assert.equal(cliMain(['note', '--title', '选 X 弃 Y', '--why', '因为 Z', '--draft', '--component', 'lib',
      '--anchors', 'runAuto @ lib/runner.js:77', '--root', root],
      { cwd: process.cwd(), out: s => ok.push(s), err: s => ok.push(s) }), 0);
    assert.match(ok.join('\n'), /✓ note note:.*\(draft\)/);

    assert.equal(cliMain(['note', '--title', 'plain', '--why', 'w', '--root', root],
      { cwd: process.cwd(), out: () => {}, err: () => {} }), 0);

    const atoms = readAllAtoms(join(root, '.lore', 'journal'));
    assert.equal(atoms.length, 2);
    const draft = atoms.find(a => a.title === '选 X 弃 Y');
    assert.equal(draft.status, 'draft');
    assert.deepEqual(draft.facets.component, ['lib']);
    assert.deepEqual(draft.refs.anchors, ['runAuto @ lib/runner.js:77']);
    assert.equal(validateAtom(draft).ok, true);
    const plain = atoms.find(a => a.title === 'plain');
    // S1：写入经 lib/journal.js 的校验闸门 → 机器来源（source:'agent'）缺 status 落盘为 draft（不变量⑦）。
    // noteAtom 本身仍不写 status 键（纯形状不变，见上面「noteAtom 默认不加 status」），补 draft 发生在落盘时。
    assert.equal(plain.status, 'draft');
    assert.equal(validateAtom(plain).ok, true);
    // 缺 --title → 用法错误 exit 1
    const bad = [];
    assert.equal(cliMain(['note', '--why', 'w', '--root', root], { cwd: process.cwd(), out: s => bad.push(s), err: s => bad.push(s) }), 1);
    assert.match(bad.join('\n'), /note requires --title/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- S1：写入路径接线（note 入口经 lib/journal.js 校验闸门） ----------
test('appendNote 经校验落盘：返回值 = 盘上那条（status:draft）；why 已剥 trailer', () => {
  const root = tmpDir();
  try {
    const returned = appendNote(root, { title: '选 X 弃 Y', why: 'real why\nCo-Authored-By: Bot <b@x>', component: ['lib'] });
    assert.equal(returned.status, 'draft');                        // 机器来源缺 status → draft
    const [stored] = readAllAtoms(join(root, '.lore', 'journal'));
    assert.deepEqual(stored, returned);                            // 返回值就是落盘原子
    assert.equal(stored.why, 'real why');                          // 写入侧 trailer 闭合（显式回归断言）
    assert.doesNotMatch(stored.why, /Co-Authored-By/);
    assert.equal(validateAtom(stored).ok, true);
    const noWhy = appendNote(root, { title: 'trailer only', why: 'Generated with Codex' });
    assert.equal('why' in readAllAtoms(join(root, '.lore', 'journal')).find(a => a.id === noWhy.id), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('appendNote 非法原子（缺 title）→ AtomRejected 可读错误，不落半行', () => {
  const root = tmpDir();
  try {
    assert.throws(() => appendNote(root, { title: '', why: 'w' }), (e) => {
      assert.ok(e instanceof AtomRejected);
      assert.match(e.message, /title: missing-title/);
      return true;
    });
    assert.equal(existsSync(join(root, '.lore', 'journal')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- ① 期遗留 B①：note 旧入口不吞旗标（写入侧错误可见性） ----------
test('CLI: 旗标吞旗标（node lib/note.js --title --why x）→ 解析期报错 exit 1，一个字节都不落', () => {
  const root = tmpDir();
  try {
    for (const [argv, flag] of [
      [['--title', '--why', 'x'], 'title'],            // 旧实现把 title 写成字面 '--why' 并落坏原子
      [['--title', 't', '--why', '--draft'], 'why'],
      [['--enrich', '--why', 'w'], 'enrich'],
    ]) {
      const r = spawnSync(process.execPath, ['lib/note.js', root, ...argv], { cwd: process.cwd(), encoding: 'utf8' });
      assert.equal(r.status, 1, argv.join(' '));
      assert.match(r.stderr, new RegExp(`^lore: flag --${flag} requires a value$`, 'm'), argv.join(' '));
      assert.match(r.stderr, /usage: node lib\/note\.js/, argv.join(' '));
      assert.equal(r.stdout, '', argv.join(' '));       // 解析失败 → 一个 verb 都不跑
    }
    assert.equal(existsSync(join(root, '.lore', 'journal')), false);
    assert.deepEqual(readAllAtoms(join(root, '.lore', 'journal')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: node lib/note.js 落盘原子 status:draft（机器来源诚实）+ 过校验', () => {
  const root = tmpDir();
  try {
    execFileSync('node', ['lib/note.js', root, '--title', 'plain cli', '--why', 'w'], { cwd: process.cwd() });
    const [a] = readAllAtoms(join(root, '.lore', 'journal'));
    assert.equal(a.status, 'draft');
    assert.equal(validateAtom(a).ok, true, JSON.stringify(validateAtom(a).errors));
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
