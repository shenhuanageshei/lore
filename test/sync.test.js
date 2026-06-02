import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseConfigCodeRoots, planSync, stampFrontmatter, buildIndex, finalizeSync } from '../lib/sync.js';

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

test('planSync builds worklist from config code_roots', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki', 'component'), { recursive: true });
    writeFileSync(join(lore, 'config.yml'), 'axes:\n  component:\n    code_roots: [lib, src/pkg]\n');
    writeFileSync(join(lore, 'wiki', 'component', 'lib.md'), 'x');   // makes priorExists true for lib
    const { codeRoots, worklist } = planSync(lore);
    assert.deepEqual(codeRoots, ['lib', 'src/pkg']);
    assert.deepEqual(worklist, [
      { component: 'lib', codeRoot: 'lib', path: 'component/lib.md', priorExists: true },
      { component: 'pkg', codeRoot: 'src/pkg', path: 'component/pkg.md', priorExists: false },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('planSync returns empty when config missing', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    assert.deepEqual(planSync(lore), { codeRoots: [], worklist: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stampFrontmatter merges mechanical fields, preserves title/summary + body', () => {
  const page =
    '---\ntitle: M3 NLP\nsummary: entity extraction\n---\n' +
    '# component: m3_nlp\n\n## Current architecture\n\nprose\n';
  const out = stampFrontmatter(page, { codeSha: 'abc1234', lastUpdated: '2026-06-01', commits: 0, atoms: 0 });
  assert.match(out, /^---\n/);
  assert.match(out, /title: M3 NLP/);
  assert.match(out, /summary: entity extraction/);
  assert.match(out, /last_updated: 2026-06-01/);
  assert.match(out, /code_sha: abc1234/);
  assert.match(out, /atoms: 0/);
  assert.match(out, /commits: 0/);
  // body preserved
  assert.match(out, /# component: m3_nlp/);
  assert.match(out, /## Current architecture/);
  assert.match(out, /prose/);
});

test('buildIndex renders TOC with half front-matter and component links', () => {
  const out = buildIndex([{ id: 'm3_nlp', title: 'M3 NLP' }, { id: 'lib', title: 'Lib' }]);
  assert.match(out, /title: Index/);
  assert.match(out, /summary: table of contents/);
  assert.match(out, /# lore wiki — index/);
  assert.match(out, /## Component/);
  assert.match(out, /- \[\[m3_nlp\]\]/);
  assert.match(out, /- \[\[lib\]\]/);
});

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

function agentPage(title, summary) {
  return `---\ntitle: ${title}\nsummary: ${summary}\n---\n# component: ${title}\n\n` +
    `## Current architecture\n\narch prose\n\n## Decision history\n\n暂无 journal 原子。\n\n` +
    `## Cross-links\n\n- [[other]]\n`;
}

test('finalizeSync stamps pages, writes INDEX + manifest', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    const compDir = join(lore, 'wiki', 'component');
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, 'm3_nlp.md'), agentPage('M3 NLP', 'entity extraction'));
    writeFileSync(join(compDir, 'lib.md'), agentPage('Lib', 'core lib'));

    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
    const r = finalizeSync(lore, '2026-06-01T08:00:00Z');

    assert.deepEqual(r.stamped.slice().sort(), ['component/lib.md', 'component/m3_nlp.md']);
    assert.equal(r.indexWritten, true);

    // pages stamped, body preserved
    const page = readFileSync(join(compDir, 'm3_nlp.md'), 'utf8');
    assert.match(page, new RegExp('code_sha: ' + sha));
    assert.match(page, /last_updated: 2026-06-01/);
    assert.match(page, /atoms: 0/);
    assert.match(page, /title: M3 NLP/);
    assert.match(page, /## Current architecture/);

    // INDEX
    const index = readFileSync(join(lore, 'wiki', 'INDEX.md'), 'utf8');
    assert.match(index, /- \[\[m3_nlp\]\]/);
    assert.match(index, /- \[\[lib\]\]/);
    assert.match(index, new RegExp('code_sha: ' + sha));

    // manifest
    const manifest = JSON.parse(readFileSync(join(lore, 'wiki', '.manifest.json'), 'utf8'));
    const comp = manifest.axes.find(a => a.id === 'component');
    assert.equal(comp.pages.length, 2);
    assert.deepEqual(comp.pages.map(p => p.id).slice().sort(), ['lib', 'm3_nlp']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI plan prints worklist JSON', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib, site]\n');
    const out = execFileSync('node', ['lib/sync.js', 'plan', lore], { cwd: process.cwd() }).toString();
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.codeRoots, ['lib', 'site']);
    assert.equal(parsed.worklist.length, 2);
    assert.equal(parsed.worklist[0].component, 'lib');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI without args exits non-zero', () => {
  assert.throws(() => execFileSync('node', ['lib/sync.js'], { cwd: process.cwd(), stdio: 'pipe' }));
});
