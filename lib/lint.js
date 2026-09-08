// lib/lint.js
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, gitCurrentSha, makeCountCommitsSince } from './manifest.js';
import { parseConfigCodeRoots, parseConfigDeep, parseConfigThemes, parseConfigThemeDeep } from './config.js';
import { resolveConfiguredDeep, parseDeepEntry, resolveConfiguredThemeDeep } from './source.js';

function rootName(codeRoot) {
  return codeRoot.split('/').pop();
}

// 合法 component 页 id 集合 = code_roots 末段 + config.deep 声明的子模块（深度页是普通 component 页）
function legalIds(codeRoots, deep = {}, repoRoot = null) {
  const names = new Set(codeRoots.map(rootName));
  if (repoRoot) {
    const invalidRoots = new Set(resolveConfiguredDeep(repoRoot, codeRoots, deep).issues
      .filter(issue => issue.kind === 'deep-root-invalid')
      .map(issue => issue.deepRoot));
    for (const [deepRoot, { order }] of Object.entries(deep)) {
      if (!invalidRoots.has(deepRoot)) for (const mod of order ?? []) names.add(parseDeepEntry(mod).id);
    }
  } else {
    for (const [deepRoot, { order }] of Object.entries(deep)) {
      if (codeRoots.some(cr => deepRoot === cr || deepRoot.startsWith(`${cr}/`))) {
        for (const mod of order ?? []) names.add(parseDeepEntry(mod).id);
      }
    }
  }
  return names;
}

export function lintOrphans(pageIds, codeRoots, deep = {}, repoRoot = null) {
  const names = legalIds(codeRoots, deep, repoRoot);
  return pageIds.filter(id => !names.has(id));
}

export function lintMissing(pageIds, codeRoots, deep = {}, repoRoot = null) {
  const pages = new Set(pageIds);
  return [...legalIds(codeRoots, deep, repoRoot)].filter(c => !pages.has(c));
}

export function lintDeepConfig(repoRoot, codeRoots, deep = {}) {
  return resolveConfiguredDeep(repoRoot, codeRoots, deep).issues.map(issue => {
    if (issue.kind === 'deep-root-invalid') return {
      kind: 'invalid-root', deepRoot: issue.deepRoot,
      message: 'deep root must equal a code_root or be its child',
    };
    if (issue.kind === 'deep-source-missing') {
      if (issue.explicit) return {
        kind: 'missing-source', deepRoot: issue.deepRoot, mod: issue.mod, expected: issue.expected,
        message: `no supported source file found for ${issue.expected} (pinned file)`,
      };
      return {
        kind: 'missing-source', deepRoot: issue.deepRoot, mod: issue.mod,
        message: `no supported source file found for ${issue.deepRoot}/${issue.mod}`,
      };
    }
    if (issue.kind === 'deep-source-ambiguous') return {
      kind: 'ambiguous-source', deepRoot: issue.deepRoot, mod: issue.mod,
      candidates: issue.candidates,
      message: `multiple supported source files found for ${issue.deepRoot}/${issue.mod} — pin one: ${issue.candidates.map(c => c.split('/').pop()).join(' / ')}`,
    };
    if (issue.kind === 'deep-source-collision') return {
      kind: 'collision-source', deepRoot: issue.deepRoot, mod: issue.mod,
      conflictEntry: issue.conflictEntry,
      message: `"${issue.entry}" and "${issue.conflictEntry}" resolve to same page id — keep one`,
    };
    // 闭合集：上游 resolveConfiguredDeep 只产上面四种 kind。新增 kind 会在此显式失败而非静默误标。
    throw new Error(`lintDeepConfig: unknown deep issue kind "${issue.kind}"`);
  });
}

function componentPages(wikiDir) {
  const dir = join(wikiDir, 'component');
  let files = [];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => e.name).sort();
  } catch { return []; }
  return files.map(f => {
    const { data } = parseFrontmatter(readFileSync(join(dir, f), 'utf8'));
    return { id: basename(f, '.md'), code_sha: data.code_sha ?? '' };
  });
}

