// test/lorehook.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateEnrich, looksLikeCodeQuestion, keywords, buildSettingsHooks, installHook, uninstallHook } from '../lib/lorehook.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-hook-')); }

test('looksLikeCodeQuestion: 代码理解问题 true / 闲聊 false', () => {
  assert.equal(looksLikeCodeQuestion('m4 报告怎么生成的'), true);
  assert.equal(looksLikeCodeQuestion('推文管道入口在哪'), true);
  assert.equal(looksLikeCodeQuestion('how does auth work'), true);
  assert.equal(looksLikeCodeQuestion('继续'), false);
  assert.equal(looksLikeCodeQuestion('谢谢，push 一下'), false);
  assert.equal(looksLikeCodeQuestion(''), false);
});

test('keywords: 去停用词留实词喂检索', () => {
  const k = keywords('m4 的报告是怎么生成的');
  assert.match(k, /m4/);
  assert.match(k, /报告/);
  assert.doesNotMatch(k, /怎么|的|是/);     // 疑问词/停用词剔除
});

test('gateEnrich notice: 恒注入混合范式提示（含 lore_ask + 锚点）', () => {
  const r = gateEnrich('随便问点啥', { level: 'notice' });
  assert.equal(r.inject, true);
  assert.match(r.context, /lore_ask/);
  assert.match(r.context, /锚点/);
});

test('gateEnrich inject: 代码问题注入切片；闲聊不注入；无命中不注入', () => {
  const search = () => 'component/m4.md#报告途径\n| 途径 | 触发 |\n|---|---|';
  const hit = gateEnrich('m4 的报告怎么生成的', { level: 'inject', search });
  assert.equal(hit.inject, true);
  assert.match(hit.context, /报告途径/);                                   // 切片内容
  assert.equal(gateEnrich('谢谢，继续', { level: 'inject', search }).inject, false);        // 闲聊门控
  assert.equal(gateEnrich('架构怎样', { level: 'inject', search: () => '' }).inject, false); // 无命中
});

test('buildSettingsHooks: UserPromptSubmit 结构正确（command 含 --level + 绝对路径）', () => {
  const h = buildSettingsHooks('inject', 'D:/lore/lib/lorehook.js');
  const entry = h.UserPromptSubmit[0].hooks[0];
  assert.equal(entry.type, 'command');
  assert.match(entry.command, /lorehook\.js/);
  assert.match(entry.command, /--level=inject/);
  assert.match(entry.command, /run/);
});

test('installHook: 写 settings.local.json、merge 保既有 hook、幂等；uninstall 删 lore 留其他', () => {
  const root = tmp();
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    // 用户已有别的 hook
    writeFileSync(join(root, '.claude', 'settings.local.json'),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo other' }] }] } }));
    installHook(root, 'notice');
    const s1 = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
    const cmds = s1.hooks.UserPromptSubmit.flatMap(g => g.hooks.map(h => h.command));
    assert.ok(cmds.some(c => c.includes('echo other')));                   // 既有 hook 保留
    assert.ok(cmds.some(c => c.includes('lorehook.js')));                  // lore hook 加上
    installHook(root, 'inject');                                          // 切档幂等：不重复 lore 条目
    const s2 = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
    const loreCmds = s2.hooks.UserPromptSubmit.flatMap(g => g.hooks).filter(h => h.command.includes('lorehook.js'));
    assert.equal(loreCmds.length, 1);
    assert.match(loreCmds[0].command, /--level=inject/);                  // 切到 inject
    uninstallHook(root);
    const s3 = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
    const after = s3.hooks.UserPromptSubmit.flatMap(g => g.hooks.map(h => h.command));
    assert.ok(after.some(c => c.includes('echo other')));                 // 别人的留
    assert.ok(!after.some(c => c.includes('lorehook.js')));               // lore 的删
  } finally { rmSync(root, { recursive: true, force: true }); }
});
