// test/host.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOSTS, readEnabledHosts, writeEnabledHosts, instructionFilesFor, defaultHostsPath, renderCommandFor, installHostCommands, uninstallHostCommands, alignHostAssets, engineRoot, engineVersion } from '../lib/host.js';

test('readEnabledHosts: 文件缺省 → ["claude"]（零变化不变量）', () => {
  assert.deepEqual(readEnabledHosts(join(tmpdir(), 'nonexistent-hosts.json')), ['claude']);
});

test('readEnabledHosts: 坏 JSON / 空数组 / 未知宿主 → 回 ["claude"]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lore-hosts-'));
  try {
    const p = join(dir, 'hosts.json');
    writeFileSync(p, 'not json');
    assert.deepEqual(readEnabledHosts(p), ['claude']);
    writeFileSync(p, JSON.stringify({ hosts: [] }));
    assert.deepEqual(readEnabledHosts(p), ['claude']);
    writeFileSync(p, JSON.stringify({ hosts: ['vim'] }));
    assert.deepEqual(readEnabledHosts(p), ['claude']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeEnabledHosts: 去重 + 过滤未知 + 全未知时 throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lore-hosts-'));
  try {
    const p = join(dir, 'hosts.json');
    assert.deepEqual(writeEnabledHosts(['claude', 'codex', 'codex', 'vim'], p), ['claude', 'codex']);
    assert.deepEqual(readEnabledHosts(p), ['claude', 'codex']);
    assert.throws(() => writeEnabledHosts(['vim'], p), /at least one host/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('instructionFilesFor: codex+opencode 共享 AGENTS.md 去重', () => {
  assert.deepEqual(instructionFilesFor(['claude']), ['CLAUDE.md']);
  assert.deepEqual(instructionFilesFor(['claude', 'codex', 'opencode']), ['CLAUDE.md', 'AGENTS.md']);
  assert.deepEqual(instructionFilesFor(['codex']), ['AGENTS.md']);
});

test('HOSTS 矩阵完整性：三宿主、promptHook 声明', () => {
  assert.deepEqual(Object.keys(HOSTS).sort(), ['claude', 'codex', 'opencode']);
  assert.equal(HOSTS.codex.promptHook, null);          // codex 无机制 → 软档封顶
  assert.equal(HOSTS.claude.commands, null);           // claude 插件自带，不生成
});

test('defaultHostsPath 在 home/.lore 下', () => {
  assert.equal(defaultHostsPath('/h'), join('/h', '.lore', 'hosts.json'));
});

test('renderCommandFor: 占位符替换 + 版本标记 + 三宿主 frontmatter 规则', () => {
  const root = engineRoot();
  const src = readFileSync(join(root, 'commands', 'sync.md'), 'utf8');
  const oc = renderCommandFor('opencode', 'sync.md', src, { root, version: '9.9.9' });
  assert.equal(oc.name, 'lore-sync.md');
  assert.match(oc.text, /^<!-- lore:v9\.9\.9 host:opencode src:sync\.md/);
  assert.ok(oc.text.includes(`${root.replace(/\\/g, '/')}/lib/sync.js`));
  assert.ok(!oc.text.includes('${CLAUDE_PLUGIN_ROOT}'));
  assert.match(oc.text, /^---\r?\ndescription:/m);                       // opencode 保留 frontmatter
  const cx = renderCommandFor('codex', 'sync.md', src, { root, version: '9.9.9' });
  assert.match(cx.text, /^<!-- lore:v9\.9\.9 host:codex /);              // codex 也带 marker（uninstall 靠它识别）
  assert.ok(!/^---\r?\ndescription:/m.test(cx.text));                    // codex 剥 frontmatter
  // 防漂移：opencode 输出 = 标记 + 源文（替换占位符后）逐字相同
  assert.equal(oc.text, `<!-- lore:v9.9.9 host:opencode src:sync.md — 自动生成，勿手改 -->\n` + src.replaceAll('${CLAUDE_PLUGIN_ROOT}', root.replace(/\\/g, '/')));
});

test('installHostCommands: 写全局目录、幂等、内容漂移才重写', () => {
  const home = mkdtempSync(join(tmpdir(), 'lore-home-'));
  try {
    const w1 = installHostCommands('opencode', { home });
    assert.equal(w1.length, 9);                                  // 9 个 commands/*.md
    assert.ok(existsSync(join(home, '.config', 'opencode', 'commands', 'lore-sync.md')));
    assert.deepEqual(installHostCommands('opencode', { home }), []);   // 幂等：无漂移不重写
    assert.equal(installHostCommands('claude', { home }).length, 0);   // claude 不生成
    // 漂移才重写：篡改一个文件 → 只重写它
    writeFileSync(join(home, '.config', 'opencode', 'commands', 'lore-ask.md'), 'tampered');
    assert.deepEqual(installHostCommands('opencode', { home }), ['lore-ask.md']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('uninstallHostCommands: 只删带 lore 标记的文件', () => {
  const home = mkdtempSync(join(tmpdir(), 'lore-home-'));
  try {
    installHostCommands('codex', { home });
    const foreign = join(home, '.codex', 'prompts', 'lore-custom.md');   // 同名但无标记 → 不动
    writeFileSync(foreign, '# 用户自己的 lore-* 文件');
    const removed = uninstallHostCommands('codex', { home });
    assert.equal(removed.length, 9);
    assert.ok(existsSync(foreign));
    assert.ok(!existsSync(join(home, '.codex', 'prompts', 'lore-sync.md')));
    assert.deepEqual(uninstallHostCommands('claude', { home }), []);     // 无 commands 的宿主早退
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('uninstallHostCommands: 真源同名文件标记被抹 → 不动（防误删用户覆盖）', () => {
  const home = mkdtempSync(join(tmpdir(), 'lore-home-'));
  try {
    installHostCommands('codex', { home });
    const hijacked = join(home, '.codex', 'prompts', 'lore-sync.md');    // 在 9 个真源里但标记被抹
    writeFileSync(hijacked, '# 用户自己的同名文件（无 lore 标记）');
    const removed = uninstallHostCommands('codex', { home });
    assert.equal(removed.length, 8);
    assert.ok(existsSync(hijacked));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('alignHostAssets: 只对启用且有 commands 的宿主重生成', () => {
  const home = mkdtempSync(join(tmpdir(), 'lore-home-'));
  try {
    writeEnabledHosts(['claude', 'codex'], join(home, '.lore', 'hosts.json'));   // claude 启用但无 commands → 跳过
    const a1 = alignHostAssets({ home });
    assert.equal(a1.length, 1);
    assert.equal(a1[0].host, 'codex');
    assert.deepEqual(alignHostAssets({ home }), []);              // 幂等
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('engineVersion: bogus root → "0"；正常 root → package.json version', () => {
  assert.equal(engineVersion(join(tmpdir(), 'lore-bogus-root-no-such')), '0');
  const pkg = JSON.parse(readFileSync(join(engineRoot(), 'package.json'), 'utf8'));
  assert.equal(engineVersion(), pkg.version);
});
