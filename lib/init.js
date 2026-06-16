import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerRepo, defaultReposPath } from './repos.js';
import { parseConfigResident } from './config.js';
import { alignAssets, alignShell, alignHookStub, alignGitignore, SHELL_FILES, CONFIG_BLOCKS } from './migrate.js';

const LORE_SUBDIRS = ['journal', 'wiki', 'site', '.state'];

export function scaffold(loreDir) {
  for (const d of LORE_SUBDIRS) mkdirSync(join(loreDir, d), { recursive: true });
}

// 壳拷贝在 migrate.js（alignShell 内容比对版）；保旧返回值（文件清单）兼容。
export function copyShell(srcSiteDir, loreDir) {
  alignShell(srcSiteDir, loreDir);
  return [...SHELL_FILES];
}

// gitignore 多行补缺在 migrate.js（facts-only 边界：.state/wiki/site 三行）；
// init 场景无既往迁移记录（空 Set = 全量补）。保旧返回值字串兼容。
export function ensureGitignore(repoRoot) {
  const had = existsSync(join(repoRoot, '.gitignore'));
  const acted = alignGitignore(repoRoot, new Set(), () => {}).length > 0;
  return !had ? 'created' : acted ? 'appended' : 'present';
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

// 单 code_root 下的顶层模块（代码文件，不含扩展名）。
// 单文件 code_root（如 server.js）→ []（无子模块概念，不进 deep）。
// 排噪音：test/spec 文件 + Python 包标记 __init__。
const DEEP_TEST_RE = /\.(test|spec|_test)\.[^.]+$/;
export function discoverDeepModules(absCodeRoot) {
  let stat;
  try { stat = statSync(absCodeRoot); } catch { return []; }
  if (stat.isFile()) return [];
  let entries;
  try { entries = readdirSync(absCodeRoot, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => e.isFile() && CODE_EXT.has(extname(e.name)) && !DEEP_TEST_RE.test(e.name))
    .map(e => e.name.slice(0, e.name.length - extname(e.name).length))
    .filter(name => name !== '__init__')
    .sort();
}

// 扫所有 code_roots，返回 { [codeRoot]: [mod1, mod2, ...] }（空 modules 的 root 不出键）。
export function discoverDeep(repoRoot, codeRoots) {
  const out = {};
  for (const cr of codeRoots) {
    const mods = discoverDeepModules(join(repoRoot, cr));
    if (mods.length) out[cr] = mods;
  }
  return out;
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

// 噪音目录（discoverDocs 专用）：只排真垃圾，绝不排 docs/doc/tests——那恰是文档所在。
// （component 的 EXCLUDE 排 docs 是因为它找代码；这里找文档，语义相反。）
const DOC_NOISE = new Set([
  '.git', '.lore', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache',
  'dist', 'build', 'out', 'target', 'vendor', 'coverage', '.claude',
  'addons', 'third_party', 'Pods', 'Assets', 'deps',   // 第三方/引擎插件目录的 md 不是本仓文档
]);

// 文档目录探测：含 ≥3 个 .md 的目录（递归，排噪音/点目录），命中即收不再下钻（取最浅）。
function docDirsUnder(absDir, rel, hits, depth = 4) {
  if (depth < 0) return;
  let entries = [];
  try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  const mdCount = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md')).length;
  // 根目录（rel===''）散落的 .md（CHANGELOG/README/NOTES…）是代码/游戏仓库常态，不算「文档目录」——
  // 否则整仓变 docs glob（**/*.md，扫进生成物/非文档）。继续下钻找专门的 docs/ 子目录；根级元文档由 metaDocs 单收。
  if (mdCount >= 3 && rel !== '') { hits.push(rel); return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || DOC_NOISE.has(e.name)) continue;
    docDirsUnder(join(absDir, e.name), rel ? `${rel}/${e.name}` : e.name, hits, depth - 1);
  }
}

// 元文档定位：根优先，否则一层非噪音子目录（threat-intel 式代码在子目录）。缺 → null。
export function findMetaDoc(repoRoot, name) {
  if (existsSync(join(repoRoot, name))) return name;
  let entries = [];
  try { entries = readdirSync(repoRoot, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || DOC_NOISE.has(e.name)) continue;
    if (existsSync(join(repoRoot, e.name, name))) return `${e.name}/${name}`;
  }
  return null;
}

// init 时探测文档目录 + 元文档位置（不止根 docs/，含子目录），喂给 renderConfigYaml。
export function discoverDocs(repoRoot) {
  const hits = [];
  docDirsUnder(repoRoot, '', hits);
  // 专门 docs/ 命名的目录优先（renderConfigYaml 取 [0]）——剩余第三方残留排后面兜底。
  const docsGlobs = hits.map(h => h ? `${h}/**/*.md` : '**/*.md')
    .sort((a, b) => (/(^|\/)docs?\//.test(a) ? 0 : 1) - (/(^|\/)docs?\//.test(b) ? 0 : 1));
  const metaDocs = [];
  for (const [kind, name] of [['changelog', 'CHANGELOG.md'], ['readme', 'README.md'], ['roadmap', 'ROADMAP.md']]) {
    const p = findMetaDoc(repoRoot, name);
    if (p) metaDocs.push({ kind, path: p });
  }
  return { docsGlobs, metaDocs };
}

export function init({ repoRoot, srcSiteDir }) {
  const loreDir = join(repoRoot, '.lore');
  scaffold(loreDir);
  const codeRoots = discoverComponents(repoRoot);
  const configPath = join(loreDir, 'config.yml');
  let configWritten = false;
  if (!existsSync(configPath)) {
    writeFileSync(configPath, renderConfigYaml(codeRoots, discoverDocs(repoRoot), { deepDisc: discoverDeep(repoRoot, codeRoots) }));
    configWritten = true;
  }
  // 其余资产全走期望态对齐器——init 重跑 = 手动迁移 + hook 首装（finalize 自动迁移不首装 hook）。
  const hadGitignore = existsSync(join(repoRoot, '.gitignore'));
  const actions = alignAssets(repoRoot, loreDir, { engineSiteDir: srcSiteDir, installHook: true });
  const cfgText = readFileSync(configPath, 'utf8');
  return {
    loreDir, codeRoots, configWritten,
    copied: [...SHELL_FILES],
    gitignore: actions.some(a => a.asset.startsWith('gitignore:')) ? (hadGitignore ? 'appended' : 'created') : 'present',
    hook: actions.find(a => a.asset === 'hook-stub')?.action ?? 'present',
    resident: parseConfigResident(cfgText) && actions.some(a => a.asset === 'claude-md' || a.asset === 'mcp-json'),
    actions,
  };
}

// 首生成模板从 CONFIG_BLOCKS（migrate.js）拼装——补缺块与出生模板单一真源。
const cfgBlock = id => CONFIG_BLOCKS.find(b => b.id === id).template;

export function renderConfigYaml(codeRoots, docsDisc = { docsGlobs: [], metaDocs: [] }, { deepDisc = {} } = {}) {
  const fmt = r => /^[A-Za-z0-9_./-]+$/.test(r) ? r : `'${r.replace(/'/g, "''")}'`;
  const roots = `[${codeRoots.map(fmt).join(', ')}]`;
  const sample = codeRoots[0] ?? 'module';
  const fill = t => t.replace('<component>', sample);
  // docs 轴用自动发现结果（discoverDocs）：docs_glob 指实际文档目录、sources 含探测到的元文档。
  const docsGlob = docsDisc.docsGlobs?.[0] ?? 'docs/**/*.md';
  const metaSources = (docsDisc.metaDocs ?? []).map(m => m.kind);   // changelog / readme / roadmap（探测到才有）
  const sources = ['docs', ...metaSources, 'claude_md_pitfalls'];
  const docsBlock = `  docs:                      # 文档轴 — 自动发现的文档目录 + 元文档（机械、物化视图、零 LLM）
    sources: [${sources.join(', ')}]
    docs_glob: ${docsGlob}`;
  const deepBlock = renderDeepBlock(deepDisc);
  return `# .lore/config.yml —— lore 引擎配置（唯一存放本 repo 特定信息处）
# component 由 /lore:init 自动发现。请按需改：重命名 / 分组 / 删 / 增。
${cfgBlock('config:language')}

axes:
  component:                 # 内置轴 + 自动发现
    discover: auto
    code_roots: ${roots}
${deepBlock}${fill(cfgBlock('config:axes.flow'))}
${fill(cfgBlock('config:axes.theme'))}
${docsBlock}
${cfgBlock('config:journal')}
${cfgBlock('config:resident-note')}
`;
}

// 生成 deep: 块：有发现 → 列 modules；无发现 → 注释骨架（让用户填）。
function renderDeepBlock(deepDisc) {
  const entries = Object.entries(deepDisc ?? {});
  if (!entries.length) {
    return `    deep:                      # 源文件级深度页（init 自动扫描的顶层模块，按需删减/分组）\n      # <code_root>: [mod1, mod2, ...]\n`;
  }
  const lines = ['    deep:                      # 源文件级深度页（init 自动扫描的顶层模块，按需删减/分组）'];
  for (const [cr, mods] of entries) {
    lines.push(`      ${cr}: [${mods.join(', ')}]`);
  }
  return lines.join('\n') + '\n';
}

// hook 安装/刷新逻辑在 migrate.js（期望态对齐器，git 查询/MARKER 门控都在那边）；
// 这里保旧返回值字串兼容（exists-foreign 等）。
export function installHook(repoRoot) {
  const here = dirname(fileURLToPath(import.meta.url));
  const cfgPath = join(repoRoot, '.lore', 'config.yml');
  const cfgText = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
  const { status } = alignHookStub(repoRoot, join(here, 'hook.js'), cfgText, { install: true });
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
