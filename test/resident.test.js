// test/resident.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { residentSection, installResident, refreshResident, removeResident, mergeMcpConfig, residentStats } from '../lib/resident.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-res-')); }
const STATS = { pages: 40, deepPages: 8, updated: '2026-06-11' };

test('residentSection: 动态状态进文案 + 标记包裹', () => {
  const s = residentSection(STATS);
  assert.match(s, /<!-- LORE_RESIDENT:START -->/);
  assert.match(s, /40 页 · 8 个组件深度页 · 最后更新 2026-06-11/);
  assert.match(s, /lore_ask/);
  assert.match(s, /lore:sync/);          // fresh-clone 引导（wiki 不进库）
  assert.match(s, /锚点/);                // 混合范式：按 func@file 锚点下钻
  assert.match(s, /下钻/);
  assert.match(s, /section=/);            // 决策史按需取
  assert.match(s, /<!-- LORE_RESIDENT:END -->/);
});

test('installResident: CLAUDE.md 不存在 → 创建（仅标记节）；已存在 → 追加；重复跑幂等替换', () => {
  const root = tmp();
  try {
    installResident(root, STATS);
    const t1 = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    assert.match(t1, /LORE_RESIDENT:START/);
    writeFileSync(join(root, 'CLAUDE.md'), '# 用户自己的内容\n\n' + t1);
    installResident(root, { ...STATS, pages: 41 });
    const t2 = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    assert.match(t2, /用户自己的内容/);                    // 用户内容保留
    assert.match(t2, /41 页/);
    assert.equal((t2.match(/LORE_RESIDENT:START/g)).length, 1);   // 不重复注入
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refreshResident: 有标记节才更新；无 CLAUDE.md / 无标记节 → no-op 不创建', () => {
  const root = tmp();
  try {
    assert.equal(refreshResident(root, STATS), false);     // 无文件 no-op
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false);
    writeFileSync(join(root, 'CLAUDE.md'), '# mine\n');
    assert.equal(refreshResident(root, STATS), false);     // 无标记节 no-op
    installResident(root, STATS);
    assert.equal(refreshResident(root, { ...STATS, pages: 99 }), true);
    assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /99 页/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('removeResident: 删标记节留其余；mergeMcpConfig: 创建/保既有/幂等', () => {
  const root = tmp();
  try {
    writeFileSync(join(root, 'CLAUDE.md'), '# keep\n');
    installResident(root, STATS);
    removeResident(root);
    const t = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    assert.match(t, /keep/);
    assert.doesNotMatch(t, /LORE_RESIDENT/);

    mergeMcpConfig(root, 'D:/engine/lib/mcp.js');
    const m1 = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    assert.equal(m1.mcpServers.lore.command, 'node');
    assert.deepEqual(m1.mcpServers.lore.args, ['D:/engine/lib/mcp.js']);
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' }, lore: { command: 'old' } } }));
    mergeMcpConfig(root, 'D:/engine/lib/mcp.js');
    const m2 = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    assert.equal(m2.mcpServers.other.command, 'x');        // 既有别家 server 保留
    assert.equal(m2.mcpServers.lore.command, 'node');      // lore 条目刷新
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { init } from '../lib/init.js';
import { execFileSync } from 'node:child_process';

test('init 集成: 默认注入 CLAUDE.md 标记节 + .mcp.json；config resident:false 跳过', () => {
  const root = tmp();
  const root2 = tmp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'a.js'), 'export const x=1;');
    init({ repoRoot: root, srcSiteDir: join(process.cwd(), 'site') });
    assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /LORE_RESIDENT:START/);
    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    assert.match(mcp.mcpServers.lore.args[0], /mcp\.js$/);
    // resident:false 的 repo：预置 config 关掉
    execFileSync('git', ['init', '-q'], { cwd: root2 });
    mkdirSync(join(root2, '.lore'), { recursive: true });
    writeFileSync(join(root2, '.lore', 'config.yml'), 'resident: false\naxes:\n  component:\n    code_roots: [lib]\n');
    mkdirSync(join(root2, 'lib'), { recursive: true });
    writeFileSync(join(root2, 'lib', 'a.js'), 'export const x=1;');
    init({ repoRoot: root2, srcSiteDir: join(process.cwd(), 'site') });
    assert.equal(existsSync(join(root2, 'CLAUDE.md')), false);
    assert.equal(existsSync(join(root2, '.mcp.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});

test('residentSection: AGENTS.md 用多宿主 syncHint', () => {
  const s = residentSection({ pages: 1, deepPages: 0, updated: '2026-07-19' }, 'AGENTS.md');
  assert.ok(s.includes('/lore-sync') && s.includes('/prompts:lore-sync'));
  const c = residentSection({ pages: 1, deepPages: 0, updated: '2026-07-19' }, 'CLAUDE.md');
  assert.ok(c.includes('/lore:sync'));
});

test('installResident 多文件: CLAUDE.md + AGENTS.md 都写、幂等、refresh 两文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lore-res-'));
  try {
    installResident(dir, { pages: 3, deepPages: 1, updated: '2026-07-19' }, ['CLAUDE.md', 'AGENTS.md']);
    for (const f of ['CLAUDE.md', 'AGENTS.md']) {
      assert.ok(existsSync(join(dir, f)));
      assert.match(readFileSync(join(dir, f), 'utf8'), /LORE_RESIDENT:START/);
    }
    installResident(dir, { pages: 3, deepPages: 1, updated: '2026-07-19' }, ['CLAUDE.md', 'AGENTS.md']);   // 幂等
    const changed = refreshResident(dir, { pages: 9, deepPages: 1, updated: '2026-07-20' }, ['CLAUDE.md', 'AGENTS.md']);
    assert.equal(changed, true);
    assert.ok(readFileSync(join(dir, 'AGENTS.md'), 'utf8').includes('9 页'));
    removeResident(dir, ['CLAUDE.md', 'AGENTS.md']);
    assert.ok(!readFileSync(join(dir, 'CLAUDE.md'), 'utf8').includes('LORE_RESIDENT'));
    assert.ok(!readFileSync(join(dir, 'AGENTS.md'), 'utf8').includes('LORE_RESIDENT'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('residentStats: 从 manifest 算 {pages, deepPages, updated}；无 manifest → 零值', () => {
  const root = tmp();
  try {
    const lore = join(root, '.lore');
    assert.deepEqual(residentStats(lore), { pages: 0, deepPages: 0, updated: '尚未 sync' });
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    writeFileSync(join(lore, 'wiki', '.manifest.json'), JSON.stringify({
      generated: '2026-06-11T08:00:00Z',
      axes: [
        { id: 'component', pages: [{ id: 'lib', group: '' }, { id: 'sync', group: '合成' }, { id: 'hook', group: '捕获' }] },
        { id: 'docs', pages: [{ id: 'ROADMAP', group: '项目状态' }] },
      ],
    }));
    assert.deepEqual(residentStats(lore), { pages: 4, deepPages: 2, updated: '2026-06-11' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
