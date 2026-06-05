import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { docsExtractor, changelogExtractor, pitfallsExtractor } from '../lib/docs.js';

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

test('renderDocsPage: plain doc spec → front-matter + summary + source link', () => {
  const md = renderDocsPage({ id: 'a', title: 'Doc A', summary: 'about A', sourcePath: 'docs/a.md', date: '2026-06-04' });
  assert.match(md, /^---\ntitle: Doc A\nsummary: about A\nsource_path: docs\/a\.md\nlast_updated: 2026-06-04\n---/);
  assert.match(md, /# docs: Doc A/);
  assert.match(md, /about A/);
  assert.match(md, /\[docs\/a\.md\]\(\.\.\/\.\.\/\.\.\/docs\/a\.md\)/);   // repo-relative source link
});

test('renderDocsPage: spec with entries (changelog) → bullet list', () => {
  const md = renderDocsPage({
    id: 'changelog', title: 'CHANGELOG', summary: '2 versions', sourcePath: 'CHANGELOG.md', date: '2026-06-04',
    entries: [{ version: '0.2.0', date: '2026-06-04' }, { version: '0.1.0', date: '2026-06-03' }],
  });
  assert.match(md, /- \*\*0\.2\.0\*\* — 2026-06-04/);
  assert.match(md, /- \*\*0\.1\.0\*\* — 2026-06-03/);
});

test('renderDocsPage: pitfalls entries → problem + 修复/预防 tail', () => {
  const md = renderDocsPage({
    id: 'pitfalls', title: 'Pitfalls', summary: '2 条', sourcePath: 'CLAUDE.md', date: '',
    entries: [{ problem: 'P1', fix: 'F1', prevention: 'V1' }, { problem: 'P2', fix: '', prevention: '' }],
  });
  assert.match(md, /- \*\*P1\*\* — 修复：F1；预防：V1/);
  assert.match(md, /- \*\*P2\*\*\n/);   // no tail when fix+prevention both empty
});
