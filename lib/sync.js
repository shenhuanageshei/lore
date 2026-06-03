import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, runManifestCli } from './manifest.js';
import { parseConfigCodeRoots } from './config.js';
import { readAllAtoms } from './journal.js';

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

export function renderDecisionHistory(atoms) {
  if (atoms.length === 0) return '暂无 journal 原子（跑 /lore:mine 补全）。';
  const sorted = [...atoms].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return sorted.map(a => {
    const sha = (a.commit ?? '').slice(0, 7);
    const date = (a.ts ?? '').slice(0, 10);
    const why = (a.why ?? '').split('\n')[0].trim();
    const meta = a.commit ? `(${sha}, ${date})` : `(${date})`;
    return why ? `- **${a.title}** — ${why} ${meta}` : `- **${a.title}** ${meta}`;
  }).join('\n');
}

export function finalizeSync(loreDir, now) {
  const repoRoot = join(resolve(loreDir), '..');
  const wikiDir = join(loreDir, 'wiki');
  const compDir = join(wikiDir, 'component');
  const codeSha = headShortSha(repoRoot);
  const lastUpdated = now.slice(0, 10);

  const allAtoms = readAllAtoms(join(loreDir, 'journal'));

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
    const component = basename(f, '.md');
    const atomsFor = allAtoms.filter(a => a.facets?.component?.includes(component));
    const md = renderDecisionHistory(atomsFor);
    let text = readFileSync(p, 'utf8').replace('{{LORE_JOURNAL}}', () => md);
    text = stampFrontmatter(text, {
      codeSha,
      lastUpdated,
      atoms: atomsFor.length,
      commits: atomsFor.filter(a => a.kind === 'commit').length,
    });
    writeFileSync(p, text);
    const { data } = parseFrontmatter(text);
    stamped.push(`component/${f}`);
    pages.push({ id: component, title: data.title ?? component });
  }

  if (!existsSync(wikiDir)) mkdirSync(wikiDir, { recursive: true });
  const indexFields = {
    codeSha,
    lastUpdated,
    atoms: allAtoms.length,
    commits: allAtoms.filter(a => a.kind === 'commit').length,
  };
  writeFileSync(join(wikiDir, 'INDEX.md'), stampFrontmatter(buildIndex(pages), indexFields));

  const manifestPath = runManifestCli(loreDir, now);
  return { stamped, indexWritten: true, manifestPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sub = process.argv[2];
  const loreDir = process.argv[3];
  if (!sub || !loreDir) {
    console.error('usage: node lib/sync.js <plan|finalize> <loreDir>');
    process.exit(1);
  }
  if (sub === 'plan') {
    console.log(JSON.stringify(planSync(loreDir), null, 2));
  } else if (sub === 'finalize') {
    const r = finalizeSync(loreDir, new Date().toISOString());
    console.log(`✓ sync finalized: stamped ${r.stamped.length} page(s), INDEX + manifest written`);
    console.log(`  manifest: ${r.manifestPath}`);
    console.log('  next: /lore:serve');
  } else {
    console.error(`unknown subcommand: ${sub} (expected plan|finalize)`);
    process.exit(1);
  }
}
