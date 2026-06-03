// test/lint.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { lintOrphans, lintMissing } from '../lib/lint.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-lint-')); }

test('lintOrphans: page ids not matching any code_root last-segment', () => {
  assert.deepEqual(lintOrphans(['lib', 'gone'], ['lib', 'src/pkg']), ['gone']);
  assert.deepEqual(lintOrphans(['lib', 'pkg'], ['lib', 'src/pkg']), []);   // pkg ← src/pkg
});

test('lintMissing: code_root last-segments with no page', () => {
  assert.deepEqual(lintMissing(['lib'], ['lib', 'src/pkg']), ['pkg']);     // pkg page missing
  assert.deepEqual(lintMissing(['lib', 'pkg'], ['lib', 'src/pkg']), []);
});
