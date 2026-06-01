import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold } from '../lib/init.js';
import { copyShell } from '../lib/init.js';

function tmpRepo() { return mkdtempSync(join(tmpdir(), 'lore-init-')); }

test('scaffold creates journal/wiki/site/.state and is idempotent', () => {
  const root = tmpRepo();
  try {
    const lore = join(root, '.lore');
    scaffold(lore);
    for (const d of ['journal', 'wiki', 'site', '.state'])
      assert.equal(statSync(join(lore, d)).isDirectory(), true);
    scaffold(lore);   // re-run must not throw
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('copyShell copies index.html + shell.mjs, overwriting stale', () => {
  const root = tmpRepo();
  try {
    const src = join(root, 'src-site');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'index.html'), '<!doctype html>NEW');
    writeFileSync(join(src, 'shell.mjs'), 'export const v = 2;');
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'site'), { recursive: true });
    writeFileSync(join(lore, 'site', 'index.html'), 'OLD');   // stale — must be overwritten

    const copied = copyShell(src, lore);
    assert.deepEqual(copied, ['index.html', 'shell.mjs']);
    assert.equal(readFileSync(join(lore, 'site', 'index.html'), 'utf8'), '<!doctype html>NEW');
    assert.equal(readFileSync(join(lore, 'site', 'shell.mjs'), 'utf8'), 'export const v = 2;');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
