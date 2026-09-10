// test/shell.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  buildPageIndex, preprocessWikilinks, buildNavModel, matchesSearch, buildMeta, buildThemeRows,
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

test('preprocessWikilinks: 带点的文件级页 id（如 server.js）也成链', () => {
  const out = preprocessWikilinks('见 [[server.js]] 门面', {});
  assert.match(out, /<a class="wikilink" href="#component\/server\.js">server\.js<\/a>/);
  assert.equal(preprocessWikilinks('[[a]]', {}).includes('href="#component/a"'), true);   // 单字符 id 仍可
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

test('buildMeta: stale chip 带排队 action 与 path（点击即排队，不再误导跑 sync）；fresh 无 action', () => {
  const m = buildMeta({ stale: 12, path: 'theme/ioc.md', last_updated: 'x', code_sha: 'y' });
  const stale = m.chips.find(c => c.kind === 'stale');
  assert.equal(stale.action, 'queue');
  assert.equal(stale.path, 'theme/ioc.md');
  assert.match(stale.text, /点击排队同步/);     // 机械徽标 = 排队同步（追代码），「重写」专给带指令按钮
  assert.doesNotMatch(stale.text, /lore:sync/);
  const f = buildMeta({ stale: 0, path: 'a.md' });
  assert.equal(f.chips.find(c => c.kind === 'fresh').action, undefined);
});

test('buildMeta: component/flow 缺架构图(hasDiagram=false)→ 可点击排队徽标；有图/非检测轴不报', () => {
  const miss = buildMeta({ axis: 'component', hasDiagram: false, path: 'component/art.md', stale: 0 });
  const chip = miss.chips.find(c => /缺架构图/.test(c.text));
  assert.ok(chip);
  assert.equal(chip.action, 'queue');
  assert.equal(chip.path, 'component/art.md');
  const has = buildMeta({ axis: 'component', hasDiagram: true, path: 'component/lib.md', stale: 0 });
  assert.ok(!has.chips.some(c => /缺架构图/.test(c.text)));        // 有图不报
  const docs = buildMeta({ axis: 'docs', path: 'docs/x.md', last_updated: 'x' });
  assert.ok(!docs.chips.some(c => /缺架构图/.test(c.text)));       // docs 不检测（无 hasDiagram 字段）
});

test('buildMeta: 深度页缺机制详解(hasMechanism=false)→ 可点击排队徽标；有档/鸟瞰页不报', () => {
  const miss = buildMeta({ axis: 'component', hasMechanism: false, hasDiagram: true, path: 'component/sync.md', stale: 0 });
  const chip = miss.chips.find(c => /缺机制详解/.test(c.text));
  assert.ok(chip);
  assert.equal(chip.action, 'queue');
  assert.equal(chip.path, 'component/sync.md');
  const has = buildMeta({ axis: 'component', hasMechanism: true, hasDiagram: true, path: 'component/runner.md', stale: 0 });
  assert.ok(!has.chips.some(c => /缺机制详解/.test(c.text)));       // 有机制档不报
  const birdseye = buildMeta({ axis: 'component', hasDiagram: true, path: 'component/lib.md', stale: 0 });
  assert.ok(!birdseye.chips.some(c => /缺机制详解/.test(c.text)));  // 鸟瞰页（无 hasMechanism 字段）不报
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

import { buildConsoleModel, pollDecide, budgetNotice } from '../site/shell.mjs';

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

test('buildConsoleModel: runner_running → busy 灯（优先于 stale/fresh，不盖 manual off）', () => {
  const m = buildConsoleModel(mkManifest([{ id: 'a', title: 'A', stale: 3 }]), { mode: 'auto', last_finalize: null, runner_running: true });
  assert.equal(m.light, 'busy');
  const off = buildConsoleModel(mkManifest([]), { mode: 'manual', last_finalize: null, runner_running: true });
  assert.equal(off.light, 'off');   // manual 优先（runner 不该在 manual 下跑，防御性显示）
});

// 预算闸读数（S6 的 /api/sync/status → budget）：状态行只报「超限」，其余一律静默。
test('budgetNotice: exceeded → 「预算超限（used/budget dimension）」；未超限/未配置/无 API → 空串（不塞噪音）', () => {
  assert.equal(budgetNotice({ budget: { configured: true, exceeded: true, used: 12, budget: 10, dimension: 'calls' } }),
    '预算超限（12/10 calls）');
  assert.equal(budgetNotice({ budget: { configured: true, exceeded: true, used: 0.5, budget: 1, dimension: 'ms' } }),
    '预算超限（0.5/1 ms）');
  assert.equal(budgetNotice({ budget: { configured: true, exceeded: true, used: 3, budget: 2 } }), '预算超限（3/2 calls）');  // 维度缺省
  assert.equal(budgetNotice({ budget: { configured: true, exceeded: true, used: 'x', budget: null, dimension: 'tokens' } }),
    '预算超限（?/? tokens）');                                                                            // 取不到的数不渲染成 0
  assert.equal(budgetNotice({ budget: { configured: true, exceeded: false, used: 1, budget: 10, dimension: 'calls' } }), '');
  assert.equal(budgetNotice({ budget: { configured: false, exceeded: false, used: 0, budget: null, dimension: 'calls' } }), '');
  assert.equal(budgetNotice({ budget: { configured: false, exceeded: true, used: 1, budget: 1, dimension: 'calls' } }), '');  // 未配置不报
  assert.equal(budgetNotice({}), '');
  assert.equal(budgetNotice(null), '');
  assert.equal(budgetNotice(), '');
});

test('pollDecide: generated 未变 → 全 false；变了 → 重建；当前页变了 → 提示条', () => {
  assert.deepEqual(pollDecide('t1', 't1', false), { changed: false, rebuildSidebar: false, showUpdateBar: false });
  assert.deepEqual(pollDecide('t1', null, false), { changed: false, rebuildSidebar: false, showUpdateBar: false });
  assert.deepEqual(pollDecide('t1', 't2', false), { changed: true, rebuildSidebar: true, showUpdateBar: false });
  assert.deepEqual(pollDecide('t1', 't2', true),  { changed: true, rebuildSidebar: true, showUpdateBar: true });
});

import { buildDocsRows } from '../site/shell.mjs';

test('buildDocsRows: 按序分段 + 配对行 + 被配对 plan 剔除 + 剥尾 + 折叠默认值', () => {
  const pages = [
    { id: 'changelog', title: 'CHANGELOG', group: '项目状态', paired_plan: '' },
    { id: 'spec-a', title: 'lore 同步控制台 B1（档位） —— 设计', group: '设计与计划', paired_plan: 'plan-a' },
    { id: 'plan-a', title: 'lore 同步控制台 B1（档位）Implementation Plan', group: '设计与计划', paired_plan: '' },
    { id: 'plan-orphan', title: '孤 plan Implementation Plan', group: '设计与计划', paired_plan: '' },
    { id: 'note-1', title: 'golden page', group: 'notes', paired_plan: '' },
  ];
  const groups = buildDocsRows(pages);
  assert.deepEqual(groups.map(g => g.group), ['项目状态', '设计与计划', 'notes']);
  assert.deepEqual(groups.map(g => g.collapsed), [false, true, true]);
  const dz = groups[1];
  assert.deepEqual(dz.rows.map(r => r.page.id), ['spec-a', 'plan-orphan']);   // plan-a 被剔除
  assert.equal(dz.rows[0].planPage.id, 'plan-a');                             // 配对解析
  assert.equal(dz.rows[0].displayTitle, 'lore 同步控制台 B1（档位）');           // 剥「—— 设计」
  assert.equal(dz.rows[1].displayTitle, '孤 plan');                           // 剥「Implementation Plan」
  assert.equal(dz.rows[1].planPage, null);
});

import { buildCrossRepoIndex } from '../site/shell.mjs';

test('buildCrossRepoIndex: 多 repo manifest 拍平成可搜索索引（搜索域含 title/summary/id）', () => {
  const mkM = pages => ({ axes: [{ id: 'component', pages }] });
  const idx = buildCrossRepoIndex([
    { repo: 'lore', manifest: mkM([{ id: 'sync', title: '合成总装线', summary: 'plan/finalize' }]) },
    { repo: 'ti', manifest: mkM([{ id: 'ioc', title: '情报抽取', summary: '' }]) },
  ]);
  assert.equal(idx.length, 2);
  assert.deepEqual(idx[0], { repo: 'lore', key: 'component/sync', title: '合成总装线', search: '合成总装线 plan/finalize sync' });
  assert.equal(idx[1].repo, 'ti');
  assert.match(idx[1].search, /ioc/);                       // id 进搜索域（英文 slug 可搜）
  assert.deepEqual(buildCrossRepoIndex([]), []);
  assert.deepEqual(buildCrossRepoIndex([{ repo: 'x', manifest: {} }]), []);   // 坏 manifest 容错
});

test('buildDocsRows: paired_plan 指向不存在的页 → 当孤页；缺 group → 项目状态', () => {
  const pages = [
    { id: 's1', title: 'X —— 设计', group: '设计与计划', paired_plan: 'ghost' },
    { id: 'p1', title: 'Y', paired_plan: '' },
  ];
  const groups = buildDocsRows(pages);
  assert.equal(groups[0].rows[0].planPage, null);          // ghost 找不到 → 孤页
  assert.equal(groups[1].group, '项目状态');                // 缺 group 兜底
  assert.equal(groups[1].collapsed, false);
});

test('buildThemeRows nests children under parents with group order', () => {
  const pages = [
    { id: 'p', title: 'P' },
    { id: 'p--c1', title: 'C1', parent: 'p', group: 'g1' },
    { id: 'p--c2', title: 'C2', parent: 'p', group: 'g1' },
    { id: 'p--c3', title: 'C3', parent: 'p', group: 'g2' },
    { id: 'other', title: 'O' },
  ];
  const rows = buildThemeRows(pages);
  assert.deepEqual(rows.map(r => r.page.id), ['p', 'other']);
  const p = rows.find(r => r.page.id === 'p');
  assert.deepEqual(p.groups.map(g => g.group), ['g1', 'g2']);
  assert.deepEqual(p.groups[0].rows.map(r => r.id), ['p--c1', 'p--c2']);
  assert.deepEqual(p.groups[1].rows.map(r => r.id), ['p--c3']);
});

test('buildThemeRows buckets an ungrouped child under an empty group name', () => {
  const rows = buildThemeRows([
    { id: 'p', title: 'P' },
    { id: 'p--c1', title: 'C1', parent: 'p' },          // 无 group
    { id: 'p--c2', title: 'C2', parent: 'p', group: 'g1' },
  ]);
  const p = rows.find(r => r.page.id === 'p');
  assert.deepEqual(p.groups.map(g => g.group), ['', 'g1']);   // 空组在前（无组子页），具名组在后
  assert.deepEqual(p.groups[0].rows.map(r => r.id), ['p--c1']);
});

// --- S7 壳打开传感器：打开/切换页 → POST /api/human/visit；失败静默、不阻塞阅读 ---
import {
  VISIT_ENDPOINT, buildVisitPathIndex, firstVisitKey, visitKey,
  createVisitSensor, installVisitSensor,
} from '../site/shell.mjs';

const VISIT_MANIFEST = {
  axes: [
    { id: 'HOME', label: 'Home', pages: [{ id: 'HOME', path: 'HOME.md' }] },
    { id: 'component', label: 'Component', pages: [
      { id: 'lib', path: 'component/lib.md' },
      { id: 'server.js', path: 'component/server.js.md' },
    ] },
  ],
};

function visitFetch({ manifest = VISIT_MANIFEST, manifestOk = true, apiOk = true, failManifest = false, failApi = false } = {}) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.endsWith('.manifest.json')) {
      if (failManifest) throw new Error('offline');
      return { ok: manifestOk, status: manifestOk ? 200 : 404, json: async () => (typeof manifest === 'function' ? manifest() : manifest) };
    }
    if (failApi) throw new Error('offline');
    return { ok: apiOk, status: apiOk ? 200 : 500, json: async () => ({ ok: apiOk }) };
  };
  const posts = () => calls.filter(c => c.url.endsWith(VISIT_ENDPOINT));
  return { calls, posts, fetchFn };
}

test('buildVisitPathIndex: 以 manifest 为真源（HOME/HOME → HOME.md 不满足 key+".md"）；坏 manifest 空表', () => {
  const idx = buildVisitPathIndex(VISIT_MANIFEST);
  assert.equal(idx['HOME/HOME'], 'HOME.md');
  assert.equal(idx['component/lib'], 'component/lib.md');
  assert.equal(idx['component/server.js'], 'component/server.js.md');   // 带点的文件级页
  assert.deepEqual(Object.keys(buildVisitPathIndex(null)), []);                  // 空表（null 原型，防键污染）
  assert.deepEqual(Object.keys(buildVisitPathIndex({ axes: [{ id: 'a' }] })), []);
});

test('visitKey: 裸键/带 # 的 hash 归一；空 hash → 落地页（与 firstPageKey 同口径）；console 不记', () => {
  assert.equal(firstVisitKey(VISIT_MANIFEST), 'HOME/HOME');
  assert.equal(visitKey('', VISIT_MANIFEST), 'HOME/HOME');
  assert.equal(visitKey('#', VISIT_MANIFEST), 'HOME/HOME');
  assert.equal(visitKey('#component/lib', VISIT_MANIFEST), 'component/lib');
  assert.equal(visitKey('component/lib', VISIT_MANIFEST), 'component/lib');
  assert.equal(visitKey('#console', VISIT_MANIFEST), '');            // 控制台不是 wiki 页
  assert.equal(firstVisitKey({ axes: [] }), '');
});

test('record: POST 一条 visit 到 BASE + api/human/visit（page = wiki 相对路径）', async () => {
  const { calls, posts, fetchFn } = visitFetch();
  const sensor = createVisitSensor({ fetchFn });
  assert.deepEqual(await sensor.record('#component/lib'), { sent: true, page: 'component/lib.md' });
  assert.equal(calls[0].url, '/wiki/.manifest.json');               // manifest 相对 BASE（per-repo "/"）
  assert.equal(calls[0].opts.cache, 'no-store');
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].url, '/api/human/visit');
  assert.equal(posts()[0].opts.method, 'POST');
  assert.equal(posts()[0].opts.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(posts()[0].opts.body), { page: 'component/lib.md' });
  // 只碰本机同源相对 URL：无协议、无外部主机
  assert.equal(calls.every(c => c.url.startsWith('/') && !/^[a-z]+:/i.test(c.url)), true);
});

