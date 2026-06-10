import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendAtom, existingIds } from './journal.js';
import { parseConfigCodeRoots, parseConfigThemes, parseConfigFlows } from './config.js';
import { stripTrailers } from './fold.js';

export const GIT_FORMAT = '%x1e%H%x1f%aI%x1f%s%x1f%b%x1f';

export function mineCommits(repoRoot, codeRoots, themes = [], flows = []) {
  const stdout = execFileSync(
    'git',
    ['log', '--no-merges', `--pretty=format:${GIT_FORMAT}`, '--name-only'],
    { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
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
    why: stripTrailers(raw.body),   // commit trailer（Co-Authored-By 等）是签名不是 rationale
    what_changed: '',
    facets: { component, flow, theme },
    refs: { files: raw.files, pitfall: null, related: [] },
    source,
    enriched: false,
    confidence: 'EXTRACTED',
  };
}

export function mine({ repoRoot, journalDir, codeRoots, themes = [], flows = [] }) {
  const seen = existingIds(journalDir);
  const atoms = mineCommits(repoRoot, codeRoots, themes, flows);
  let added = 0, skipped = 0;
  for (const a of atoms) {
    if (seen.has(a.id)) { skipped++; continue; }
    appendAtom(journalDir, a);
    seen.add(a.id);
    added++;
  }
  return { scanned: atoms.length, added, skipped };
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
  const r = mine({ repoRoot, journalDir, codeRoots, themes, flows });
  console.log(`✓ mined ${r.added} new commit atom(s) (${r.skipped} already present, ${r.scanned} scanned)`);
  if (!existsSync(configPath)) {
    console.log('  note: no .lore/config.yml — run /lore:init for component tagging');
  }
  console.log('  next: /lore:sync');
}
