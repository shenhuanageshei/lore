// test/lint.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { lintOrphans, lintMissing, lintStale, lint } from '../lib/lint.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-lint-')); }

test('lintOrphans: page ids not matching any code_root last-segment', () => {
  assert.deepEqual(lintOrphans(['lib', 'gone'], ['lib', 'src/pkg']), ['gone']);
  assert.deepEqual(lintOrphans(['lib', 'pkg'], ['lib', 'src/pkg']), []);   // pkg ← src/pkg
});

test('lintMissing: code_root last-segments with no page', () => {
  assert.deepEqual(lintMissing(['lib'], ['lib', 'src/pkg']), ['pkg']);     // pkg page missing
  assert.deepEqual(lintMissing(['lib', 'pkg'], ['lib', 'src/pkg']), []);
});

test('lintStale: pages whose code_sha != current → behind via countSince', () => {
  const pages = [
    { id: 'a', code_sha: 'old1234' },
    { id: 'b', code_sha: 'cur5678' },   // == current → not stale
    { id: 'c', code_sha: '' },           // no sha → skipped
  ];
  const countSince = sha => (sha === 'old1234' ? 3 : 0);
  assert.deepEqual(lintStale(pages, 'cur5678', countSince), [
    { page: 'a', code_sha: 'old1234', behind: 3 },
  ]);
});

function gitRepo() {
  const root = tmpDir();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  writeFileSync(join(root, 'f.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'c1'], { cwd: root });
  return root;
}
function page(loreDir, id, codeSha) {
  const dir = join(loreDir, 'wiki', 'component');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), `---\ntitle: ${id}\ncode_sha: ${codeSha}\n---\n# ${id}\n`);
}

test('lint orchestrator reports stale + orphan + missing', () => {
  const root = gitRepo();   // has commit c1
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    const sha1 = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
    // a second commit so HEAD advances past sha1 (sha1 is now 1 behind)
    writeFileSync(join(root, 'g.txt'), 'y');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'c2'], { cwd: root });

    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib, site]\n');
    page(lore, 'lib', sha1);    // stale: page stamped at c1, HEAD now at c2 → behind 1
    page(lore, 'gone', execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim());   // orphan, current sha → not stale
    // 'site' code_root has no page → missing

    const r = lint({ loreDir: lore });
    assert.deepEqual(r.stale.map(s => s.page), ['lib']);
    assert.equal(r.stale[0].behind, 1);          // exactly 1 commit behind (real reachable sha)
    assert.deepEqual(r.orphans, ['gone']);
    assert.deepEqual(r.missing, ['site']);
    assert.equal(r.clean, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lint: clean repo → clean:true', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    const cur = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib]\n');
    page(lore, 'lib', cur);   // current sha, matches root → no drift
    const r = lint({ loreDir: lore });
    assert.deepEqual(r, { stale: [], orphans: [], missing: [], clean: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
