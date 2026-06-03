// test/hook.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureHead } from '../lib/hook.js';
import { readAllAtoms } from '../lib/journal.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-hook-')); }
function gitRepo() {
  const root = tmpDir();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  return root;
}
function commitFile(root, rel, content, msg) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', msg], { cwd: root });
}

test('captureHead writes HEAD commit atom (source=hook), idempotent', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'x', 'add lib');
    const journalDir = join(root, '.lore', 'journal');
    const r1 = captureHead({ repoRoot: root, journalDir, codeRoots: ['lib'] });
    assert.equal(r1.added, 1);
    const atoms = readAllAtoms(journalDir);
    assert.equal(atoms.length, 1);
    assert.equal(atoms[0].title, 'add lib');
    assert.equal(atoms[0].source, 'hook');
    assert.deepEqual(atoms[0].facets.component, ['lib']);
    assert.equal(captureHead({ repoRoot: root, journalDir, codeRoots: ['lib'] }).added, 0);  // idempotent
    assert.equal(readAllAtoms(journalDir).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('captureHead on a merge HEAD adds nothing new on the second call', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'a.txt', '1', 'base');
    execFileSync('git', ['checkout', '-q', '-b', 'feat'], { cwd: root });
    commitFile(root, 'b.txt', '2', 'feat commit');
    execFileSync('git', ['checkout', '-q', '-'], { cwd: root });   // back to the default branch
    commitFile(root, 'c.txt', '3', 'main commit');                  // divergent → real merge
    execFileSync('git', ['merge', '-q', '--no-ff', '-m', 'merge feat', 'feat'], { cwd: root });
    const journalDir = join(root, '.lore', 'journal');
    captureHead({ repoRoot: root, journalDir, codeRoots: [] });
    const second = captureHead({ repoRoot: root, journalDir, codeRoots: [] });
    assert.equal(second.added, 0);   // idempotent regardless of merge-HEAD fallback
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI never throws / exits 0 even on a non-git dir', () => {
  const root = tmpDir();   // not a git repo
  try {
    execFileSync('node', ['lib/hook.js', root], { cwd: process.cwd() });   // must not throw
  } finally { rmSync(root, { recursive: true, force: true }); }
});