test('record: portal 形态（BASE=/<repo>/）URL 带前缀；manifest 只取一次', async () => {
  const { calls, fetchFn } = visitFetch();
  const sensor = createVisitSensor({ base: '/lore/', fetchFn });
  await sensor.record('#component/lib');
  await sensor.record('#component/server.js');
  assert.equal(calls.filter(c => c.url.endsWith('.manifest.json')).length, 1);
  assert.deepEqual(calls.map(c => c.url), [
    '/lore/wiki/.manifest.json', '/lore/api/human/visit', '/lore/api/human/visit',
  ]);
});

test('record: 每次打开都发（壳侧无去重窗口）——同页短窗重复由服务端 lib/human.js 的 windowMs 权威判定', async () => {
  const { posts, fetchFn } = visitFetch();
  const sensor = createVisitSensor({ fetchFn });
  assert.equal((await sensor.record('#component/lib')).sent, true);
  assert.equal((await sensor.record('#component/lib')).sent, true);
  assert.equal(posts().length, 2);                                  // 不去重：权威判定只有服务端一处
  assert.deepEqual(JSON.parse(posts()[1].opts.body), { page: 'component/lib.md' });
});

test('record: console / 未知页键 / 空 manifest → 不记，且不抛', async () => {
  const { posts, fetchFn } = visitFetch();
  const sensor = createVisitSensor({ fetchFn });
  assert.deepEqual(await sensor.record('#console'), { sent: false, reason: 'not-a-page' });
  assert.deepEqual(await sensor.record('#component/ghost'), { sent: false, reason: 'unknown-page' });
  assert.equal(posts().length, 0);
  const empty = visitFetch({ manifest: { axes: [] } });
  assert.deepEqual(await createVisitSensor({ fetchFn: empty.fetchFn }).record(''), { sent: false, reason: 'not-a-page' });
  assert.equal(empty.posts().length, 0);
});

test('record: API 不可用（fetch 抛错 / 非 2xx）→ 静默降级，不抛、不重试风暴', async () => {
  const down = visitFetch({ failApi: true });
  assert.deepEqual(await createVisitSensor({ fetchFn: down.fetchFn }).record('#component/lib'),
    { sent: false, reason: 'api-unavailable', page: 'component/lib.md' });
  assert.equal(down.posts().length, 1);
  const bad = visitFetch({ apiOk: false });
  assert.equal((await createVisitSensor({ fetchFn: bad.fetchFn }).record('#component/lib')).sent, false);
});

test('record: 壳常驻期间新出现的页 → 缓存失效重取 manifest 后仍记上（不静默丢一次阅读）', async () => {
  let m = VISIT_MANIFEST;
  const { posts, fetchFn } = visitFetch({ manifest: () => m });
  const sensor = createVisitSensor({ fetchFn });
  assert.deepEqual(await sensor.record('#component/newpage'), { sent: false, reason: 'unknown-page' });
  assert.equal(posts().length, 0);
  m = { axes: [{ id: 'component', pages: [{ id: 'newpage', path: 'component/newpage.md' }] }] };
  assert.deepEqual(await sensor.record('#component/newpage'), { sent: true, page: 'component/newpage.md' });
  assert.equal(posts().length, 1);
});

test('record: manifest 取不到（无 .lore / 静态服务）→ no-manifest，零 POST、不抛', async () => {
  const offline = visitFetch({ failManifest: true });
  assert.deepEqual(await createVisitSensor({ fetchFn: offline.fetchFn }).record('#component/lib'),
    { sent: false, reason: 'no-manifest' });
  assert.equal(offline.posts().length, 0);
  const missing = visitFetch({ manifestOk: false });
  assert.deepEqual(await createVisitSensor({ fetchFn: missing.fetchFn }).record('#component/lib'),
    { sent: false, reason: 'no-manifest' });
  assert.equal(missing.posts().length, 0);
});

test('installVisitSensor: 浏览器自装配——落地页立即记一次 + 每次 hash 切换记一次；失败不抛', async () => {
  const { posts, fetchFn } = visitFetch();
  const listeners = {};
  const win = { location: { hash: '#component/lib' }, addEventListener: (ev, fn) => { (listeners[ev] ??= []).push(fn); } };
  const sensor = installVisitSensor({ win, fetchFn });
  assert.ok(sensor);
  await new Promise(r => setTimeout(r, 5));                         // fire-and-forget：等一拍让请求落地
  assert.equal(posts().length, 1);                                  // 打开当前页即记
  win.location.hash = '#component/server.js';
  for (const fn of listeners.hashchange) fn();                      // 切换页 → 再记
  await new Promise(r => setTimeout(r, 5));
  assert.equal(posts().length, 2);
  assert.deepEqual(JSON.parse(posts()[1].opts.body), { page: 'component/server.js.md' });
  // API 全挂 → 装配仍成功、渲染不受影响（无未捕获异常）
  const down = visitFetch({ failApi: true, failManifest: true });
  const win2 = { location: { hash: '#component/lib' }, addEventListener: () => {} };
  assert.ok(installVisitSensor({ win: win2, fetchFn: down.fetchFn }));
  await new Promise(r => setTimeout(r, 5));
});


test('installVisitSensor: 自装配推导 base —— portal /lore/site/index.html → /lore/wiki/… 与 /lore/api/human/visit', async () => {
  // 审计 D5：自装配写死 base='/' 时，portal 形态请求打到 /wiki/… → 恒 no-manifest、零 visit、零告警
  const portal = visitFetch();
  const win = { location: { hash: '#component/lib', pathname: '/lore/site/index.html' }, addEventListener: () => {} };
  assert.ok(installVisitSensor({ win, fetchFn: portal.fetchFn }));
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(portal.calls.map(c => c.url), ['/lore/wiki/.manifest.json', '/lore/api/human/visit']);
  assert.equal(portal.posts().length, 1);

  // per-repo 形态（/site/index.html）→ 前缀 "/"，与既有行为一致
  const repo = visitFetch();
  const winRepo = { location: { hash: '#component/lib', pathname: '/site/index.html' }, addEventListener: () => {} };
  installVisitSensor({ win: winRepo, fetchFn: repo.fetchFn });
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(repo.calls.map(c => c.url), ['/wiki/.manifest.json', '/api/human/visit']);

  // 显式传 base 仍优先（既有语义不变）
  const explicit = visitFetch();
  const winExplicit = { location: { hash: '#component/lib', pathname: '/lore/site/index.html' }, addEventListener: () => {} };
  installVisitSensor({ win: winExplicit, base: '/ti/', fetchFn: explicit.fetchFn });
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(explicit.calls.map(c => c.url), ['/ti/wiki/.manifest.json', '/ti/api/human/visit']);

  // 无 pathname（旧窗口形状）→ 兜底 "/"，不抛
  const legacy = visitFetch();
  const winLegacy = { location: { hash: '#component/lib' }, addEventListener: () => {} };
  installVisitSensor({ win: winLegacy, fetchFn: legacy.fetchFn });
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(legacy.calls.map(c => c.url), ['/wiki/.manifest.json', '/api/human/visit']);
});

test('installVisitSensor: Node / 无 location / 无 addEventListener → 不装配（返回 null，零副作用）', () => {
  assert.equal(installVisitSensor(), null);                          // 测试进程里 globalThis 没有 location
  assert.equal(installVisitSensor({ win: {} }), null);
  assert.equal(installVisitSensor({ win: { location: { hash: '#x' } } }), null);
});

// --- 壳阶段 B：底部状态行读数（设计 §5.3 / §5.5）---
// 纯函数（无 DOM）：site/index.html 只负责把下面这些字段填进 #statusline 并接上「队列 → 同步面板」的动作。
import { buildStatusLine, STATUS_UNKNOWN } from '../site/shell.mjs';

