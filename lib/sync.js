import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, runManifestCli, makeCountCommitsSince } from './manifest.js';
import { buildGraph } from './graph.js';
import { parseConfigCodeRoots, parseConfigThemes, parseConfigFlows, parseConfigDocsAxis, parseConfigLanguage, parseConfigDeep } from './config.js';
import { buildDocsAxis } from './docs.js';
import { readAllAtoms } from './journal.js';
import { foldAtoms, stripTrailers } from './fold.js';
import { discoverTranslations } from './i18n.js';
import { buildHomeStatus, defaultHomePage, finalizeHomeText } from './home.js';
import { readFingerprints, writeFingerprints, proseHash } from './fingerprint.js';
import { alignAssets } from './migrate.js';
import { resolveConfiguredDeep } from './source.js';

export { resolveConfiguredDeep } from './source.js';

// 增量：component 页只在「无指纹（新页）/ 代码动过其 code_root」时入 worklist（agent 重写 prose）。
// HOME/theme/flow 是 cross-cutting 且便宜 → 默认仍全入。--all 忽略指纹、强制全量（首跑/兜底/大改后）。
export function planSync(loreDir, { all = false } = {}) {
  const configPath = join(loreDir, 'config.yml');
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const codeRoots = parseConfigCodeRoots(configText);
  const themes = parseConfigThemes(configText);
  const flows = parseConfigFlows(configText);
  const wikiDir = join(loreDir, 'wiki');
  const exists = (axis, id) => existsSync(join(wikiDir, axis, `${id}.md`));

  const fingerprints = readFingerprints(join(loreDir, '.state'));
  const repoRoot = join(resolve(loreDir), '..');
  const countSince = makeCountCommitsSince(repoRoot);

  const worklist = [];
  worklist.push({ axis: 'HOME', id: 'HOME', path: 'HOME.md', priorExists: existsSync(join(wikiDir, 'HOME.md')) });

  for (const codeRoot of codeRoots) {
    const id = codeRoot.split('/').pop();
    const rel = `component/${id}.md`;
    const fp = fingerprints[rel];
    let stale = null, reason;
    if (all) { reason = 'all'; }
    else if (!fp) { reason = 'new'; }
    else { stale = countSince(fp.prose_sha, [codeRoot]); reason = stale > 0 ? 'code-changed' : 'fresh'; }
    const include = all || !fp || (stale ?? 0) > 0;
    if (include) {
      worklist.push({ axis: 'component', id, component: id, codeRoot, path: rel, priorExists: exists('component', id), stale, reason });
    }
  }
  // 深度页（源文件级）：config deep 声明 → 每个子模块一页 component/<mod>.md，
  // 增量按 resolver 找到的实际源文件做 git 变更计数。
  const deep = parseConfigDeep(configText);
  const resolvedDeep = resolveConfiguredDeep(repoRoot, codeRoots, deep);
  for (const { deepRoot, mod, sourceFile } of resolvedDeep.entries) {
    const rel = `component/${mod}.md`;
    const fp = fingerprints[rel];
    let stale = null, reason;
    if (all) { reason = 'all'; }
    else if (!fp) { reason = 'new'; }
    else { stale = countSince(fp.prose_sha, [sourceFile]); reason = stale > 0 ? 'code-changed' : 'fresh'; }
    const include = all || !fp || (stale ?? 0) > 0;
    if (include) {
      worklist.push({ axis: 'component', id: mod, component: mod, codeRoot: deepRoot, sourceFile, kind: 'deep', path: rel, priorExists: exists('component', mod), stale, reason });
    }
  }
  for (const th of themes) {
    worklist.push({ axis: 'theme', id: th.id, path: `theme/${th.id}.md`, priorExists: exists('theme', th.id) });
  }
  for (const fl of flows) {
    worklist.push({ axis: 'flow', id: fl.id, path: `flow/${fl.id}.md`, priorExists: exists('flow', fl.id) });
  }
  return { codeRoots, themes, flows, worklist, configIssues: resolvedDeep.issues };
}

const SYNC_AXES = ['component', 'theme', 'flow'];

export function buildIndex(axisPages) {
  const sections = [];
  for (const axis of ['component', 'flow', 'theme', 'docs']) {   // keep in sync with manifest AXIS_ORDER (minus INDEX)
    const pages = axisPages[axis];
    if (!pages || pages.length === 0) continue;
    const heading = axis.charAt(0).toUpperCase() + axis.slice(1);
    sections.push(`## ${heading}\n${pages.map(p => `- [[${p.id}]]`).join('\n')}`);
  }
  return `---\ntitle: Index\nsummary: table of contents\n---\n# lore wiki — index\n\n${sections.join('\n\n')}\n`;
}

