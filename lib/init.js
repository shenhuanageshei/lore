import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const LORE_SUBDIRS = ['journal', 'wiki', 'site', '.state'];

export function scaffold(loreDir) {
  for (const d of LORE_SUBDIRS) mkdirSync(join(loreDir, d), { recursive: true });
}

const SHELL_FILES = ['index.html', 'shell.mjs'];

export function copyShell(srcSiteDir, loreDir) {
  const dest = join(loreDir, 'site');
  mkdirSync(dest, { recursive: true });
  for (const f of SHELL_FILES) copyFileSync(join(srcSiteDir, f), join(dest, f));
  return [...SHELL_FILES];
}

const IGNORE_LINE = '.lore/.state/';

export function ensureGitignore(repoRoot) {
  const p = join(repoRoot, '.gitignore');
  if (!existsSync(p)) {
    writeFileSync(p, IGNORE_LINE + '\n');
    return 'created';
  }
  const text = readFileSync(p, 'utf8');
  if (text.split(/\r?\n/).some(l => l.trim() === IGNORE_LINE)) return 'present';
  const sep = text === '' || text.endsWith('\n') ? '' : '\n';
  appendFileSync(p, sep + IGNORE_LINE + '\n');
  return 'appended';
}

const EXCLUDE = new Set([
  '.git', '.lore', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache',
  'dist', 'build', 'out', 'target', 'vendor', 'coverage',
  'docs', 'doc', 'tests', 'test', '__tests__', 'config', '.github', '.idea', '.vscode',
]);

const CODE_EXT = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs',
  '.java', '.kt', '.rb', '.php', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.swift', '.scala', '.sh',
]);

function topDirs(repoRoot) {
  let entries = [];
  try { entries = readdirSync(repoRoot, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !EXCLUDE.has(e.name))
    .map(e => e.name);
}

function dirHasCode(absDir, depth = 2) {
  let entries = [];
  try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) if (e.isFile() && CODE_EXT.has(extname(e.name))) return true;
  if (depth > 1) {
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && dirHasCode(join(absDir, e.name), depth - 1)) return true;
    }
  }
  return false;
}

function dedupeAncestors(roots) {
  return roots.filter(r => !roots.some(o => o !== r && o.startsWith(r + '/')));
}

function discoverFallback(repoRoot) {
  const out = [];
  for (const d of topDirs(repoRoot)) if (dirHasCode(join(repoRoot, d))) out.push(d);
  return out;
}

export function discoverComponents(repoRoot) {
  const roots = new Set();
  for (const r of discoverFallback(repoRoot)) roots.add(r);
  return dedupeAncestors([...roots]).sort();
}