const STATUS_MANIFEST = {
  axes: [
    { id: 'component', label: 'Component', pages: [
      { id: 'a', title: 'A', stale: 2, path: 'component/a.md' },
      { id: 'b', title: 'B', stale: 0 },
    ] },
    { id: 'docs', label: 'Docs', pages: [{ id: 'c', title: 'C' }] },
  ],
};
const AT_1402 = new Date(2026, 8, 10, 14, 2);        // 本地时间 14:02（getHours 不受时区影响）
const okFuel = { capture_state: 'ok', capture_pct: 38, window_commits: 50, days_since_capture: 0, last_hook_ts: '2026-09-10T06:02:00Z' };
const unknownFuel = { capture_state: 'unknown', capture_pct: 'unknown', window_commits: 'unknown', days_since_capture: 'unknown', last_hook_ts: 'unknown' };
const noneFuel = { capture_state: 'none', capture_pct: 'unknown', window_commits: 'unknown', days_since_capture: 'unknown', last_hook_ts: 'unknown' };

test('buildStatusLine: ok 态 → §5.3 规范一行（CAPTURE OK · 捕获率 · 断流 · 页 · 队列 · 时刻）', () => {
  const line = buildStatusLine({ status: { fuel: okFuel }, manifest: STATUS_MANIFEST, queued: 2, now: AT_1402 });
  assert.equal(line.text, 'CAPTURE OK · 决策捕获率 38% · 断流 0 天 · 3 页 · 队列 1 · 14:02');
  assert.equal(line.capture_state, 'ok');
  assert.equal(line.capture_text, 'CAPTURE OK');
  assert.equal(line.capture_class, 'live');                       // 绿点（复用已落地 CSS）
  assert.equal(line.pages_text, '3 页');                          // 页数来自 manifest 全轴页数和
  assert.equal(line.queue_text, '队列 1');                        // 队列 = 既有 buildConsoleModel().stalePages
  assert.equal(line.queue_count, 1);
  assert.equal(line.stamp_text, '14:02');
  assert.equal(line.budget_text, '');                             // 未超限/未配置 → 不塞噪音
});

test('buildStatusLine: ok 态但真值为 0 → 如实渲染 0（别把「测出来是零」修成 unknown）', () => {
  const line = buildStatusLine({
    status: { fuel: { ...okFuel, capture_pct: 0, days_since_capture: 0 } },
    manifest: STATUS_MANIFEST, now: AT_1402,
  });
  assert.equal(line.rate_text, '决策捕获率 0%');
  assert.equal(line.gap_text, '断流 0 天');
});

test('buildStatusLine: none 态 → 「CAPTURE 未捕获」（危险形态），与 unknown 严格不同词', () => {
  const none = buildStatusLine({ status: { fuel: noneFuel }, manifest: STATUS_MANIFEST, now: AT_1402 });
  const unknown = buildStatusLine({ status: { fuel: unknownFuel }, manifest: STATUS_MANIFEST, now: AT_1402 });
  assert.equal(none.capture_text, 'CAPTURE 未捕获');
  assert.equal(none.capture_class, 'cap-none');
  assert.equal(none.capture_text.includes(STATUS_UNKNOWN), false);      // 未捕获 ≠ 测不出
  assert.notEqual(none.capture_text, unknown.capture_text);
  assert.match(none.text, /^CAPTURE 未捕获 · /);
});

test('buildStatusLine: unknown 态 → 渲染 unknown，绝不渲染成 0', () => {
  const line = buildStatusLine({ status: { fuel: unknownFuel }, manifest: STATUS_MANIFEST, now: AT_1402 });
  assert.equal(line.capture_text, 'CAPTURE unknown');
  assert.equal(line.capture_class, 'cap-unknown');
  assert.equal(line.rate_text, '决策捕获率 unknown');
  assert.equal(line.gap_text, '断流 unknown');
  assert.equal(line.text, 'CAPTURE unknown · 决策捕获率 unknown · 断流 unknown · 3 页 · 队列 1 · 14:02');
  assert.equal(/\b0%|断流 0/.test(line.text), false);              // 测不出的数不许变成 0（D13）
  // 值缺失 / 非数字垃圾（NaN、字符串数字）同样走 unknown 分支，不猜
  for (const bad of [{}, { capture_pct: NaN, days_since_capture: '0' }, { capture_pct: null, days_since_capture: Infinity }]) {
    const l = buildStatusLine({ status: { fuel: { ...unknownFuel, ...bad, capture_state: 'ok' } }, manifest: STATUS_MANIFEST, now: AT_1402 });
    assert.equal(l.rate_text, '决策捕获率 unknown', JSON.stringify(bad));
    assert.equal(l.gap_text, '断流 unknown', JSON.stringify(bad));
  }
});

test('buildStatusLine: API 不可用（SYNC_STATUS 为 null）→ 降级为静态读数，不报错、不空白', () => {
  const line = buildStatusLine({ status: null, manifest: STATUS_MANIFEST, queued: 0, now: AT_1402 });
  assert.equal(line.capture_state, 'unknown');
  assert.equal(line.text, 'CAPTURE unknown · 决策捕获率 unknown · 断流 unknown · 3 页 · 队列 1 · 14:02');
  assert.equal(line.pages_text, '3 页');                            // 页数/队列来自 manifest，静态服务也读得到
  assert.equal(line.queue_count, 1);                                // 「队列」仍可点开同步面板（只读态）
  assert.equal(line.budget_text, '');                               // 无 API → 无预算读数，不报错
  assert.equal(buildStatusLine({ now: AT_1402 }).text, 'CAPTURE unknown · 决策捕获率 unknown · 断流 unknown · unknown 页 · 队列 unknown · 14:02');
  assert.equal(buildStatusLine({ now: AT_1402 }).queue_count, null);   // 无 manifest → 不可点，绝不用 0 冒充
});

test('buildStatusLine: 预算超限复用既有 budgetNotice()（独立读数，不改文案）', () => {
  const status = {
    fuel: okFuel,
    budget: { configured: true, exceeded: true, used: 12, budget: 10, dimension: 'calls' },
  };
  const line = buildStatusLine({ status, manifest: STATUS_MANIFEST, now: AT_1402 });
  assert.equal(line.budget_text, budgetNotice(status));
  assert.equal(line.budget_text, '预算超限（12/10 calls）');
  assert.equal(line.text.includes('预算超限'), false);               // 读数是独立 span（超限才出现），不进规范一行
});

// --- 壳阶段 C 视觉①：源码锚点 = 引出线注记（设计 §5.4 / D7 / D15）---
// 纯函数（无 DOM）：renderAnchors(html) → { html, notes:[{n, anchor, line}] }；点角标的交互在 site/index.html。
// line 是 D15 的判据：行级锚点 = 行号；文件级锚点 = null（渲染时绝不硬凑行号，改标注「源未给行号」）。
import { renderAnchors, renderNoteHtml, ANCHOR_NO_LINE } from '../site/shell.mjs';

test('renderAnchors: 多个锚点 → 按正文出现顺序编号 1..N，角标落在锚点后，notes 与之一一对应', () => {
  const html = '<p>入口 <code>runAuto @ lib/runner.js:77</code>，再看 <code>planSync @ lib/sync.js:21</code>。</p>';
  const { html: out, notes } = renderAnchors(html);
  assert.deepEqual(notes, [
    { n: 1, anchor: 'runAuto @ lib/runner.js:77', line: 77 },
    { n: 2, anchor: 'planSync @ lib/sync.js:21', line: 21 },
  ]);
  assert.match(out, /runAuto @ lib\/runner\.js:77<sup class="anchor-ref" data-anchor-n="1"/);
  assert.match(out, /planSync @ lib\/sync\.js:21<sup class="anchor-ref" data-anchor-n="2"/);
  assert.match(out, /\[1\]<\/sup>/);
  assert.match(out, /\[2\]<\/sup>/);
});

test('renderAnchors: 同一锚点重复出现 → 复用同一编号（不一号多义、不一义多号）', () => {
  const html = '<p>a <code>renderDecisionHistory @ lib/sync.js:162</code> b <code>foldJournal @ lib/sync.js:185</code> '
    + 'c <code>renderDecisionHistory @ lib/sync.js:162</code></p>';
  const { html: out, notes } = renderAnchors(html);
  assert.equal(notes.length, 2);                                   // 唯一锚点只有两个
  assert.deepEqual(notes.map(n => n.n), [1, 2]);
  assert.equal((out.match(/data-anchor-n="1"/g) || []).length, 2); // 重复出现处都插角标，且同号
  assert.equal((out.match(/data-anchor-n="2"/g) || []).length, 1);
  assert.equal((out.match(/\[1\]<\/sup>/g) || []).length, 2);
});

test('renderAnchors: 零锚点 → notes 空数组且 html 原样返回（不插角标、不产生空注记栏）', () => {
  const html = '<h1>标题</h1><p>没有锚点的一段话 <code>foo()</code>。</p>';
  const r = renderAnchors(html);
  assert.deepEqual(r.notes, []);
  assert.equal(r.html, html);                                      // 严格同一串（不是"看起来一样"）
  assert.equal(renderAnchors('').html, '');
  assert.deepEqual(renderAnchors('').notes, []);
});

test('renderAnchors: 确定性——同一输入两次调用结果逐字段相同（不读挂钟、不依赖 Map 迭代顺序）', () => {
  const html = '<p><code>b @ z/z.js:2</code><code>a @ a/a.js:1</code><code>b @ z/z.js:2</code></p>';
  const one = renderAnchors(html), two = renderAnchors(html);
  assert.deepEqual(one, two);
  assert.equal(one.html, two.html);
  assert.deepEqual(one.notes.map(n => n.anchor), ['b @ z/z.js:2', 'a @ a/a.js:1']);   // 号序 = 正文顺序
});

test('renderAnchors: D7 —— 锚点按生成时刻的 file:line 原样渲染，不重解析、不改写行号', () => {
  const { html: out, notes } = renderAnchors('<p><code>route() @ site/index.html:413</code></p>');
  assert.equal(notes[0].anchor, 'route() @ site/index.html:413');  // 逐字原样（含圆括号形态）
  assert.match(out, /site\/index\.html:413/);                      // 正文里仍是同一个行号
  assert.equal(/stale|重解析|已更新/.test(out), false);
  // 前导斜杠的路径形态（wiki 表里真实存在：`/api/sync/finalize @ server.js:190`）
  assert.deepEqual(renderAnchors('<td><code>/api/sync/finalize @ server.js:190</code></td>').notes,
    [{ n: 1, anchor: '/api/sync/finalize @ server.js:190', line: 190 }]);
});

test('renderAnchors: 不碰标签属性、<pre> 代码块与 mermaid 图源（插进去会污染样本 / 画坏图）', () => {
  const attr = renderAnchors('<p title="runAuto @ lib/runner.js:77">正文无锚点</p>');
  assert.deepEqual(attr.notes, []);
  assert.equal(attr.html, '<p title="runAuto @ lib/runner.js:77">正文无锚点</p>');
  const pre = renderAnchors('<pre><code>runAuto @ lib/runner.js:77\n</code></pre>');
  assert.deepEqual(pre.notes, []);
  assert.equal(/anchor-ref/.test(pre.html), false);
  const mer = renderAnchors('<div class="mermaid">A[runAuto @ lib/runner.js:77] --&gt; B</div>');
  assert.deepEqual(mer.notes, []);
  assert.equal(/anchor-ref/.test(mer.html), false);
  // <pre> 之外仍照常编号（跳过是局部的，不是把整页静音）
  const mixed = renderAnchors('<pre><code>x @ a/a.js:1\n</code></pre><p><code>y @ b/b.js:2</code></p>');
  assert.deepEqual(mixed.notes, [{ n: 1, anchor: 'y @ b/b.js:2', line: 2 }]);
});

