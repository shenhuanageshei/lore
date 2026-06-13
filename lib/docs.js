// lib/docs.js — deterministic docs-axis extractors (zero-dep, no LLM, no journal)
import { readdirSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from './manifest.js';
import { findMetaDoc } from './init.js';   // 元文档子目录定位（单向依赖：init 不 import docs）

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
  const prefix = docsGlob.split('/**')[0].replace(/\/$/, '');   // 'docs/**/*.md'→'docs'; tolerate trailing slash
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
      body: parseFrontmatter(text).body,
    };
  });
}

export function changelogExtractor(repoRoot) {
  const rel = findMetaDoc(repoRoot, 'CHANGELOG.md');   // 根优先，否则一层子目录（threat-intel 式）
  if (!rel) return [];
  const text = readFileSync(join(repoRoot, rel), 'utf8');
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
    sourcePath: rel,
    date: (entries.find(e => e.date) || entries[0]).date,
    entries,
    body: parseFrontmatter(text).body,
  }];
}

// README / ROADMAP：整篇收一页（title 取首个 # 标题，summary 取首段）。
export function readmeExtractor(repoRoot) {
  const rel = findMetaDoc(repoRoot, 'README.md');
  if (!rel) return [];
  const text = readFileSync(join(repoRoot, rel), 'utf8');
  return [{
    id: 'readme', title: extractTitle(text, 'README'), summary: extractSummary(text),
    sourcePath: rel, date: '', body: parseFrontmatter(text).body,
  }];
}

export function roadmapExtractor(repoRoot) {
  const rel = findMetaDoc(repoRoot, 'ROADMAP.md');
  if (!rel) return [];
  const text = readFileSync(join(repoRoot, rel), 'utf8');
  return [{
    id: 'roadmap', title: extractTitle(text, 'ROADMAP'), summary: extractSummary(text),
    sourcePath: rel, date: '', body: parseFrontmatter(text).body,
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

// docs 轴分组（spec 2026-06-13-lore-docs-axis-presentation）：通用化，零 config。
// 元文档（changelog/readme/roadmap/pitfalls，不论路径）独立置顶组；其余按语义子目录段。
const META_DOC_RE = /(^|\/)(changelog|readme|roadmap)\.md$|(^|\/)claude\.md$/i;
const SEMANTIC_DIR = {
  specs: '设计', spec: '设计', design: '设计', plans: '计划', plan: '计划',
  debugging: '调试', debug: '调试', api: '接口', architecture: '架构', arch: '架构',
  notes: '笔记', note: '笔记',
};
export function docGroup(sourcePath) {
  const p = (sourcePath ?? '').replace(/\\/g, '/');
  if (META_DOC_RE.test(p)) return '项目状态';
  for (const seg of p.toLowerCase().split('/')) if (SEMANTIC_DIR[seg]) return SEMANTIC_DIR[seg];
  return '其它';
}

// superpowers 命名约定配对：specs/<date>-<slug>-design.md ↔ plans/<date>-<slug>.md。
// 命中 → spec 就地标 pairedPlan = plan 的页 id。错配风险低（date+slug 双键）。
export function pairDocs(specs) {
  const planByKey = new Map();
  for (const s of specs) {
    const m = (s.sourcePath ?? '').replace(/\\/g, '/')
      .match(/^docs\/superpowers\/plans\/(\d{4}-\d{2}-\d{2})-(.+)\.md$/);
    if (m) planByKey.set(`${m[1]}|${m[2]}`, s.id);
  }
  for (const s of specs) {
    const m = (s.sourcePath ?? '').replace(/\\/g, '/')
      .match(/^docs\/superpowers\/specs\/(\d{4}-\d{2}-\d{2})-(.+)-design\.md$/);
    if (m) {
      const planId = planByKey.get(`${m[1]}|${m[2]}`);
      if (planId) s.pairedPlan = planId;
    }
  }
  return specs;
}

export function renderDocsPage(spec) {
  const fm = `---\ntitle: ${spec.title}\nsummary: ${spec.summary}\nsource_path: ${spec.sourcePath}\nlast_updated: ${spec.date}\ngroup: ${spec.group ?? docGroup(spec.sourcePath)}${spec.pairedPlan ? `\npaired_plan: ${spec.pairedPlan}` : ''}\n---`;
  const ref = `> 源文档：\`${spec.sourcePath}\``;        // plain-text reference (not a link → no 404)
  const main = spec.body !== undefined
    ? spec.body                                          // embed the doc's body verbatim (its own H1 is the title)
    : `# ${spec.title}${renderEntries(spec.entries)}`;   // pitfalls etc.: header + entries list
  return `${fm}\n${ref}\n\n${main}\n`;
}

const EXTRACTORS = {
  docs: (root, cfg) => docsExtractor(root, cfg.docsGlob),
  changelog: (root) => changelogExtractor(root),
  readme: (root) => readmeExtractor(root),
  roadmap: (root) => roadmapExtractor(root),
  claude_md_pitfalls: (root) => pitfallsExtractor(root),
};

export function buildDocsAxis(loreDir, repoRoot, docsConfig) {
  const docsDir = join(loreDir, 'wiki', 'docs');
  rmSync(docsDir, { recursive: true, force: true });   // nuke — materialized view (also clears a now-empty axis)
  const specs = [];
  for (const src of docsConfig.sources) {
    const fn = EXTRACTORS[src];
    if (fn) specs.push(...fn(repoRoot, docsConfig));   // unknown source key → skip silently (config-gated)
  }
  for (const s of specs) s.group = docGroup(s.sourcePath);
  pairDocs(specs);
  specs.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.id.localeCompare(b.id));   // newest docs first
  if (!specs.length) return [];                        // no docs → leave no empty wiki/docs axis dir
  mkdirSync(docsDir, { recursive: true });
  // NOTE: id collisions silently overwrite (e.g. a docs/changelog.md vs the 'changelog' page).
  // Contrived; deferred to ROADMAP (折叠页 id 碰撞前缀). Acceptable for v1.
  for (const spec of specs) writeFileSync(join(docsDir, `${spec.id}.md`), renderDocsPage(spec));
  return specs.map(s => ({ id: s.id, title: s.title }));
}
