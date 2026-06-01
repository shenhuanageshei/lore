import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

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
