import { join, dirname } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';

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
