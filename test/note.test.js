// test/note.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { noteAtom } from '../lib/note.js';
import { readAllAtoms } from '../lib/journal.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-note-')); }

test('noteAtom builds a decision atom (source=agent, enriched, commit=null)', () => {
  const a = noteAtom({ id: 'note:x', ts: '2026-06-03T08:00:00Z', title: 'use ZSET', why: 'range queries', component: ['lib'], flow: ['f'], theme: ['perf'], files: ['lib/a.js'] });
  assert.equal(a.id, 'note:x');
  assert.equal(a.kind, 'decision');
  assert.equal(a.commit, null);
  assert.equal(a.title, 'use ZSET');
  assert.equal(a.why, 'range queries');
  assert.equal(a.source, 'agent');
  assert.equal(a.enriched, true);
  assert.equal(a.confidence, 'EXTRACTED');
  assert.equal(a.what_changed, '');
  assert.deepEqual(a.facets, { component: ['lib'], flow: ['f'], theme: ['perf'] });
  assert.deepEqual(a.refs, { files: ['lib/a.js'], pitfall: null, related: [] });
});

test('noteAtom defaults facets/refs to empty', () => {
  const a = noteAtom({ id: 'note:y', ts: '2026-06-03T08:00:00Z', title: 't', why: 'w' });
  assert.deepEqual(a.facets, { component: [], flow: [], theme: [] });
  assert.deepEqual(a.refs.files, []);
});

test('CLI: note flags → decision atom in journal', () => {
  const root = tmpDir();
  try {
    const out = execFileSync('node', ['lib/note.js', root, '--title', 'use ZSET', '--why', 'range queries O(logN)', '--component', 'lib', '--files', 'lib/a.js,lib/b.js'], { cwd: process.cwd() }).toString();
    assert.match(out, /noted decision atom note:/);
    const atoms = readAllAtoms(join(root, '.lore', 'journal'));
    assert.equal(atoms.length, 1);
    assert.equal(atoms[0].kind, 'decision');
    assert.equal(atoms[0].title, 'use ZSET');
    assert.equal(atoms[0].why, 'range queries O(logN)');
    assert.equal(atoms[0].source, 'agent');
    assert.deepEqual(atoms[0].facets.component, ['lib']);
    assert.deepEqual(atoms[0].refs.files, ['lib/a.js', 'lib/b.js']);
    assert.match(atoms[0].id, /^note:/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
