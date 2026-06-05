import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scaffold, copyShell, ensureGitignore, discoverComponents, renderConfigYaml, init, installHook } from '../lib/init.js';

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
    writeFileSync(join(src, 'mermaid.min.js'), 'window.mermaid={};');
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'site'), { recursive: true });
    writeFileSync(join(lore, 'site', 'index.html'), 'OLD');   // stale — must be overwritten

    const copied = copyShell(src, lore);
    assert.deepEqual(copied, ['index.html', 'shell.mjs', 'mermaid.min.js']);
    assert.equal(readFileSync(join(lore, 'site', 'index.html'), 'utf8'), '<!doctype html>NEW');
    assert.equal(readFileSync(join(lore, 'site', 'shell.mjs'), 'utf8'), 'export const v = 2;');
    assert.equal(readFileSync(join(lore, 'site', 'mermaid.min.js'), 'utf8'), 'window.mermaid={};');
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

test('renderConfigYaml injects roots and declares hook:true', () => {
  const yaml = renderConfigYaml(['m1', 'm2']);
  assert.match(yaml, /discover: auto/);
  assert.match(yaml, /code_roots: \[m1, m2\]/);
  assert.match(yaml, /hook: true/);
  assert.match(yaml, /mine: \[commits, changelog, claude_md_pitfalls\]/);
  assert.match(yaml, /^\s*flow:/m);
  assert.match(yaml, /^\s*theme:/m);
});

test('renderConfigYaml handles empty roots', () => {
  assert.match(renderConfigYaml([]), /code_roots: \[\]/);
});

test('renderConfigYaml quotes only roots with YAML-special chars', () => {
  const yaml = renderConfigYaml(['m1', 'a b', 'src/pkg']);
  // normal names stay bare; the one with a space is single-quoted
  assert.match(yaml, /code_roots: \[m1, 'a b', src\/pkg\]/);
});

function fakeSrcSite() {
  const src = mkdtempSync(join(tmpdir(), 'lore-srcsite-'));
  writeFileSync(join(src, 'index.html'), '<!doctype html>shell');
  writeFileSync(join(src, 'shell.mjs'), 'export const x = 1;');
  writeFileSync(join(src, 'mermaid.min.js'), 'window.mermaid={};');
  return src;
}