// 每页源范围（与 planSync/finalize 同一口径）：鸟瞰页 = 整个 code_root；深度页 = resolver 找到的源文件。
// 未知页（孤儿）不在表内 → 调用方兜底成全仓口径（pathspec 缺省）。
export function componentScopes(codeRoots, deep = {}, repoRoot = null) {
  const map = new Map();
  for (const codeRoot of codeRoots) map.set(rootName(codeRoot), [codeRoot]);
  if (repoRoot) {
    for (const { mod, sourceFile } of resolveConfiguredDeep(repoRoot, codeRoots, deep).entries) {
      map.set(mod, [sourceFile]);
    }
  }
  return map;
}

// 陈旧度 = 「动过该页源范围」的提交数，不是全仓提交数。
// 全仓口径会把源文件从未变过的页误报成 stale（实测 dogfood：fingerprint/fold/hook/mine 的源文件
// 自盖章起 0 提交，却被报 behind 233）——与 planSync 的增量判定必须同一口径，否则 lint 每次收敛后
// 仍报一堆误报，真漂移淹在噪声里。code_sha 由 finalize 盖成该页 prose 的 sha，故语义与
// planSync 的 fingerprints[rel].prose_sha 一致。
export function lintStale(pages, scopes, countSince) {
  const out = [];
  for (const p of pages) {
    if (!p.code_sha) continue;                                  // 未 finalize 的页不算漂移
    const behind = countSince(p.code_sha, scopes?.get?.(p.id)); // 无 scope → 全仓兜底
    if (behind > 0) out.push({ page: p.id, code_sha: p.code_sha, behind });
  }
  return out;
}

const JOURNAL_TOKEN = '{{LORE_JOURNAL}}';
const LINT_AXES = ['component', 'theme', 'flow'];

// Flag FINALIZED pages (stamped with code_sha) that still hold a literal {{LORE_JOURNAL}}.
// Sync replaces the token at finalize; a survivor on a finalized page = sync corruption / drift.
// Pre-sync pages (no code_sha) legitimately carry the token, so they are not flagged.
// 判定前剥掉哨兵区（决策史里 commit message 可能字面提到 token）和 inline code span
// （机制档讲 token 的 `{{LORE_JOURNAL}}` 引用）——同款误报 sync 的 foldJournal 修过（94c1269），lint 这里补上。
const SENTINEL_RE = /<!--\s*LORE_[A-Z_]+:START\s*-->[\s\S]*?<!--\s*LORE_[A-Z_]+:END\s*-->/g;
export function lintUnfolded(wikiDir) {
  const out = [];
  for (const axis of LINT_AXES) {
    const dir = join(wikiDir, axis);
    let files = [];
    try {
      files = readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.md'))
        .map(e => e.name).sort();
    } catch { continue; }
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      const { data } = parseFrontmatter(text);
      const bare = text.replace(SENTINEL_RE, '').replace(/`[^`\n]*`/g, '');
      if (data.code_sha && bare.includes(JOURNAL_TOKEN)) out.push(`${axis}/${f}`);
    }
  }
  return out;
}

// mermaid 语法启发式校验（零依赖，不引入 mermaid 运行时）。抓 dogfood 实测踩过的坑：
// 节点 id 用保留字（graph[...] 渲染炸）、断箭头（== > 空格断开）、未知图类型、引号不配对。
const MERMAID_TYPES = /^(flowchart|graph|stateDiagram(-v2)?|sequenceDiagram|classDiagram|erDiagram|gantt|pie|journey|timeline|mindmap)\b/;
const RESERVED_NODE = /(?:^|\s)(graph|end|click|style|subgraph|linkStyle|classDef)\s*[\[\({]/;
const BROKEN_ARROW = /(-{2,}|={2,})\s+>/;
export function mermaidIssues(src) {
  const issues = [];
  const lines = (src ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return issues;
  if (!MERMAID_TYPES.test(lines[0])) issues.push(`unknown diagram type: "${lines[0].slice(0, 30)}"`);
  for (const l of lines.slice(1)) {
    const rm = l.match(RESERVED_NODE);
    if (rm) issues.push(`reserved id "${rm[1]}" used as node (rename it — mermaid keyword)`);
    if (BROKEN_ARROW.test(l)) issues.push(`broken arrow (space before ">"): "${l.slice(0, 40)}"`);
    if (((l.match(/"/g) ?? []).length) % 2 === 1) issues.push(`unbalanced quote: "${l.slice(0, 40)}"`);
  }
  return issues;
}

const MERMAID_BLOCK_RE = /```mermaid\r?\n([\s\S]*?)```/g;
const MERMAID_SCAN = ['component', 'theme', 'flow'];   // agent 写的页 + HOME；docs 是物化转载，源文档作者负责
export function lintMermaid(wikiDir) {
  const out = [];
  const scanFile = (rel) => {
    let text;
    try { text = readFileSync(join(wikiDir, rel), 'utf8'); } catch { return; }
    let m, idx = 0;
    while ((m = MERMAID_BLOCK_RE.exec(text)) !== null) {
      idx++;
      for (const issue of mermaidIssues(m[1])) out.push({ page: rel, diagram: idx, issue });
    }
  };
  for (const axis of MERMAID_SCAN) {
    let files = [];
    try {
      files = readdirSync(join(wikiDir, axis), { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name).sort();
    } catch { continue; }
    for (const f of files) scanFile(`${axis}/${f}`);
  }
  scanFile('HOME.md');
  return out;
}

// component/flow 页缺 mermaid 架构图（sync.md 明确要求）→ 报。排翻译 sidecar（只取单段名 `<id>.md`）。
// 质量保证：sync 的架构 prose+图是 agent 写的、会漏（jpm 6 页全漏），机械检测让缺图可见而非默默接受。
export function lintMissingDiagram(wikiDir) {
  const out = [];
  for (const axis of ['component', 'flow']) {
    let files = [];
    try { files = readdirSync(join(wikiDir, axis)).filter(f => /^[^.]+\.md$/.test(f)); } catch { continue; }
    for (const f of files) {
      if (!/```mermaid/.test(readFileSync(join(wikiDir, axis, f), 'utf8'))) out.push(`${axis}/${f}`);
    }
  }
  return out;
}

