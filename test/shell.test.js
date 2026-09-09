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
