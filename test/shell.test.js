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

test('buildMeta: docs page → only last-updated chip (no atoms/code_sha)', () => {
  const chips = buildMeta({ axis: 'docs', last_updated: '2026-06-07', path: 'docs/x.md' }).chips;
  const text = chips.map(c => c.text).join(' | ');
  assert.match(text, /last-updated 2026-06-07/);
  assert.doesNotMatch(text, /atoms/);
  assert.doesNotMatch(text, /code_sha/);
});

test('buildMeta: component page keeps atoms + code_sha', () => {
  const chips = buildMeta({ axis: 'component', last_updated: '2026-06-07', code_sha: 'abc', synthesized_from: { atoms: 3, commits: 2 } }).chips;
  const text = chips.map(c => c.text).join(' | ');
  assert.match(text, /3 atoms · 2 commits/);
  assert.match(text, /code_sha abc/);
});

import { baseFromPathname } from '../site/shell.mjs';

test('baseFromPathname: per-repo serve (/site/...) → "/"', () => {
  assert.equal(baseFromPathname('/site/'), '/');
  assert.equal(baseFromPathname('/site/index.html'), '/');
});

test('baseFromPathname: portal (/<repo>/site/...) → "/<repo>/"', () => {
  assert.equal(baseFromPathname('/lore/site/'), '/lore/');
  assert.equal(baseFromPathname('/lore/site/index.html'), '/lore/');
  assert.equal(baseFromPathname('/ti/site/'), '/ti/');
});

test('baseFromPathname: 无 /site 段 → "/" 兜底', () => {
  assert.equal(baseFromPathname('/'), '/');
});

import { buildConsoleModel, pollDecide } from '../site/shell.mjs';

const mkManifest = pages => ({ axes: [{ id: 'component', label: 'Component', pages }] });

test('buildConsoleModel: 0 stale → fresh 绿灯', () => {
  const m = buildConsoleModel(mkManifest([{ id: 'lib', title: 'lib', stale: 0 }]), { mode: 'notify', last_finalize: 't0' });
  assert.equal(m.light, 'fresh');
  assert.equal(m.staleTotal, 0);
  assert.equal(m.mode, 'notify');
  assert.equal(m.lastFinalize, 't0');
});

test('buildConsoleModel: N stale → stale 黄灯 + 按 stale 降序 + 同分 key 字母序', () => {
  const m = buildConsoleModel(mkManifest([
    { id: 'a', title: 'A', stale: 1, last_updated: 'd1', path: 'component/a.md' },
    { id: 'b', title: 'B', stale: 5, last_updated: 'd2', path: 'component/b.md' },
    { id: 'c', title: 'C', stale: 0 },
    { id: 'z', title: 'Z', stale: 1, last_updated: 'd3', path: 'component/z.md' },
  ]), { mode: 'notify', last_finalize: null });
  assert.equal(m.light, 'stale');
  assert.equal(m.staleTotal, 3);
  assert.deepEqual(m.stalePages.map(p => p.key), ['component/b', 'component/a', 'component/z']);  // 同分 a<z
  // 整体形状钉死：path 是 T8/T9 排队按钮唯一依赖的字段，丢了 UI 会静默失效
  assert.deepEqual(m.stalePages[0],
    { key: 'component/b', title: 'B', stale: 5, last_updated: 'd2', path: 'component/b.md' });
});

test('buildConsoleModel: manual → off 灰灯但 stale 数照算（关自动 ≠ 藏信息）', () => {
  const m = buildConsoleModel(mkManifest([{ id: 'a', title: 'A', stale: 3 }]), { mode: 'manual', last_finalize: null });
  assert.equal(m.light, 'off');
  assert.equal(m.staleTotal, 1);
});

test('buildConsoleModel: status null（python server / portal 无 API）→ 默认 notify', () => {
  const m = buildConsoleModel(mkManifest([]), null);
  assert.equal(m.mode, 'notify');
  assert.equal(m.lastFinalize, null);
  assert.equal(m.light, 'fresh');
  assert.equal(m.staleTotal, 0);
});

test('pollDecide: generated 未变 → 全 false；变了 → 重建；当前页变了 → 提示条', () => {
  assert.deepEqual(pollDecide('t1', 't1', false), { changed: false, rebuildSidebar: false, showUpdateBar: false });
  assert.deepEqual(pollDecide('t1', null, false), { changed: false, rebuildSidebar: false, showUpdateBar: false });
  assert.deepEqual(pollDecide('t1', 't2', false), { changed: true, rebuildSidebar: true, showUpdateBar: false });
  assert.deepEqual(pollDecide('t1', 't2', true),  { changed: true, rebuildSidebar: true, showUpdateBar: true });
});
