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

import {
  buildPageIndex, preprocessWikilinks, buildNavModel, matchesSearch, buildMeta,
} from '../site/shell.mjs';

const MANIFEST = {
  current_code_sha: 'abc1234',
  axes: [
    { id: 'component', label: 'Component', pages: [
      { id: 'm3_nlp', title: 'M3 NLP', summary: 'extraction', path: 'component/m3_nlp.md', stale: 3,
        code_sha: 'def5678', synthesized_from: { atoms: 8, commits: 5 } }] },
    { id: 'theme', label: 'Theme', pages: [
      { id: 'quality', title: 'Quality', summary: 'qa', path: 'theme/quality.md', stale: 0,
        code_sha: 'abc1234', synthesized_from: { atoms: 14, commits: 9 } }] },
  ],
};

test('buildPageIndex maps short id to axis/id', () => {
  const idx = buildPageIndex(MANIFEST);
  assert.equal(idx.m3_nlp, 'component/m3_nlp');
  assert.equal(idx.quality, 'theme/quality');
});

test('preprocessWikilinks rewrites [[id]] to hash anchors', () => {
  const idx = buildPageIndex(MANIFEST);
  const out = preprocessWikilinks('see [[m3_nlp]] now', idx);
  assert.match(out, /<a class="wikilink" href="#component\/m3_nlp">m3_nlp<\/a>/);
});

test('preprocessWikilinks falls back for unknown id', () => {
  const out = preprocessWikilinks('[[ghost]]', {});
  assert.match(out, /href="#component\/ghost"/);   // best-effort fallback
});

test('buildNavModel passes axes through with pages', () => {
  const nav = buildNavModel(MANIFEST);
  assert.equal(nav.length, 2);
  assert.equal(nav[0].id, 'component');
  assert.equal(nav[0].pages[0].id, 'm3_nlp');
});

test('matchesSearch matches title and summary case-insensitively', () => {
  const page = MANIFEST.axes[0].pages[0];
  assert.equal(matchesSearch(page, 'nlp'), true);
  assert.equal(matchesSearch(page, 'EXTRACT'), true);
  assert.equal(matchesSearch(page, 'zzz'), false);
  assert.equal(matchesSearch(page, ''), true);     // empty term shows all
});

test('buildMeta produces freshness chips (stale and fresh)', () => {
  const stale = buildMeta(MANIFEST.axes[0].pages[0]);
  assert.equal(stale.chips.some(c => c.kind === 'stale' && /3/.test(c.text)), true);
  const fresh = buildMeta(MANIFEST.axes[1].pages[0]);
  assert.equal(fresh.chips.some(c => c.kind === 'fresh'), true);
  assert.equal(fresh.chips.some(c => /14 atoms/.test(c.text)), true);
});

test('renderMarkdown renders ```mermaid as <div class="mermaid">, escaped not <pre>', () => {
  const html = renderMarkdown('```mermaid\nflowchart TD\nA-->B\n```');
  assert.match(html, /<div class="mermaid">/);
  assert.match(html, /A--&gt;B/);           // escaped; browser textContent decodes back to A-->B
  assert.doesNotMatch(html, /<pre>/);       // mermaid is NOT a code block
});

test('renderMarkdown still renders non-mermaid fences as <pre><code>', () => {
  const html = renderMarkdown('```js\nconst x = 1;\n```');
  assert.match(html, /<pre><code>const x = 1;/);
  assert.doesNotMatch(html, /class="mermaid"/);
});

test('renderMarkdown escapes < and & inside mermaid source', () => {
  const html = renderMarkdown('```mermaid\ngraph LR\nA["a<b & c"]-->B\n```');
  assert.match(html, /&lt;b &amp; c/);
  assert.match(html, /<div class="mermaid">/);
});

test('renderMarkdown bare ``` (no lang) stays a code block', () => {
  const html = renderMarkdown('```\nplain\n```');
  assert.match(html, /<pre><code>plain/);
  assert.doesNotMatch(html, /class="mermaid"/);
});

import { chooseInitialLanguage, resolveLocalizedPage } from '../site/shell.mjs';

test('chooseInitialLanguage prefers saved language when available', () => {
  const manifest = { language: { default: 'zh', available: ['zh', 'en'] }, user_preferences: { language: 'zh' } };
  assert.equal(chooseInitialLanguage(manifest, 'en'), 'en');
  assert.equal(chooseInitialLanguage(manifest, 'ja'), 'zh');
  assert.equal(chooseInitialLanguage(manifest, null), 'zh');
});

test('resolveLocalizedPage returns base page for default language', () => {
  const page = { path: 'component/lib.md', lang: 'zh', translations: [{ lang: 'en', path: 'component/lib.en.md', stale: false }] };
  assert.deepEqual(resolveLocalizedPage(page, 'zh'), {
    path: 'component/lib.md',
    lang: 'zh',
    missing: false,
    stale: false,
  });
});

test('resolveLocalizedPage returns ready translation for selected language', () => {
  const page = { path: 'component/lib.md', lang: 'zh', translations: [{ lang: 'en', path: 'component/lib.en.md', stale: false }] };
  assert.deepEqual(resolveLocalizedPage(page, 'en'), {
    path: 'component/lib.en.md',
    lang: 'en',
    missing: false,
    stale: false,
  });
});

test('resolveLocalizedPage falls back to base page when translation is missing or stale', () => {
  const missing = { path: 'component/lib.md', lang: 'zh', translations: [] };
  assert.deepEqual(resolveLocalizedPage(missing, 'en'), {
    path: 'component/lib.md',
    lang: 'en',
    missing: true,
    stale: false,
  });
  const stale = { path: 'component/lib.md', lang: 'zh', translations: [{ lang: 'en', path: 'component/lib.en.md', stale: true }] };
  assert.deepEqual(resolveLocalizedPage(stale, 'en'), {
    path: 'component/lib.md',
    lang: 'en',
    missing: false,
    stale: true,
  });
});
