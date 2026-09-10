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

// --- 壳阶段 C 视觉①：源码锚点 = 引出线注记（设计 §5.4 / D7）---
// 纯函数（无 DOM）：renderAnchors(html) → { html, notes:[{n, anchor}] }；点角标的交互在 site/index.html。
import { renderAnchors } from '../site/shell.mjs';

test('renderAnchors: 多个锚点 → 按正文出现顺序编号 1..N，角标落在锚点后，notes 与之一一对应', () => {
  const html = '<p>入口 <code>runAuto @ lib/runner.js:77</code>，再看 <code>planSync @ lib/sync.js:21</code>。</p>';
  const { html: out, notes } = renderAnchors(html);
  assert.deepEqual(notes, [
    { n: 1, anchor: 'runAuto @ lib/runner.js:77' },
    { n: 2, anchor: 'planSync @ lib/sync.js:21' },
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
    [{ n: 1, anchor: '/api/sync/finalize @ server.js:190' }]);
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
  assert.deepEqual(mixed.notes, [{ n: 1, anchor: 'y @ b/b.js:2' }]);
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
  const empty = buildStatusLine({ status: null, manifest: { axes: [] }, now: AT_1402 });
  assert.equal(empty.queue_text, '队列 0');                         // manifest 说 0 页落后 = 真值 0（不是 unknown）
  assert.equal(empty.pages_text, '0 页');
  assert.match(empty.queue_hint, /0 条排队请求/);                    // 读得到的 0 照报 0（别把真值改成 unknown）
});

test('buildStatusLine: 排队条数取不到 → 提示语不许出现「0 条」（D13：取不到 ≠ 0）', () => {
  // 唯一调用方目前总传有限数（QUEUED_PAGES.size），但这个默认值的语义必须本来就对——
  // 否则下个调用方一传 NaN/null/Infinity，提示语就悄悄撒谎「0 条排队请求」。
  // 注：显式传 undefined 会命中形参默认值 0（那是 API 契约上的「没给 = 0 条」，非本断言的范围）。
  for (const bad of [NaN, null, Infinity, -Infinity, '2']) {
    const line = buildStatusLine({ status: { fuel: okFuel }, manifest: STATUS_MANIFEST, queued: bad, now: AT_1402 });
    assert.equal(line.queue_hint.includes('0 条'), false,
      `queued=${String(bad)} 时提示语不得出现「0 条」，实际：${line.queue_hint}`);
    assert.match(line.queue_hint, /排队请求 unknown/);
    assert.match(line.queue_hint, /1 页待重写/);                      // 页面待重写数（读得到的）仍照报
  }
});
