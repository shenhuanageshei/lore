import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathComponent } from '../lib/mine.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-mine-')); }

test('pathComponent: prefix match → last segment', () => {
  assert.equal(pathComponent('lib/sync.js', ['lib', 'site']), 'lib');
  assert.equal(pathComponent('site/shell.mjs', ['lib', 'site']), 'site');
});

test('pathComponent: longest match wins, last segment name', () => {
  assert.equal(pathComponent('src/pkg/core.py', ['src', 'src/pkg']), 'pkg');
});

test('pathComponent: no match → null (and prefix-of-name does not falsely match)', () => {
  assert.equal(pathComponent('README.md', ['lib', 'site']), null);
  assert.equal(pathComponent('libfoo/x.js', ['lib']), null);
});
