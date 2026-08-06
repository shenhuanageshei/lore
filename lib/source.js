import { execFileSync } from 'node:child_process';
import { readdirSync, realpathSync, lstatSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

export const CODE_EXT = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs',
  '.java', '.kt', '.rb', '.php', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.swift', '.scala', '.sh',
]);

// 深度页条目的「显式/裸名」判定 + 页 id 推导（纯语法，不碰 fs）。
// 显式 = 条目带 CODE_EXT 里的扩展名（如 e2e_smoke.sh）→ 页 id 为去扩展名的基名；
// 裸名 = 其余（含全扩展名 .py、大写扩展名）→ id 即条目原文。
export function parseDeepEntry(entry) {
  const ext = extname(entry);
  const explicit = ext !== '' && CODE_EXT.has(ext);
  return { id: explicit ? entry.slice(0, entry.length - ext.length) : entry, explicit };
}

export function resolveDeepSource(repoRoot, deepRoot, entry) {
  const absRoot = join(repoRoot, deepRoot);
  let entries = [];
  try { entries = readdirSync(absRoot, { withFileTypes: true }); } catch {}
  const { id, explicit } = parseDeepEntry(entry);
  if (explicit) {
    const hit = entries.find(e => e.isFile() && e.name === entry);
    if (hit) return { status: 'ok', sourceFile: relative(repoRoot, join(absRoot, hit.name)).replaceAll('\\', '/') };
    return { status: 'missing', candidates: [], expected: `${deepRoot}/${entry}` };
  }
  const candidates = entries
    .filter(e => {
      const ext = extname(e.name);
      return e.isFile()
        && CODE_EXT.has(ext)
        && e.name.slice(0, e.name.length - ext.length) === id;
    })
    .map(e => relative(repoRoot, join(absRoot, e.name)).replaceAll('\\', '/'))
    .sort();

  if (candidates.length === 1) return { status: 'ok', sourceFile: candidates[0] };
  if (candidates.length === 0) return { status: 'missing', candidates: [] };
  return { status: 'ambiguous', candidates };
}

