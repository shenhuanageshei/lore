import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { planSync, stampFrontmatter, buildIndex, finalizeSync, renderDecisionHistory } from '../lib/sync.js';
import { init } from '../lib/init.js';
import { start, stop } from '../lib/serve.js';
import { appendAtom } from '../lib/journal.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-sync-')); }

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

test('renderDecisionHistory: empty → placeholder', () => {
  assert.equal(renderDecisionHistory([]), '暂无 journal 原子（跑 /lore:mine 补全）。');
});

test('renderDecisionHistory: atom with why → bullet with why, short sha, date', () => {
  const out = renderDecisionHistory([
    { title: 'fix crawler', why: 'anti data blowup\nsecond line', commit: 'abc1234567', ts: '2026-06-01T08:00:00Z', kind: 'commit' },
  ]);
  assert.equal(out, '- **fix crawler** — anti data blowup (abc1234, 2026-06-01)');
});

test('renderDecisionHistory: atom without why → no why segment', () => {
  const out = renderDecisionHistory([
    { title: 'add site', why: '', commit: 'def4567890', ts: '2026-05-30T10:00:00Z', kind: 'commit' },
  ]);
  assert.equal(out, '- **add site** (def4567, 2026-05-30)');
});

test('renderDecisionHistory: multiple atoms sorted ts-desc; input not mutated', () => {
  const atoms = [
    { title: 'older', why: '', commit: 'aaaaaaa0', ts: '2026-05-01T00:00:00Z', kind: 'commit' },
    { title: 'newer', why: '', commit: 'bbbbbbb0', ts: '2026-06-01T00:00:00Z', kind: 'commit' },
  ];
  const out = renderDecisionHistory(atoms);
  assert.match(out, /newer[\s\S]*older/);   // newer first
  assert.equal(atoms[0].title, 'older');     // input order unchanged
});

