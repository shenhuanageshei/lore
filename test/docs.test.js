import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { docsExtractor } from '../lib/docs.js';

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
