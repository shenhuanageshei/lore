// test/shell.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripFrontmatter, renderMarkdown } from '../site/shell.mjs';

test('stripFrontmatter removes the leading --- block', () => {
  const md = '---\ntitle: X\ncode_sha: a\n---\n# Heading\nbody';
  assert.equal(stripFrontmatter(md).trim().startsWith('# Heading'), true);
});

test('stripFrontmatter leaves body untouched when no front-matter', () => {
  assert.equal(stripFrontmatter('# Heading\nb').startsWith('# Heading'), true);
});

test('renderMarkdown handles headings, lists, code, inline code', () => {
  const html = renderMarkdown('# T\n\n- a\n- b\n\n`x`\n\n```\ncode\n```');
  assert.match(html, /<h1>T<\/h1>/);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(html, /<code>x<\/code>/);
  assert.match(html, /<pre><code>code/);
});

test('renderMarkdown renders tables and links', () => {
  const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |\n\n[t](u)');
  assert.match(html, /<table>/);
  assert.match(html, /<th>A<\/th>/);
  assert.match(html, /<a href="u">t<\/a>/);
});

test('renderMarkdown escapes html in code blocks', () => {
  const html = renderMarkdown('```\n<script>\n```');
  assert.match(html, /&lt;script&gt;/);
});

test('renderMarkdown handles tables without a trailing pipe', () => {
  const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2');
  assert.match(html, /<th>A<\/th><th>B<\/th>/);
  assert.match(html, /<td>1<\/td><td>2<\/td>/);   // last cell '2' must survive
});
