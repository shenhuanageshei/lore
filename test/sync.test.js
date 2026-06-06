import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { planSync, stampFrontmatter, buildIndex, finalizeSync, renderDecisionHistory, foldJournal } from '../lib/sync.js';
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
      { axis: 'HOME', id: 'HOME', path: 'HOME.md', priorExists: false },
      { axis: 'component', id: 'lib', component: 'lib', codeRoot: 'lib', path: 'component/lib.md', priorExists: true },
      { axis: 'component', id: 'pkg', component: 'pkg', codeRoot: 'src/pkg', path: 'component/pkg.md', priorExists: false },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('planSync returns empty when config missing', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    assert.deepEqual(planSync(lore), { codeRoots: [], themes: [], flows: [], worklist: [{ axis: 'HOME', id: 'HOME', path: 'HOME.md', priorExists: false }] });
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
  const out = buildIndex({ component: [{ id: 'm3_nlp', title: 'M3 NLP' }, { id: 'lib', title: 'Lib' }] });
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
    assert.equal(parsed.worklist.length, 3);
    assert.equal(parsed.worklist[0].axis, 'HOME');
    assert.equal(parsed.worklist[1].component, 'lib');
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

test('finalizeSync injects journal markdown literally — no $-pattern corruption', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    const compDir = join(lore, 'wiki', 'component');
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, 'lib.md'), tokenPage('Lib', 'core'));
    const journalDir = join(lore, 'journal');
    // commit title containing replacement-pattern special sequences
    appendAtom(journalDir, {
      id: 'commit:a', ts: '2026-06-01T08:00:00Z', kind: 'commit', commit: 'aaaaaaa0',
      title: 'fix $& and $$ and $1 patterns', why: '', facets: { component: ['lib'] },
    });

    finalizeSync(lore, '2026-06-02T00:00:00Z');

    const libPage = readFileSync(join(compDir, 'lib.md'), 'utf8');
    // function-form replace inserts md literally; the string form would turn
    // $& into the token text and $$ into a single $ — these assertions catch that.
    assert.match(libPage, /fix \$& and \$\$ and \$1 patterns/);
    assert.doesNotMatch(libPage, /\{\{LORE_JOURNAL\}\}/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('foldJournal: single token folds journal md (regression), no warning', () => {
  const warnings = [];
  const text = '# C\n\n## Decision history\n\n{{LORE_JOURNAL}}\n';
  const out = foldJournal(text, '- **x** (2026-06-01)', { page: 'component/c.md', warn: m => warnings.push(m) });
  assert.match(out, /- \*\*x\*\* \(2026-06-01\)/);
  assert.doesNotMatch(out, /\{\{LORE_JOURNAL\}\}/);
  assert.equal(warnings.length, 0);
});

test('foldJournal: zero tokens → text unchanged, no warning (own-history pages are a valid pattern)', () => {
  const warnings = [];
  const text = '# C\n\n## Decision history\n\n暂无 journal 原子。\n';
  const out = foldJournal(text, '- **x**', { page: 'component/c.md', warn: m => warnings.push(m) });
  assert.equal(out, text);                              // page untouched, no fold slot
  assert.equal(warnings.length, 0);                     // 0 is silent; only >1 (corruption) warns
});

test('foldJournal: multiple tokens → folds into LAST, blanks earlier, warns, no literal token', () => {
  const warnings = [];
  const text =
    '# C\n\n## Current architecture\n\nThe {{LORE_JOURNAL}} token marks history.\n\n' +
    '## Decision history\n\n{{LORE_JOURNAL}}\n\n## Cross-links\n\n- [[x]]\n';
  const md = '- **real entry** (2026-06-01)';
  const out = foldJournal(text, md, { page: 'component/c.md', warn: m => warnings.push(m) });
  assert.doesNotMatch(out, /\{\{LORE_JOURNAL\}\}/);                                  // no literal token survives
  assert.match(out, /## Decision history\n\n- \*\*real entry\*\* \(2026-06-01\)\n/); // folded into the LAST slot
  assert.match(out, /The  token marks history\./);                                  // earlier prose token blanked
  assert.equal((out.match(/real entry/g) || []).length, 1);                         // journal md inserted exactly once
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /component\/c\.md/);                                     // names the page
  assert.match(warnings[0], /expected 1/);                                          // names the ambiguity
});

test('foldJournal: multi-token path inserts md literally — $-pattern safe', () => {
  const text = 'a {{LORE_JOURNAL}} b {{LORE_JOURNAL}} c';
  const out = foldJournal(text, 'fix $& and $$ and $1', { page: 'p', warn: () => {} });
  assert.match(out, /fix \$& and \$\$ and \$1/);
  assert.doesNotMatch(out, /\{\{LORE_JOURNAL\}\}/);
});

// agent page that mentions the token in prose AND in the real Decision-history slot
function twoTokenPage(title, summary) {
  return `---\ntitle: ${title}\nsummary: ${summary}\n---\n# component: ${title}\n\n` +
    `## Current architecture\n\nThe {{LORE_JOURNAL}} token marks where history goes.\n\n` +
    `## Decision history\n\n{{LORE_JOURNAL}}\n\n` +
    `## Cross-links\n\n- [[other]]\n`;
}

test('finalizeSync: duplicate {{LORE_JOURNAL}} tokens fold into the last, ship no literal token + warn', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    const compDir = join(lore, 'wiki', 'component');
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, 'lib.md'), twoTokenPage('Lib', 'core'));
    appendAtom(join(lore, 'journal'), { id: 'commit:a', ts: '2026-06-01T08:00:00Z', kind: 'commit', commit: 'aaaaaaa0', title: 'real fix', why: 'reason', facets: { component: ['lib'] } });

    const warnings = [];
    finalizeSync(lore, '2026-06-02T00:00:00Z', { warn: m => warnings.push(m) });

    const libPage = readFileSync(join(compDir, 'lib.md'), 'utf8');
    assert.doesNotMatch(libPage, /\{\{LORE_JOURNAL\}\}/);                 // no literal token shipped
    assert.match(libPage, /## Decision history\n\n- \*\*real fix\*\*/);  // folded into the LAST (decision-history) slot
    assert.match(libPage, /The  token marks where history goes\./);      // earlier prose token blanked
    assert.equal((libPage.match(/real fix/g) || []).length, 1);          // journal injected exactly once
    assert.match(libPage, /atoms: 1/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /component\/lib\.md/);
    assert.match(warnings[0], /expected 1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('renderDecisionHistory: decision atom (no commit) omits sha', () => {
  const out = renderDecisionHistory([
    { title: 'use ZSET', why: 'range queries', commit: null, ts: '2026-06-03T08:00:00Z', kind: 'decision' },
  ]);
  assert.equal(out, '- **use ZSET** — range queries (2026-06-03)');
});

test('renderDecisionHistory: mixes commit + decision atoms, ts-desc', () => {
  const out = renderDecisionHistory([
    { title: 'old commit', why: '', commit: 'aaaaaaa0', ts: '2026-06-01T00:00:00Z', kind: 'commit' },
    { title: 'new note', why: 'because', commit: null, ts: '2026-06-03T00:00:00Z', kind: 'decision' },
  ]);
  assert.match(out, /new note[\s\S]*old commit/);                          // ts desc
  assert.match(out, /- \*\*new note\*\* — because \(2026-06-03\)/);        // decision: (date)
  assert.match(out, /- \*\*old commit\*\* \(aaaaaaa, 2026-06-01\)/);       // commit: (sha, date)
});

test('planSync includes theme worklist items with axis', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib]\n  theme:\n    values:\n    - { id: quality, match: [质量] }\n');
    const { worklist, themes } = planSync(lore);
    assert.deepEqual(themes, [{ id: 'quality', match: ['质量'] }]);
    assert.ok(worklist.some(w => w.axis === 'component' && w.id === 'lib' && w.path === 'component/lib.md'));
    assert.ok(worklist.some(w => w.axis === 'theme' && w.id === 'quality' && w.path === 'theme/quality.md'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('buildIndex: object form renders per-axis sections', () => {
  const out = buildIndex({ component: [{ id: 'lib', title: 'Lib' }], theme: [{ id: 'quality', title: 'Quality' }] });
  assert.match(out, /## Component\n- \[\[lib\]\]/);
  assert.match(out, /## Theme\n- \[\[quality\]\]/);
});

test('finalizeSync folds both component and theme axes', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    for (const axis of ['component', 'theme']) mkdirSync(join(lore, 'wiki', axis), { recursive: true });
    writeFileSync(join(lore, 'wiki', 'component', 'lib.md'), tokenPage('Lib', 'c'));
    writeFileSync(join(lore, 'wiki', 'theme', 'quality.md'), tokenPage('Quality', 't'));
    const journalDir = join(lore, 'journal');
    appendAtom(journalDir, { id: 'commit:a', ts: '2026-06-03T00:00:00Z', kind: 'commit', commit: 'aaaaaaa0', title: 'lib fix', why: '', facets: { component: ['lib'], flow: [], theme: ['quality'] } });

    finalizeSync(lore, '2026-06-03T00:00:00Z');

    assert.match(readFileSync(join(lore, 'wiki', 'component', 'lib.md'), 'utf8'), /- \*\*lib fix\*\*/);
    assert.match(readFileSync(join(lore, 'wiki', 'theme', 'quality.md'), 'utf8'), /- \*\*lib fix\*\*/);
    const index = readFileSync(join(lore, 'wiki', 'INDEX.md'), 'utf8');
    assert.match(index, /## Component/);
    assert.match(index, /## Theme/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('integration: config theme → mine tags it → sync folds into theme page', () => {
  const root = gitRepo();
  try {
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'a.js'), 'export const x = 1;');
    init({ repoRoot: root, srcSiteDir: join(process.cwd(), 'site') });
    const lore = join(root, '.lore');
    // rewrite config with code_roots + a theme whose keyword the commit will contain
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib]\n  theme:\n    values:\n    - { id: quality, match: [accuracy] }\n');
    // a commit whose subject contains the keyword
    writeFileSync(join(root, 'lib', 'b.js'), 'y');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'improve accuracy'], { cwd: root });
    execFileSync('node', ['lib/mine.js', root], { cwd: process.cwd() });   // tags theme:quality

    const themeDir = join(lore, 'wiki', 'theme');
    mkdirSync(themeDir, { recursive: true });
    writeFileSync(join(themeDir, 'quality.md'), tokenPage('Quality', 'q'));   // agent theme page (stub)
    execFileSync('node', ['lib/sync.js', 'finalize', lore], { cwd: process.cwd() });

    assert.match(readFileSync(join(themeDir, 'quality.md'), 'utf8'), /improve accuracy/);   // theme page folds the commit
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('commands/sync.md documents HOME work item', () => {
  const doc = readFileSync(join(process.cwd(), 'commands', 'sync.md'), 'utf8');
  assert.match(doc, /HOME page/);
  assert.match(doc, /\{\{LORE_HOME_STATUS\}\}/);
  assert.match(doc, /Knowledge flow/);
});

test('planSync includes HOME as the first work item', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    writeFileSync(join(lore, 'config.yml'), 'axes:\n  component:\n    code_roots: [lib]\n');
    const r = planSync(lore);
    assert.equal(r.worklist[0].axis, 'HOME');
    assert.equal(r.worklist[0].path, 'HOME.md');
    assert.equal(r.worklist[0].priorExists, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('finalizeSync writes HOME before manifest and keeps INDEX', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    writeFileSync(join(lore, 'config.yml'), 'language:\n  default: zh\n  available: [zh, en]\n');
    finalizeSync(lore, '2026-06-06T00:00:00Z');
    const home = readFileSync(join(lore, 'wiki', 'HOME.md'), 'utf8');
    assert.match(home, /title: Home/);
    assert.match(home, /## Status/);
    assert.doesNotMatch(home, /\{\{LORE_HOME_STATUS\}\}/);
    assert.equal(existsSync(join(lore, 'wiki', 'INDEX.md')), true);
    const manifest = JSON.parse(readFileSync(join(lore, 'wiki', '.manifest.json'), 'utf8'));
    assert.deepEqual(manifest.axes.slice(0, 2).map(a => a.id), ['HOME', 'INDEX']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('finalizeSync HOME status is idempotent across re-syncs (no duplicate ## Status)', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    writeFileSync(join(lore, 'config.yml'), 'language:\n  default: zh\n  available: [zh, en]\n');
    finalizeSync(lore, '2026-06-06T00:00:00Z');
    finalizeSync(lore, '2026-06-07T00:00:00Z');
    const home = readFileSync(join(lore, 'wiki', 'HOME.md'), 'utf8');
    assert.equal((home.match(/## Status/g) || []).length, 1);   // sentinel region swapped, not appended
    assert.doesNotMatch(home, /\{\{LORE_HOME_STATUS\}\}/);
    assert.match(home, /Updated: `2026-06-07`/);                // status refreshed to the 2nd run
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('planSync includes flow worklist items', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib]\n  flow:\n    values:\n    - { id: pipe, spans: [lib] }\n');
    const { worklist, flows } = planSync(lore);
    assert.deepEqual(flows, [{ id: 'pipe', spans: ['lib'] }]);
    assert.ok(worklist.some(w => w.axis === 'flow' && w.id === 'pipe' && w.path === 'flow/pipe.md'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('finalizeSync folds the flow axis', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki', 'flow'), { recursive: true });
    writeFileSync(join(lore, 'wiki', 'flow', 'pipe.md'), tokenPage('Pipe', 'p'));
    appendAtom(join(lore, 'journal'), { id: 'commit:a', ts: '2026-06-03T00:00:00Z', kind: 'commit', commit: 'aaaaaaa0', title: 'flow fix', why: '', facets: { component: ['lib'], flow: ['pipe'], theme: [] } });
    finalizeSync(lore, '2026-06-03T00:00:00Z');
    assert.match(readFileSync(join(lore, 'wiki', 'flow', 'pipe.md'), 'utf8'), /- \*\*flow fix\*\*/);
    assert.match(readFileSync(join(lore, 'wiki', 'INDEX.md'), 'utf8'), /## Flow/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('integration: config flow → mine tags it → sync folds into flow page', () => {
  const root = gitRepo();
  try {
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'a.js'), 'export const x = 1;');
    init({ repoRoot: root, srcSiteDir: join(process.cwd(), 'site') });
    const lore = join(root, '.lore');
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib]\n  flow:\n    values:\n    - { id: pipe, spans: [lib] }\n');
    writeFileSync(join(root, 'lib', 'b.js'), 'y');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'touch lib pipeline'], { cwd: root });
    execFileSync('node', ['lib/mine.js', root], { cwd: process.cwd() });   // atom component:[lib] → flow:[pipe]

    const flowDir = join(lore, 'wiki', 'flow');
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, 'pipe.md'), tokenPage('Pipe', 'p'));
    execFileSync('node', ['lib/sync.js', 'finalize', lore], { cwd: process.cwd() });

    assert.match(readFileSync(join(flowDir, 'pipe.md'), 'utf8'), /touch lib pipeline/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('finalizeSync builds docs axis from config + files (INDEX + manifest)', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-sync-docs-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root,
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    const lore = join(root, '.lore');
    // a component page so the journal-fold (SYNC_AXES) path also runs alongside the docs axis
    mkdirSync(join(lore, 'wiki', 'component'), { recursive: true });
    mkdirSync(join(lore, 'journal'), { recursive: true });
    writeFileSync(join(lore, 'config.yml'),
      'axes:\n  component:\n    code_roots: [lib]\n  docs:\n    sources: [docs, changelog]\n    docs_glob: docs/**/*.md\n');
    writeFileSync(join(lore, 'wiki', 'component', 'lib.md'), '---\ntitle: lib\nsummary: s\n---\n# component: lib\n## Decision history\n{{LORE_JOURNAL}}\n');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'design.md'), '# Design\n\nthe design.\n');
    writeFileSync(join(root, 'CHANGELOG.md'), '## [0.1.0] — 2026-06-03\n- x\n');

    finalizeSync(lore, '2026-06-05T00:00:00Z', { warn() {} });

    assert.ok(existsSync(join(lore, 'wiki', 'docs', 'design.md')));
    assert.ok(existsSync(join(lore, 'wiki', 'docs', 'changelog.md')));
    assert.match(readFileSync(join(lore, 'wiki', 'docs', 'changelog.md'), 'utf8'), /0\.1\.0/);
    const index = readFileSync(join(lore, 'wiki', 'INDEX.md'), 'utf8');
    assert.match(index, /## Docs/);
    assert.match(index, /\[\[design\]\]/);
    const manifest = JSON.parse(readFileSync(join(lore, 'wiki', '.manifest.json'), 'utf8'));
    assert.ok(manifest.axes.some(a => a.id === 'docs' && a.pages.some(p => p.id === 'design')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
