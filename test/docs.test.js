import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { docsExtractor, changelogExtractor, pitfallsExtractor, buildDocsAxis } from '../lib/docs.js';
import { existsSync as exists } from 'node:fs';

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-docs-')); }

test('docsExtractor: one spec per .md, recursive, sorted', () => {
  const root = tmp();
  try {
    mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'a.md'), '# Title A\n\nFirst para of A.\n');
    writeFileSync(join(root, 'docs', 'specs', '2026-06-04-thing.md'),
      '---\ntitle: Thing FM\nsummary: from front-matter\n---\n# H1 ignored when FM title\nbody');
    const specs = docsExtractor(root, 'docs/**/*.md');
    assert.equal(specs.length, 2);
    assert.equal(specs[0].id, 'a');
    assert.equal(specs[0].title, 'Title A');
    assert.equal(specs[0].summary, 'First para of A.');
    assert.equal(specs[0].sourcePath, 'docs/a.md');
    const thing = specs[1];
    assert.equal(thing.id, 'specs-2026-06-04-thing');
    assert.equal(thing.title, 'Thing FM');
    assert.equal(thing.summary, 'from front-matter');
    assert.equal(thing.date, '2026-06-04');
    assert.equal(thing.sourcePath, 'docs/specs/2026-06-04-thing.md');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('docsExtractor: empty/missing docs dir → []', () => {
  const root = tmp();
  try { assert.deepEqual(docsExtractor(root, 'docs/**/*.md'), []); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('docsExtractor: summary falls back to first prose para when no H1', () => {
  const root = tmp();
  try {
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'noh1.md'), '## Section\n\nprose under a level-2 heading.\n');
    const specs = docsExtractor(root, 'docs/**/*.md');
    assert.equal(specs.length, 1);
    assert.equal(specs[0].summary, 'prose under a level-2 heading.');
    assert.equal(specs[0].title, 'noh1');   // no H1, no FM → filename fallback
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('changelogExtractor: versions → single folded spec', () => {
  const root = tmp();
  try {
    writeFileSync(join(root, 'CHANGELOG.md'),
      '# Changelog\n\n## [0.2.0] — 2026-06-04\n\n### 新增\n- mermaid\n\n## [0.1.0] — 2026-06-03\n\n- first\n');
    const specs = changelogExtractor(root);
    assert.equal(specs.length, 1);
    const s = specs[0];
    assert.equal(s.id, 'changelog');
    assert.equal(s.title, 'CHANGELOG');
    assert.equal(s.sourcePath, 'CHANGELOG.md');
    assert.equal(s.date, '2026-06-04');               // newest version date
    assert.equal(s.entries.length, 2);
    assert.deepEqual(s.entries[0], { version: '0.2.0', date: '2026-06-04' });
    assert.deepEqual(s.entries[1], { version: '0.1.0', date: '2026-06-03' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('changelogExtractor: no CHANGELOG → []', () => {
  const root = tmp();
  try { assert.deepEqual(changelogExtractor(root), []); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('changelogExtractor: hyphen separator + Unreleased date skip', () => {
  const root = tmp();
  try {
    writeFileSync(join(root, 'CHANGELOG.md'),
      '## [Unreleased]\n- wip\n\n## [0.3.0] - 2026-06-10\n- thing\n');
    const specs = changelogExtractor(root);
    assert.equal(specs[0].entries.length, 2);
    assert.deepEqual(specs[0].entries[0], { version: 'Unreleased', date: '' });
    assert.deepEqual(specs[0].entries[1], { version: '0.3.0', date: '2026-06-10' });
    assert.equal(specs[0].date, '2026-06-10');   // skips dateless Unreleased
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('changelogExtractor: file with no version headings → []', () => {
  const root = tmp();
  try {
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\njust prose, no versions\n');
    assert.deepEqual(changelogExtractor(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pitfallsExtractor: Problem/Fix/Prevention blocks → single folded spec', () => {
  const root = tmp();
  try {
    writeFileSync(join(root, 'CLAUDE.md'),
      'project notes\n\n**Problem**: tokens leak\n**Fix**: escape them\n**Prevention**: add a test\n\n' +
      '**问题**：超时\n**修复**：加重试\n**预防**：监控\n');
    const specs = pitfallsExtractor(root);
    assert.equal(specs.length, 1);
    assert.equal(specs[0].id, 'pitfalls');
    assert.equal(specs[0].entries.length, 2);
    assert.equal(specs[0].entries[0].problem, 'tokens leak');
    assert.equal(specs[0].entries[0].fix, 'escape them');
    assert.equal(specs[0].entries[0].prevention, 'add a test');
    assert.equal(specs[0].entries[1].problem, '超时');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pitfallsExtractor: no CLAUDE.md or no markers → []', () => {
  const root = tmp();
  try {
    assert.deepEqual(pitfallsExtractor(root), []);              // no file
    writeFileSync(join(root, 'CLAUDE.md'), 'just prose, no pitfalls\n');
    assert.deepEqual(pitfallsExtractor(root), []);              // no markers
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { renderDocsPage } from '../lib/docs.js';

test('renderDocsPage: spec with body → embeds body, plain-text source ref, no link, no # docs:', () => {
  const md = renderDocsPage({ id: 'a', title: 'Doc A', summary: 'about A', sourcePath: 'docs/a.md', date: '2026-06-04', body: '# Doc A\n\nfull content here.\n' });
  assert.match(md, /^---\ntitle: Doc A\nsummary: about A\nsource_path: docs\/a\.md\nlast_updated: 2026-06-04\ngroup: 其它\n---/);
  assert.match(md, /> 源文档：`docs\/a\.md`/);     // plain-text reference
  assert.match(md, /# Doc A\n\nfull content here\./); // body embedded verbatim
  assert.doesNotMatch(md, /\]\(\.\.\/\.\.\/\.\.\//);  // NO markdown link → no 404
  assert.doesNotMatch(md, /# docs:/);                 // no double-H1 wrapper
});

test('renderDocsPage: pitfalls (no body, has entries) → # title + entries list', () => {
  const md = renderDocsPage({ id: 'pitfalls', title: 'Pitfalls', summary: '1 条', sourcePath: 'CLAUDE.md', date: '', entries: [{ problem: 'P', fix: 'F', prevention: 'V' }] });
  assert.match(md, /> 源文档：`CLAUDE\.md`/);
  assert.match(md, /# Pitfalls/);
  assert.match(md, /- \*\*P\*\* — 修复：F；预防：V/);
});

test('renderDocsPage: changelog body embeds (entries not rendered as list)', () => {
  const md = renderDocsPage({ id: 'changelog', title: 'CHANGELOG', summary: '1 版本', sourcePath: 'CHANGELOG.md', date: '2026-06-03', entries: [{ version: '0.1.0', date: '2026-06-03' }], body: '# Changelog\n\n## [0.1.0] — 2026-06-03\n- x\n' });
  assert.match(md, /# Changelog/);
  assert.match(md, /## \[0\.1\.0\]/);
  assert.doesNotMatch(md, /- \*\*0\.1\.0\*\* —/);  // entries NOT rendered (body present wins)
});

test('buildDocsAxis: writes wiki/docs pages; nuke-rebuild drops removed docs', () => {
  const root = tmp();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'a.md'), '# A\n\npara\n');
    writeFileSync(join(root, 'docs', 'b.md'), '# B\n\npara\n');
    writeFileSync(join(root, 'CHANGELOG.md'), '## [0.1.0] — 2026-06-03\n- x\n');

    let pages = buildDocsAxis(lore, root, { sources: ['docs', 'changelog'], docsGlob: 'docs/**/*.md' });
    assert.deepEqual(pages.map(p => p.id).sort(), ['a', 'b', 'changelog']);
    assert.ok(exists(join(lore, 'wiki', 'docs', 'a.md')));
    assert.ok(exists(join(lore, 'wiki', 'docs', 'changelog.md')));

    // remove b.md, rebuild → b page must disappear (materialized view)
    rmSync(join(root, 'docs', 'b.md'));
    pages = buildDocsAxis(lore, root, { sources: ['docs', 'changelog'], docsGlob: 'docs/**/*.md' });
    assert.ok(!exists(join(lore, 'wiki', 'docs', 'b.md')));
    assert.ok(exists(join(lore, 'wiki', 'docs', 'a.md')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('docsExtractor: spec carries body (front-matter stripped)', () => {
  const root = tmp();
  try {
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'a.md'), '---\ntitle: A\n---\n# A\n\npara body\n');
    const s = docsExtractor(root, 'docs/**/*.md')[0];
    assert.equal(s.body, '# A\n\npara body\n');   // FM stripped, rest verbatim
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('changelogExtractor: spec carries CHANGELOG body', () => {
  const root = tmp();
  try {
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [0.1.0] — 2026-06-03\n- x\n');
    const s = changelogExtractor(root)[0];
    assert.match(s.body, /# Changelog/);
    assert.match(s.body, /## \[0\.1\.0\]/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('buildDocsAxis: no source docs → no empty wiki/docs dir', () => {
  const root = tmp();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    // no docs/, no CHANGELOG.md
    const pages = buildDocsAxis(lore, root, { sources: ['docs', 'changelog'], docsGlob: 'docs/**/*.md' });
    assert.deepEqual(pages, []);
    assert.ok(!exists(join(lore, 'wiki', 'docs')));   // dir not left behind → no empty axis in manifest
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('buildDocsAxis: returns specs sorted by date desc (tiebreak id)', () => {
  const root = tmp();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', '2026-06-01-old.md'), '# Old\n\nx\n');
    writeFileSync(join(root, 'docs', '2026-06-10-new.md'), '# New\n\nx\n');
    writeFileSync(join(root, 'docs', '2026-06-05-mid.md'), '# Mid\n\nx\n');
    const pages = buildDocsAxis(lore, root, { sources: ['docs'], docsGlob: 'docs/**/*.md' });
    assert.deepEqual(pages.map(p => p.id), ['2026-06-10-new', '2026-06-05-mid', '2026-06-01-old']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { docGroup, pairDocs } from '../lib/docs.js';

test('docGroup: 元文档→项目状态；语义子目录段映射；未知→其它；win 反斜杠容错', () => {
  // 元文档（不论路径）→ 项目状态（置顶组）
  assert.equal(docGroup('docs/ROADMAP.md'), '项目状态');
  assert.equal(docGroup('CHANGELOG.md'), '项目状态');
  assert.equal(docGroup('threat-intel/README.md'), '项目状态');
  assert.equal(docGroup('CLAUDE.md'), '项目状态');                          // pitfalls
  // 语义子目录段
  assert.equal(docGroup('docs/superpowers/specs/2026-06-08-x-design.md'), '设计');
  assert.equal(docGroup('docs/superpowers/plans/2026-06-08-x.md'), '计划');
  assert.equal(docGroup('threat-intel/docs/debugging/x.md'), '调试');
  assert.equal(docGroup('threat-intel/docs/api/x.md'), '接口');
  assert.equal(docGroup('threat-intel/docs/architecture/x.md'), '架构');
  assert.equal(docGroup('docs/superpowers/notes/2026-06-02-y.md'), '笔记');
  assert.equal(docGroup('docs\\superpowers\\specs\\2026-06-08-w-design.md'), '设计');   // win 反斜杠容错
  // 未知 → 其它
  assert.equal(docGroup('threat-intel/docs/DEPLOY.md'), '其它');
});

test('pairDocs: 同 date+slug 的 spec↔plan 配对；date 同 slug 异不配；孤页不标', () => {
  const mk = (sourcePath, id) => ({ sourcePath, id });
  const specs = [
    mk('docs/superpowers/specs/2026-06-08-lore-content-quality-design.md', 'superpowers-specs-2026-06-08-lore-content-quality-design'),
    mk('docs/superpowers/plans/2026-06-08-lore-content-quality.md', 'superpowers-plans-2026-06-08-lore-content-quality'),
    mk('docs/superpowers/specs/2026-06-07-lore-portal-design.md', 'superpowers-specs-2026-06-07-lore-portal-design'),
    mk('docs/superpowers/plans/2026-06-07-lore-roadmap-cleanup.md', 'superpowers-plans-2026-06-07-lore-roadmap-cleanup'),
    mk('docs/ROADMAP.md', 'ROADMAP'),
  ];
  pairDocs(specs);
  assert.equal(specs[0].pairedPlan, 'superpowers-plans-2026-06-08-lore-content-quality');   // 配上
  assert.equal(specs[2].pairedPlan, undefined);    // 孤 spec（同日 plan 是别的 slug）
  assert.equal(specs[3].pairedPlan, undefined);    // 孤 plan 不标
  assert.equal(specs[4].pairedPlan, undefined);    // 非 superpowers 不参与
});

test('buildDocsAxis: 物化页 frontmatter 含 group；配对 spec 含 paired_plan', () => {
  const root = tmp();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    mkdirSync(join(root, 'docs', 'superpowers', 'specs'), { recursive: true });
    mkdirSync(join(root, 'docs', 'superpowers', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'superpowers', 'specs', '2026-06-08-thing-design.md'), '# Thing 设计\n\nspec body\n');
    writeFileSync(join(root, 'docs', 'superpowers', 'plans', '2026-06-08-thing.md'), '# Thing Plan\n\nplan body\n');
    writeFileSync(join(root, 'docs', 'ROADMAP.md'), '# 路线图\n\nroadmap body\n');
    buildDocsAxis(lore, root, { sources: ['docs'], docsGlob: 'docs/**/*.md' });

    const spec = readFileSync(join(lore, 'wiki', 'docs', 'superpowers-specs-2026-06-08-thing-design.md'), 'utf8');
    assert.match(spec, /^group: 设计$/m);
    assert.match(spec, /^paired_plan: superpowers-plans-2026-06-08-thing$/m);

    const plan = readFileSync(join(lore, 'wiki', 'docs', 'superpowers-plans-2026-06-08-thing.md'), 'utf8');
    assert.match(plan, /^group: 计划$/m);
    assert.doesNotMatch(plan, /paired_plan/);            // plan 侧不标

    const rm = readFileSync(join(lore, 'wiki', 'docs', 'ROADMAP.md'), 'utf8');
    assert.match(rm, /^group: 项目状态$/m);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
