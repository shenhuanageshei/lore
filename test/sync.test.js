import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseConfigCodeRoots } from '../lib/sync.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-sync-')); }

test('parseConfigCodeRoots: single-line list', () => {
  assert.deepEqual(
    parseConfigCodeRoots('axes:\n  component:\n    code_roots: [lib, site]\n'),
    ['lib', 'site']
  );
});

test('parseConfigCodeRoots: dequotes entries with special chars', () => {
  assert.deepEqual(
    parseConfigCodeRoots("    code_roots: ['a b', m1, \"x\"]\n"),
    ['a b', 'm1', 'x']
  );
});

test('parseConfigCodeRoots: empty list', () => {
  assert.deepEqual(parseConfigCodeRoots('    code_roots: []\n'), []);
});

test('parseConfigCodeRoots: missing line yields []', () => {
  assert.deepEqual(parseConfigCodeRoots('axes: {}\n'), []);
});