// 深度页（config deep 声明的子模块）缺「## 机制详解」折叠档 → 报。深度页才完整两档；
// 鸟瞰页只要概览档、theme/flow 单档，都不在此检测。两档质量门，配合 hasMechanism 壳徽标。
export function lintMissingMechanism(wikiDir, deep = {}) {
  const out = [];
  for (const cr of Object.keys(deep)) {
    for (const mod of deep[cr].order ?? []) {
      const id = parseDeepEntry(mod).id;   // 归一化基名（显式条目 e2e_smoke.sh → e2e_smoke）
      try {
        if (!/^##\s+机制详解/m.test(readFileSync(join(wikiDir, 'component', `${id}.md`), 'utf8'))) out.push(`component/${id}.md`);
      } catch { /* 页缺失 → lintMissing 已管 */ }
    }
  }
  return out;
}

export function lint({ loreDir }) {
  const wikiDir = join(loreDir, 'wiki');
  const configPath = join(loreDir, 'config.yml');
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const codeRoots = configText ? parseConfigCodeRoots(configText) : [];
  const deep = configText ? parseConfigDeep(configText) : {};
  const pages = componentPages(wikiDir);
  const ids = pages.map(p => p.id);
  const repoRoot = join(resolve(loreDir), '..');

  let currentSha = '';
  let countSince = () => 0;
  try {
    currentSha = gitCurrentSha(repoRoot);
    countSince = makeCountCommitsSince(repoRoot);
  } catch { /* non-git → skip stale */ }

  const stale = currentSha ? lintStale(pages, componentScopes(codeRoots, deep, repoRoot), countSince) : [];
  const orphans = lintOrphans(ids, codeRoots, deep, repoRoot);
  const missing = lintMissing(ids, codeRoots, deep, repoRoot);
  const unfolded = lintUnfolded(wikiDir);
  const mermaid = lintMermaid(wikiDir);
  const missingDiagram = lintMissingDiagram(wikiDir);
  const missingMechanism = lintMissingMechanism(wikiDir, deep);
  const deepConfig = lintDeepConfig(repoRoot, codeRoots, deep);
  const themeDeepCfg = configText ? parseConfigThemeDeep(configText) : { parents: [], children: [] };
  const themes = configText ? parseConfigThemes(configText) : [];
  const resolvedThemeDeep = resolveConfiguredThemeDeep(repoRoot, themes, themeDeepCfg);
  const themeDeepDiag = [
    ...lintThemeDeepConfig(repoRoot, themes, themeDeepCfg),
    ...lintThemeDeepPages(wikiDir, resolvedThemeDeep.children, themes),
  ];
  const themeDeepWarnings = themeDeepDiag.filter(d => d.kind === 'theme-id-reserved-separator');
  const themeDeepFatal = themeDeepDiag.filter(d => d.kind !== 'theme-id-reserved-separator');
  return {
    stale, orphans, missing, unfolded, mermaid, missingDiagram, missingMechanism, deepConfig, themeDeep: themeDeepFatal, themeDeepWarnings,
    clean: stale.length === 0 && orphans.length === 0 && missing.length === 0 && unfolded.length === 0 && mermaid.length === 0 && missingDiagram.length === 0 && missingMechanism.length === 0 && deepConfig.length === 0 && themeDeepFatal.length === 0,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const loreDir = process.argv[2] ?? join(process.cwd(), '.lore');
  const r = lint({ loreDir });
  if (r.clean) {
    console.log('✓ lore lint: clean (no drift)');
  } else {
    if (r.stale.length) console.log(`stale (${r.stale.length}): ` + r.stale.map(s => `${s.page} (behind ${s.behind})`).join(', '));
    if (r.orphans.length) console.log(`orphans (${r.orphans.length}): ${r.orphans.join(', ')}`);
    if (r.missing.length) console.log(`missing (${r.missing.length}): ${r.missing.join(', ')} → run /lore:sync`);
    if (r.unfolded.length) console.log(`unfolded (${r.unfolded.length}): ${r.unfolded.join(', ')} → literal {{LORE_JOURNAL}} (re-run /lore:sync)`);
    if (r.mermaid.length) console.log(`mermaid (${r.mermaid.length}): ` + r.mermaid.map(m => `${m.page}#${m.diagram} ${m.issue}`).join('; '));
    if (r.missingDiagram.length) console.log(`missing-diagram (${r.missingDiagram.length}): ${r.missingDiagram.join(', ')} → component/flow 缺 mermaid 架构图（壳徽标可点击排队重写）`);
    if (r.missingMechanism.length) console.log(`missing-mechanism (${r.missingMechanism.length}): ${r.missingMechanism.join(', ')} → 深度页缺「## 机制详解」折叠档（壳徽标可点击排队重写）`);
    if (r.deepConfig.length) console.log(`deep-config (${r.deepConfig.length}): ` + r.deepConfig.map(i => `${i.deepRoot}${i.mod ? `/${i.mod}` : ''} — ${i.message}`).join('; '));
    if (r.themeDeep.length) console.log(`theme-deep (${r.themeDeep.length}): ` + r.themeDeep.map(d => {
      const loc = [d.parent, d.child].filter(Boolean).join('/');
      return `${loc ? loc + ' ' : ''}${d.kind} — ${d.message}`;
    }).join('; '));
  }
  // 非阻断警告永远打印（clean 只看 fatal；若仓库只剩警告，上面分支不会走 else）。
  if (r.themeDeepWarnings.length) console.log(`theme-deep-warning (${r.themeDeepWarnings.length}): ` + r.themeDeepWarnings.map(d => d.message).join('; '));
  process.exit(0);
}

// ---- theme deep 诊断 ----
export function lintThemeDeepConfig(repoRoot, themes, themeDeep) {
  const { issues } = resolveConfiguredThemeDeep(repoRoot, themes, themeDeep);
  return issues.map(i => {
    switch (i.kind) {
      case 'theme-deep-parent-missing': return {
        kind: 'theme-deep-parent-missing', parent: i.parent, child: i.child,
        message: `parent "${i.parent}" must exist exactly once in axes.theme.values (child "${i.child}")`,
      };
      case 'theme-deep-id-collision': return {
        kind: 'theme-deep-id-collision', parent: i.parent, child: i.child,
        message: i.canonical
          ? `canonical id "${i.canonical}" collides with another theme page — keep one`
          : `child id "${i.child}" duplicated under parent "${i.parent}"`,
      };
      case 'theme-deep-sources-empty': return {
        kind: 'theme-deep-sources-empty', parent: i.parent, child: i.child,
        message: `child "${i.child}" declares no sources`,
      };
      case 'theme-deep-source-invalid': return {
        kind: 'theme-deep-source-invalid', parent: i.parent, child: i.child, entry: i.entry,
        message: `source "${i.entry}": ${i.reason}`,
      };
      case 'theme-deep-source-missing': return {
        kind: 'theme-deep-source-missing', parent: i.parent, child: i.child, entry: i.entry,
        message: `no source file matched "${i.entry}" for parent "${i.parent}" / child "${i.child}"`,
      };
      case 'theme-deep-source-outside-repo': return {
        kind: 'theme-deep-source-outside-repo', parent: i.parent, child: i.child, entry: i.entry,
        message: `source "${i.entry}" resolves outside the repository`,
      };
      default: throw new Error(`lintThemeDeepConfig: unknown issue kind "${i.kind}"`);
    }
  });
}

// 页级诊断：缺页 / 缺机制 / 缺图 / 双向缺链接 / 孤儿子路径 / 历史 `--` 顶层主题（非阻断）。
export function lintThemeDeepPages(wikiDir, children, themes) {
  const out = [];
  const childByCanonical = new Map(children.map(c => [`${c.parent}--${c.id}`, c]));
  const parentSet = new Set(themes.map(t => t.id));
  const themeDir = join(wikiDir, 'theme');
  let files = [];
  try {
    files = readdirSync(themeDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md')).map(e => basename(e.name, '.md'));
  } catch {}
  const pageSet = new Set(files);

  for (const [canonical, c] of childByCanonical) {
    if (!pageSet.has(canonical)) {
      out.push({ kind: 'theme-deep-page-missing', parent: c.parent, child: c.id, message: `child page theme/${canonical}.md missing — run /lore:sync` });
      continue;
    }
    const text = readFileSync(join(wikiDir, 'theme', `${canonical}.md`), 'utf8');
    const { body } = parseFrontmatter(text);
    if (!/^##\s+机制详解/m.test(body)) out.push({ kind: 'theme-deep-mechanism-missing', parent: c.parent, child: c.id, message: `child theme/${canonical}.md lacks "## 机制详解"` });
    if (!/```mermaid/.test(body)) out.push({ kind: 'theme-deep-diagram-missing', parent: c.parent, child: c.id, message: `child theme/${canonical}.md lacks a mermaid architecture diagram` });
    if (!text.includes(`[[${c.parent}]]`)) out.push({ kind: 'theme-deep-parent-link-missing', parent: c.parent, child: c.id, message: `child theme/${canonical}.md must link its parent [[${c.parent}]]` });
  }

  for (const parent of parentSet) {
    if (!pageSet.has(parent)) continue;
    const text = readFileSync(join(wikiDir, 'theme', `${parent}.md`), 'utf8');
    for (const [canonical, c] of childByCanonical) {
      if (c.parent !== parent) continue;
      if (!text.includes(`[[${canonical}]]`)) out.push({ kind: 'theme-deep-child-link-missing', parent, child: c.id, message: `overview theme/${parent}.md must list child [[${canonical}]]` });
    }
  }

  for (const id of pageSet) {
    if (childByCanonical.has(id) || parentSet.has(id)) continue;
    if (id.includes('--')) out.push({ kind: 'theme-deep-orphan', parent: id.split('--')[0], child: id, message: `theme page theme/${id}.md is no longer configured — remove or re-add under theme.deep` });
  }

  // Amendment 4：历史 `--` 顶层主题 id —— 非阻断警告（不使 clean 变红）。
  for (const id of parentSet) {
    if (id.includes('--')) out.push({ kind: 'theme-id-reserved-separator', parent: id, child: '', message: `top-level theme id "${id}" contains the reserved "--" separator (theme-deep children share this namespace)` });
  }
  return out;
}
