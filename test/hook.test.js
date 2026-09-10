// test/hook.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { captureHead } from '../lib/hook.js';
import { readAllAtoms } from '../lib/journal.js';
import { validateAtom } from '../lib/atom.js';
import { init } from '../lib/init.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-hook-')); }
function gitRepo() {
  const root = tmpDir();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  return root;
}
function commitFile(root, rel, content, msg) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', msg], { cwd: root });
}

test('captureHead writes HEAD commit atom (source=hook), idempotent', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'x', 'add lib');
    const journalDir = join(root, '.lore', 'journal');
    const r1 = captureHead({ repoRoot: root, journalDir, codeRoots: ['lib'] });
    assert.equal(r1.added, 1);
    const atoms = readAllAtoms(journalDir);
    assert.equal(atoms.length, 1);
    assert.equal(atoms[0].title, 'add lib');
    assert.equal(atoms[0].source, 'hook');
    assert.deepEqual(atoms[0].facets.component, ['lib']);
    assert.equal(captureHead({ repoRoot: root, journalDir, codeRoots: ['lib'] }).added, 0);  // idempotent
    assert.equal(readAllAtoms(journalDir).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('captureHead: trailer-only commit body → 原子不写 why 键；真实 body 剥净签名', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'x', 'feat: t\n\nCo-Authored-By: Bot <b@x.com>\n🤖 Generated with [Claude Code](https://x)');
    const journalDir = join(root, '.lore', 'journal');
    assert.equal(captureHead({ repoRoot: root, journalDir, codeRoots: ['lib'] }).added, 1);
    const atom = readAllAtoms(journalDir)[0];
    assert.equal('why' in atom, false);
    // 对照：真实 body → why 保留且无签名
    commitFile(root, 'lib/b.js', 'y', 'feat: u\n\nreal rationale\nSigned-off-by: D <d@x.com>');
    assert.equal(captureHead({ repoRoot: root, journalDir, codeRoots: ['lib'] }).added, 1);
    const second = readAllAtoms(journalDir).find(a => a.title === 'feat: u');
    assert.equal(second.why, 'real rationale');
    assert.doesNotMatch(second.why, /Co-Authored-By|Signed-off-by|Generated with/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- S1：hook 入口经 lib/journal.js 校验闸门 ----------
test('captureHead 落盘原子过校验且 status:draft（机器来源诚实，不变量⑦）', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'x', 'feat: y\n\nreal rationale\nCo-Authored-By: Bot <b@x.com>');
    const journalDir = join(root, '.lore', 'journal');
    assert.equal(captureHead({ repoRoot: root, journalDir, codeRoots: ['lib'] }).added, 1);
    const atom = readAllAtoms(journalDir)[0];
    assert.equal(atom.status, 'draft');                              // source:'hook' 缺 status → 落盘 draft
    assert.equal(atom.why, 'real rationale');                        // 写入侧 trailer 闭合（经校验落盘）
    assert.equal(validateAtom(atom).ok, true, JSON.stringify(validateAtom(atom).errors));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- ① 期遗留 B②：hook 路径的校验拒绝必须可观测（但绝不挡提交） ----------
// 手工构造一个 git 提交对象，其 author 行**没有可解析的时间戳**——git 自己写不出这种提交
// （GIT_AUTHOR_DATE 会被归一化），只能用 plumbing（hash-object --literally）落。
// 实测 git log 的 %aI 对不可解析日期回吐非 ISO 占位符（"%aI"）→ commitAtom 的 ts 非法
// → lib/journal.js 的写入闸门抛 AtomRejected。这是确定性地造出「hook 路径遇 AtomRejected」的手段。
function commitWithUnparseableDate(root, message) {
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root }).toString().trim();
  const body = ['tree ' + tree, 'author A <a@a>', 'committer A <a@a> 1757000000 +0000', '', message, ''].join('\n');
  const sha = execFileSync('git', ['hash-object', '--literally', '-t', 'commit', '-w', '--stdin'],
    { cwd: root, input: body }).toString().trim();
  const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root }).toString().trim();
  execFileSync('git', ['update-ref', `refs/heads/${branch}`, sha], { cwd: root });
  return sha;
}

