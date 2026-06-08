// lib/manifest.js
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverTranslations, isTranslationSidecar, readPreferences } from './i18n.js';
import { parseConfigLanguage } from './config.js';

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

const AXIS_ORDER = ['HOME', 'INDEX', 'component', 'flow', 'theme', 'docs'];
const ROOT_AXIS_FILES = { HOME: 'HOME.md', INDEX: 'INDEX.md' };

export function deriveAxes(subdirNames) {
  const known = AXIS_ORDER.filter(id => subdirNames.includes(id));
  const rest = subdirNames.filter(id => !AXIS_ORDER.includes(id)).sort();
  return [...known, ...rest].map(id => ({
    id,
    label: id === 'INDEX' ? 'INDEX' : id.charAt(0).toUpperCase() + id.slice(1),
  }));
}

export function emitManifest({
  wikiDir,
  currentSha,
  countCommitsSince,
  now,
  axes,
  language = { default: 'en', available: ['en'] },
  preferences = {},
  staleScopes = {},
}) {
  const entries = readdirSync(wikiDir, { withFileTypes: true });
  const subdirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  const rootAxes = Object.entries(ROOT_AXIS_FILES)
    .filter(([, file]) => entries.some(e => e.isFile() && e.name === file))
    .map(([axis]) => axis);
  const axisDefs = axes ?? deriveAxes([...rootAxes, ...subdirs]);

  const builtAxes = [];
  for (const ax of axisDefs) {
    const pages = [];
    if (ROOT_AXIS_FILES[ax.id]) {
      if (rootAxes.includes(ax.id)) {
        pages.push(pageEntry(wikiDir, '', ax.id, currentSha, countCommitsSince, language, staleScopes));
      }
    } else {
      const axisDir = join(wikiDir, ax.id);
      let files = [];
      try {
        files = readdirSync(axisDir, { withFileTypes: true })
          .filter(e => e.isFile() && e.name.endsWith('.md'))
          .filter(e => !isTranslationSidecar(e.name, language.available, language.default))
          .map(e => e.name);
      } catch { files = []; }
      files.sort();
      for (const f of files) {
        pages.push(pageEntry(wikiDir, ax.id, f.replace(/\.md$/, ''), currentSha, countCommitsSince, language, staleScopes));
      }
      if (ax.id === 'docs') {
        pages.sort((a, b) => (b.last_updated || '').localeCompare(a.last_updated || '') || a.id.localeCompare(b.id));
      }
    }
    builtAxes.push({ id: ax.id, label: ax.label, pages });
  }
  return { generated: now, current_code_sha: currentSha, language, user_preferences: preferences, axes: builtAxes };
}

function pageEntry(wikiDir, axisId, id, currentSha, countCommitsSince, language, staleScopes = {}) {
  const rel = axisId ? `${axisId}/${id}.md` : `${id}.md`;
  const text = readFileSync(join(wikiDir, rel), 'utf8');
  const { data } = parseFrontmatter(text);
  const sha = data.code_sha ?? '';
  const stale = sha && sha !== currentSha ? countCommitsSince(sha, staleScopes[rel]) : 0;
  return {
    id,
    axis: axisId,
    title: data.title ?? id,
    summary: data.summary ?? '',
    last_updated: data.last_updated ?? '',
    path: rel,
    lang: data.lang ?? language.default,
    translations: discoverTranslations({
      wikiDir,
      pagePath: rel,
      pageText: text,
      available: language.available,
      defaultLang: language.default,
    }),
    stale,
    code_sha: sha,
    synthesized_from: { atoms: data.atoms ?? 0, commits: data.commits ?? 0 },
  };
}

export function gitCurrentSha(repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot })
      .toString().trim();
  } catch (e) {
    throw new Error(`lore: git rev-parse failed in ${repoRoot} — is this a git repo with at least one commit?\n${e.message}`);
  }
}

export function makeCountCommitsSince(repoRoot) {
  return (sha, pathspec) => {
    try {
      const args = ['rev-list', '--count', `${sha}..HEAD`];
      if (pathspec && pathspec.length) args.push('--', ...pathspec);
      const out = execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim();
      return Number(out) || 0;
    } catch {
      return 0;   // unknown/unreachable sha or empty diff → treat as not-stale
    }
  };
}

export function runManifestCli(loreDir, nowIso, staleScopes = {}) {
  const repoRoot = join(resolve(loreDir), '..');
  const wikiDir = join(loreDir, 'wiki');
  const configPath = join(loreDir, 'config.yml');
  const language = existsSync(configPath)
    ? parseConfigLanguage(readFileSync(configPath, 'utf8'))
    : { default: 'en', available: ['en'] };
  const preferences = readPreferences(join(loreDir, '.state'));
  const manifest = emitManifest({
    wikiDir,
    currentSha: gitCurrentSha(repoRoot),
    countCommitsSince: makeCountCommitsSince(repoRoot),
    now: nowIso,
    language,
    preferences,
    staleScopes,
  });
  const out = join(wikiDir, '.manifest.json');
  writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  return { manifestPath: out, manifest };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const loreDir = process.argv[2];
  if (!loreDir) { console.error('usage: node lib/manifest.js <loreDir>'); process.exit(1); }
  const { manifestPath } = runManifestCli(loreDir, new Date().toISOString());
  console.log(`wrote ${manifestPath}`);
}