const FM_ORDER = ['title', 'summary', 'last_updated', 'code_sha', 'atoms', 'commits'];

export function stampFrontmatter(pageText, { codeSha, lastUpdated, commits = 0, atoms = 0 }) {
  const { data, body } = parseFrontmatter(pageText);
  const merged = {
    title: data.title ?? '',
    summary: data.summary ?? '',
    last_updated: lastUpdated,
    code_sha: codeSha,
    atoms,
    commits,
  };
  const fm = FM_ORDER.map(k => `${k}: ${merged[k]}`).join('\n');
  return `---\n${fm}\n---\n${body}`;
}

function headShortSha(repoRoot) {
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, windowsHide: true }).toString().trim();
}

// 当前 repo 所有 ref 可达的完整 sha 集合（喂 foldAtoms 丢孤儿）。
// best-effort：非 git / git 不可用 → null，foldAtoms 退化为仅合并、不丢孤儿。
function reachableShaSet(repoRoot) {
  try {
    const out = execFileSync('git', ['rev-list', '--all'],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024, windowsHide: true }).toString();
    return new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
  } catch { return null; }
}

export function renderDecisionHistory(atoms) {
  if (atoms.length === 0) return '暂无 journal 原子（跑 /lore:mine 补全）。';
  const sorted = [...atoms].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return sorted.map(a => {
    const sha = (a.commit ?? '').slice(0, 7);
    const date = (a.ts ?? '').slice(0, 10);
    const why = stripTrailers(a.why ?? '').split('\n')[0].trim();   // 防御旧原子里已落盘的 trailer 噪音
    const meta = a.commit ? `(${sha}, ${date})` : `(${date})`;
    return why ? `- **${a.title}** — ${why} ${meta}` : `- **${a.title}** ${meta}`;
  }).join('\n');
}

const JOURNAL_TOKEN = '{{LORE_JOURNAL}}';
const DH_HEADING = '## Decision history';
const DH_HEADING_RE = /^## (?:Decision history(?:[ \t][^\r\n]*)?|决策史|决策历史(?: \(Decision history\))?)\r?\n/m;
const DH_START = '<!-- LORE_JOURNAL:START -->';
const DH_END = '<!-- LORE_JOURNAL:END -->';

