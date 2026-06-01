import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold, copyShell, ensureGitignore } from '../lib/init.js';

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

test('ensureGitignore: created / appended / present', () => {
  const root = tmpRepo();
  const root2 = tmpRepo();
  try {
    // created: no .gitignore yet
    assert.equal(ensureGitignore(root), 'created');
    assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^\.lore\/\.state\/$/m);

    // appended: preexisting file missing the line, original content kept
    writeFileSync(join(root2, '.gitignore'), 'node_modules/\n');
    assert.equal(ensureGitignore(root2), 'appended');
    const txt = readFileSync(join(root2, '.gitignore'), 'utf8');
    assert.match(txt, /node_modules\//);
    assert.match(txt, /\.lore\/\.state\//);

    // present: already has the line → no duplicate
    assert.equal(ensureGitignore(root2), 'present');
    const dupes = readFileSync(join(root2, '.gitignore'), 'utf8')
      .split(/\r?\n/).filter(l => l.trim() === '.lore/.state/');
    assert.equal(dupes.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});
