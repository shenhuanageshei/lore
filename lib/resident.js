// lib/resident.js —— agent 常驻消费的触发面（spec 2026-06-11-lore-agent-residency）。
// CLAUDE.md 是用户文件：只动 LORE_RESIDENT 标记节内、幂等替换、可一键卸载——侵入克制。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const START = '<!-- LORE_RESIDENT:START -->';
const END = '<!-- LORE_RESIDENT:END -->';
const BLOCK_RE = /<!--\s*LORE_RESIDENT:START\s*-->[\s\S]*?<!--\s*LORE_RESIDENT:END\s*-->/;

export function residentSection({ pages, deepPages, updated }) {
  return `${START}
## lore wiki（本仓库的活文档）

本 repo 由 lore 维护多轴 wiki（${pages} 页 · ${deepPages} 个组件深度页 · 最后更新 ${updated}）。
**理解架构、查找模块职责、查决策原因时，先查 wiki 再 grep 源码**：
- MCP 工具：\`lore_ask\`（关键词检索，返回命中节）→ \`lore_page\`（取单页/单节，\`view=agent\` 省 40% token）→ \`lore_neighbors\`（图谱扩展）
- 无 MCP 时：读 \`.lore/wiki/INDEX.md\` 定位 → 读目标页
- wiki 缺失（fresh clone：wiki 不进库）→ 先跑 \`/lore:sync\` 合成
- 决策史/踩坑/「为什么不那样做」只有 wiki 有——源码注释和 git log 都查不动这类问题。
${END}`;
}

// 从 manifest 算注入文案的动态状态。无 manifest（未 sync）→ 零值占位。
export function residentStats(loreDir) {
  const p = join(loreDir, 'wiki', '.manifest.json');
  if (!existsSync(p)) return { pages: 0, deepPages: 0, updated: '尚未 sync' };
  try {
    const m = JSON.parse(readFileSync(p, 'utf8'));
    let pages = 0, deepPages = 0;
    for (const ax of m.axes ?? []) {
      pages += (ax.pages ?? []).length;
      if (ax.id === 'component') deepPages += (ax.pages ?? []).filter(pg => pg.group).length;
    }
    return { pages, deepPages, updated: (m.generated ?? '').slice(0, 10) || '未知' };
  } catch { return { pages: 0, deepPages: 0, updated: '尚未 sync' }; }
}

// init 时注入：无 CLAUDE.md 创建；有则替换标记节或末尾追加。幂等。
export function installResident(repoRoot, stats) {
  const p = join(repoRoot, 'CLAUDE.md');
  const block = residentSection(stats);
  if (!existsSync(p)) { writeFileSync(p, block + '\n'); return; }
  const text = readFileSync(p, 'utf8');
  writeFileSync(p, BLOCK_RE.test(text)
    ? text.replace(BLOCK_RE, block)
    : text.replace(/\n*$/, '\n\n') + block + '\n');
}

// finalize 末尾刷新：仅当文件存在且已有标记节（用户关掉/删掉 = 尊重，不复活）。
export function refreshResident(repoRoot, stats) {
  const p = join(repoRoot, 'CLAUDE.md');
  if (!existsSync(p)) return false;
  const text = readFileSync(p, 'utf8');
  if (!BLOCK_RE.test(text)) return false;
  writeFileSync(p, text.replace(BLOCK_RE, residentSection(stats)));
  return true;
}

export function removeResident(repoRoot) {
  const p = join(repoRoot, 'CLAUDE.md');
  if (!existsSync(p)) return;
  const text = readFileSync(p, 'utf8');
  if (!BLOCK_RE.test(text)) return;
  writeFileSync(p, text.replace(BLOCK_RE, '').replace(/\n{3,}/g, '\n\n'));
}

// .mcp.json merge：不覆盖其他 server；lore 条目以本次为准（引擎路径与 hook 同策略——挪位置重跑 init）。
export function mergeMcpConfig(repoRoot, mcpJsPath) {
  const p = join(repoRoot, '.mcp.json');
  let cfg = {};
  if (existsSync(p)) { try { cfg = JSON.parse(readFileSync(p, 'utf8')) ?? {}; } catch { cfg = {}; } }
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), lore: { command: 'node', args: [mcpJsPath] } };
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
}
