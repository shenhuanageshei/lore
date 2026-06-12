// lib/migrate.js —— 期望态对齐器（spec 2026-06-11-lore-migrate-design）。
// 引擎升级后 repo 内资产自动收敛：收敛型「算期望→比实际→不同才写」；
// 一次性迁移记 .state/migrations.json（applied 后用户删除不复活——用户主权）。
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- 一次性迁移记录（best-effort：读坏 → 空，同 syncstate 风格） ----------
export function readMigrations(stateDir) {
  try {
    const j = JSON.parse(readFileSync(join(stateDir, 'migrations.json'), 'utf8'));
    return new Set(Array.isArray(j.applied) ? j.applied : []);
  } catch { return new Set(); }
}

export function appendMigration(stateDir, id) {
  const s = readMigrations(stateDir);
  s.add(id);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'migrations.json'), JSON.stringify({ applied: [...s] }, null, 2) + '\n');
}

// ---------- 壳（收敛型）：引擎 site/ 是期望源；.lore/site/ 是引擎领地，手改会被覆盖 ----------
export const SHELL_FILES = ['index.html', 'shell.mjs', 'mermaid.min.js'];

export function alignShell(engineSiteDir, loreDir) {
  const dest = join(loreDir, 'site');
  mkdirSync(dest, { recursive: true });
  const actions = [];
  for (const f of SHELL_FILES) {
    const src = join(engineSiteDir, f);
    if (!existsSync(src)) continue;                    // 引擎缺该文件（如测试夹具）→ 跳过
    const dst = join(dest, f);
    const want = readFileSync(src);
    const had = existsSync(dst);
    if (had && want.equals(readFileSync(dst))) continue;
    copyFileSync(src, dst);
    actions.push({ asset: `shell:${f}`, action: had ? 'refreshed' : 'installed' });
  }
  return actions;
}

// ---------- 总入口（后续逐资产挂载；单资产失败不挡其他） ----------
export function alignAssets(repoRoot, loreDir, opts = {}) {
  const engineSiteDir = opts.engineSiteDir ?? join(HERE, '..', 'site');
  const actions = [];
  const guard = (name, fn) => {
    try { actions.push(...fn()); }
    catch { actions.push({ asset: name, action: 'error' }); }
  };
  guard('shell', () => alignShell(engineSiteDir, loreDir));
  return actions;
}

export function formatActions(actions) {
  return actions.map(a => `${a.asset}:${a.action}`).join(', ');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(process.argv[2] ?? process.cwd());
  const loreDir = join(repoRoot, '.lore');
  if (!existsSync(loreDir)) {
    console.error(`no .lore at ${repoRoot} — run /lore:init first`);
    process.exit(1);
  }
  const actions = alignAssets(repoRoot, loreDir);
  if (actions.length) console.log('migrate: ' + formatActions(actions));
}
