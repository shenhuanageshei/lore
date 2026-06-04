// test/ask.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { searchPages } from '../lib/ask.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-ask-')); }

const MANIFEST = {
  axes: [
    { id: 'INDEX', pages: [{ id: 'INDEX', title: 'Index', summary: 'toc', path: 'INDEX.md' }] },
    { id: 'component', pages: [
      { id: 'm3_nlp', title: 'M3 NLP', summary: 'entity extraction accuracy', path: 'component/m3_nlp.md' },
      { id: 'm1', title: 'M1 Crawler', summary: 'fetch articles', path: 'component/m1.md' },
    ] },
    { id: 'theme', pages: [{ id: 'quality', title: 'Quality', summary: 'accuracy and false positives', path: 'theme/quality.md' }] },
  ],
};

test('searchPages: ranks by title+summary keyword hits, skips INDEX axis', () => {
  const hits = searchPages(MANIFEST, 'accuracy');
  assert.deepEqual(hits.map(h => h.path), ['component/m3_nlp.md', 'theme/quality.md']);  // both hit, sorted by path
  assert.ok(hits.every(h => h.score === 1));
});

test('searchPages: multi-term scores higher; case-insensitive', () => {
  const hits = searchPages(MANIFEST, 'NLP Accuracy');
  assert.equal(hits[0].path, 'component/m3_nlp.md');   // title 'M3 NLP' + summary 'accuracy' = 2 hits
  assert.equal(hits[0].score, 2);
});

test('searchPages: no match → []; does not mutate manifest', () => {
  assert.deepEqual(searchPages(MANIFEST, 'zzz'), []);
  const before = JSON.stringify(MANIFEST);
  searchPages(MANIFEST, 'accuracy');
  assert.equal(JSON.stringify(MANIFEST), before);
});

test('CLI: prints candidates; no-manifest → exit non-zero', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    writeFileSync(join(lore, 'wiki', '.manifest.json'), JSON.stringify(MANIFEST));
    const out = execFileSync('node', ['lib/ask.js', lore, 'accuracy'], { cwd: process.cwd() }).toString();
    assert.match(out, /component\/m3_nlp\.md/);

    const root2 = tmpDir();
    mkdirSync(join(root2, '.lore', 'wiki'), { recursive: true });   // no .manifest.json
    assert.throws(() => execFileSync('node', ['lib/ask.js', join(root2, '.lore'), 'x'], { cwd: process.cwd(), stdio: 'pipe' }));
    rmSync(root2, { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { init } from '../lib/init.js';

function gitRepo() {
  const root = tmpDir();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  writeFileSync(join(root, 'f.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  return root;
}

test('integration: init → write page → sync → ask finds it', () => {
  const root = gitRepo();
  try {
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'a.js'), 'export const x = 1;');
    init({ repoRoot: root, srcSiteDir: join(process.cwd(), 'site') });
    const lore = join(root, '.lore');
    const compDir = join(lore, 'wiki', 'component');
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, 'lib.md'), `---\ntitle: Lib Core\nsummary: dedup ZSET accuracy\n---\n# component: lib\n\n## Current architecture\n\nx\n\n## Decision history\n\n{{LORE_JOURNAL}}\n\n## Cross-links\n\n- [[x]]\n`);
    execFileSync('node', ['lib/sync.js', 'finalize', lore], { cwd: process.cwd() });   // emits manifest with the page

    const out = execFileSync('node', ['lib/ask.js', lore, 'dedup accuracy'], { cwd: process.cwd() }).toString();
    assert.match(out, /component\/lib\.md/);   // ask finds the page by its summary keywords
  } finally { rmSync(root, { recursive: true, force: true }); }
});
