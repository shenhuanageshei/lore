// lib/note.js
import { appendAtom } from './journal.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function noteAtom({ id, ts, title, why, component = [], flow = [], theme = [], files = [] }) {
  return {
    id,
    ts,
    kind: 'decision',
    commit: null,
    title,
    why,
    what_changed: '',
    facets: { component, flow, theme },
    refs: { files, pitfall: null, related: [] },
    source: 'agent',
    enriched: true,
    confidence: 'EXTRACTED',
  };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args._[0] ?? process.cwd();
  const list = s => (s ? s.split(',').map(x => x.trim()).filter(Boolean) : []);
  const atom = noteAtom({
    id: `note:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    title: args.title ?? '',
    why: args.why ?? '',
    component: list(args.component),
    flow: list(args.flow),
    theme: list(args.theme),
    files: list(args.files),
  });
  appendAtom(join(repoRoot, '.lore', 'journal'), atom);
  console.log(`✓ noted decision atom ${atom.id}`);
}
