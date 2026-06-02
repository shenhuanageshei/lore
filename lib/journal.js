import { join, dirname } from 'node:path';
import { mkdirSync, appendFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';

export function appendAtom(journalDir, atom) {
  const p = atomPath(journalDir, atom.ts);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(atom) + '\n');
}

export function atomPath(journalDir, isoTs) {
  const year = isoTs.slice(0, 4);
  const month = isoTs.slice(5, 7);
  const date = isoTs.slice(0, 10);   // YYYY-MM-DD
  return join(journalDir, year, month, `${date}.ndjson`);
}

function walkNdjson(dir) {
  let out = [];
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkNdjson(full));
    else if (e.isFile() && e.name.endsWith('.ndjson')) out.push(full);
  }
  return out;
}

export function readAllAtoms(journalDir) {
  if (!existsSync(journalDir)) return [];
  const atoms = [];
  for (const f of walkNdjson(journalDir)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (t) atoms.push(JSON.parse(t));
    }
  }
  return atoms;
}

export function existingIds(journalDir) {
  return new Set(readAllAtoms(journalDir).map(a => a.id));
}
