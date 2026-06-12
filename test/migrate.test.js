// test/migrate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readMigrations, appendMigration, alignShell, SHELL_FILES, alignHookStub, renderHookStub, HOOK_MARKER } from '../lib/migrate.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-mig-')); }

test('migrations: 缺文件/坏 JSON → 空 Set；append → 读回；幂等', () => {
  const st = tmp();
  try {
    assert.equal(readMigrations(st).size, 0);
    writeFileSync(join(st, 'migrations.json'), '{broken');
    assert.equal(readMigrations(st).size, 0);
    appendMigration(st, 'config:axes.docs');
    appendMigration(st, 'config:axes.docs');           // 重复 append 幂等
    appendMigration(st, 'resident:install');
    const s = readMigrations(st);
    assert.deepEqual([...s].sort(), ['config:axes.docs', 'resident:install']);
  } finally { rmSync(st, { recursive: true, force: true }); }
});

test('alignShell: 目标缺 → installed；内容同 → 零动作；stale → refreshed；引擎缺文件 → 跳过', () => {
  const eng = tmp(); const lore = tmp();
  try {
    writeFileSync(join(eng, 'index.html'), '<html>v2</html>');
    writeFileSync(join(eng, 'shell.mjs'), 'export const v = 2;');
    // mermaid.min.js 故意不建 → 跳过不抛
    const a1 = alignShell(eng, lore);
    assert.deepEqual(a1.map(x => x.action), ['installed', 'installed']);
    assert.equal(readFileSync(join(lore, 'site', 'shell.mjs'), 'utf8'), 'export const v = 2;');
    assert.deepEqual(alignShell(eng, lore), []);        // 幂等
    writeFileSync(join(lore, 'site', 'shell.mjs'), 'export const v = 1;');   // stale
    const a2 = alignShell(eng, lore);
    assert.deepEqual(a2, [{ asset: 'shell:shell.mjs', action: 'refreshed' }]);
    assert.equal(readFileSync(join(lore, 'site', 'shell.mjs'), 'utf8'), 'export const v = 2;');
  } finally { rmSync(eng, { recursive: true, force: true }); rmSync(lore, { recursive: true, force: true }); }
});

test('alignHookStub: absent → installed；老内容含 MARKER → refreshed；一致 → present；foreign → foreign 不碰', () => {
  const root = tmp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const r1 = alignHookStub(root, 'D:/engine/lib/hook.js', 'journal:\n  hook: true\n');
    assert.equal(r1.status, 'installed');
    const hookPath = join(root, '.git', 'hooks', 'post-commit');
    assert.match(readFileSync(hookPath, 'utf8'), /D:\/engine\/lib\/hook\.js/);
    assert.equal(alignHookStub(root, 'D:/engine/lib/hook.js', '').status, 'present');     // 幂等
    const r2 = alignHookStub(root, 'D:/engine2/lib/hook.js', '');                          // 引擎挪位置
    assert.equal(r2.status, 'refreshed');
    assert.match(readFileSync(hookPath, 'utf8'), /D:\/engine2\/lib\/hook\.js/);
    writeFileSync(hookPath, '#!/bin/sh\necho mine\n');                                     // foreign
    assert.equal(alignHookStub(root, 'D:/engine/lib/hook.js', '').status, 'foreign');
    assert.match(readFileSync(hookPath, 'utf8'), /echo mine/);                             // 未被碰
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('alignHookStub: journal hook:false → disabled 不装；非 git 目录 → no-git', () => {
  const root = tmp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    assert.equal(alignHookStub(root, 'D:/e/hook.js', 'journal:\n  hook: false\n').status, 'disabled');
    assert.equal(existsSync(join(root, '.git', 'hooks', 'post-commit')), false);
    const plain = tmp();
    try { assert.equal(alignHookStub(plain, 'D:/e/hook.js', '').status, 'no-git'); }
    finally { rmSync(plain, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
