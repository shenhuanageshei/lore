import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold, copyShell, ensureGitignore, discoverComponents } from '../lib/init.js';

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

test('discoverComponents: fallback picks top-level code dirs, skips excludes/assets', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'lib'));    writeFileSync(join(root, 'lib', 'a.js'), 'x');
    mkdirSync(join(root, 'docs'));   writeFileSync(join(root, 'docs', 'a.md'), 'x');     // excluded name
    mkdirSync(join(root, 'tests'));  writeFileSync(join(root, 'tests', 't.js'), 'x');    // excluded name
    mkdirSync(join(root, 'assets')); writeFileSync(join(root, 'assets', 'logo.png'), 'x'); // no code ext
    mkdirSync(join(root, '.git'));   writeFileSync(join(root, '.git', 'x.js'), 'x');      // dot-excluded
    assert.deepEqual(discoverComponents(root), ['lib']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('discoverComponents: finds code in a depth-2 subdir', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'pkg', 'sub'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'sub', 'mod.py'), 'x');   // depth-2 file
    assert.deepEqual(discoverComponents(root), ['pkg']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('discoverComponents: empty repo yields []', () => {
  const root = tmpRepo();
  try { assert.deepEqual(discoverComponents(root), []); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('discoverComponents: Python top-level packages via __init__.py', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'm1')); writeFileSync(join(root, 'm1', '__init__.py'), '');
    mkdirSync(join(root, 'm2')); writeFileSync(join(root, 'm2', '__init__.py'), '');
    mkdirSync(join(root, 'shared')); writeFileSync(join(root, 'shared', 'util.py'), 'x'); // fallback path
    assert.deepEqual(discoverComponents(root), ['m1', 'm2', 'shared']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('discoverComponents: src/ layout reports src/<pkg> and drops bare src (ancestor dedup)', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'src', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'src', 'pkg', '__init__.py'), '');
    writeFileSync(join(root, 'src', 'pkg', 'core.py'), 'x');
    assert.deepEqual(discoverComponents(root), ['src/pkg']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('discoverComponents: JS workspaces expand dir/* and drop the bare parent', () => {
  const root = tmpRepo();
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    mkdirSync(join(root, 'packages', 'a'), { recursive: true }); writeFileSync(join(root, 'packages', 'a', 'i.js'), 'x');
    mkdirSync(join(root, 'packages', 'b'), { recursive: true }); writeFileSync(join(root, 'packages', 'b', 'i.js'), 'x');
    assert.deepEqual(discoverComponents(root), ['packages/a', 'packages/b']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('discoverComponents: workspaces object form {packages:[...]}', () => {
  const root = tmpRepo();
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: { packages: ['apps/*'] } }));
    mkdirSync(join(root, 'apps', 'web'), { recursive: true }); writeFileSync(join(root, 'apps', 'web', 'i.js'), 'x');
    assert.deepEqual(discoverComponents(root), ['apps/web']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