test('hook CLI: AtomRejected → stderr 打一行 lore:、退出码仍 0、一个字节都不落', () => {
  const root = gitRepo();
  const plain = tmpDir();   // 非 git 目录：用来对照「非 AtomRejected 的错误仍静默」
  try {
    commitFile(root, 'a.txt', '1', 'base');          // 先要有一个 HEAD（HEAD^{tree} 要用）
    const sha = commitWithUnparseableDate(root, 'feat: 时间戳不可解析');

    const r = spawnSync(process.execPath, ['lib/hook.js', root], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(r.status, 0);                       // post-commit 钩子永不挡提交
    assert.match(r.stderr, /^lore: refusing to write invalid atom "commit:[0-9a-f]+": ts: /m);
    assert.ok(r.stderr.includes(sha));               // 报的就是这条坏提交
    assert.equal(r.stdout, '');
    assert.equal(existsSync(join(root, '.lore', 'journal')), false);   // 拒绝路径不产生半行

    // 对照：非 AtomRejected 的错误（不是 git 仓库）不产生 lore: 行——钩子自己不该刷屏
    // （git 自己的 "fatal: not a git repository" 走的是 execFileSync 继承来的 stderr，与本模块无关）
    const q = spawnSync(process.execPath, ['lib/hook.js', plain], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(q.status, 0);
    assert.doesNotMatch(q.stderr, /^lore: /m);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

test('captureHead on a merge HEAD adds nothing new on the second call', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'a.txt', '1', 'base');
    execFileSync('git', ['checkout', '-q', '-b', 'feat'], { cwd: root });
    commitFile(root, 'b.txt', '2', 'feat commit');
    execFileSync('git', ['checkout', '-q', '-'], { cwd: root });   // back to the default branch
    commitFile(root, 'c.txt', '3', 'main commit');                  // divergent → real merge
    execFileSync('git', ['merge', '-q', '--no-ff', '-m', 'merge feat', 'feat'], { cwd: root });
    const journalDir = join(root, '.lore', 'journal');
    captureHead({ repoRoot: root, journalDir, codeRoots: [] });
    const second = captureHead({ repoRoot: root, journalDir, codeRoots: [] });
    assert.equal(second.added, 0);   // idempotent regardless of merge-HEAD fallback
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI never throws / exits 0 even on a non-git dir', () => {
  const root = tmpDir();   // not a git repo
  try {
    execFileSync('node', ['lib/hook.js', root], { cwd: process.cwd() });   // must not throw
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('captureHead tags theme from config themes', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'x', 'improve accuracy');
    const journalDir = join(root, '.lore', 'journal');
    const r = captureHead({ repoRoot: root, journalDir, codeRoots: ['lib'], themes: [{ id: 'quality', match: ['accuracy'] }] });
    assert.equal(r.added, 1);
    assert.deepEqual(readAllAtoms(journalDir)[0].facets.theme, ['quality']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('integration: init installs hook → a real commit auto-writes a journal atom', () => {
  const root = gitRepo();   // helper already in this file: git init + user config, no commit yet
  try {
    // a discoverable code dir so init writes code_roots: [lib]
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'a.js'), 'export const x = 1;');
    const r = init({ repoRoot: root, srcSiteDir: join(process.cwd(), 'site') });
    assert.equal(r.hook, 'installed');

    // a real commit AFTER init → the installed post-commit hook fires and captures it
    writeFileSync(join(root, 'lib', 'b.js'), 'export const y = 2;');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'add b'], { cwd: root });

    const atoms = readAllAtoms(join(root, '.lore', 'journal'));
    const added = atoms.find(a => a.title === 'add b');
    assert.ok(added, 'hook should have captured the "add b" commit');
    assert.equal(added.source, 'hook');
    assert.deepEqual(added.facets.component, ['lib']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('captureHead tags flow from config flows', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'x', 'lib change');
    const journalDir = join(root, '.lore', 'journal');
    const r = captureHead({ repoRoot: root, journalDir, codeRoots: ['lib'], flows: [{ id: 'pipe', spans: ['lib'] }] });
    assert.equal(r.added, 1);
    assert.deepEqual(readAllAtoms(journalDir)[0].facets.flow, ['pipe']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- maybeRefresh (Task 6): commit-time detached mechanical finalize ---
import { maybeRefresh } from '../lib/hook.js';

test('maybeRefresh: 有 manifest → spawn finalize（detached）', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mr-'));
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    writeFileSync(join(lore, 'wiki', '.manifest.json'), '{"axes":[]}');
    const calls = [];
    const r = maybeRefresh({ loreDir: lore, spawnFn: (cmd, args) => { calls.push({ cmd, args }); return { unref() {} }; } });
    assert.equal(r.spawned, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[1], 'finalize');            // node sync.js finalize <lore>
    assert.equal(calls[0].args[2], lore);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('maybeRefresh: 无 manifest → 不 spawn', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mr-'));
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    let spawned = false;
    const r = maybeRefresh({ loreDir: lore, spawnFn: () => { spawned = true; return { unref() {} }; } });
    assert.equal(r.spawned, false);
    assert.equal(spawned, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('maybeRefresh: spawn 抛错也不抛出（best-effort）', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mr-'));
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    writeFileSync(join(lore, 'wiki', '.manifest.json'), '{"axes":[]}');
    const r = maybeRefresh({ loreDir: lore, spawnFn: () => { throw new Error('boom'); } });
    assert.equal(r.spawned, false);                        // 吞掉异常、返回未 spawn
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { writeSyncMode } from '../lib/syncstate.js';

test('maybeRefresh: mode=manual → 不 spawn（自动刷新关闭）', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mr-'));
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    writeFileSync(join(lore, 'wiki', '.manifest.json'), '{"axes":[]}');
    writeSyncMode(join(lore, '.state'), 'manual');
    let spawned = false;
    const r = maybeRefresh({ loreDir: lore, spawnFn: () => { spawned = true; return { unref() {} }; } });
    assert.equal(r.spawned, false);
    assert.equal(r.reason, 'manual');
    assert.equal(spawned, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('maybeRefresh: mode=notify（显式写入）→ spawn 照旧', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mr-'));
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    writeFileSync(join(lore, 'wiki', '.manifest.json'), '{"axes":[]}');
    writeSyncMode(join(lore, '.state'), 'notify');
    const calls = [];
    const r = maybeRefresh({ loreDir: lore, spawnFn: (cmd, args) => { calls.push(args); return { unref() {} }; } });
    assert.equal(r.spawned, true);
    assert.equal(calls.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { readAutoPending } from '../lib/syncstate.js';

test('maybeRefresh: mode=auto → 写 pending 时间戳 + 照旧 spawn finalize；notify 不写 pending', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mr-'));
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    writeFileSync(join(lore, 'wiki', '.manifest.json'), '{"axes":[]}');
    writeSyncMode(join(lore, '.state'), 'auto');
    const calls = [];
    const r = maybeRefresh({ loreDir: lore, spawnFn: (cmd, args) => { calls.push(args); return { unref() {} }; } });
    assert.equal(r.spawned, true);                                  // 机械 finalize 照旧
    assert.equal(calls.length, 1);
    assert.notEqual(readAutoPending(join(lore, '.state')), null);   // pending 写了
    // notify 对照：不写 pending
    const root2 = mkdtempSync(join(tmpdir(), 'lore-mr-'));
    const lore2 = join(root2, '.lore');
    mkdirSync(join(lore2, 'wiki'), { recursive: true });
    writeFileSync(join(lore2, 'wiki', '.manifest.json'), '{"axes":[]}');
    maybeRefresh({ loreDir: lore2, spawnFn: () => ({ unref() {} }) });
    assert.equal(readAutoPending(join(lore2, '.state')), null);
    rmSync(root2, { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
