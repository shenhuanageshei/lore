// test/host.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOSTS, readEnabledHosts, writeEnabledHosts, instructionFilesFor, defaultHostsPath } from '../lib/host.js';

test('readEnabledHosts: 文件缺省 → ["claude"]（零变化不变量）', () => {
  assert.deepEqual(readEnabledHosts(join(tmpdir(), 'nonexistent-hosts.json')), ['claude']);
});

test('readEnabledHosts: 坏 JSON / 空数组 / 未知宿主 → 回 ["claude"]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lore-hosts-'));
  const p = join(dir, 'hosts.json');
  writeFileSync(p, 'not json');
  assert.deepEqual(readEnabledHosts(p), ['claude']);
  writeFileSync(p, JSON.stringify({ hosts: [] }));
  assert.deepEqual(readEnabledHosts(p), ['claude']);
  writeFileSync(p, JSON.stringify({ hosts: ['vim'] }));
  assert.deepEqual(readEnabledHosts(p), ['claude']);
});

test('writeEnabledHosts: 去重 + 过滤未知 + 全未知时 throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lore-hosts-'));
  const p = join(dir, 'hosts.json');
  assert.deepEqual(writeEnabledHosts(['claude', 'codex', 'codex', 'vim'], p), ['claude', 'codex']);
  assert.deepEqual(readEnabledHosts(p), ['claude', 'codex']);
  assert.throws(() => writeEnabledHosts(['vim'], p), /at least one host/);
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