// Rebuild the `## Decision history` section idempotently.
// 定位标题 → 下个 H2 / EOF 的整段；section 内有 token 或哨兵才重建（整段替换为
// 哨兵包裹的决策史 md，吞掉历史累积 + 多余 token → 自愈已肿页面）。
// 无标题 → no-op；有标题但无 token/哨兵（页面自管）→ no-op。
// 字符串切片拼接，$-pattern 安全（不经 replace 替换串）。
export function foldJournal(text, md, { page = '(page)', warn = (m) => console.error(m) } = {}) {
  const m = DH_HEADING_RE.exec(text);
  if (!m) return text;                                       // 无决策史 section
  const start = m.index;
  const afterHeading = m.index + m[0].length;
  const rel = text.slice(afterHeading).search(/^## /m);
  const end = rel === -1 ? text.length : afterHeading + rel;
  const section = text.slice(start, end);

  const hasSentinel = section.includes(DH_START);
  if (!section.includes(JOURNAL_TOKEN) && !hasSentinel) {
    return text;                                            // 标题 + 手写自管 → 不碰
  }
  // warn 仅在首次迁移（无哨兵、多个游离占位 token = 曾损坏）时。哨兵稳态后，section
  // 内的 token 是决策史内容的字面引用（如讲 token 的 commit message），不算损坏。
  if (!hasSentinel) {
    const tokenN = section.split(JOURNAL_TOKEN).length - 1;
    if (tokenN > 1) {
      warn(`lore sync: ${page} — ${tokenN} ${JOURNAL_TOKEN} / accumulated decision history, rebuilt + deduped`);
    }
  }
  const block = `${DH_HEADING}\n\n${DH_START}\n${md}\n${DH_END}\n`;
  const tail = text.slice(end);
  return text.slice(0, start) + block + (tail ? `\n${tail}` : '');
}

// Translation counts for the HOME status block. Sidecars live on disk, not on the
// lightweight {id,title} axisPages entries, so re-derive by scanning. missing = an
// available non-default language with no sidecar on disk.
function translationStats({ wikiDir, axisPages, language }) {
  const others = language.available.filter(l => l !== language.default);
  if (!others.length) return { ready: 0, stale: 0, missing: 0 };
  let ready = 0, stale = 0, missing = 0;
  for (const [axis, pages] of Object.entries(axisPages)) {
    for (const p of pages) {
      const rel = `${axis}/${p.id}.md`;
      const abs = join(wikiDir, rel);
      if (!existsSync(abs)) continue;
      const found = discoverTranslations({
        wikiDir, pagePath: rel, pageText: readFileSync(abs, 'utf8'),
        available: language.available, defaultLang: language.default,
      });
      const byLang = new Map(found.map(t => [t.lang, t]));
      for (const lang of others) {
        const t = byLang.get(lang);
        if (!t) missing++; else if (t.stale) stale++; else ready++;
      }
    }
  }
  return { ready, stale, missing };
}

export function finalizeSync(loreDir, now, { warn = (m) => console.error(m) } = {}) {
  const repoRoot = join(resolve(loreDir), '..');
  const wikiDir = join(loreDir, 'wiki');
  const stateDir = join(loreDir, '.state');
  const codeSha = headShortSha(repoRoot);
  const lastUpdated = now.slice(0, 10);
  const rawAtoms = readAllAtoms(join(loreDir, 'journal'));
  // 折叠：丢 amend/rebase 孤儿 + 同 id 合并。下游决策史与 HOME/INDEX 计数一并基于折叠后视图。
  const allAtoms = foldAtoms(rawAtoms, { reachableShas: reachableShaSet(repoRoot) });

  // prose 指纹：解耦「prose 新鲜度」与「机械 finalize」。对该页 finalize 后将写入的稳定文本算 hash
  // （foldJournal / finalizeHomeText 之后）——token↔哨兵形态在首次 finalize 时跳变，若对读入文本算，
  // 会把 seed 后第一次机械刷新误判成「正文变了」而错误推进 prose_sha。
  const fingerprints = readFingerprints(stateDir);
  const nextFingerprints = {};
  const resolveProseSha = (rel, finalText) => {
    const h = proseHash(finalText);
    const prev = fingerprints[rel];
    const prose_sha = (prev && prev.prose_hash === h) ? prev.prose_sha : codeSha;
    nextFingerprints[rel] = { prose_hash: h, prose_sha };
    return prose_sha;
  };

  const stamped = [];
  const axisPages = {};
  for (const axis of SYNC_AXES) {
    const axisDir = join(wikiDir, axis);
    let files = [];
    try {
      files = readdirSync(axisDir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.md'))
        .map(e => e.name).sort();
    } catch { continue; }
    axisPages[axis] = [];
    for (const f of files) {
      const p = join(axisDir, f);
      const id = basename(f, '.md');
      const rel = `${axis}/${f}`;
      const atomsFor = allAtoms.filter(a => a.facets?.[axis]?.includes(id));
      const md = renderDecisionHistory(atomsFor);
      let text = foldJournal(readFileSync(p, 'utf8'), md, { page: rel, warn });
      const proseSha = resolveProseSha(rel, text);           // 对折叠后的稳定文本算指纹
      text = stampFrontmatter(text, {
        codeSha: proseSha,
        lastUpdated,
        atoms: atomsFor.length,
        commits: atomsFor.filter(a => a.kind === 'commit').length,
      });
      writeFileSync(p, text);
      const { data } = parseFrontmatter(text);
      stamped.push(rel);
      axisPages[axis].push({ id, title: data.title ?? id });
    }
  }

  // docs axis — mechanical materialized view of docs/ + CHANGELOG + CLAUDE.md (no journal, no LLM)
  // single config read feeds both docs and language (do not re-declare configPath/configText below)
  const configPath = join(loreDir, 'config.yml');
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const docsConfig = parseConfigDocsAxis(configText);
  const language = parseConfigLanguage(configText);
  if (docsConfig) {
    const docsPages = buildDocsAxis(loreDir, repoRoot, docsConfig);
    if (docsPages.length) axisPages.docs = docsPages;
  }

  if (!existsSync(wikiDir)) mkdirSync(wikiDir, { recursive: true });

  // HOME — 半稳定人读页；机械状态注入哨兵区，re-sync 原地替换。走同一指纹逻辑（对注入后的文本算）。
  // 写在 manifest 前，使 HOME 落为 axis 0。
  const pkgPath = join(repoRoot, 'package.json');
  let version = 'unknown', pkgName = null;
  try { const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); version = pkg.version ?? 'unknown'; pkgName = pkg.name ?? null; } catch {}
  const homePath = join(wikiDir, 'HOME.md');
  // 脚手架标题用真实仓库名（package.json name → 仓库目录名），不再写死 'lore'
  const existingHome = existsSync(homePath) ? readFileSync(homePath, 'utf8') : defaultHomePage({ title: pkgName || basename(repoRoot), axisPages });
  const homeStatus = buildHomeStatus({
    version, codeSha, lastUpdated, axisPages, language,
    translationStats: translationStats({ wikiDir, axisPages, language }),
  });
  const homeText = finalizeHomeText(existingHome, homeStatus);
  const homeProseSha = resolveProseSha('HOME.md', homeText);  // 对注入状态块后的稳定文本算指纹
  writeFileSync(homePath, stampFrontmatter(homeText, {
    codeSha: homeProseSha,
    lastUpdated,
    atoms: allAtoms.length,
    commits: allAtoms.filter(a => a.kind === 'commit').length,
  }));

  // INDEX — 纯机械 TOC，永远当前（不进指纹）
  const indexFields = {
    codeSha,
    lastUpdated,
    atoms: allAtoms.length,
    commits: allAtoms.filter(a => a.kind === 'commit').length,
  };
  writeFileSync(join(wikiDir, 'INDEX.md'), stampFrontmatter(buildIndex(axisPages), indexFields));

  // 写回指纹 + GC：nextFingerprints 只装本轮处理过（仍存在）的页 → 孤儿（已删页）天然丢弃。
  writeFingerprints(stateDir, nextFingerprints);

  // staleScopes：component → [code_root]；flow → spans 各 code_root；theme / HOME → 无（全仓）。
  const codeRoots = parseConfigCodeRoots(configText);
  const flows = parseConfigFlows(configText);
  const staleScopes = {};
  for (const cr of codeRoots) staleScopes[`component/${cr.split('/').pop()}.md`] = [cr];
  for (const fl of flows) {
    const roots = (fl.spans ?? []).map(s => codeRoots.find(cr => cr.split('/').pop() === s) ?? s);
    if (roots.length) staleScopes[`flow/${fl.id}.md`] = roots;
  }
  // 深度页：component/<mod>.md → [实际解析出的源文件]（按源文件精确 stale）
  const deep = parseConfigDeep(configText);
  const resolvedDeep = resolveConfiguredDeep(repoRoot, codeRoots, deep);
  for (const { mod, sourceFile } of resolvedDeep.entries) {
    staleScopes[`component/${mod}.md`] = [sourceFile];
  }
  // component 排序 + 分组：鸟瞰（code_root）置顶 + 各 deep order 流水线序；group 来自 deep groups
  const componentOrder = [...codeRoots.map(cr => cr.split('/').pop())];
  const pageGroups = {};
  for (const [, { order, groups }] of Object.entries(deep)) {
    componentOrder.push(...order);
    for (const g of groups) for (const mod of g.mods) pageGroups[mod] = g.name;
  }

  const { manifestPath, manifest } = runManifestCli(loreDir, now, staleScopes, componentOrder, pageGroups);
  writeFileSync(join(wikiDir, '.graph.json'),
    JSON.stringify(buildGraph(allAtoms, manifest, now), null, 2) + '\n');
  // 期望态对齐：引擎升级后资产自动收敛（壳/hook stub/config 补缺/resident 节刷新）。best-effort。
  let migrate = [];
  try { migrate = alignAssets(join(resolve(loreDir), '..'), resolve(loreDir)); } catch { /* 不挡 finalize */ }
  return { stamped, indexWritten: true, manifestPath, migrate };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sub = process.argv[2];
  const loreDir = process.argv[3];
  if (!sub || !loreDir) {
    console.error('usage: node lib/sync.js <plan|finalize> <loreDir>');
    process.exit(1);
  }
  if (sub === 'plan') {
    const all = process.argv.includes('--all');
    console.log(JSON.stringify(planSync(loreDir, { all }), null, 2));
  } else if (sub === 'finalize') {
    const r = finalizeSync(loreDir, new Date().toISOString());
    console.log(`✓ sync finalized: stamped ${r.stamped.length} page(s), INDEX + manifest written`);
    console.log(`  manifest: ${r.manifestPath}`);
    if (r.migrate.length) console.log('  migrate: ' + r.migrate.map(a => `${a.asset}:${a.action}`).join(', '));
    console.log('  next: /lore:serve');
  } else {
    console.error(`unknown subcommand: ${sub} (expected plan|finalize)`);
    process.exit(1);
  }
}
