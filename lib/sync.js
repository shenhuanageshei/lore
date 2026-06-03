import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, runManifestCli } from './manifest.js';
import { parseConfigCodeRoots, parseConfigThemes } from './config.js';
import { readAllAtoms } from './journal.js';

export function planSync(loreDir) {
  const configPath = join(loreDir, 'config.yml');
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const codeRoots = parseConfigCodeRoots(configText);
  const themes = parseConfigThemes(configText);
  const wikiDir = join(loreDir, 'wiki');
  const exists = (axis, id) => existsSync(join(wikiDir, axis, `${id}.md`));
  const worklist = [];
  for (const codeRoot of codeRoots) {
    const id = codeRoot.split('/').pop();
    worklist.push({ axis: 'component', id, component: id, codeRoot, path: `component/${id}.md`, priorExists: exists('component', id) });
  }
  for (const th of themes) {
    worklist.push({ axis: 'theme', id: th.id, path: `theme/${th.id}.md`, priorExists: exists('theme', th.id) });
  }
  return { codeRoots, themes, worklist };
}

const SYNC_AXES = ['component', 'theme'];

export function buildIndex(axisPages) {
  const sections = [];
  for (const axis of ['component', 'theme', 'flow']) {
    const pages = axisPages[axis];
    if (!pages || pages.length === 0) continue;
    const heading = axis.charAt(0).toUpperCase() + axis.slice(1);
    sections.push(`## ${heading}\n${pages.map(p => `- [[${p.id}]]`).join('\n')}`);
  }
  return `---\ntitle: Index\nsummary: table of contents\n---\n# lore wiki — index\n\n${sections.join('\n\n')}\n`;
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
  const codeSha = headShortSha(repoRoot);
  const lastUpdated = now.slice(0, 10);
  const allAtoms = readAllAtoms(join(loreDir, 'journal'));

  const stamped = [];
  const axisPages = {};
  for (const axis of SYNC_AXES) {
    const axisDir = join(wikiDir, axis);
    let files = [];
    try {
      files = readdirSync(axisDir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.md'))
        .map(e => e.name).sort();
    } catch { continue; }
    axisPages[axis] = [];
    for (const f of files) {
      const p = join(axisDir, f);
      const id = basename(f, '.md');
      const atomsFor = allAtoms.filter(a => a.facets?.[axis]?.includes(id));
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
      stamped.push(`${axis}/${f}`);
      axisPages[axis].push({ id, title: data.title ?? id });
    }
  }

  if (!existsSync(wikiDir)) mkdirSync(wikiDir, { recursive: true });
  const indexFields = {
    codeSha,
    lastUpdated,
    atoms: allAtoms.length,
    commits: allAtoms.filter(a => a.kind === 'commit').length,
  };
  writeFileSync(join(wikiDir, 'INDEX.md'), stampFrontmatter(buildIndex(axisPages), indexFields));

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
