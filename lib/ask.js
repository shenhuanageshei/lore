// lib/ask.js
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function searchPages(manifest, query) {
  const terms = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const axis of manifest.axes ?? []) {
    if (axis.id === 'INDEX') continue;
    for (const p of axis.pages ?? []) {
      const hay = `${p.title ?? ''} ${p.summary ?? ''}`.toLowerCase();
      const score = terms.filter(t => hay.includes(t)).length;
      if (score > 0) out.push({ axis: axis.id, id: p.id, title: p.title, summary: p.summary, path: p.path, score });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const loreDir = process.argv[2] ?? join(process.cwd(), '.lore');
  const query = process.argv.slice(3).join(' ');
  const manifestPath = join(loreDir, 'wiki', '.manifest.json');
  if (!existsSync(manifestPath)) {
    console.error('lore: no .manifest.json — run /lore:sync first');
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const hits = searchPages(manifest, query);
  if (hits.length === 0) {
    console.log('no matching pages');
  } else {
    for (const h of hits) console.log(`${h.path}  [${h.axis}] ${h.title} (score ${h.score})`);
  }
  process.exit(0);
}
