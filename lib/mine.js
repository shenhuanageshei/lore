import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendAtom, existingIds } from './journal.js';
import { parseConfigCodeRoots, parseConfigThemes, parseConfigFlows } from './config.js';
import { whyField } from './fold.js';

export const GIT_FORMAT = '%x1e%H%x1f%aI%x1f%s%x1f%b%x1f';

export function mineCommits(repoRoot, codeRoots, themes = [], flows = []) {
  const stdout = execFileSync(
    'git',
    ['log', '--no-merges', `--pretty=format:${GIT_FORMAT}`, '--name-only'],
    { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  ).toString();
  return parseGitLog(stdout).map(raw => commitAtom(raw, codeRoots, 'miner:commits', themes, flows));
}

export function pathComponent(filePath, codeRoots) {
  let best = null;
  for (const root of codeRoots) {
    if (filePath === root || filePath.startsWith(root + '/')) {
      if (best === null || root.length > best.length) best = root;
    }
  }
  return best === null ? null : best.split('/').pop();
}

export function parseGitLog(stdout) {
  return stdout
    .split('\x1e')
    .slice(1)
    .map(rec => {
      const [sha, ts, subject, body, filesBlob = ''] = rec.split('\x1f');
      const files = filesBlob.split('\n').map(s => s.trim()).filter(Boolean);
      return { sha, ts, subject, body, files };
    });
}

export function commitAtom(raw, codeRoots, source = 'miner:commits', themes = [], flows = []) {
  const component = [...new Set(
    raw.files.map(f => pathComponent(f, codeRoots)).filter(Boolean),
  )].sort();
  const theme = tagThemes(`${raw.subject} ${raw.body}`, themes);
  const flow = tagFlows(component, flows);
  return {
    id: `commit:${raw.sha}`,
    ts: raw.ts,
    kind: 'commit',
    commit: raw.sha,
    title: raw.subject,
    ...whyField(raw.body),   // trailer（Co-Authored-By / Generated with 等）是签名不是 rationale；剥后无正文 → 不写 why 键
    what_changed: '',
    facets: { component, flow, theme },
    refs: { files: raw.files, pitfall: null, related: [] },
    source,
    enriched: false,
    confidence: 'EXTRACTED',
  };
}

// ---------- 踩坑入库（接线 `journal.mine: [..., claude_md_pitfalls]` 这条死声明） ----------
// 源：CLAUDE.md / AGENTS.md 的「**问题** / **修复** / **预防**」三段记录。
// 同源去重：两份指令文件是同一份清单的手工双份，逐字内容会漂移（实测 2 条预防段里的
// backend 名不同：claude vs Codex），所以身份键 = 规范化「问题」并遮蔽内联代码段——
// 漂移恰好都落在代码片段里，遮蔽后同一踩坑在两份文件里得同一个键、只落一条原子。
export const PITFALL_FILES = ['CLAUDE.md', 'AGENTS.md'];
export const PITFALL_SOURCE = 'miner:claude_md_pitfalls';
export const MINE_SOURCES = ['commits', 'claude_md_pitfalls'];

const PITFALL_LABELS = [
  ['problem', /^\*\*(?:Problem|问题)\*\*[：:][ \t]*/m],
  ['fix', /^\*\*(?:Fix|修复)\*\*[：:][ \t]*/m],
  ['prevention', /^\*\*(?:Prevention|预防)\*\*[：:][ \t]*/m],
];
const normText = s => String(s ?? '').replace(/\s+/g, ' ').trim();

// 单份文档 → 踩坑条目数组（每条含 problem/fix/prevention；值可跨行，到下一个标签止）。
export function parsePitfallEntries(text) {
  const entries = [];
  for (const chunk of String(text ?? '').split(/(?=^\*\*(?:Problem|问题)\*\*[：:])/m)) {
    const marks = [];
    for (const [key, re] of PITFALL_LABELS) {
      const m = chunk.match(re);
      if (m) marks.push({ key, labelAt: m.index, valueAt: m.index + m[0].length });
    }
    if (!marks.length || marks[0].key !== 'problem') continue;   // 只认以「问题」起头的块
    marks.sort((a, b) => a.labelAt - b.labelAt);
    const entry = {};
    for (let i = 0; i < marks.length; i++) {
      const to = i + 1 < marks.length ? marks[i + 1].labelAt : chunk.length;   // 到下一个标签行为止
      entry[marks[i].key] = chunk.slice(marks[i].valueAt, to).trim();
    }
    entries.push({ problem: entry.problem ?? '', fix: entry.fix ?? '', prevention: entry.prevention ?? '' });
  }
  return entries;
}

// 身份键（同源去重 + 幂等）：规范化问题 + 内联代码遮蔽。
export function pitfallKey(entry) {
  return normText(entry.problem).replace(/`[^`]*`/g, '<code>');
}

export function pitfallId(entry) {
  return `pitfall:${createHash('sha256').update(pitfallKey(entry)).digest('hex').slice(0, 16)}`;
}

const PITFALL_TITLE_MAX = 120;
const pitfallTitle = problem => (problem.length > PITFALL_TITLE_MAX ? `${problem.slice(0, PITFALL_TITLE_MAX)}…` : problem);

export function pitfallAtom(entry, { ts, sources = [] } = {}) {
  const problem = normText(entry.problem), fix = normText(entry.fix), prevention = normText(entry.prevention);
  return {
    id: pitfallId({ problem, fix, prevention }),
    ts,
    kind: 'pitfall',
    commit: null,
    title: pitfallTitle(problem),
    what_changed: '',
    facets: { component: [], flow: [], theme: [] },
    refs: { files: [], pitfall: null, related: [] },
    source: PITFALL_SOURCE,
    sources: [...sources].sort(),   // 哪些指令文件承载了这条踩坑（同源去重的证据）
    problem, fix, prevention,       // 固定三段（设计 §3.1）
    status: 'draft',                // 机器挖掘 = 草稿；只有 owner 的直接动作能产生 confirmed
    enriched: false,
    confidence: 'EXTRACTED',
  };
}

// 读指令文件 → 去重后的踩坑原子（三段不全的条目跳过——与 S1 校验同款口径）。
export function minePitfalls({ repoRoot, files = PITFALL_FILES, now = new Date().toISOString() } = {}) {
  const byKey = new Map();
  for (const rel of files) {
    const p = join(repoRoot, rel);
    if (!existsSync(p)) continue;
    for (const entry of parsePitfallEntries(readFileSync(p, 'utf8'))) {
      if (!normText(entry.problem) || !normText(entry.fix) || !normText(entry.prevention)) continue;
      const k = pitfallKey(entry);
      const hit = byKey.get(k);
      if (hit) { if (!hit.sources.includes(rel)) hit.sources.push(rel); continue; }
      byKey.set(k, { ...entry, sources: [rel] });   // 先见者为准（文件顺序即优先级）
    }
  }
  return [...byKey.values()].map(e => pitfallAtom(e, { ts: now, sources: e.sources }));
}

// config 的 `journal.mine` 声明；缺声明 → ['commits']（历史行为）。未知键静默忽略（同 docs 轴 extractor 口径）。
export function parseConfigMine(configText) {
  const m = (configText ?? '').match(/^[ \t]*mine:\s*\[([^\]]*)\]/m);
  if (!m) return ['commits'];
  const list = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '').trim()).filter(Boolean);
  return list.length ? list : ['commits'];
}

export function mine({ repoRoot, journalDir, codeRoots, themes = [], flows = [], mines = ['commits'], now } = {}) {
  const seen = existingIds(journalDir);
  const bySource = {};
  const atoms = [];
  if (mines.includes('commits')) {
    const commits = mineCommits(repoRoot, codeRoots, themes, flows);
    atoms.push(...commits);
    bySource.commits = { scanned: commits.length, added: 0, skipped: 0 };
  }
  if (mines.includes('claude_md_pitfalls')) {
    const pitfalls = minePitfalls({ repoRoot, now });
    atoms.push(...pitfalls);
    bySource.claude_md_pitfalls = { scanned: pitfalls.length, added: 0, skipped: 0 };
  }
  let added = 0, skipped = 0;
  for (const a of atoms) {
    const bucket = a.kind === 'pitfall' ? bySource.claude_md_pitfalls : bySource.commits;
    if (seen.has(a.id)) { skipped++; if (bucket) bucket.skipped++; continue; }
    appendAtom(journalDir, a);
    seen.add(a.id);
    added++;
    if (bucket) bucket.added++;
  }
  return { scanned: atoms.length, added, skipped, bySource };
}

export function tagThemes(text, themes) {
  const lower = (text ?? '').toLowerCase();
  return themes
    .filter(th => th.match.some(kw => lower.includes(kw.toLowerCase())))
    .map(th => th.id)
    .sort();
}

export function tagFlows(components, flows) {
  const set = new Set(components);
  return flows
    .filter(fl => fl.spans.some(s => set.has(s)))
    .map(fl => fl.id)
    .sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = process.argv[2] ?? process.cwd();
  const loreDir = join(repoRoot, '.lore');
  const configPath = join(loreDir, 'config.yml');
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const codeRoots = parseConfigCodeRoots(configText);
  const themes = parseConfigThemes(configText);
  const flows = parseConfigFlows(configText);
  const journalDir = join(loreDir, 'journal');
  const mines = parseConfigMine(configText);
  const r = mine({ repoRoot, journalDir, codeRoots, themes, flows, mines });
  const c = r.bySource.commits;
  if (c) console.log(`✓ mined ${c.added} new commit atom(s) (${c.skipped} already present, ${c.scanned} scanned)`);
  const pf = r.bySource.claude_md_pitfalls;
  if (pf) console.log(`✓ mined ${pf.added} new pitfall atom(s) (${pf.skipped} already present, ${pf.scanned} scanned)`);
  if (!existsSync(configPath)) {
    console.log('  note: no .lore/config.yml — run /lore:init for component tagging');
  }
  console.log('  next: /lore:sync');
}
