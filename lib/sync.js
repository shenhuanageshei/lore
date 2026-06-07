import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, runManifestCli } from './manifest.js';
import { parseConfigCodeRoots, parseConfigThemes, parseConfigFlows, parseConfigDocsAxis, parseConfigLanguage } from './config.js';
import { buildDocsAxis } from './docs.js';
import { readAllAtoms } from './journal.js';
import { foldAtoms } from './fold.js';
import { discoverTranslations } from './i18n.js';
import { buildHomeStatus, defaultHomePage, finalizeHomeText } from './home.js';

export function planSync(loreDir) {
  const configPath = join(loreDir, 'config.yml');
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const codeRoots = parseConfigCodeRoots(configText);
  const themes = parseConfigThemes(configText);
  const wikiDir = join(loreDir, 'wiki');
  const exists = (axis, id) => existsSync(join(wikiDir, axis, `${id}.md`));
  const worklist = [];
  worklist.push({ axis: 'HOME', id: 'HOME', path: 'HOME.md', priorExists: existsSync(join(wikiDir, 'HOME.md')) });
  for (const codeRoot of codeRoots) {
    const id = codeRoot.split('/').pop();
    worklist.push({ axis: 'component', id, component: id, codeRoot, path: `component/${id}.md`, priorExists: exists('component', id) });
  }
  for (const th of themes) {
    worklist.push({ axis: 'theme', id: th.id, path: `theme/${th.id}.md`, priorExists: exists('theme', th.id) });
  }
  const flows = parseConfigFlows(configText);
  for (const fl of flows) {
    worklist.push({ axis: 'flow', id: fl.id, path: `flow/${fl.id}.md`, priorExists: exists('flow', fl.id) });
  }
  return { codeRoots, themes, flows, worklist };
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
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim();
}

// 当前 repo 所有 ref 可达的完整 sha 集合（喂 foldAtoms 丢孤儿）。
// best-effort：非 git / git 不可用 → null，foldAtoms 退化为仅合并、不丢孤儿。
function reachableShaSet(repoRoot) {
  try {
    const out = execFileSync('git', ['rev-list', '--all'],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }).toString();
    return new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
  } catch { return null; }
}

export function renderDecisionHistory(atoms) {
  if (atoms.length === 0) return '暂无 journal 原子（跑 /lore:mine 补全）。';
  const sorted = [...atoms].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return sorted.map(a => {
    const sha = (a.commit ?? '').slice(0, 7);
    const date = (a.ts ?? '').slice(0, 10);
    const why = (a.why ?? '').split('\n')[0].trim();
    const meta = a.commit ? `(${sha}, ${date})` : `(${date})`;
    return why ? `- **${a.title}** — ${why} ${meta}` : `- **${a.title}** ${meta}`;
  }).join('\n');
}

const JOURNAL_TOKEN = '{{LORE_JOURNAL}}';

function countOccurrences(text, sub) {
  let n = 0, i = 0;
  while ((i = text.indexOf(sub, i)) !== -1) { n++; i += sub.length; }
  return n;
}

// Fold rendered decision-history markdown into a page's {{LORE_JOURNAL}} placeholder.
// count 0 → no-op (a page may legitimately supply its own decision history, no token).
// count 1 → the happy path: replace it.
// count >1 → ambiguous (e.g. a prose mention of the token alongside the real slot): warn,
// then fold into the LAST occurrence — the conventional Decision-history slot, which always
// follows any prose mention — and blank the earlier ones. Never leaves a literal token.
export function foldJournal(text, md, { page = '(page)', warn = (m) => console.error(m) } = {}) {
  const count = countOccurrences(text, JOURNAL_TOKEN);
  if (count <= 1) {
    return text.replace(JOURNAL_TOKEN, () => md);   // 0 → no match (no-op); 1 → fold. function-form: $&/$$-safe
  }
  warn(`lore sync: ${page} — ${count} ${JOURNAL_TOKEN} placeholders (expected 1); folded into the last, blanked the rest`);
  const lastIdx = text.lastIndexOf(JOURNAL_TOKEN);
  const head = text.slice(0, lastIdx).split(JOURNAL_TOKEN).join('');   // blank earlier tokens
  const tail = text.slice(lastIdx + JOURNAL_TOKEN.length);
  return head + md + tail;                                             // md inserted literally ($-safe)
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
  const codeSha = headShortSha(repoRoot);
  const lastUpdated = now.slice(0, 10);
  const rawAtoms = readAllAtoms(join(loreDir, 'journal'));
  // 折叠：丢 amend/rebase 孤儿 + 同 id 合并。下游决策史(153)与 HOME/INDEX 计数(196/197/203/204) 一并基于折叠后视图。
  const allAtoms = foldAtoms(rawAtoms, { reachableShas: reachableShaSet(repoRoot) });

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
      const atomsFor = allAtoms.filter(a => a.facets?.[axis]?.includes(id));
      const md = renderDecisionHistory(atomsFor);
      let text = foldJournal(readFileSync(p, 'utf8'), md, { page: `${axis}/${f}`, warn });
      text = stampFrontmatter(text, {
        codeSha,
        lastUpdated,
        atoms: atomsFor.length,
        commits: atomsFor.filter(a => a.kind === 'commit').length,
      });
      writeFileSync(p, text);
      const { data } = parseFrontmatter(text);
      stamped.push(`${axis}/${f}`);
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

  // HOME — human orientation page; mechanical status injected into a sentinel region
  // so re-sync swaps it in place. Written before the manifest so HOME lands as axis 0.
  const pkgPath = join(repoRoot, 'package.json');
  let version = 'unknown';
  try { version = JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? 'unknown'; } catch {}
  const homePath = join(wikiDir, 'HOME.md');
  const existingHome = existsSync(homePath) ? readFileSync(homePath, 'utf8') : defaultHomePage({ title: 'lore', axisPages });
  const homeStatus = buildHomeStatus({
    version, codeSha, lastUpdated, axisPages, language,
    translationStats: translationStats({ wikiDir, axisPages, language }),
  });
  writeFileSync(homePath, stampFrontmatter(finalizeHomeText(existingHome, homeStatus), {
    codeSha,
    lastUpdated,
    atoms: allAtoms.length,
    commits: allAtoms.filter(a => a.kind === 'commit').length,
  }));

  const indexFields = {
    codeSha,
    lastUpdated,
    atoms: allAtoms.length,
    commits: allAtoms.filter(a => a.kind === 'commit').length,
  };
  writeFileSync(join(wikiDir, 'INDEX.md'), stampFrontmatter(buildIndex(axisPages), indexFields));

  const manifestPath = runManifestCli(loreDir, now);
  return { stamped, indexWritten: true, manifestPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sub = process.argv[2];
  const loreDir = process.argv[3];
  if (!sub || !loreDir) {
    console.error('usage: node lib/sync.js <plan|finalize> <loreDir>');
    process.exit(1);
  }
  if (sub === 'plan') {
    console.log(JSON.stringify(planSync(loreDir), null, 2));
  } else if (sub === 'finalize') {
    const r = finalizeSync(loreDir, new Date().toISOString());
    console.log(`✓ sync finalized: stamped ${r.stamped.length} page(s), INDEX + manifest written`);
    console.log(`  manifest: ${r.manifestPath}`);
    console.log('  next: /lore:serve');
  } else {
    console.error(`unknown subcommand: ${sub} (expected plan|finalize)`);
    process.exit(1);
  }
}
