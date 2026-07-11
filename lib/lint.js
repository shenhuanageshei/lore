// lib/lint.js
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, gitCurrentSha, makeCountCommitsSince } from './manifest.js';
import { parseConfigCodeRoots, parseConfigDeep } from './config.js';
import { resolveConfiguredDeep } from './source.js';

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
      if (!invalidRoots.has(deepRoot)) for (const mod of order ?? []) names.add(mod);
    }
  } else {
    for (const [deepRoot, { order }] of Object.entries(deep)) {
      if (codeRoots.some(cr => deepRoot === cr || deepRoot.startsWith(`${cr}/`))) {
        for (const mod of order ?? []) names.add(mod);
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
    if (issue.kind === 'deep-source-missing') return {
      kind: 'missing-source', deepRoot: issue.deepRoot, mod: issue.mod,
      message: `no supported source file found for ${issue.deepRoot}/${issue.mod}`,
    };
    return {
      kind: 'ambiguous-source', deepRoot: issue.deepRoot, mod: issue.mod,
      candidates: issue.candidates,
      message: `multiple supported source files found for ${issue.deepRoot}/${issue.mod}`,
    };
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

export function lintStale(pages, currentSha, countSince) {
  return pages
    .filter(p => p.code_sha && p.code_sha !== currentSha)
    .map(p => ({ page: p.id, code_sha: p.code_sha, behind: countSince(p.code_sha) }));
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
      try {
        if (!/^##\s+机制详解/m.test(readFileSync(join(wikiDir, 'component', `${mod}.md`), 'utf8'))) out.push(`component/${mod}.md`);
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

  const stale = currentSha ? lintStale(pages, currentSha, countSince) : [];
  const orphans = lintOrphans(ids, codeRoots, deep, repoRoot);
  const missing = lintMissing(ids, codeRoots, deep, repoRoot);
  const unfolded = lintUnfolded(wikiDir);
  const mermaid = lintMermaid(wikiDir);
  const missingDiagram = lintMissingDiagram(wikiDir);
  const missingMechanism = lintMissingMechanism(wikiDir, deep);
  const deepConfig = lintDeepConfig(repoRoot, codeRoots, deep);
  return {
    stale, orphans, missing, unfolded, mermaid, missingDiagram, missingMechanism, deepConfig,
    clean: stale.length === 0 && orphans.length === 0 && missing.length === 0 && unfolded.length === 0 && mermaid.length === 0 && missingDiagram.length === 0 && missingMechanism.length === 0 && deepConfig.length === 0,
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
  }
  process.exit(0);
}