test('init scaffolds, copies shell, writes config, sets gitignore', () => {
  const root = tmpRepo();
  const src = fakeSrcSite();
  try {
    mkdirSync(join(root, 'lib')); writeFileSync(join(root, 'lib', 'a.js'), 'x'); // discoverable
    const r = init({ repoRoot: root, srcSiteDir: src });
    const lore = join(root, '.lore');
    for (const d of ['journal', 'wiki', 'site', '.state'])
      assert.equal(statSync(join(lore, d)).isDirectory(), true);
    assert.equal(existsSync(join(lore, 'site', 'index.html')), true);
    assert.equal(existsSync(join(lore, 'site', 'shell.mjs')), true);
    assert.equal(existsSync(join(lore, 'config.yml')), true);
    assert.deepEqual(r.copied, ['index.html', 'shell.mjs', 'mermaid.min.js']);
    assert.deepEqual(r.codeRoots, ['lib']);
    assert.equal(r.configWritten, true);
    assert.equal(r.gitignore, 'created');
    assert.match(readFileSync(join(lore, 'config.yml'), 'utf8'), /code_roots: \[lib\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test('init re-run keeps user-edited config.yml, still refreshes shell', () => {
  const root = tmpRepo();
  const src = fakeSrcSite();
  try {
    init({ repoRoot: root, srcSiteDir: src });
    const cfg = join(root, '.lore', 'config.yml');
    writeFileSync(cfg, '# user edited\naxes: {}\n');                    // simulate user edit
    writeFileSync(join(src, 'index.html'), '<!doctype html>UPGRADED');  // engine upgraded shell
    const r2 = init({ repoRoot: root, srcSiteDir: src });
    assert.equal(r2.configWritten, false);
    assert.equal(readFileSync(cfg, 'utf8'), '# user edited\naxes: {}\n'); // preserved
    assert.equal(readFileSync(join(root, '.lore', 'site', 'index.html'), 'utf8'), '<!doctype html>UPGRADED'); // refreshed
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test('CLI: node lib/init.js <repo> initializes and prints summary', () => {
  const root = tmpRepo();
  try {
    const out = execFileSync('node', ['lib/init.js', root], { cwd: process.cwd() }).toString();
    assert.match(out, /lore initialized/);
    assert.match(out, /shell copied: index\.html, shell\.mjs, mermaid\.min\.js/);
    // uses the REAL plugin site/ (self-located) — both shell files land in the temp repo
    assert.equal(existsSync(join(root, '.lore', 'site', 'index.html')), true);
    assert.equal(existsSync(join(root, '.lore', 'site', 'shell.mjs')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function bareGitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'lore-hook-init-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

test('installHook: installs lore post-commit when absent (idempotent)', () => {
  const root = bareGitRepo();
  try {
    assert.equal(installHook(root), 'installed');
    const hook = readFileSync(join(root, '.git', 'hooks', 'post-commit'), 'utf8');
    assert.match(hook, /# lore:post-commit/);
    assert.match(hook, /lib\/hook\.js/);          // forward-slash path
    assert.doesNotMatch(hook, /\\/);              // no backslashes (sh-safe)
    assert.equal(installHook(root), 'present');   // idempotent
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installHook: does not clobber a foreign hook', () => {
  const root = bareGitRepo();
  try {
    const hp = join(root, '.git', 'hooks', 'post-commit');
    writeFileSync(hp, '#!/bin/sh\necho custom\n');
    assert.equal(installHook(root), 'exists-foreign');
    assert.equal(readFileSync(hp, 'utf8'), '#!/bin/sh\necho custom\n');  // untouched
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installHook: warns when core.hooksPath set', () => {
  const root = bareGitRepo();
  try {
    execFileSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: root });
    assert.equal(installHook(root), 'hookspath-set');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installHook: core.hooksPath at a DIFFERENT dir → skips, writes no hook', () => {
  const root = bareGitRepo();
  try {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });
    assert.equal(installHook(root), 'hookspath-set');
    assert.equal(existsSync(join(root, '.git', 'hooks', 'post-commit')), false);  // untouched
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installHook: core.hooksPath at the repo default .git/hooks → installs', () => {
  const root = bareGitRepo();
  try {
    execFileSync('git', ['config', 'core.hooksPath', '.git/hooks'], { cwd: root });   // resolves equal to default
    assert.equal(installHook(root), 'installed');
    const hook = readFileSync(join(root, '.git', 'hooks', 'post-commit'), 'utf8');
    assert.match(hook, /# lore:post-commit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installHook: no-git dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-nogit-'));
  try {
    assert.equal(installHook(root), 'no-git');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installHook: works from inside a git worktree (resolves common git dir)', () => {
  const root = bareGitRepo();
  const wt = mkdtempSync(join(tmpdir(), 'lore-wt-'));
  try {
    // a commit is needed before adding a worktree
    writeFileSync(join(root, 'f.txt'), 'x');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
    rmSync(wt, { recursive: true, force: true });   // git worktree add needs the path to not exist
    execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: root });

    // installing from inside the worktree must succeed (not throw) and land in the COMMON hooks dir
    assert.equal(installHook(wt), 'installed');
    assert.equal(existsSync(join(root, '.git', 'hooks', 'post-commit')), true);
  } finally {
    try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: root }); } catch {}
    rmSync(wt, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('init installs the hook and sets config hook: true', () => {
  const root = bareGitRepo();
  const src = fakeSrcSite();
  try {
    const r = init({ repoRoot: root, srcSiteDir: src });
    assert.equal(r.hook, 'installed');
    assert.equal(existsSync(join(root, '.git', 'hooks', 'post-commit')), true);
    assert.match(readFileSync(join(root, '.lore', 'config.yml'), 'utf8'), /hook: true/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});
