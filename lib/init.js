import { mkdirSync, copyFileSync } from 'node:fs';
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
