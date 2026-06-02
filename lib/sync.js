import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseFrontmatter, runManifestCli } from './manifest.js';

export function parseConfigCodeRoots(configText) {
  const m = configText.match(/^\s*code_roots:\s*\[([^\]]*)\]/m);
  if (!m) return [];
  return m[1]
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}

export function planSync(loreDir) {
  const configPath = join(loreDir, 'config.yml');
  const codeRoots = existsSync(configPath)
    ? parseConfigCodeRoots(readFileSync(configPath, 'utf8'))
    : [];
  const worklist = codeRoots.map(codeRoot => {
    const component = codeRoot.split('/').pop();
    const path = `component/${component}.md`;
    return { component, codeRoot, path, priorExists: existsSync(join(loreDir, 'wiki', path)) };
  });
  return { codeRoots, worklist };
}

export function buildIndex(pages) {
  const links = pages.map(p => `- [[${p.id}]]`).join('\n');
  return `---
title: Index
summary: table of contents
---
# lore wiki — index

## Component
${links}
`;
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

export function finalizeSync(loreDir, now) {
  const repoRoot = join(resolve(loreDir), '..');
  const wikiDir = join(loreDir, 'wiki');
  const compDir = join(wikiDir, 'component');
  const codeSha = headShortSha(repoRoot);
  const lastUpdated = now.slice(0, 10);
  const fields = { codeSha, lastUpdated, commits: 0, atoms: 0 };

  let files = [];
  try {
    files = readdirSync(compDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => e.name)
      .sort();
  } catch { files = []; }

  const stamped = [];
  const pages = [];
  for (const f of files) {
    const p = join(compDir, f);
    const text = stampFrontmatter(readFileSync(p, 'utf8'), fields);
    writeFileSync(p, text);
    const { data } = parseFrontmatter(text);
    const id = basename(f, '.md');
    stamped.push(`component/${f}`);
    pages.push({ id, title: data.title ?? id });
  }

  if (!existsSync(wikiDir)) mkdirSync(wikiDir, { recursive: true });
  writeFileSync(join(wikiDir, 'INDEX.md'), stampFrontmatter(buildIndex(pages), fields));

  const manifestPath = runManifestCli(loreDir, now);
  return { stamped, indexWritten: true, manifestPath };
}