function pathContains(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

function canonicalizeFromExisting(path) {
  let cursor = path;
  const suffix = [];
  while (true) {
    try {
      lstatSync(cursor);
      break;
    } catch (err) {
      if (err.code !== 'ENOENT') return null;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  try {
    const real = realpathSync(cursor);
    if (!lstatSync(real).isDirectory()) return null;
    return resolve(real, ...suffix);
  } catch { return null; }
}

function validDeepRoot(repoRoot, deepRoot, codeRoots) {
  const repoPath = resolve(repoRoot);
  const deepPath = resolve(repoPath, deepRoot);
  if (!pathContains(repoPath, deepPath)) return false;
  let repoReal;
  try { repoReal = realpathSync(repoPath); } catch { return false; }
  const deepReal = canonicalizeFromExisting(deepPath);
  if (!deepReal || !pathContains(repoReal, deepReal)) return false;
  return codeRoots.some(cr => {
    if (deepRoot !== cr && !deepRoot.startsWith(`${cr}/`)) return false;
    const codePath = resolve(repoPath, cr);
    if (!pathContains(repoPath, codePath) || !pathContains(codePath, deepPath)) return false;
    const codeReal = canonicalizeFromExisting(codePath);
    return codeReal !== null && pathContains(repoReal, codeReal) && pathContains(codeReal, deepReal);
  });
}

export function resolveConfiguredDeep(repoRoot, codeRoots, deep) {
  const entries = [], issues = [];
  for (const [deepRoot, { order = [] }] of Object.entries(deep)) {
    if (!validDeepRoot(repoRoot, deepRoot, codeRoots)) {
      issues.push({ kind: 'deep-root-invalid', deepRoot });
      continue;
    }
    const seen = new Map();
    for (const entry of order) {
      const { id } = parseDeepEntry(entry);
      const result = resolveDeepSource(repoRoot, deepRoot, entry);
      if (result.status === 'ok') {
        if (seen.has(id)) {
          // 重复条目（原文相同）静默取一；真正不同写法撞同基名（如 e2e_smoke.py 与 e2e_smoke.sh）才报碰撞。
          if (seen.get(id) !== entry) issues.push({ kind: 'deep-source-collision', deepRoot, mod: id, entry: seen.get(id), conflictEntry: entry });
          continue;
        }
        seen.set(id, entry);
        entries.push({ deepRoot, entry, mod: id, sourceFile: result.sourceFile });
      } else if (result.status === 'missing') {
        if (result.expected) issues.push({ kind: 'deep-source-missing', deepRoot, mod: entry, explicit: true, expected: result.expected });
        else issues.push({ kind: 'deep-source-missing', deepRoot, mod: entry, expectedBase: `${deepRoot}/${entry}` });
      } else {
        issues.push({ kind: 'deep-source-ambiguous', deepRoot, mod: entry, candidates: result.candidates });
      }
    }
  }
  return { entries, issues };
}

// theme-deep 预算（设计「安全与资源边界」）：具名常量 + 边界测试。
export const THEME_DEEP_MAX_GLOB_FILES = 200;    // 每 glob 展开上限
export const THEME_DEEP_MAX_CHILD_SOURCES = 200; // 每子源文件总数上限
export const THEME_DEEP_MAX_TOTAL_FILES = 1000;  // 每计划全部分子展开总数上限

const THEME_GLOB_CHARS = /[*?[\]{}]/;

function normalizeRepoRel(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

// 语法校验（规则 4/5）：仓库相对、斜杠归一、无绝对/盘符/.. /NUL。
function validateThemeDeepEntry(entry) {
  if (entry.includes('\0')) return { ok: false, reason: 'NUL byte' };
  if (entry.startsWith(':')) return { ok: false, reason: 'pathspec magic not allowed' };
  if (isAbsolute(entry)) return { ok: false, reason: 'absolute path' };
  const norm = normalizeRepoRel(entry);
  if (/^[A-Za-z]:\//.test(norm)) return { ok: false, reason: 'drive-qualified path' };
  if (norm.split('/').some(s => s === '..')) return { ok: false, reason: '".." traversal' };
  return { ok: true, norm };
}

// 字面量文件：realpath 解析（含最深存在祖先），拒绝落出仓库的 symlink/junction。
function canonicalizeRepoFile(repoRoot, rel) {
  const abs = join(repoRoot, rel);
  let cursor = abs, suffix = [];
  while (true) {
    try { lstatSync(cursor); break; } catch (err) {
      if (err.code !== 'ENOENT') return null;
      const parent = dirname(cursor);
      if (parent === cursor) return null;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
  try { return resolve(realpathSync(cursor), ...suffix); } catch { return null; }
}

function resolveThemeDeepLiteral(repoRoot, entry, norm) {
  const repoPath = resolve(repoRoot);
  const abs = join(repoPath, norm);
  if (!pathContains(repoPath, abs)) return { status: 'outside-repo', entry, resolvedPath: norm };
  const canon = canonicalizeRepoFile(repoPath, norm);
  if (canon === null) return { status: 'missing', matches: [] };
  let st;
  try { st = lstatSync(canon); } catch { return { status: 'missing', matches: [] }; }
  if (!st.isFile()) return { status: 'missing', matches: [] };   // 规则 6：必须普通文件
  const repoReal = realpathSync(repoPath);
  if (!pathContains(repoReal, canon)) return { status: 'outside-repo', entry, resolvedPath: relative(repoRoot, canon).replaceAll('\\', '/') };
  return { status: 'ok', sourceFiles: [relative(repoRoot, canon).replaceAll('\\', '/')] };
}

function resolveThemeDeepGlob(repoRoot, entry, norm) {
  try {
    const out = execFileSync('git',
      ['ls-files', '--cached', '--others', '--exclude-standard', `:(glob)${norm}`],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }).toString();
    const files = out.split('\n').map(s => s.trim().replace(/\\/g, '/')).filter(Boolean);
    if (files.length === 0) return { status: 'missing', matches: [] };   // 规则 7：零匹配 = missing，绝不当作新页
    if (files.length > THEME_DEEP_MAX_GLOB_FILES) {
      return { status: 'invalid', entry, reason: `glob expanded to ${files.length} files (max ${THEME_DEEP_MAX_GLOB_FILES})` };
    }
    return { status: 'ok', sourceFiles: files };
  } catch {
    return { status: 'invalid', entry, reason: 'git unavailable (non-git repo?)' };
  }
}

// 单条源条目（字面量或 glob）→ 4 态结果（设计「源解析契约」）。
export function resolveThemeDeepSource(repoRoot, entry) {
  const v = validateThemeDeepEntry(entry);
  if (!v.ok) return { status: 'invalid', entry, reason: v.reason };
  if (THEME_GLOB_CHARS.test(v.norm)) return resolveThemeDeepGlob(repoRoot, entry, v.norm);
  return resolveThemeDeepLiteral(repoRoot, entry, v.norm);
}

// 一个子的全部源条目 → ok(sourceFiles 去重排序) 或首个失败态（设计公开契约，ok 不带 entry）。
export function resolveThemeDeepSources(repoRoot, entries) {
  const all = [];
  for (const entry of entries) {
    const r = resolveThemeDeepSource(repoRoot, entry);
    if (r.status !== 'ok') return { ...r, entry };
    all.push(...r.sourceFiles);
  }
  if (all.length > THEME_DEEP_MAX_CHILD_SOURCES) {
    return { status: 'invalid', entry: entries[0], reason: `child expanded to ${all.length} files (max ${THEME_DEEP_MAX_CHILD_SOURCES})` };
  }
  const seen = new Set();
  const files = [];
  for (const f of all) if (!seen.has(f)) { seen.add(f); files.push(f); }   // 规则 8：去重 + 排序 → 指纹稳定
  files.sort();
  return { status: 'ok', sourceFiles: files };
}

// 配置级校验 + 解析（规则 1-10）。children = 合法子（{parent,id,group,sources,sourceFiles}）；issues 累积不崩溃。
export function resolveConfiguredThemeDeep(repoRoot, themes, themeDeep) {
  const issues = [];
  const children = [];
  const canonicalSeen = new Map();
  let totalFiles = 0;
  for (const parent of themeDeep.parents) {
    const parentChildren = themeDeep.children.filter(c => c.parent === parent);
    const seenIds = new Set();
    const parentCount = themes.filter(t => t.id === parent).length;
    for (const c of parentChildren) {
      // 规则 2：子 id 父内唯一 + 规范 id 全局唯一
      if (seenIds.has(c.id)) { issues.push({ kind: 'theme-deep-id-collision', parent, child: c.id }); continue; }
      seenIds.add(c.id);
      const canonicalId = `${parent}--${c.id}`;
      if (canonicalSeen.has(canonicalId)) { issues.push({ kind: 'theme-deep-id-collision', parent, child: c.id, canonical: canonicalId }); continue; }
      canonicalSeen.set(canonicalId, true);
      // 规则 1：父必须恰出现一次
      if (parentCount !== 1) { issues.push({ kind: 'theme-deep-parent-missing', parent, child: c.id }); continue; }
      // 规则 3：至少 1 条源
      if (!c.sources || c.sources.length === 0) { issues.push({ kind: 'theme-deep-sources-empty', parent, child: c.id }); continue; }
      // 规则 4-9：逐条解析；规则 10：共享源合法（两子各持己份，不静默删）
      const r = resolveThemeDeepSources(repoRoot, c.sources);
      if (r.status !== 'ok') {
        issues.push({ kind: `theme-deep-source-${r.status}`, parent, child: c.id, entry: r.entry, reason: r.reason, resolvedPath: r.resolvedPath, matches: r.matches });
        continue;
      }
      totalFiles += r.sourceFiles.length;
      children.push({ parent, id: c.id, group: c.group, sources: c.sources, sourceFiles: r.sourceFiles });
    }
  }
  if (totalFiles > THEME_DEEP_MAX_TOTAL_FILES) {
    issues.push({ kind: 'theme-deep-source-invalid', parent: '', child: '', entry: '', reason: `total expanded sources ${totalFiles} exceed max ${THEME_DEEP_MAX_TOTAL_FILES}` });
  }
  return { children, issues };
}
