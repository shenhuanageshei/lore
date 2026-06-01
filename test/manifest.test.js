// test/manifest.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../lib/manifest.js';

test('parseFrontmatter extracts flat keys and body', () => {
  const md = [
    '---',
    'title: M3 NLP',
    'summary: entity extraction',
    'last_updated: 2026-05-28',
    'code_sha: def5678',
    'atoms: 8',
    'commits: 5',
    'stale: 3',
    '---',
    '',
    '# M3 NLP',
    'body line',
  ].join('\n');
  const { data, body } = parseFrontmatter(md);
  assert.equal(data.title, 'M3 NLP');
  assert.equal(data.summary, 'entity extraction');
  assert.equal(data.code_sha, 'def5678');
  assert.equal(data.atoms, 8);          // numeric coercion
  assert.equal(data.commits, 5);
  assert.equal(data.stale, 3);
  assert.equal(body.trim().startsWith('# M3 NLP'), true);
});

test('parseFrontmatter returns empty data when no front-matter', () => {
  const { data, body } = parseFrontmatter('# Just a title\ntext');
  assert.deepEqual(data, {});
  assert.equal(body.startsWith('# Just a title'), true);
});

test('parseFrontmatter ignores malformed lines without throwing', () => {
  const md = '---\ntitle: ok\ngarbage-no-colon\n---\nbody';
  const { data } = parseFrontmatter(md);
  assert.equal(data.title, 'ok');
  assert.equal('garbage-no-colon' in data, false);
});
