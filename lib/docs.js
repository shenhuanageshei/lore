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
