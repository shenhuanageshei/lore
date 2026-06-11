// test/hook.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureHead } from '../lib/hook.js';
import { readAllAtoms } from '../lib/journal.js';
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