// --- 壳阶段 D15：锚点两形态都收，但必须区别渲染（计划 §2 D15 / 验收 ①②③）---
test('D15: 文件级锚点 `fn @ file` 被识别，但 line 为 null —— 源没给行号就不许有行号', () => {
  const { html: out, notes } = renderAnchors('<p>入口 <code>finalizeSync @ lib/sync.js</code>。</p>');
  assert.deepEqual(notes, [{ n: 1, anchor: 'finalizeSync @ lib/sync.js', line: null }]);
  assert.equal(notes[0].line, null);
  assert.match(out, /finalizeSync @ lib\/sync\.js<sup class="anchor-ref" data-anchor-n="1"/);
  // 正文里不得凭空长出 `:数字`（硬凑行号 = 违反不变量⑧）
  assert.equal(/lib\/sync\.js:\d/.test(out), false);
});

test('D15: 区别渲染 —— 行级锚点无标注，文件级锚点显式标注「源未给行号」', () => {
  const withLine = renderNoteHtml({ n: 1, anchor: 'runAuto @ lib/runner.js:77', line: 77 });
  const noLine = renderNoteHtml({ n: 2, anchor: 'finalizeSync @ lib/sync.js', line: null });
  assert.match(withLine, /runAuto @ lib\/runner\.js:77/);            // 行号原样（D7）
  assert.equal(withLine.includes(ANCHOR_NO_LINE), false);            // 行级锚点不挂「源未给行号」
  assert.match(noLine, /finalizeSync @ lib\/sync\.js/);              // 文件级：显示到文件为止
  assert.match(noLine, /源未给行号/);                                 // 且必须显式标注
  assert.equal(/lib\/sync\.js:\d/.test(noLine), false);              // 且绝不含行号
  assert.equal(noLine.includes('class="note-src"'), true);           // 标注是独立元素，不是混进 anchor 文本
  // anchor 逐字原样 + HTML 转义（不能被正文里的 < > 撕开）
  assert.match(renderNoteHtml({ n: 3, anchor: 'a<b @ c/d.js', line: null }), /a&lt;b @ c\/d\.js/);
});

test('D15: 换行碎片不得被识别 —— 扩展名 <2 字符一律不算锚点（反例 `finalizeSync @ lib/sync.j`）', () => {
  // 实测反例：markdown 硬换行把 `lib/sync.js` 截成 `lib/sync.j`，旧正则（扩展名 ≥1）会把它渲染成
  // 一条看起来确定的注记——比不渲染更坏。
  const frag = renderAnchors('<p>见 <code>finalizeSync @ lib/sync.j</code></p>');
  assert.deepEqual(frag.notes, []);
  assert.equal(frag.html, '<p>见 <code>finalizeSync @ lib/sync.j</code></p>');   // 原样返回（空态 nop）
  // 行级形态同样受这条约束（两形态共用同一文件名合法性判定，不可能只堵一边）
  assert.deepEqual(renderAnchors('<p><code>f @ lib/sync.j:12</code></p>').notes, []);
  assert.deepEqual(renderAnchors('<p><code>a @ b.c</code></p>').notes, []);
  // 单字符扩展名的"行级"锚点同样不认（`:12` 不能把不合法的文件名救回来）
  assert.deepEqual(renderAnchors('<p><code>a @ b.c:12</code></p>').notes, []);
  assert.equal(/anchor-ref/.test(renderAnchors('<p><code>a @ b.c:12</code></p>').html), false);
  // 边界：≥2 字符的合法扩展名照常认（.ts 文件级 / .mjs 行级）
  assert.deepEqual(renderAnchors('<p><code>a @ b/c.ts</code></p>').notes.map(n => n.line), [null]);
  assert.deepEqual(renderAnchors('<p><code>a @ b/c.mjs:3</code></p>').notes.map(n => n.line), [3]);
});

test('D15: 两形态混用 → 统一在一个编号空间递增（不重复、不跳号），同锚点仍复用同号', () => {
  const html = '<p><code>runAuto @ lib/runner.js:77</code> <code>finalizeSync @ lib/sync.js</code> '
    + '<code>runAuto @ lib/runner.js:77</code> <code>renderAnchors @ site/shell.mjs</code></p>';
  const { html: out, notes } = renderAnchors(html);
  assert.deepEqual(notes, [
    { n: 1, anchor: 'runAuto @ lib/runner.js:77', line: 77 },
    { n: 2, anchor: 'finalizeSync @ lib/sync.js', line: null },
    { n: 3, anchor: 'renderAnchors @ site/shell.mjs', line: null },
  ]);
  assert.deepEqual(notes.map(n => n.n), [1, 2, 3]);                  // 统一递增，两形态不各占一套号
  assert.equal((out.match(/data-anchor-n="1"/g) || []).length, 2);   // 重复的行级锚点复用 1 号
  assert.equal((out.match(/data-anchor-n="2"/g) || []).length, 1);
  assert.equal((out.match(/data-anchor-n="3"/g) || []).length, 1);
  // 同一文件级锚点重复出现 → 同样复用编号（编号规则与形态无关）
  const dup = renderAnchors('<p><code>a @ b/c.js</code><code>a @ b/c.js</code></p>');
  assert.equal(dup.notes.length, 1);
  assert.equal((dup.html.match(/data-anchor-n="1"/g) || []).length, 2);
});

// --- 壳阶段 C 视觉②：决策史 = 修改记录表（设计 §5.4 / D6；生成侧 = lib/sync.js renderDecisionHistory）---
import { parseDecisionLog, renderDecisionTable, DECISION_EMPTY } from '../site/shell.mjs';
import { renderDecisionHistory } from '../lib/sync.js';

const DH_LINE = '- **fix crawler** — anti data blowup (abc1234, 2026-06-01)';

test('parseDecisionLog: 正常行 → {version: 短 sha, date, change} 三列', () => {
  assert.deepEqual(parseDecisionLog(DH_LINE), [
    { version: 'abc1234', date: '2026-06-01', change: '**fix crawler** — anti data blowup', atom_id: null },
  ]);
});

test('parseDecisionLog: 无 why 的行（`- **title** (sha, date)`）→ change 只有标题', () => {
  assert.deepEqual(parseDecisionLog('- **add site** (def4567, 2026-05-30)'), [
    { version: 'def4567', date: '2026-05-30', change: '**add site**', atom_id: null },
  ]);
});

test('parseDecisionLog: 无 sha 的原子 → 版本列用 atom id 兜底（D6），且 atom_id 可取', () => {
  const md = renderDecisionHistory([
    { id: 'decision:2026-06-03-use-zset', ts: '2026-06-03T08:00:00Z', kind: 'decision', commit: null,
      title: 'use ZSET', why: 'range queries' },
  ]);
  assert.match(md, /\(2026-06-03\)/);                                   // 仍是无 sha 形态
  assert.match(md, /title="decision:2026-06-03-use-zset"/);             // 载体在 md 里就有
  assert.deepEqual(parseDecisionLog(md), [{
    version: 'decision:2026-06-03-use-zset',                            // 版本列 = atom id（不是日期）
    date: '2026-06-03',
    change: '**use ZSET** — range queries',
    atom_id: 'decision:2026-06-03-use-zset',
  }]);
});

test('parseDecisionLog: D6 的撞车场景——同一天 13 条无 sha 原子，版本列两两不同', () => {
  const atoms = Array.from({ length: 13 }, (_, i) => ({
    id: `decision:2026-06-03-item-${i}`, ts: '2026-06-03T08:00:00Z', kind: 'decision', commit: null,
    title: `决定 ${i}`, why: 'why',
  }));
  const rows = parseDecisionLog(renderDecisionHistory(atoms));
  assert.equal(rows.length, 13);
  assert.equal(new Set(rows.map(r => r.version)).size, 13);             // 只靠日期会全撞成一列
  assert.equal(rows.every(r => r.version.startsWith('decision:')), true);
});

test('parseDecisionLog: 解析失败 → 降级（整行进 change 列、日期列 —），绝不丢行', () => {
  const md = [
    DH_LINE,
    '- **no meta at all** — why without parenthetical',
    '- **weird meta** — why (deadbeef, 不是日期)',
    '- 裸行（连标题都没有）',
  ].join('\n');
  const rows = parseDecisionLog(md);
  assert.equal(rows.length, 4);                                          // 四行进四行出
  assert.deepEqual(rows[0], { version: 'abc1234', date: '2026-06-01', change: '**fix crawler** — anti data blowup', atom_id: null });
  assert.deepEqual(rows[1], { version: '—', date: '—', change: '**no meta at all** — why without parenthetical', atom_id: null });
  assert.deepEqual(rows[2], { version: '—', date: '—', change: '**weird meta** — why (deadbeef, 不是日期)', atom_id: null });
  assert.deepEqual(rows[3], { version: '—', date: '—', change: '裸行（连标题都没有）', atom_id: null });
});

test('parseDecisionLog: 空态提示 → 空数组（不是一条"行"）；哨兵注释/空行/标题都不算条目', () => {
  assert.deepEqual(parseDecisionLog(DECISION_EMPTY), []);
  assert.deepEqual(parseDecisionLog(`\n${DECISION_EMPTY}\n`), []);
  assert.deepEqual(parseDecisionLog('<!-- LORE_JOURNAL:START -->\n' + DECISION_EMPTY + '\n<!-- LORE_JOURNAL:END -->'), []);
  assert.deepEqual(parseDecisionLog('## Decision history\n\n'), []);
  assert.deepEqual(parseDecisionLog(''), []);
  assert.deepEqual(parseDecisionLog(null), []);
});

test('parseDecisionLog: 旧物化内容（无 atom id 载体、只有日期）→ 版本列退化为日期，不丢行', () => {
  assert.deepEqual(parseDecisionLog('- **use ZSET** — range queries (2026-06-03)'), [
    { version: '2026-06-03', date: '2026-06-03', change: '**use ZSET** — range queries', atom_id: null },
  ]);
});

