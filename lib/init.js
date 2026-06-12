import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { registerRepo, defaultReposPath } from './repos.js';
import { installResident, mergeMcpConfig, residentStats } from './resident.js';
import { parseConfigResident } from './config.js';
import { alignHookStub } from './migrate.js';

const LORE_SUBDIRS = ['journal', 'wiki', 'site', '.state'];

export function scaffold(loreDir) {
  for (const d of LORE_SUBDIRS) mkdirSync(join(loreDir, d), { recursive: true });
}

const SHELL_FILES = ['index.html', 'shell.mjs', 'mermaid.min.js'];

export function copyShell(srcSiteDir, loreDir) {
  const dest = join(loreDir, 'site');
  mkdirSync(dest, { recursive: true });
  for (const f of SHELL_FILES) copyFileSync(join(srcSiteDir, f), join(dest, f));
  return [...SHELL_FILES];
}

const IGNORE_LINE = '.lore/.state/';

export function ensureGitignore(repoRoot) {
  const p = join(repoRoot, '.gitignore');
  if (!existsSync(p)) {
    writeFileSync(p, IGNORE_LINE + '\n');
    return 'created';
  }
  const text = readFileSync(p, 'utf8');
  if (text.split(/\r?\n/).some(l => l.trim() === IGNORE_LINE)) return 'present';
  const sep = text === '' || text.endsWith('\n') ? '' : '\n';
  appendFileSync(p, sep + IGNORE_LINE + '\n');
  return 'appended';
}

const EXCLUDE = new Set([
  '.git', '.lore', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache',
  'dist', 'build', 'out', 'target', 'vendor', 'coverage',
  'docs', 'doc', 'tests', 'test', '__tests__', 'config', '.github', '.idea', '.vscode',
]);

const CODE_EXT = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs',
  '.java', '.kt', '.rb', '.php', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.swift', '.scala', '.sh',
]);

function topDirs(repoRoot) {
  let entries = [];
  try { entries = readdirSync(repoRoot, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !EXCLUDE.has(e.name))
    .map(e => e.name);
}

function dirHasCode(absDir, depth = 2) {
  let entries = [];
  try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) if (e.isFile() && CODE_EXT.has(extname(e.name))) return true;
  if (depth > 1) {
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && dirHasCode(join(absDir, e.name), depth - 1)) return true;
    }
  }
  return false;
}

function dedupeAncestors(roots) {
  return roots.filter(r => !roots.some(o => o !== r && o.startsWith(r + '/')));
}

function discoverFallback(repoRoot) {
  const out = [];
  for (const d of topDirs(repoRoot)) if (dirHasCode(join(repoRoot, d))) out.push(d);
  return out;
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function discoverPython(repoRoot) {
  const out = [];
  for (const d of topDirs(repoRoot)) {
    if (existsSync(join(repoRoot, d, '__init__.py'))) out.push(d);
  }
  const srcAbs = join(repoRoot, 'src');
  if (isDir(srcAbs)) {
    for (const e of readdirSync(srcAbs, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(srcAbs, e.name, '__init__.py'))) out.push('src/' + e.name);
    }
  }
  return out;
}

function discoverJsWorkspaces(repoRoot) {
  const pkgPath = join(repoRoot, 'package.json');
  if (!existsSync(pkgPath)) return [];
  let pkg;
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { return []; }
  const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces
    : Array.isArray(pkg.workspaces?.packages) ? pkg.workspaces.packages : [];
  const out = [];
  for (const pat of ws) {
    if (typeof pat !== 'string') continue;
    if (pat.endsWith('/*')) {
      const base = pat.slice(0, -2);
      const baseAbs = join(repoRoot, base);
      if (isDir(baseAbs)) {
        for (const e of readdirSync(baseAbs, { withFileTypes: true })) {
          if (e.isDirectory()) out.push(base + '/' + e.name);
        }
      }
    } else if (isDir(join(repoRoot, pat))) {
      out.push(pat);
    }
  }
  return out;
}

export function discoverComponents(repoRoot) {
  const roots = new Set();
  for (const r of discoverFallback(repoRoot)) roots.add(r);
  for (const r of discoverPython(repoRoot)) roots.add(r);
  for (const r of discoverJsWorkspaces(repoRoot)) roots.add(r);
  return dedupeAncestors([...roots]).sort();
}

