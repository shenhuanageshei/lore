// lib/docs.js — deterministic docs-axis extractors (zero-dep, no LLM, no journal)
import { readdirSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from './manifest.js';

export function slugifyDocPath(relFromDocs) {
  return relFromDocs.replace(/\.md$/i, '').replace(/[\\/]/g, '-');
}

export function extractDate(name) {
  const m = name.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

export function extractTitle(text, fallback) {
  const { data, body } = parseFrontmatter(text);
  if (data.title) return data.title;
  const h1 = body.match(/^#\s+(.+)$/m);
  return h1 ? h1[1].trim() : fallback;
}

export function extractSummary(text) {
  const { data, body } = parseFrontmatter(text);
  if (data.summary) return data.summary;
  const lines = body.split(/\r?\n/);
  let i = 0;
  // skip leading blank lines and heading lines (# Title, ## Section, ...)
  while (i < lines.length && (lines[i].trim() === '' || /^#{1,6}\s/.test(lines[i]))) i++;
  let para = '';
  while (i < lines.length && lines[i].trim() !== '' && !/^#/.test(lines[i])) {
    para += (para ? ' ' : '') + lines[i].trim();
    i++;
  }
  return para.length > 200 ? para.slice(0, 197) + '...' : para;
}

function walkMd(absDir, relPrefix, out) {
  let entries = [];
  try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
    if (e.isDirectory()) walkMd(join(absDir, e.name), rel, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(rel);
  }
}

export function docsExtractor(repoRoot, docsGlob = 'docs/**/*.md') {
  const prefix = docsGlob.split('/**')[0];               // 'docs/**/*.md' → 'docs'
  const base = join(repoRoot, prefix);
  if (!existsSync(base)) return [];
  const rels = [];
  walkMd(base, '', rels);                                 // relative to docs/
  return rels.map(rel => {
    const text = readFileSync(join(base, rel), 'utf8');
    const fallback = rel.replace(/\.md$/i, '').split('/').pop();
    return {
      id: slugifyDocPath(rel),
      title: extractTitle(text, fallback),
      summary: extractSummary(text),
      sourcePath: `${prefix}/${rel}`,
      date: extractDate(rel),
    };
  });
}

export function changelogExtractor(repoRoot) {
  const p = join(repoRoot, 'CHANGELOG.md');
  if (!existsSync(p)) return [];
  const text = readFileSync(p, 'utf8');
  const entries = [];
  // match `## [x.y.z] — date` / `## [x.y.z] - date`; capture the heading tail, then find the date in it
  const re = /^##\s*\[([^\]]+)\]([^\n]*)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const dm = m[2].match(/(\d{4}-\d{2}-\d{2})/);
    entries.push({ version: m[1], date: dm ? dm[1] : '' });
  }
  if (!entries.length) return [];
  return [{
    id: 'changelog',
    title: 'CHANGELOG',
    summary: `${entries.length} 个版本，最新 ${entries[0].version}`,
    sourcePath: 'CHANGELOG.md',
    date: (entries.find(e => e.date) || entries[0]).date,
    entries,
  }];
}

const PITFALL_PROBLEM = /\*\*(?:Problem|问题)\*\*[：:]\s*(.+)/;
const PITFALL_FIX = /\*\*(?:Fix|修复)\*\*[：:]\s*(.+)/;
const PITFALL_PREVENTION = /\*\*(?:Prevention|预防)\*\*[：:]\s*(.+)/;

export function pitfallsExtractor(repoRoot) {
  const p = join(repoRoot, 'CLAUDE.md');
  if (!existsSync(p)) return [];
  const text = readFileSync(p, 'utf8');
  // split at each Problem label; each chunk that contains one is a pitfall
  const chunks = text.split(/(?=\*\*(?:Problem|问题)\*\*[：:])/);
  const entries = [];
  for (const c of chunks) {
    const pm = c.match(PITFALL_PROBLEM);
    if (!pm) continue;
    const fm = c.match(PITFALL_FIX);
    const vm = c.match(PITFALL_PREVENTION);
    entries.push({ problem: pm[1].trim(), fix: fm ? fm[1].trim() : '', prevention: vm ? vm[1].trim() : '' });
  }
  if (!entries.length) return [];
  return [{
    id: 'pitfalls',
    title: 'Pitfalls',
    summary: `${entries.length} 条踩坑`,
    sourcePath: 'CLAUDE.md',
    date: '',
    entries,
  }];
}

function renderEntries(entries) {
  if (!entries || !entries.length) return '';
  // changelog entries have {version,date}; pitfalls have {problem,fix,prevention}
  const lines = entries.map(e => {
    if (e.version !== undefined) return `- **${e.version}** — ${e.date}`;
    const tail = [e.fix && `修复：${e.fix}`, e.prevention && `预防：${e.prevention}`].filter(Boolean).join('；');
    return tail ? `- **${e.problem}** — ${tail}` : `- **${e.problem}**`;
  });
  return '\n\n' + lines.join('\n');
}

export function renderDocsPage(spec) {
  const fm = `---\ntitle: ${spec.title}\nsummary: ${spec.summary}\nsource_path: ${spec.sourcePath}\nlast_updated: ${spec.date}\n---`;
  // .lore/wiki/docs/<id>.md is 3 levels deep from repo root → ../../../ reaches the source
  const link = `源文档：[${spec.sourcePath}](../../../${spec.sourcePath})`;
  return `${fm}\n# docs: ${spec.title}\n\n${spec.summary}\n\n${link}${renderEntries(spec.entries)}\n`;
}

const EXTRACTORS = {
  docs: (root, cfg) => docsExtractor(root, cfg.docsGlob),
  changelog: (root) => changelogExtractor(root),
  claude_md_pitfalls: (root) => pitfallsExtractor(root),
};

export function buildDocsAxis(loreDir, repoRoot, docsConfig) {
  const docsDir = join(loreDir, 'wiki', 'docs');
  rmSync(docsDir, { recursive: true, force: true });   // nuke — materialized view
  mkdirSync(docsDir, { recursive: true });
  const specs = [];
  for (const src of docsConfig.sources) {
    const fn = EXTRACTORS[src];
    if (fn) specs.push(...fn(repoRoot, docsConfig));   // unknown source key → skip silently (config-gated)
  }
  // NOTE: id collisions silently overwrite (e.g. a docs/changelog.md vs the 'changelog' page).
  // Contrived; deferred to ROADMAP (折叠页 id 碰撞前缀). Acceptable for v1.
  for (const spec of specs) writeFileSync(join(docsDir, `${spec.id}.md`), renderDocsPage(spec));
  return specs.map(s => ({ id: s.id, title: s.title }));
}