test('renderDecisionTable: 决策史列表 → 三列表格 md（版本/日期/变更与原因），其余字节原样', () => {
  const page = [
    '---', 'title: P', '---', '# P', '', '正文一段。', '',
    '## Decision history', '', '<!-- LORE_JOURNAL:START -->',
    DH_LINE,
    '- **add site** (def4567, 2026-05-30)',
    '<!-- LORE_JOURNAL:END -->', '', '## 下一节', '尾巴。',
  ].join('\n');
  const out = renderDecisionTable(page);
  assert.match(out, /\| 版本 \| 日期 \| 变更与原因 \|/);
  assert.match(out, /\| abc1234 \| 2026-06-01 \| \*\*fix crawler\*\* — anti data blowup \|/);
  assert.match(out, /\| def4567 \| 2026-05-30 \| \*\*add site\*\* \|/);
  assert.equal(/- \*\*fix crawler\*\*/.test(out), false);                // 列表行已被表格取代
  assert.match(out, /正文一段。/);                                       // 别的字节没动
  assert.match(out, /## 下一节\n尾巴。/);
  // 表格 md 交给既有 renderMarkdown，就是真三列表格（表头文案 = §5.4 的三列名）
  const html = renderMarkdown(out);
  assert.match(html, /<th>版本<\/th><th>日期<\/th><th>变更与原因<\/th>/);
  assert.match(html, /<b>fix crawler<\/b>/);                            // change 列仍走 inline()
});

test('renderDecisionTable: atom id 必须能在渲染结果里取到（title 属性，供对照 lore confirm <atom-id>）', () => {
  const page = '## Decision history\n\n<!-- LORE_JOURNAL:START -->\n'
    + renderDecisionHistory([{ id: 'decision:2026-06-03-use-zset', ts: '2026-06-03T08:00:00Z', kind: 'decision', commit: null, title: 'use ZSET', why: 'range queries' }])
    + '\n<!-- LORE_JOURNAL:END -->\n';
  const out = renderDecisionTable(page);
  assert.match(out, /title="decision:2026-06-03-use-zset"/);            // D6 的交叉引用没被丢掉
  assert.match(out, /\| <span class="dh-ver" title="decision:2026-06-03-use-zset">decision:2026-06-03-use-zset<\/span> \| 2026-06-03 \|/);
  assert.match(renderMarkdown(out), /<span class="dh-ver" title="decision:2026-06-03-use-zset">/);
});

test('renderDecisionTable: 无决策史小节 / 空态 → 原样返回（不得渲染出空表头）', () => {
  const noSection = '# P\n\n只有正文，没有决策史。\n';
  assert.equal(renderDecisionTable(noSection), noSection);
  const empty = `## Decision history\n\n<!-- LORE_JOURNAL:START -->\n${DECISION_EMPTY}\n<!-- LORE_JOURNAL:END -->\n`;
  assert.equal(renderDecisionTable(empty), empty);                      // 空态：空数组 → 一个字都不改
  assert.equal(/版本/.test(renderDecisionTable(empty)), false);
  // 围栏代码块里的 `## Decision history` 不是小节（页面正文常引用这个标题）
  const fenced = '```md\n## Decision history\n- **x** — y (abc1234, 2026-06-01)\n```\n';
  assert.equal(renderDecisionTable(fenced), fenced);
  // 手写自管小节（标题 + 散文，无列表）→ 不碰
  const prose = '## Decision history\n\n这里是人写的说明。\n';
  assert.equal(renderDecisionTable(prose), prose);
});

// 代码评审 🔵#3：原先 `slice(first, last+1)` 把两列表项之间的整段散文也喂给 parseDecisionLog，
// 散文被当成「解析失败的降级行」进表格（version/date 均为 —）——不丢数据，但版式误导。
// 修法：只取连续列表段（从 first 起，段内非列表行跳过）。「不丢行」原则不变：真正的列表行一条不丢。
test('renderDecisionTable: 列表中间夹散文 → 散文不得进表格，列表行一条不丢（评审 🔵#3）', () => {
  const page = [
    '## Decision history', '',
    '- **a** — why a (abc1234, 2026-06-01)',
    '',
    '这一段是人工维护的说明：两个决定之间插了散文。',
    '',
    '- **b** — why b (def4567, 2026-05-30)',
    '',
    '## 下一节',
  ].join('\n');
  const out = renderDecisionTable(page);
  const table = out.split('\n').filter(l => l.startsWith('|'));
  assert.equal(table.length, 4, `表头+分隔+两条数据，实际：${JSON.stringify(table)}`);
  assert.match(out, /\| abc1234 \| 2026-06-01 \| \*\*a\*\* — why a \|/);
  assert.match(out, /\| def4567 \| 2026-05-30 \| \*\*b\*\* — why b \|/);   // 被散文隔开的下半段也不丢
  assert.equal(table.some(l => l.includes('人工维护')), false);            // 散文没进表格
  assert.equal(/\|\s*—\s*\|\s*—\s*\|/.test(out), false);                   // 没有 version/date 皆 — 的降级行
  // 散文也没被从正文里删掉；它的**落位**由下一条测试逐行钉住（不是「原位保留」，见那里）
  assert.match(out, /这一段是人工维护的说明：两个决定之间插了散文。/);
  assert.match(out, /## 下一节/);
  assert.match(renderMarkdown(out), /<th>版本<\/th><th>日期<\/th><th>变更与原因<\/th>/);
});

// 代码评审 R3（第二轮）：注释声称段内非列表行「原位保留」，实现却是把它们全挪到整张表之后——
// 注释与实现不符，而上面那条测试只断言散文「存在」，钉不住位置（用存在性冒充行为正确性的老毛病）。
// 处置：选「整张表 + 散文移到表后」这一边（改成真·分段插表会让小节里出现多张表头，
// 而壳侧 tagDecisionTable 只认第一张表 → 得连调用点一起改），并把该语义**逐行**钉在这里：
// 以后谁再改落位，这条会红，逼他同时改注释与测试。
test('renderDecisionTable: 散文的落位 = 整张表格之后（不是「原位」）——逐行钉住', () => {
  const page = [
    '## Decision history', '',
    '- **a** — why a (abc1234, 2026-06-01)', '',
    '这一段是人工维护的说明。', '',
    '- **b** — why b (def4567, 2026-05-30)', '',
    '## 下一节',
  ].join('\n');
  const out = renderDecisionTable(page);
  const lines = out.split('\n');
  assert.equal(lines[0], '## Decision history');
  // 表格整体（表头 / 分隔 / 两条数据）落在**第一条列表行**的位置，连续不断
  assert.deepEqual(lines.slice(2, 6), [
    '| 版本 | 日期 | 变更与原因 |',
    '|---|---|---|',
    '| abc1234 | 2026-06-01 | **a** — why a |',
    '| def4567 | 2026-05-30 | **b** — why b |',
  ]);
  // 散文在整张表**之后**（这正是旧注释说错的地方），且仍在小节内、下一节之前
  assert.equal(lines[6], '');
  assert.equal(lines[7], '这一段是人工维护的说明。');
  assert.equal(lines[10], '## 下一节');
  assert.equal(lines.filter(l => l.includes('人工维护')).length, 1, '散文不许丢，也不许复制');
  assert.equal(lines.some(l => l === '- **a** — why a (abc1234, 2026-06-01)'), false);   // 列表行已被表格取代
});

// 代码评审 R3（第二轮）🔵：中间那段收集列表行的循环原先没有围栏追踪（首尾两个循环都有）。
// 后果有两面：① 代码块里 `- ` 开头的样本被当条目抽进表格（假条目）；
// ② 输出阶段按「列表行」跳过时把**围栏内的那一行**一并删掉（代码块少一行，样本被破坏）。
test('renderDecisionTable: 决策史小节里夹围栏代码块 → 块内 `- ` 行不进表格、也不被删（评审 R3 🔵）', () => {
  const page = [
    '## Decision history', '',
    '- **a** — why a (abc1234, 2026-06-01)', '',
    '下面这段是样本，不是条目：', '',
    '```md',
    '- **示例条目** — 这只是代码块里的样本 (deadbee, 2026-01-01)',
    '```', '',
    '- **b** — why b (def4567, 2026-05-30)', '',
    '## 下一节',
  ].join('\n');
  const out = renderDecisionTable(page);
  const table = out.split('\n').filter(l => l.startsWith('|')).join('\n');
  assert.equal(table.includes('示例条目'), false, '代码块里的 `- ` 行被当条目抽进表格了');
  assert.equal(table.includes('deadbee'), false);
  assert.match(table, /\| abc1234 \|/);
  assert.match(table, /\| def4567 \|/);                       // 真条目一条不丢（围栏隔开的也收）
  assert.match(out, /```md\n- \*\*示例条目\*\* — 这只是代码块里的样本 \(deadbee, 2026-01-01\)\n```/,
    '代码块必须逐字保留（以前会被「列表行」跳过规则吃掉一行）');
  assert.equal(out.split('\n').filter(l => /^```/.test(l)).length, 2);   // 开栏 + 闭栏都在
});

test('renderDecisionTable: 确定性——同一输入两次调用结果相同；表格里的 `|` 不撕表', () => {
  const page = '## Decision history\n\n<!-- LORE_JOURNAL:START -->\n'
    + '- **a | b** — why (abc1234, 2026-06-01)\n<!-- LORE_JOURNAL:END -->\n';
  assert.equal(renderDecisionTable(page), renderDecisionTable(page));
  const cells = renderDecisionTable(page).split('\n').find(l => l.includes('abc1234'));
  assert.equal(cells.split('|').length, 5);                             // 首尾空 + 三格：`|` 被中和，没多裂一格
  assert.match(cells, /&#124;/);
});

test('生成侧契约（lib/sync.js）：只对无 sha 且有 id 的原子附加 atom id，有 sha 的逐字节不变', () => {
  const withSha = renderDecisionHistory([
    { id: 'commit:a', ts: '2026-06-01T08:00:00Z', kind: 'commit', commit: 'abc1234567', title: 't', why: 'w' },
  ]);
  assert.equal(withSha, '- **t** — w (abc1234, 2026-06-01)');            // 有 sha：零噪音
  const noId = renderDecisionHistory([
    { ts: '2026-06-03T08:00:00Z', kind: 'decision', commit: null, title: 'd', why: 'w' },
  ]);
  assert.equal(noId, '- **d** — w (2026-06-03)');                       // 无 id 可附：保持原输出
  const escaped = renderDecisionHistory([
    { id: 'decision:a"b<c', ts: '2026-06-03T08:00:00Z', kind: 'decision', commit: null, title: 'd', why: '' },
  ]);
  assert.match(escaped, /title="decision:a&quot;b&lt;c"/);               // 属性值转义，不撕 markdown
  assert.deepEqual(parseDecisionLog(escaped)[0].atom_id, 'decision:a"b<c');   // 读回来仍是原 id
});

test('buildStatusLine: 「队列 N」提示语带上已排队条数（QUEUED_PAGES 口径），供面板入口的 title', () => {
  const line = buildStatusLine({ status: { fuel: okFuel }, manifest: STATUS_MANIFEST, queued: 2, now: AT_1402 });
  assert.match(line.queue_hint, /1 页待重写/);
  assert.match(line.queue_hint, /2 条排队请求/);
  const empty = buildStatusLine({ status: null, manifest: { axes: [] }, queued: 0, now: AT_1402 });
  assert.equal(empty.queue_text, '队列 0');                         // manifest 说 0 页落后 = 真值 0（不是 unknown）
  assert.equal(empty.pages_text, '0 页');
  assert.match(empty.queue_hint, /0 条排队请求/);                    // 读得到的 0 照报 0（别把真值改成 unknown）
});

test('buildStatusLine: 排队条数取不到 → 提示语不许出现「0 条」（D13：取不到 ≠ 0）', () => {
  // 唯一调用方目前总传有限数（QUEUED_PAGES.size），但这个形参的语义必须本来就对——
  // 否则下个调用方一传 undefined/NaN/null，提示语就悄悄撒谎「0 条排队请求」。
  // 注：queued **没有默认值**（曾经的 `= 0` 正是「取不到冒充 0」的本体）：调用点拿不到条数时
  // 自然就是 undefined，而 undefined 必须走 unknown，不得落到 0。真值 0 必须显式传。
  for (const bad of [undefined, NaN, null, Infinity, -Infinity, '2']) {
    const line = buildStatusLine({ status: { fuel: okFuel }, manifest: STATUS_MANIFEST, queued: bad, now: AT_1402 });
    assert.equal(line.queue_hint.includes('0 条'), false,
      `queued=${String(bad)} 时提示语不得出现「0 条」，实际：${line.queue_hint}`);
    assert.match(line.queue_hint, /排队请求 unknown/);
    assert.match(line.queue_hint, /1 页待重写/);                      // 页面待重写数（读得到的）仍照报
    assert.equal(line.queue_text, '队列 1');                          // 队列数本身来自 manifest，不受影响
  }
  // 省略该字段 = 调用点没拿到条数 → 同样 unknown（这一条正是「默认值不能是 0」的回归断言）
  const omitted = buildStatusLine({ status: { fuel: okFuel }, manifest: STATUS_MANIFEST, now: AT_1402 });
  assert.equal(omitted.queue_hint.includes('0 条'), false);
  assert.match(omitted.queue_hint, /排队请求 unknown/);
});

// ---------- 调用点回归（D13）：site/index.html 不许把「取不到的队列数」伪造成 0 ----------
// 为什么这里抽源码来跑、而不是只断言字样：`buildStatusLine` 上一轮已删掉 `queued = 0` 形参默认值，
// 把「取不到冒充 0」从纯函数里堵掉——但**读数是调用点在 site/index.html 里产生的**。调用点若把
// 「rewrite-requests 失败」写成 `QUEUED_PAGES = new Set()` 再传 `.size`，纯函数的修复就被整体架空：
// 只列表端点失败、status 其实成功时，状态行会理直气壮地报「0 条排队请求」——正是 D13 点名的反模式。
// 壳是 SPA、内联脚本依赖 DOM，本仓零依赖无 jsdom，故把 index.html 里**真正的**那几块源码
// （状态声明 / fetchSyncStatus / 两个读数出口）抽出来在 Node 里执行：测行为，不测字样。
const SHELL_HTML = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');

// 从 header 起按花括号配对切出整段函数（跳过字符串/模板/行注释里的花括号）。
// 抽不到就直接失败：抽取器静默失真 = 测试假装通过，比不测更糟。
function sliceShellFn(header) {
  const at = SHELL_HTML.indexOf(header);
  assert.notEqual(at, -1, `site/index.html 里找不到「${header}」——抽取器失效，需同步更新本测试`);
  let depth = 0, quote = null, i = SHELL_HTML.indexOf('{', at);
  for (; i < SHELL_HTML.length; i++) {
    const c = SHELL_HTML[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '/' && SHELL_HTML[i + 1] === '/') { i = SHELL_HTML.indexOf('\n', i); if (i === -1) break; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { i++; break; }
  }
  return SHELL_HTML.slice(at, i);
}

function buildShellQueueApi(fetchStub) {
  const decls = SHELL_HTML.match(/let SYNC_STATUS = null;[\s\S]*?let SYNC_RUNS = \[\];/);
  assert.ok(decls, 'site/index.html 的状态声明块抽取失败——需同步更新本测试');
  const body = [
    decls[0],
    sliceShellFn('async function fetchSyncStatus'),
    sliceShellFn('function queuedArg'),
    sliceShellFn('function queuedCountText'),
    'return { fetchSyncStatus, queuedArg, queuedCountText, snap: () => ({ ok: QUEUED_OK, size: QUEUED_PAGES.size, apiOk: SYNC_API_OK }) };',
  ].join('\n');
  return new Function('fetch', 'BASE', body)(fetchStub, '/');
}

function shellQueueFixture({ statusOk = true, list, runs = { runs: [] } } = {}) {
  const ok = body => ({ ok: true, json: async () => body });
  const fetchStub = async url => {
    if (url.endsWith('api/sync/status')) return statusOk ? ok({ fuel: okFuel }) : { ok: false, json: async () => ({}) };
    if (url.endsWith('api/sync/rewrite-requests')) { if (list === 'throw') throw new Error('boom'); return ok(list); }
    if (url.endsWith('api/sync/runs')) return ok(runs);
    throw new Error('unexpected url: ' + url);
  };
  return buildShellQueueApi(fetchStub);
}

test('调用点：rewrite-requests 失败（status 成功）→ 队列读数传 undefined，状态行报 unknown 而非「0 条」（D13）', async () => {
  const api = shellQueueFixture({ list: 'throw' });
  await api.fetchSyncStatus();
  assert.equal(api.snap().apiOk, true);                    // 主 status 成功不连坐（二次列表失败只清它自己那份）
  assert.equal(api.queuedArg(), undefined);                // 取不到 → undefined，绝不是 0
  const line = buildStatusLine({ status: { fuel: okFuel }, manifest: STATUS_MANIFEST, queued: api.queuedArg(), now: AT_1402 });
  assert.match(line.queue_hint, /排队请求 unknown/);
  assert.equal(line.queue_hint.includes('0 条排队请求'), false);
  assert.equal(api.queuedCountText().includes('0 条'), false);   // 控制台「已排队请求」同一读数，同样不许报 0 条
  assert.match(api.queuedCountText(), /unknown/);
});

test('调用点：还没轮询到（初始态）→ 队列读数同样是 unknown，不许拿空 Set 的 size 充 0', () => {
  const api = shellQueueFixture({ list: { requests: [] } });
  assert.equal(api.queuedArg(), undefined);
  assert.equal(api.queuedCountText().includes('0 条'), false);
});

test('调用点：确实读到列表 → 真值照报（含 0 条），不许一律降级成 unknown', async () => {
  const one = shellQueueFixture({ list: { requests: [{ page: 'component/a.md' }] } });
  await one.fetchSyncStatus();
  assert.equal(one.queuedArg(), 1);
  assert.equal(one.queuedCountText(), '1 条');
  assert.match(buildStatusLine({ status: { fuel: okFuel }, manifest: STATUS_MANIFEST, queued: one.queuedArg(), now: AT_1402 }).queue_hint, /1 条排队请求/);

  const zero = shellQueueFixture({ list: { requests: [] } });
  await zero.fetchSyncStatus();
  assert.equal(zero.queuedArg(), 0);                       // 测出来是零 → 必须原样报 0（别把真值修成 unknown）
  assert.equal(zero.queuedCountText(), '0 条');
  assert.match(buildStatusLine({ status: { fuel: okFuel }, manifest: STATUS_MANIFEST, queued: zero.queuedArg(), now: AT_1402 }).queue_hint, /0 条排队请求/);
});

// 行为之外还要盯住「接线」：上面三条测的是读数出口本身，若调用点留着出口不用、
// 回退成 `queued: QUEUED_PAGES.size`（控制台回退成 `${QUEUED_PAGES.size} 条`），
// 出口的行为测试照样全绿——而 bug 恰恰出在接线上。故这里直接盯调用点。
test('调用点接线：状态行与控制台都必须走队列读数出口，不许直接读 QUEUED_PAGES.size', () => {
  assert.match(SHELL_HTML, /buildStatusLine\(\{[^}]*queued: queuedArg\(\)/, '状态行的 queued 必须来自 queuedArg()（取不到 → undefined）');
  assert.equal(/queued:\s*QUEUED_PAGES\.size/.test(SHELL_HTML), false, '状态行不得直接传 QUEUED_PAGES.size');
  assert.match(SHELL_HTML, /\$\{queuedCountText\(\)\}/, '控制台「已排队请求」必须来自 queuedCountText()');
  const consoleRow = SHELL_HTML.split('\n').find(l => l.includes('已排队请求'));   // 控制台「状态」小节那一行
  assert.ok(consoleRow, 'site/index.html 里找不到「已排队请求」那一行');
  assert.equal(consoleRow.includes('QUEUED_PAGES.size'), false, '控制台那一行不得直接渲染 QUEUED_PAGES.size 条');
});

// ---------- 首屏与导航的健壮性（代码评审 R3 ①③④）----------
// boot 容错 / route 查 res.ok + 并发防护 / pollTick 坏 manifest。口径同上：抽 site/index.html 里
// **真正的**源码在 Node 里跑，断言行为而不是字样——上一轮的教训正是「用存在性冒充行为正确性」。
// 壳是 SPA、内联脚本依赖 DOM，而本仓零依赖、无 jsdom → 只把 DOM 世界当桩，被抽出来的函数是**真源码**；
// 与它协作的模块函数按参数注入（真实函数照传，其余是「被调用即记录」的桩）。

function fakeElement() {
  return {
    innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, title: '',
    className: '', scrollTop: 0, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, prepend() {}, remove() {}, after() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    setAttribute() {}, getAttribute: () => null, focus() {}, select() {},
    contains: () => false, scrollIntoView() {}, click() {},
  };
}

function fakeDocument() {
  const byId = new Map();
  return {
    hidden: false,
    documentElement: { setAttribute() {}, getAttribute: () => 'light' },
    head: fakeElement(), body: fakeElement(),
    getElementById(id) { if (!byId.has(id)) byId.set(id, fakeElement()); return byId.get(id); },
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => fakeElement(), addEventListener() {},
  };
}

// escapeHtml 是单行箭头函数，花括号配对抽取器会被它内部的正则/对象字面量带偏 → 按整行抽。
function shellEscapeLine() {
  const l = SHELL_HTML.split('\n').find(x => x.trim().startsWith('const escapeHtml'));
  assert.ok(l, 'site/index.html 里找不到 escapeHtml 的一行式定义——抽取器失效，需同步更新本测试');
  return l;
}

// boot()：抽 loadManifest + boot 的真源码，协作者注入成桩——测的是 boot 自己的控制流
// （失败后是否仍然接线、是否退到安全默认、是否记下原因）。
function buildShellBoot({ fetchStub }) {
  const called = [];
  const mk = name => () => { called.push(name); return Promise.resolve(); };
  const body = [
    "let MANIFEST = { axes: [] }, PAGE_INDEX = {}, FLAT = {}, SELECTED_LANG = 'en';",
    'let BOOT_ERROR = null;',
    'let LAST_GENERATED = null;',
    sliceShellFn('async function loadManifest'),
    sliceShellFn('async function boot'),
    'return { boot, snap: () => ({ MANIFEST, PAGE_INDEX, FLAT, SELECTED_LANG, BOOT_ERROR, LAST_GENERATED }) };',
  ].join('\n');
  const build = new Function(
    'fetch', 'BASE', 'localStorage', 'buildPageIndex', 'chooseInitialLanguage',
    'buildSidebar', 'wireSearch', 'wireTheme', 'wireShortcuts', 'wireInspector', 'wireLanguage',
    'fetchSyncStatus', 'wireSyncConsole', 'renderSyncLight', 'wireRepoSwitch', 'schedulePoll',
    'window', 'route', body);
  const scheduled = [];
  const api = build(fetchStub, '/', { getItem: () => null, setItem() {} },
    buildPageIndex, chooseInitialLanguage,
    mk('buildSidebar'), mk('wireSearch'), mk('wireTheme'), mk('wireShortcuts'),
    mk('wireInspector'), mk('wireLanguage'), mk('fetchSyncStatus'), mk('wireSyncConsole'),
    mk('renderSyncLight'), mk('wireRepoSwitch'),
    ms => scheduled.push(ms),
    { addEventListener: ev => called.push('on:' + ev) },
    () => called.push('route'));
  api.called = called;
  api.scheduled = scheduled;
  return api;
}

const BOOT_FAILURES = {
  'fetch 抛错（瞬时网络失败）': () => { throw new Error('network down'); },
  'HTTP 404': async () => ({ ok: false, status: 404, json: async () => ({}) }),
  'JSON 损坏（json() 抛错）': async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }),
  '合法 JSON 但缺 axes': async () => ({ ok: true, json: async () => ({ generated: '2026-09-10T00:00:00Z' }) }),
};

for (const [label, fetchStub] of Object.entries(BOOT_FAILURES)) {
  test(`boot(): ${label} → 不 reject、退到安全默认、其余接线照常启动（评审 R3 ①）`, async () => {
    const api = buildShellBoot({ fetchStub });
    await api.boot();                       // 关键断言：这一行以前整体抛出 → 侧栏/路由/F 键全不启动，壳停在死骨架
    const s = api.snap();
    assert.deepEqual(s.MANIFEST.axes, [], '必须退到安全默认（空目录），不得把坏对象留在 MANIFEST 里');
    assert.ok(s.BOOT_ERROR, '必须记下失败原因——route() 据此显示可见的错误提示');
    for (const w of ['buildSidebar', 'wireSearch', 'wireTheme', 'wireShortcuts', 'wireInspector',
      'wireLanguage', 'fetchSyncStatus', 'wireSyncConsole', 'renderSyncLight', 'wireRepoSwitch', 'route']) {
      assert.ok(api.called.includes(w), `${w} 没被调用 —— 壳会停在死骨架（F1–F5 全 disabled）`);
    }
    assert.deepEqual(api.scheduled, [15000], '轮询仍要起来——它是失败后的自愈路径');
    assert.ok(api.called.includes('on:hashchange'));
  });
}

test('boot(): manifest 正常 → 既有行为一字不变（页表 / 语言 / LAST_GENERATED 都就位）', async () => {
  const m = {
    generated: '2026-09-10T00:00:00Z',
    language: { default: 'zh', available: ['zh'] },
    axes: [{ id: 'component', pages: [{ id: 'a', path: 'component/a.md' }] }],
  };
  const api = buildShellBoot({ fetchStub: async () => ({ ok: true, json: async () => m }) });
  await api.boot();
  const s = api.snap();
  assert.equal(s.BOOT_ERROR, null);
  assert.deepEqual(Object.keys(s.FLAT), ['component/a']);
  assert.equal(s.PAGE_INDEX.a, 'component/a');
  assert.equal(s.MANIFEST.generated, '2026-09-10T00:00:00Z');
  assert.equal(s.LAST_GENERATED, '2026-09-10T00:00:00Z');
  assert.equal(s.SELECTED_LANG, 'zh');
});

// route()：抽真源码，DOM 与协作者当桩。断言的是**正文区最终写出了什么**（行为），不是源码里有没有字样。
function buildShellRoute({ fetchStub, hash = '#component/a' }) {
  const doc = fakeDocument();
  const location = { hash };
  const seen = { inspector: [] };
  const body = [
    "let MANIFEST = { axes: [] }, PAGE_INDEX = {}, FLAT = {}, SELECTED_LANG = 'en';",
    'let BOOT_ERROR = null;',
    'let ROUTE_SEQ = 0;',
    shellEscapeLine(),
    sliceShellFn('function renderNotFound'),
    sliceShellFn('function renderBootFailure'),
    sliceShellFn('function renderLoadError'),
    sliceShellFn('async function route'),
    'return { route,',
    '  setFlat: f => { FLAT = f; }, setBootError: e => { BOOT_ERROR = e; },',
    '  html: () => document.getElementById("content").innerHTML,',
    '  metaHtml: () => document.getElementById("meta").innerHTML };',
  ].join('\n');
  const build = new Function(
    'fetch', 'BASE', 'document', 'location', 'window', 'prompt',
    'firstPageKey', 'renderInspector', 'renderConsolePage', 'renderMeta', 'renderTranslateState',
    'resolveLocalizedPage', 'stripFrontmatter', 'renderDecisionTable', 'renderMarkdown',
    'preprocessWikilinks', 'renderAnchors', 'tagDecisionTable', 'ensureMermaid', 'themedSrc', 'LB', body);
  const api = build(fetchStub, '/', doc, location, {}, () => null,
    () => '', notes => seen.inspector.push(notes), () => {}, () => '', () => '',
    resolveLocalizedPage, stripFrontmatter, renderDecisionTable, renderMarkdown,
    preprocessWikilinks, renderAnchors, () => {}, async () => {}, s => s, { open() {} });
  api.doc = doc;
  api.location = location;
  api.seen = seen;
  return api;
}

const PAGE_A = { id: 'a', axis: 'component', path: 'component/a.md', title: 'A', lang: 'en' };
const PAGE_B = { id: 'b', axis: 'component', path: 'component/b.md', title: 'B', lang: 'en' };

test('route(): 页文件非 2xx → 走既有 404 分支，绝不把 404 响应体当正文渲染（评审 R3 ②）', async () => {
  const api = buildShellRoute({ fetchStub: async () => ({ ok: false, status: 404, text: async () => 'not found' }) });
  api.setFlat({ 'component/a': PAGE_A });
  await api.route();
  assert.match(api.html(), /<h1>404<\/h1>/);
  assert.equal(api.html().includes('not found'), false,
    `404 响应体被当 markdown 渲染成正文了：${api.html()}`);
  assert.deepEqual(api.seen.inspector.at(-1), [], '404 页没有锚点 → 注记栏必须清空');
});

test('route(): 正文 fetch 抛错 → 显示加载失败，不许静默停在上页（评审 R3 ②）', async () => {
  let fail = false;
  const api = buildShellRoute({
    fetchStub: async () => {
      if (fail) throw new Error('network down');
      return { ok: true, text: async () => '第一页的正文' };
    },
  });
  api.setFlat({ 'component/a': PAGE_A, 'component/b': PAGE_B });
  await api.route();
  assert.match(api.html(), /第一页的正文/);                       // 先正常渲染 A
  api.location.hash = '#component/b';
  fail = true;
  await api.route();
  assert.match(api.html(), /页面加载失败/);
  assert.equal(api.html().includes('第一页的正文'), false,
    '停在上页 = 让读者以为当前 hash 就是屏幕上那份内容（比空白更坏的谎）');
});

test('route(): 连续两次切换 → 慢的那次落地被丢弃，不许把新页覆盖回旧页（评审 R3 ③）', async () => {
  let releaseA;
  const gateA = new Promise(r => { releaseA = r; });
  const api = buildShellRoute({
    fetchStub: async url => {
      if (String(url).includes('component/a.md')) { await gateA; return { ok: true, text: async () => 'AAAA' }; }
      return { ok: true, text: async () => 'BBBB' };
    },
  });
  api.setFlat({ 'component/a': PAGE_A, 'component/b': PAGE_B });
  const slow = api.route();                 // A：慢（挂在 gate 上）
  api.location.hash = '#component/b';
  await api.route();                        // B：快，先落地
  assert.match(api.html(), /BBBB/);
  releaseA();
  await slow;                               // A 后落地：必须被丢弃
  assert.match(api.html(), /BBBB/, '慢的那次把新页整体覆盖回旧页了（经典 SPA 竞态）');
  assert.equal(api.html().includes('AAAA'), false);
});

test('route(): manifest 没读到 → 正文区给出可见的错误提示，不是误导性的 404（评审 R3 ①）', async () => {
  const api = buildShellRoute({ fetchStub: async () => { throw new Error('不该被调用'); } });
  api.setBootError('<img src=x onerror=1> 500');
  await api.route();                        // FLAT 为空 → 没有 page 可渲染
  assert.match(api.html(), /页面目录加载失败/);
  assert.equal(api.html().includes('<h1>404</h1>'), false, '外壳没数据时报 404 会让读者以为是自己点错了页');
  assert.equal(api.html().includes('<img'), false, '错误文案进 innerHTML 前必须转义');
  assert.match(api.html(), /&lt;img/);
});

// pollTick()：抽真源码，只把 DOM/网络/协作者当桩。坏 manifest 每一轮都会来一次（15s），
// 所以这里的断言是「不炸」而不是「这一次的结果对不对」。
function buildShellPollTick({ fetchStub }) {
  const called = [];
  const location = { hash: '#component/a' };
  const body = [
    "let MANIFEST = { axes: [] }, PAGE_INDEX = {}, FLAT = {}, SELECTED_LANG = 'en';",
    'let LAST_GENERATED = null, POLL_TIMER = null, FAST_LEFT = 0;',
    sliceShellFn('async function pollTick'),
    'return { pollTick, setManifest: m => { MANIFEST = m; }, setFlat: f => { FLAT = f; },',
    '  snap: () => ({ MANIFEST, LAST_GENERATED, FLAT }) };',
  ].join('\n');
  const build = new Function(
    'fetch', 'BASE', 'document', 'location', 'firstPageKey', 'pollDecide', 'buildPageIndex',
    'buildSidebar', 'fetchSyncStatus', 'renderSyncLight', 'renderConsolePage', 'showUpdateBar',
    'schedulePoll', body);
  const mk = name => () => { called.push(name); return Promise.resolve(); };
  const api = build(fetchStub, '/', fakeDocument(), location, () => '', pollDecide, buildPageIndex,
    mk('buildSidebar'), mk('fetchSyncStatus'), mk('renderSyncLight'), mk('renderConsolePage'),
    mk('showUpdateBar'), mk('schedulePoll'));
  api.called = called;
  return api;
}

test('pollTick(): 坏 manifest（null / 缺 axes / 非数组）→ 不抛、不动状态、不重建侧栏（评审 R3 ④）', async () => {
  for (const bad of [null, {}, { axes: 'nope' }, { axes: null }]) {
    const api = buildShellPollTick({ fetchStub: async () => ({ json: async () => bad }) });
    const before = api.snap().MANIFEST;
    await api.pollTick();                   // 以前这里每 15s 抛一次 TypeError（未处理拒绝风暴）
    assert.deepEqual(api.snap().MANIFEST, before, `坏 manifest ${JSON.stringify(bad)} 不该改写 MANIFEST`);
    assert.equal(api.called.includes('buildSidebar'), false, '坏数据不得重建侧栏（把读者正在看的目录清空更坏）');
    assert.equal(api.snap().LAST_GENERATED, null);
  }
});

test('pollTick(): 正常 manifest → 既有行为不变（generated 变了才重建侧栏）', async () => {
  const fresh = {
    generated: '2026-09-10T01:00:00Z',
    axes: [{ id: 'component', pages: [{ id: 'a', path: 'component/a.md' }] }],
  };
  const api = buildShellPollTick({ fetchStub: async () => ({ json: async () => fresh }) });
  await api.pollTick();
  assert.equal(api.snap().LAST_GENERATED, '2026-09-10T01:00:00Z');
  assert.deepEqual(Object.keys(api.snap().FLAT), ['component/a']);
  assert.ok(api.called.includes('buildSidebar'));
  assert.ok(api.called.includes('fetchSyncStatus'));
});

// 状态行读数：manifest 没读到时的安全默认 `{axes: []}` **不许**被当成「测出来 0 页」（D13）。
// 抽 renderStatusLine 的真源码，DOM 与读数出口当桩，断的是**它写进 #statusline 的字**。
function buildShellStatusLine() {
  const doc = fakeDocument();
  const body = [
    "let MANIFEST = { axes: [] }, PAGE_INDEX = {}, FLAT = {}, SELECTED_LANG = 'en';",
    'let BOOT_ERROR = null;',
    'let SYNC_STATUS = null;',
    sliceShellFn('function renderStatusLine'),
    'return { renderStatusLine, set: (m, b) => { MANIFEST = m; BOOT_ERROR = b; } };',
  ].join('\n');
  const build = new Function('document', 'buildStatusLine', 'queuedArg', body);
  const api = build(doc, buildStatusLine, () => undefined);
  api.doc = doc;
  return api;
}

test('renderStatusLine: manifest 没读到 → 页数/队列读 unknown，不拿安全默认的 0 冒充（D13）', () => {
  const api = buildShellStatusLine();
  api.set({ axes: [] }, 'HTTP 500');
  api.renderStatusLine();
  assert.equal(api.doc.getElementById('status-pages').textContent, 'unknown 页');
  assert.match(api.doc.getElementById('status-queue').textContent, /队列 unknown/);
  // 目录正常（哪怕真的是 0 页）→ 读数回真值，不许一律降级成 unknown
  api.set({ axes: [] }, null);
  api.renderStatusLine();
  assert.equal(api.doc.getElementById('status-pages').textContent, '0 页');
  assert.match(api.doc.getElementById('status-queue').textContent, /队列 0/);
});

// ---------- 只读模式下的档位键（代码评审 R5 🟡）----------
// 为什么抽真源码来跑：三个档位键的禁用态是 `renderSyncLight` 在**运行时**写上去的（静态 markup 里
// 三个 `data-mode` 键都不带 `disabled`），grep 选择器字样只能证明「写了某行」，证明不了「三个键都被禁」
// ——上一轮的教训正是「验字样只给虚假的通过感」。壳是 SPA、本仓零依赖无 jsdom → DOM 当桩，
// 抽出来的 renderSyncLight 是真源码；它依赖的纯函数（buildConsoleModel / budgetNotice）照传真实实现。
function buildShellSyncLight(apiOk) {
  const doc = fakeDocument();
  const seg = ['manual', 'notify', 'auto'].map(mode => (
    { dataset: { mode }, disabled: false, title: '', classList: { toggle() {} } }));
  // 桩只认「选择器有没有把 auto 档排除在外」这件事：旧写法 `:not([data-mode="auto"])` 会原样少返回
  // auto —— 于是「auto 在只读模式下没被禁用」这个 bug 会被断言直接抓住；等价的新写法照样返回三个。
  doc.querySelectorAll = sel => (String(sel).includes('not([data-mode="auto"])')
    ? seg.filter(b => b.dataset.mode !== 'auto') : seg);
  const body = [
    'let SYNC_STATUS = null;',
    `let SYNC_API_OK = ${apiOk};`,
    'let MANIFEST = { axes: [] };',
    sliceShellFn('function renderSyncLight'),
    'return { renderSyncLight, seg: SEG };',   // new Function 无闭包：抽出的源码看不到本文件的 seg，须按参数注入
  ].join('\n');
  const build = new Function('document', 'buildConsoleModel', 'budgetNotice', 'queuedArg', 'renderStatusLine', 'SEG', body);
  return build(doc, buildConsoleModel, budgetNotice, () => undefined, () => {}, seg);
}

test('只读模式（SYNC_API_OK=false）→ 顶部面板三个档位键全部 disabled（评审 R5 🟡：auto 不再是死键）', () => {
  const api = buildShellSyncLight(false);
  api.renderSyncLight();
  for (const b of api.seg) {
    assert.equal(b.disabled, true,
      `${b.dataset.mode} 档在只读模式下仍可点——fetch 对非 2xx 不抛错 → catch 不触发 → 界面毫无变化（D8 禁止的死键）`);
    assert.match(b.title, /只读模式/, `${b.dataset.mode} 档缺只读提示（与控制台页 RO_ATTR 口径一致）`);
  }
});

test('正常态（SYNC_API_OK=true）→ 三个档位键均可点、无只读提示，行为不变', () => {
  const api = buildShellSyncLight(true);
  api.renderSyncLight();
  for (const b of api.seg) {
    assert.equal(b.disabled, false, `${b.dataset.mode} 档在正常态被误禁用（三个档位都该可切换）`);
    assert.equal(b.title, '', `${b.dataset.mode} 档在正常态挂着只读提示`);
  }
});

// ---------- 阶段 A 的机检项入库（代码评审 R4 🟡#2）----------
// 为什么必须搬进 `node --test`：这几条（正文字号/字体栈/13 个 §5.2 token/零外部资源引用）此前只活在
// 计划文档的手工 `node -e` 命令里，而补这些探针的动机恰恰是「它们可以静默回归」——留在手工命令里，
// 回归只在有人记得重跑时才被抓到（`grep 13.5px test/` 零命中就是证据）。现在每次 `node --test` 都守。
//
// 防阷值（上一轮真发生过）：**先剥注释再匹配**。实测 site/index.html 里 `#8A94A3` 与 `@import` 都只
// 出现在注释文本里（--dim 行尾「不得回退 #8A94A3」、D1 行「绝不 @import / CDN」），不剥注释就会把
// 「注释里提到」误报成「已经回退」——探针反过来咬人的经典形态。
const SHELL_HTML_NO_COMMENTS = SHELL_HTML.replace(/<!--[\s\S]*?-->/g, '');
const SHELL_STYLE = (() => {
  const m = SHELL_HTML_NO_COMMENTS.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(m, 'site/index.html 里找不到 <style> 块——抽取器失效，需同步更新本测试');
  return m[1].replace(/\/\*[\s\S]*?\*\//g, '');   // CSS 注释里提过的色值/指令一律不算数
})();
// 浅色档的 :root（第一个 :root 就是它；dark/sepia 跟在后面，是重映射不是校色对象）
const SHELL_ROOT_BLOCK = (() => {
  const i = SHELL_STYLE.indexOf(':root');
  assert.notEqual(i, -1, 'site/index.html 里找不到 :root——抽取器失效，需同步更新本测试');
  const open = SHELL_STYLE.indexOf('{', i);
  const close = SHELL_STYLE.indexOf('}', open);
  assert.ok(open !== -1 && close > open, ':root 块解析失败——需同步更新本测试');
  return SHELL_STYLE.slice(open + 1, close);
})();
const tokenOf = (block, name) => {
  const m = block.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
};

// 设计 §5.2 的 13 个值（逐值固定：改一个值就是改了整套视觉语言——已逐值验收，不得「顺手调」）
const DESIGN_TOKENS = {
  bg: '#F4F6F9', pan: '#FFFFFF', pan2: '#F8FAFC', bd: '#E2E7EE', bd2: '#CFD7E2',
  fg: '#0F1319', mut: '#5B6473', dim: '#6B7280', acc: '#5B5BD6', acc2: '#0E7490',
  amber: '#B45309', ok: '#15803D', bad: '#DC2626',
};

test('阶段 A：浅色 :root 的 13 个 §5.2 token 与设计逐值相等', () => {
  assert.equal(Object.keys(DESIGN_TOKENS).length, 13, '§5.2 是 13 个值——少一个就是漏了一个角色');
  for (const [name, value] of Object.entries(DESIGN_TOKENS)) {
    assert.equal(tokenOf(SHELL_ROOT_BLOCK, name), value,
      `--${name} 与设计 §5.2 不等（token 是整套视觉语言的地基，不是可调参数）`);
  }
  // 弱色回退是最危险的一种回归：v1 的 #8A94A3 在白底只有 3.07:1，违反设计自己的 ≥4.5:1 要求。
  assert.equal(SHELL_STYLE.includes('#8A94A3'), false, '弱色回退到 #8A94A3（白底 3.07:1，违反 §5.2）');
});

test('阶段 A：正文 13.5px/1.66 + 两个字体角色的首族与中文回退', () => {
  const bodies = SHELL_STYLE.match(/(?:^|[\s,{])body\s*\{[^}]*\}/g) ?? [];
  const body = bodies.find(b => /font:/.test(b));
  assert.ok(body, 'site/index.html 里找不到带 font 的 body 规则——抽取器失效，需同步更新本测试');
  assert.match(body, /font:\s*13\.5px\/1\.66/, '正文字号/行高必须与设计 §5.2 相等');

  const font = tokenOf(SHELL_ROOT_BLOCK, 'font') ?? '';
  const mono = tokenOf(SHELL_ROOT_BLOCK, 'mono') ?? '';
  const firstFamily = s => s.split(',')[0].trim().replace(/^["']|["']$/g, '');
  assert.equal(firstFamily(font), 'Inter', '--font 首族必须是 Inter');
  assert.equal(firstFamily(mono), 'JetBrains Mono', '--mono 首族必须是 JetBrains Mono（读数/锚点/日期角色）');
  // 中文回退：没装 Inter 时中文不能掉成方框——两个中文族都必须在栈里
  for (const cn of ['PingFang SC', 'Microsoft YaHei']) {
    assert.ok(font.includes(cn), `--font 缺中文回退「${cn}」`);
  }
  // 定义与使用是两件事：--mono 定义得再对，没人用也等于没落地（读数类文本必须真的落这个角色）
  assert.ok(/var\(--mono\)/.test(SHELL_STYLE), '--mono 定义了却没有任何使用点——字体角色没落地');
});

test('阶段 A：零外部资源引用（不引 CDN 字体 / 图标 / 脚本，D1 不引外链）', () => {
  assert.equal(/@import/.test(SHELL_STYLE), false, '@import 会把壳连到外部（D1 明确禁止联网取字体）');
  // 只用字体栈降级（D1）。本机回环地址除外（portal 跳转 URL 是壳自己的功能，不是外部依赖）。
  const external = SHELL_HTML_NO_COMMENTS
    .match(/https?:\/\/(?!127\.0\.0\.1\b|localhost\b|\[::1\])[^\s"'`)]+/g) ?? [];
  assert.deepEqual(external, [], `壳里出现外部资源引用（联网即违反 §2 不变量②）：${external.join(', ')}`);
  // 协议相对 URL（//cdn.example.com/...）是同一件事的另一种写法，别让它从缝里溜进来
  assert.equal(/<link\b[^>]*\bhref\s*=\s*["']?\/\//i.test(SHELL_HTML_NO_COMMENTS), false, '协议相对外链同样是外链');
});
