// lib/lint.js
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, gitCurrentSha, makeCountCommitsSince } from './manifest.js';
import { parseConfigCodeRoots } from './config.js';

function rootName(codeRoot) {
  return codeRoot.split('/').pop();
}

export function lintOrphans(pageIds, codeRoots) {
  const names = new Set(codeRoots.map(rootName));
  return pageIds.filter(id => !names.has(id));
}

export function lintMissing(pageIds, codeRoots) {
  const pages = new Set(pageIds);
  return [...new Set(codeRoots.map(rootName))].filter(c => !pages.has(c));
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
      if (data.code_sha && text.includes(JOURNAL_TOKEN)) out.push(`${axis}/${f}`);
    }
  }
  return out;
}

export function lint({ loreDir }) {
  const wikiDir = join(loreDir, 'wiki');
  const configPath = join(loreDir, 'config.yml');
  const codeRoots = existsSync(configPath)
    ? parseConfigCodeRoots(readFileSync(configPath, 'utf8'))
    : [];
  const pages = componentPages(wikiDir);
  const ids = pages.map(p => p.id);

  let currentSha = '';
  let countSince = () => 0;
  try {
    const repoRoot = join(resolve(loreDir), '..');
    currentSha = gitCurrentSha(repoRoot);
    countSince = makeCountCommitsSince(repoRoot);
  } catch { /* non-git → skip stale */ }

  const stale = currentSha ? lintStale(pages, currentSha, countSince) : [];
  const orphans = lintOrphans(ids, codeRoots);
  const missing = lintMissing(ids, codeRoots);
  const unfolded = lintUnfolded(wikiDir);
  return {
    stale, orphans, missing, unfolded,
    clean: stale.length === 0 && orphans.length === 0 && missing.length === 0 && unfolded.length === 0,
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
  }
  process.exit(0);
}
