import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendAtom, existingIds } from './journal.js';
import { parseConfigCodeRoots } from './config.js';

const GIT_FORMAT = '%x1e%H%x1f%aI%x1f%s%x1f%b%x1f';

export function mineCommits(repoRoot, codeRoots) {
  const stdout = execFileSync(
    'git',
    ['log', '--no-merges', `--pretty=format:${GIT_FORMAT}`, '--name-only'],
    { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
  ).toString();
  return parseGitLog(stdout).map(raw => commitAtom(raw, codeRoots));
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

export function commitAtom(raw, codeRoots) {
  const component = [...new Set(
    raw.files.map(f => pathComponent(f, codeRoots)).filter(Boolean),
  )].sort();
  return {
    id: `commit:${raw.sha}`,
    ts: raw.ts,
    kind: 'commit',
    commit: raw.sha,
    title: raw.subject,
    why: raw.body,
    what_changed: '',
    facets: { component, flow: [], theme: [] },
    refs: { files: raw.files, pitfall: null, related: [] },
    source: 'miner:commits',
    enriched: false,
    confidence: 'EXTRACTED',
  };
}

export function mine({ repoRoot, journalDir, codeRoots }) {
  const seen = existingIds(journalDir);
  const atoms = mineCommits(repoRoot, codeRoots);
  let added = 0, skipped = 0;
  for (const a of atoms) {
    if (seen.has(a.id)) { skipped++; continue; }
    appendAtom(journalDir, a);
    seen.add(a.id);
    added++;
  }
  return { scanned: atoms.length, added, skipped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = process.argv[2] ?? process.cwd();
  const loreDir = join(repoRoot, '.lore');
  const configPath = join(loreDir, 'config.yml');
  const codeRoots = existsSync(configPath)
    ? parseConfigCodeRoots(readFileSync(configPath, 'utf8'))
    : [];
  const journalDir = join(loreDir, 'journal');
  const r = mine({ repoRoot, journalDir, codeRoots });
  console.log(`✓ mined ${r.added} new commit atom(s) (${r.skipped} already present, ${r.scanned} scanned)`);
  if (!existsSync(configPath)) {
    console.log('  note: no .lore/config.yml — run /lore:init for component tagging');
  }
  console.log('  next: /lore:sync');
}
