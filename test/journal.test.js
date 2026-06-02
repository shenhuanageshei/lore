import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomPath, appendAtom, readAllAtoms, existingIds } from '../lib/journal.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-journal-')); }

test('atomPath maps ISO ts to YYYY/MM/YYYY-MM-DD.ndjson', () => {
  assert.equal(atomPath('/j', '2026-06-01T08:00:00Z'), join('/j', '2026', '06', '2026-06-01.ndjson'));
  assert.equal(atomPath('/j', '2025-12-31T23:59:59+09:00'), join('/j', '2025', '12', '2025-12-31.ndjson'));
});

test('appendAtom writes one JSON line to the date shard; second append same day → 2 lines', () => {
  const dir = tmpDir();
  try {
    const j = join(dir, 'journal');
    appendAtom(j, { id: 'a', ts: '2026-06-01T08:00:00Z', x: 1 });
    appendAtom(j, { id: 'b', ts: '2026-06-01T09:00:00Z', x: 2 });
    const shard = join(j, '2026', '06', '2026-06-01.ndjson');
    const lines = readFileSync(shard, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { id: 'a', ts: '2026-06-01T08:00:00Z', x: 1 });
    assert.deepEqual(JSON.parse(lines[1]), { id: 'b', ts: '2026-06-01T09:00:00Z', x: 2 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readAllAtoms reads across day/month/year shards; missing dir → []', () => {
  const dir = tmpDir();
  try {
    const j = join(dir, 'journal');
    assert.deepEqual(readAllAtoms(j), []);                       // missing dir
    appendAtom(j, { id: 'a', ts: '2026-06-01T08:00:00Z' });
    appendAtom(j, { id: 'b', ts: '2026-07-15T08:00:00Z' });
    appendAtom(j, { id: 'c', ts: '2025-01-02T08:00:00Z' });
    const ids = readAllAtoms(j).map(a => a.id).sort();
    assert.deepEqual(ids, ['a', 'b', 'c']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('existingIds returns the set of atom ids', () => {
  const dir = tmpDir();
  try {
    const j = join(dir, 'journal');
    appendAtom(j, { id: 'commit:x', ts: '2026-06-01T08:00:00Z' });
    appendAtom(j, { id: 'commit:y', ts: '2026-06-01T08:00:00Z' });
    const s = existingIds(j);
    assert.equal(s.has('commit:x'), true);
    assert.equal(s.has('commit:y'), true);
    assert.equal(s.has('commit:z'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
