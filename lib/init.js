import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LORE_SUBDIRS = ['journal', 'wiki', 'site', '.state'];

export function scaffold(loreDir) {
  for (const d of LORE_SUBDIRS) mkdirSync(join(loreDir, d), { recursive: true });
}
