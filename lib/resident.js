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
**理解架构/查模块/查决策时，先用 wiki 建框架、再按锚点下钻源码——别一上来全文 grep。**
- **建框架**：\`lore_ask "<关键词>"\`（返回命中节切片，含内容）→ \`lore_page view=agent\`（跳概览+决策史，只看机制骨架，省约 60% token）。无 MCP 时跑 \`node <lore>/lib/ask.js .lore "<关键词>"\` 或读 \`.lore/wiki/INDEX.md\` 定位。
- **精准下钻**：wiki 页内锚点写作 \`func @ file\`——顺锚点直接 Read 那个函数/文件，不要全文 grep（wiki 是带导航的源码地图）。
- **查「为什么/决策史/踩坑」**：\`lore_page section="Decision history"\`（决策史只有 wiki 有，源码注释和 git log 都查不动）。
- wiki 缺失（fresh clone：wiki 不进库）→ 先跑 \`/lore:sync\` 合成。
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