export function init({ repoRoot, srcSiteDir }) {
  const loreDir = join(repoRoot, '.lore');
  scaffold(loreDir);
  const copied = copyShell(srcSiteDir, loreDir);
  const codeRoots = discoverComponents(repoRoot);
  const configPath = join(loreDir, 'config.yml');
  let configWritten = false;
  if (!existsSync(configPath)) {
    writeFileSync(configPath, renderConfigYaml(codeRoots));
    configWritten = true;
  }
  const gitignore = ensureGitignore(repoRoot);
  const hook = installHook(repoRoot);
  // resident-mode（spec 2026-06-11）：CLAUDE.md 注入 + MCP 注册。config resident:false 关。
  let resident = false;
  const cfgText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  if (parseConfigResident(cfgText)) {
    installResident(repoRoot, residentStats(loreDir));
    mergeMcpConfig(repoRoot, join(dirname(fileURLToPath(import.meta.url)), 'mcp.js'));
    resident = true;
  }
  return { loreDir, copied, codeRoots, configWritten, gitignore, hook, resident };
}

export function renderConfigYaml(codeRoots) {
  const fmt = r => /^[A-Za-z0-9_./-]+$/.test(r) ? r : `'${r.replace(/'/g, "''")}'`;
  const roots = `[${codeRoots.map(fmt).join(', ')}]`;
  const sample = codeRoots[0] ?? 'module';
  return `# .lore/config.yml —— lore 引擎配置（唯一存放本 repo 特定信息处）
# component 由 /lore:init 自动发现。请按需改：重命名 / 分组 / 删 / 增。
language:                    # wiki 语言（人读首页 + 双语 sidecar）
  default: en                # repo 主语言（改成 zh 则中文为主）
  available: [en]            # 已就绪语言；加 zh 启用中英双语翻译页

axes:
  component:                 # 内置轴 + 自动发现
    discover: auto
    code_roots: ${roots}
  flow:                      # 声明轴 — "数据怎么端到端跑"（示例，按需填）
    values: []
    # - { id: article-pipeline, spans: [${sample}] }
  theme:                     # 自定义横切轴 — "这条长期主线怎么演进"（示例，按需填）
    values: []
    # - { id: quality, desc: "质量保证", match: [质量, accuracy, 误报] }
  docs:                      # 文档轴 — 把 docs/ + CHANGELOG + CLAUDE.md 收进 wiki（机械、物化视图、零 LLM）
    # sources: [docs, changelog, claude_md_pitfalls]
    # docs_glob: docs/**/*.md
journal:
  hook: true                 # post-commit hook 已装（每 commit 写 journal 骨架原子）
  mine: [commits, changelog, claude_md_pitfalls]
`;
}

// hook 安装/刷新逻辑在 migrate.js（期望态对齐器，git 查询/MARKER 门控都在那边）；
// 这里保旧返回值字串兼容（exists-foreign 等）。
export function installHook(repoRoot) {
  const here = dirname(fileURLToPath(import.meta.url));
  const cfgPath = join(repoRoot, '.lore', 'config.yml');
  const cfgText = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
  const { status } = alignHookStub(repoRoot, join(here, 'hook.js'), cfgText);
  return { foreign: 'exists-foreign' }[status] ?? status;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = process.argv[2] ?? process.cwd();
  const HERE = dirname(fileURLToPath(import.meta.url));
  const srcSiteDir = join(HERE, '..', 'site');
  const r = init({ repoRoot, srcSiteDir });
  console.log(`✓ lore initialized at ${r.loreDir}`);
  console.log(`  shell copied: ${r.copied.join(', ')}`);
  console.log(`  components discovered: ${r.codeRoots.length ? r.codeRoots.join(', ') : '(none — edit .lore/config.yml)'}`);
  console.log(`  config.yml: ${r.configWritten ? 'written' : 'kept (already existed)'}`);
  console.log(`  .gitignore: ${r.gitignore}`);
  let registered = null;
  try { registered = registerRepo(defaultReposPath(), { loreDir: r.loreDir }); }
  catch { /* portal 登记 best-effort：失败不阻断 init */ }
  console.log(`  portal: ${registered ? `已登记为 “${registered.name}”（/lore:portal start 聚合浏览）` : '(登记跳过)'}`);
  console.log('  next: edit .lore/config.yml if needed, then /lore:sync');
}
