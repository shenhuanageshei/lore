// lib/manifest.js
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NUMERIC_KEYS = new Set(['atoms', 'commits', 'stale']);

export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text };
  const block = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  const data = {};
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;                       // skip malformed
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (!key) continue;
    const n = Number(val);
    data[key] = NUMERIC_KEYS.has(key) ? (Number.isNaN(n) ? 0 : n) : val;
  }
  return { data, body };
}

const AXIS_ORDER = ['INDEX', 'component', 'flow', 'theme'];

export function deriveAxes(subdirNames) {
  const known = AXIS_ORDER.filter(id => subdirNames.includes(id));
  const rest = subdirNames.filter(id => !AXIS_ORDER.includes(id)).sort();
  return [...known, ...rest].map(id => ({
    id,
    label: id === 'INDEX' ? 'INDEX' : id.charAt(0).toUpperCase() + id.slice(1),
  }));
}

export function emitManifest({ wikiDir, currentSha, countCommitsSince, now, axes }) {
  const entries = readdirSync(wikiDir, { withFileTypes: true });
  const subdirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  const hasIndex = entries.some(e => e.isFile() && e.name === 'INDEX.md');
  const axisDefs = axes ?? deriveAxes([...(hasIndex ? ['INDEX'] : []), ...subdirs]);

  const builtAxes = [];
  for (const ax of axisDefs) {
    const pages = [];
    if (ax.id === 'INDEX') {
      if (hasIndex) pages.push(pageEntry(wikiDir, '', 'INDEX', currentSha, countCommitsSince));
    } else {
      const axisDir = join(wikiDir, ax.id);
      let files = [];
      try {
        files = readdirSync(axisDir, { withFileTypes: true })
          .filter(e => e.isFile() && e.name.endsWith('.md'))
          .map(e => e.name);
      } catch { files = []; }
      files.sort();
      for (const f of files) {
        pages.push(pageEntry(wikiDir, ax.id, f.replace(/\.md$/, ''), currentSha, countCommitsSince));
      }
    }
    builtAxes.push({ id: ax.id, label: ax.label, pages });
  }
  return { generated: now, current_code_sha: currentSha, axes: builtAxes };
}

function pageEntry(wikiDir, axisId, id, currentSha, countCommitsSince) {
  const rel = axisId ? `${axisId}/${id}.md` : `${id}.md`;
  const text = readFileSync(join(wikiDir, rel), 'utf8');
  const { data } = parseFrontmatter(text);
  const sha = data.code_sha ?? '';
  const stale = sha && sha !== currentSha ? countCommitsSince(sha) : 0;
  return {
    id,
    title: data.title ?? id,
    summary: data.summary ?? '',
    path: rel,
    stale,
    code_sha: sha,
    synthesized_from: { atoms: data.atoms ?? 0, commits: data.commits ?? 0 },
  };
}

function gitCurrentSha(repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot })
      .toString().trim();
  } catch (e) {
    throw new Error(`lore: git rev-parse failed in ${repoRoot} — is this a git repo with at least one commit?\n${e.message}`);
  }
}

function makeCountCommitsSince(repoRoot) {
  return (sha) => {
    try {
      const out = execFileSync('git', ['rev-list', '--count', `${sha}..HEAD`],
        { cwd: repoRoot, stdio: 'pipe' }).toString().trim();
      return Number(out) || 0;
    } catch {
      return 0;   // unknown/unreachable sha → treat as not-stale
    }
  };
}

export function runManifestCli(loreDir, nowIso) {
  const repoRoot = join(resolve(loreDir), '..');
  const wikiDir = join(loreDir, 'wiki');
  const manifest = emitManifest({
    wikiDir,
    currentSha: gitCurrentSha(repoRoot),
    countCommitsSince: makeCountCommitsSince(repoRoot),
    now: nowIso,
  });
  const out = join(wikiDir, '.manifest.json');
  writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const loreDir = process.argv[2];
  if (!loreDir) { console.error('usage: node lib/manifest.js <loreDir>'); process.exit(1); }
  const out = runManifestCli(loreDir, new Date().toISOString());
  console.log(`wrote ${out}`);
}