test('integration: init -> agent page -> sync finalize -> serve renders', async () => {
  const root = gitRepo();
  try {
    // a discoverable code dir so init writes code_roots: [lib]
    mkdirSync(join(root, 'lib'));
    writeFileSync(join(root, 'lib', 'a.js'), 'export const x = 1;');
    init({ repoRoot: root, srcSiteDir: join(process.cwd(), 'site') });
    const lore = join(root, '.lore');

    // plan sees the component
    const plan = JSON.parse(execFileSync('node', ['lib/sync.js', 'plan', lore], { cwd: process.cwd() }).toString());
    assert.ok(plan.worklist.some(w => w.component === 'lib'));

    // simulate the agent synthesis step
    const compDir = join(lore, 'wiki', 'component');
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, 'lib.md'), agentPage('Lib', 'core lib'));

    // real finalize via CLI
    execFileSync('node', ['lib/sync.js', 'finalize', lore], { cwd: process.cwd() });

    // serve (force node fallback for determinism) + fetch
    const info = await start({ loreDir: lore, port: 0, canRun: () => false, now: 't' });
    try {
      assert.equal((await fetch(info.url + '../wiki/INDEX.md')).status, 200);
      const page = await fetch(info.url + '../wiki/component/lib.md');
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Current architecture/);
      assert.equal((await fetch(info.url + '../wiki/.manifest.json')).status, 200);
    } finally {
      await stop({ loreDir: lore });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// agent page whose Decision history section is the injection token (new command format)
function tokenPage(title, summary) {
  return `---\ntitle: ${title}\nsummary: ${summary}\n---\n# component: ${title}\n\n` +
    `## Current architecture\n\narch prose\n\n## Decision history\n\n{{LORE_JOURNAL}}\n\n` +
    `## Cross-links\n\n- [[other]]\n`;
}

test('finalizeSync folds journal atoms into the {{LORE_JOURNAL}} token + stamps per-page counts', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    const compDir = join(lore, 'wiki', 'component');
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, 'lib.md'), tokenPage('Lib', 'core'));
    writeFileSync(join(compDir, 'other.md'), tokenPage('Other', 'x'));   // no matching atoms

    const journalDir = join(lore, 'journal');
    appendAtom(journalDir, { id: 'commit:a', ts: '2026-06-01T08:00:00Z', kind: 'commit', commit: 'aaaaaaa0', title: 'newer fix', why: 'because', facets: { component: ['lib'] } });
    appendAtom(journalDir, { id: 'commit:b', ts: '2026-05-01T08:00:00Z', kind: 'commit', commit: 'bbbbbbb0', title: 'older fix', why: '', facets: { component: ['lib'] } });

    finalizeSync(lore, '2026-06-02T00:00:00Z');

    const libPage = readFileSync(join(compDir, 'lib.md'), 'utf8');
    assert.doesNotMatch(libPage, /\{\{LORE_JOURNAL\}\}/);                       // token replaced
    assert.match(libPage, /- \*\*newer fix\*\* — because \(aaaaaaa, 2026-06-01\)/);
    assert.match(libPage, /- \*\*older fix\*\* \(bbbbbbb, 2026-05-01\)/);
    assert.match(libPage, /newer fix[\s\S]*older fix/);                          // ts desc
    assert.match(libPage, /atoms: 2/);
    assert.match(libPage, /commits: 2/);

    const otherPage = readFileSync(join(compDir, 'other.md'), 'utf8');
    assert.match(otherPage, /暂无 journal 原子/);
    assert.match(otherPage, /atoms: 0/);

    const index = readFileSync(join(lore, 'wiki', 'INDEX.md'), 'utf8');
    assert.match(index, /atoms: 2/);                                            // grand totals
    assert.match(index, /commits: 2/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('finalizeSync backward-compat: page without token does not crash, still stamps counts', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    const compDir = join(lore, 'wiki', 'component');
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, 'lib.md'), agentPage('Lib', 'core'));   // old format, no token
    const journalDir = join(lore, 'journal');
    appendAtom(journalDir, { id: 'commit:a', ts: '2026-06-01T08:00:00Z', kind: 'commit', commit: 'aaaaaaa0', title: 't', why: '', facets: { component: ['lib'] } });

    finalizeSync(lore, '2026-06-02T00:00:00Z');
    const libPage = readFileSync(join(compDir, 'lib.md'), 'utf8');
    assert.match(libPage, /暂无 journal 原子/);   // agent's own placeholder untouched (no token)
    assert.match(libPage, /atoms: 1/);            // counts still stamped from journal
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('integration: init → mine → sync folds commit atom into component page', () => {
  const root = gitRepo();   // has an initial commit (f.txt)
  try {
    // a commit touching lib/ so mine tags it component:[lib]
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'a.js'), 'export const x = 1;');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'add lib feature'], { cwd: root });

    init({ repoRoot: root, srcSiteDir: join(process.cwd(), 'site') });   // config code_roots: [lib]
    const lore = join(root, '.lore');
    const compDir = join(lore, 'wiki', 'component');
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, 'lib.md'), tokenPage('Lib', 'core'));   // agent page with the token

    execFileSync('node', ['lib/mine.js', root], { cwd: process.cwd() });             // populate journal
    execFileSync('node', ['lib/sync.js', 'finalize', lore], { cwd: process.cwd() }); // fold + manifest

    const libPage = readFileSync(join(compDir, 'lib.md'), 'utf8');
    assert.match(libPage, /add lib feature/);            // commit atom title now in decision history
    assert.doesNotMatch(libPage, /\{\{LORE_JOURNAL\}\}/);
    assert.match(libPage, /atoms: 1/);                   // only the lib-touching commit matches

    const manifest = JSON.parse(readFileSync(join(lore, 'wiki', '.manifest.json'), 'utf8'));
    const libEntry = manifest.axes.find(a => a.id === 'component').pages.find(p => p.id === 'lib');
    assert.equal(libEntry.synthesized_from.atoms, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
