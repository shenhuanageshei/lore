---
title: lore docs 轴重构（分组置顶 + feature 配对 + 默认折叠）Implementation Plan
summary: > **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [...
source_path: docs/superpowers/plans/2026-06-10-lore-docs-axis-regroup.md
last_updated: 2026-06-10
group: 设计与计划
---
> 源文档：`docs/superpowers/plans/2026-06-10-lore-docs-axis-regroup.md`

# lore docs 轴重构（分组置顶 + feature 配对 + 默认折叠）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** docs 轴 54 页流水分流：「📌 项目状态」（changelog/ROADMAP/pitfalls）置顶常开，specs/plans 按 feature 配对成一行并默认折叠，搜索可穿透折叠组。

**Architecture:** `docs.js` 物化时推导 `group` + 配对 `paired_plan` 写进页 frontmatter；`manifest.js` frontmatter 优先透传 + docs 轴组间排序（排序单一来源）；`shell.mjs` 纯函数 `buildDocsRows`（归组分段/配对/剥尾，可测）；`index.html` 渲染折叠组 + plan 徽标（span 非嵌套 a）+ localStorage 记忆 + 搜索穿透。

**Tech Stack:** Node 内置 + `node --test`。零外部依赖。

**Spec:** `docs/superpowers/specs/2026-06-10-lore-docs-axis-regroup-design.md`（设计已批）。

**硬约束：** ① 新 CSS 全主题变量（禁硬编码色值）。② plan 徽标用 `<span>` + JS 跳转——`<a>` 内嵌 `<a>` 非法 HTML。③ dogfood 壳改动双 cp（`.lore/site/` 的 index.html + shell.mjs）。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `lib/docs.js` | 修改 | `docGroup` + `pairDocs` 导出；`buildDocsAxis` 集成；`renderDocsPage` frontmatter 增写 `group:`/`paired_plan:` |
| `test/docs.test.js` | 扩展 | 上述单测 |
| `lib/manifest.js` | 修改 | `pageEntry` group frontmatter 优先 + `paired_plan` 透传；docs 轴组间排序 |
| `test/manifest.test.js` | 扩展 | docs 排序 + 透传 |
| `site/shell.mjs` | 修改 | `buildDocsRows` 导出 |
| `test/shell.test.js` | 扩展 | buildDocsRows 全分支 |
| `site/index.html` | 修改 | docs 侧栏分支 + 折叠 toggle + localStorage + 搜索穿透 + CSS |
| `docs/ROADMAP.md` | 修改 | 标记完成 |

---

## Task 1: `docs.js` —— `docGroup` + `pairDocs`

**Files:**
- Modify: `lib/docs.js`
- Modify: `test/docs.test.js`

- [ ] **Step 1: 写失败测试** —— `test/docs.test.js` 末尾追加（import 行扩 `docGroup, pairDocs`）：

```js
import { docGroup, pairDocs } from '../lib/docs.js';

test('docGroup: superpowers specs/plans → 设计与计划；notes → notes；其余 → 项目状态', () => {
  assert.equal(docGroup('docs/superpowers/specs/2026-06-08-x-design.md'), '设计与计划');
  assert.equal(docGroup('docs/superpowers/plans/2026-06-08-x.md'), '设计与计划');
  assert.equal(docGroup('docs/superpowers/notes/2026-06-02-y.md'), 'notes');
  assert.equal(docGroup('docs/ROADMAP.md'), '项目状态');
  assert.equal(docGroup('CHANGELOG.md'), '项目状态');           // 折叠页 sourcePath
  assert.equal(docGroup('CLAUDE.md'), '项目状态');              // pitfalls
  assert.equal(docGroup('docs\\superpowers\\specs\\2026-06-08-w-design.md'), '设计与计划');   // win 反斜杠容错
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
```

- [ ] **Step 2: 跑红** —— Run: `node --test test/docs.test.js`，Expected: FAIL（`docGroup` 未导出）

- [ ] **Step 3: 实现** —— `lib/docs.js` 在 `renderDocsPage` 之前加：

```js
// docs 轴分组（spec 2026-06-10-lore-docs-axis-regroup）：硬编码启发式，零 config。
// 无 superpowers 结构的 repo 全落「项目状态」单组 = 行为同现状。
export function docGroup(sourcePath) {
  const p = (sourcePath ?? '').replace(/\\/g, '/');
  if (/^docs\/superpowers\/(specs|plans)\//.test(p)) return '设计与计划';
  if (/^docs\/superpowers\/notes\//.test(p)) return 'notes';
  return '项目状态';
}

// superpowers 命名约定配对：specs/<date>-<slug>-design.md ↔ plans/<date>-<slug>.md。
// 命中 → spec 就地标 pairedPlan = plan 的页 id。错配风险低（date+slug 双键）。
export function pairDocs(specs) {
  const planByKey = new Map();
  for (const s of specs) {
    const m = (s.sourcePath ?? '').replace(/\\/g, '/')
      .match(/^docs\/superpowers\/plans\/(\d{4}-\d{2}-\d{2})-(.+)\.md$/);
    if (m) planByKey.set(`${m[1]}|${m[2]}`, s.id);
  }
  for (const s of specs) {
    const m = (s.sourcePath ?? '').replace(/\\/g, '/')
      .match(/^docs\/superpowers\/specs\/(\d{4}-\d{2}-\d{2})-(.+)-design\.md$/);
    if (m) {
      const planId = planByKey.get(`${m[1]}|${m[2]}`);
      if (planId) s.pairedPlan = planId;
    }
  }
  return specs;
}
```

- [ ] **Step 4: 跑绿** —— Run: `node --test test/docs.test.js`，Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/docs.js test/docs.test.js
git commit -m "feat(docs): docGroup heuristic + spec/plan pairing by date+slug"
```

---

## Task 2: `docs.js` —— 物化集成（frontmatter 增写 group / paired_plan）

**Files:**
- Modify: `lib/docs.js`
- Modify: `test/docs.test.js`

- [ ] **Step 1: 写失败测试** —— `test/docs.test.js` 末尾追加：

```js
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
    assert.match(spec, /^group: 设计与计划$/m);
    assert.match(spec, /^paired_plan: superpowers-plans-2026-06-08-thing$/m);

    const plan = readFileSync(join(lore, 'wiki', 'docs', 'superpowers-plans-2026-06-08-thing.md'), 'utf8');
    assert.match(plan, /^group: 设计与计划$/m);
    assert.doesNotMatch(plan, /paired_plan/);            // plan 侧不标

    const rm = readFileSync(join(lore, 'wiki', 'docs', 'ROADMAP.md'), 'utf8');
    assert.match(rm, /^group: 项目状态$/m);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

（`readFileSync` 若未 import，在测试文件顶部 node:fs import 里补。）

- [ ] **Step 2: 跑红** —— Run: `node --test test/docs.test.js`，Expected: FAIL（frontmatter 无 group）

- [ ] **Step 3: 实现** —— `lib/docs.js` 两处：

`renderDocsPage` 的 frontmatter 模板行替换为：

```js
  const fm = `---\ntitle: ${spec.title}\nsummary: ${spec.summary}\nsource_path: ${spec.sourcePath}\nlast_updated: ${spec.date}\ngroup: ${spec.group ?? docGroup(spec.sourcePath)}${spec.pairedPlan ? `\npaired_plan: ${spec.pairedPlan}` : ''}\n---`;
```

`buildDocsAxis` 里 `specs.sort(...)` 之前加两行：

```js
  for (const s of specs) s.group = docGroup(s.sourcePath);
  pairDocs(specs);
```

- [ ] **Step 4: 跑绿** —— Run: `node --test test/docs.test.js`，Expected: PASS（含原有 docs 用例——`renderDocsPage` 旧断言若钉了 frontmatter 完整形状需同步加 group 行；意图不变）

- [ ] **Step 5: Commit**

```bash
git add lib/docs.js test/docs.test.js
git commit -m "feat(docs): materialize group + paired_plan into docs-page frontmatter"
```

---

## Task 3: `manifest.js` —— frontmatter 透传 + docs 组排序

**Files:**
- Modify: `lib/manifest.js`
- Modify: `test/manifest.test.js`

- [ ] **Step 1: 写失败测试** —— `test/manifest.test.js` 末尾追加（fixture helper 沿用文件内既有模式：mkdtemp + wiki 目录 + writeFileSync 页 + emitManifest 直调）：

```js
test('emitManifest: docs 轴组间固定序 + 组内时间降序 + paired_plan 透传', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mani-docs-'));
  try {
    const wikiDir = join(root, 'wiki');
    mkdirSync(join(wikiDir, 'docs'), { recursive: true });
    const page = (id, group, date, extra = '') =>
      writeFileSync(join(wikiDir, 'docs', `${id}.md`),
        `---\ntitle: ${id}\nsummary: s\nlast_updated: ${date}\ngroup: ${group}\n${extra}---\nbody\n`);
    page('old-spec', '设计与计划', '2026-06-01', 'paired_plan: old-plan\n');
    page('old-plan', '设计与计划', '2026-06-01');
    page('new-spec', '设计与计划', '2026-06-09');
    page('changelog', '项目状态', '2026-06-07');
    page('ROADMAP', '项目状态', '');
    page('a-note', 'notes', '2026-06-02');
    const manifest = emitManifest({
      wikiDir, currentSha: 'cur', countCommitsSince: () => 0, now: 't0',
      axes: [{ id: 'docs', label: 'Docs' }],
    });
    const docs = manifest.axes.find(a => a.id === 'docs');
    assert.deepEqual(docs.pages.map(p => p.id),
      ['changelog', 'ROADMAP', 'new-spec', 'old-plan', 'old-spec', 'a-note']);
      // 项目状态(时间降序,无日期垫底) → 设计与计划(同上;同日期 id 字母序) → notes
    assert.equal(docs.pages.find(p => p.id === 'old-spec').paired_plan, 'old-plan');
    assert.equal(docs.pages.find(p => p.id === 'changelog').paired_plan, '');
    assert.equal(docs.pages.find(p => p.id === 'changelog').group, '项目状态');   // frontmatter 优先
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑红** —— Run: `node --test test/manifest.test.js`，Expected: FAIL（docs 仍纯时间排序，changelog 不在首位；paired_plan undefined）

- [ ] **Step 3: 实现** —— `lib/manifest.js` 两处：

`pageEntry` 的 return 对象里：

```js
    group: data.group ?? pageGroups[id] ?? '',
    paired_plan: data.paired_plan ?? '',
```

（`group` 行是替换现有 `group: pageGroups[id] ?? '',`；`paired_plan` 是新增行。）

`emitManifest` 里现有 docs 排序块（`if (ax.id === 'docs') { pages.sort(...) }`）替换为：

```js
      if (ax.id === 'docs') {
        const GROUP_RANK = { '项目状态': 0, '设计与计划': 1, 'notes': 2 };   // 其他值 3 垫底防御
        pages.sort((a, b) =>
          ((GROUP_RANK[a.group] ?? 3) - (GROUP_RANK[b.group] ?? 3))
          || (b.last_updated || '').localeCompare(a.last_updated || '')
          || a.id.localeCompare(b.id));
      }
```

- [ ] **Step 4: 跑绿** —— Run: `node --test test/manifest.test.js`，Expected: PASS（原有 docs 时间降序用例若无 group 字段 → 全部空 group 同 rank 3 → 退化纯时间序，向后兼容不破）

- [ ] **Step 5: Commit**

```bash
git add lib/manifest.js test/manifest.test.js
git commit -m "feat(manifest): docs-axis group ordering + frontmatter group/paired_plan passthrough"
```

---

## Task 4: `shell.mjs` —— `buildDocsRows`

**Files:**
- Modify: `site/shell.mjs`
- Modify: `test/shell.test.js`

- [ ] **Step 1: 写失败测试** —— `test/shell.test.js` 末尾追加：

```js
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
```

- [ ] **Step 2: 跑红** —— Run: `node --test test/shell.test.js`，Expected: FAIL（buildDocsRows 未导出）

- [ ] **Step 3: 实现** —— `site/shell.mjs` 末尾追加：

```js
// docs 轴侧栏模型（spec 2026-06-10-lore-docs-axis-regroup）：按 manifest 给定顺序分段
// （排序单一来源在 manifest），配对行合并、被配对 plan 剔除、显示名剥模板尾巴。
export function buildDocsRows(pages) {
  const byId = new Map(pages.map(p => [p.id, p]));
  const paired = new Set(pages.filter(p => p.paired_plan && byId.has(p.paired_plan)).map(p => p.paired_plan));
  const stripTail = t => (t ?? '')
    .replace(/\s*(?:——|—|--)\s*设计\s*$/, '')
    .replace(/\s+Implementation\s+Plan\s*$/i, '')
    .trim();
  const groups = [];
  let cur = null;
  for (const p of pages) {
    if (paired.has(p.id)) continue;                       // 被配对的 plan 不占行（页本体仍可直链/搜索）
    const g = p.group || '项目状态';
    if (!cur || cur.group !== g) {
      cur = { group: g, collapsed: g !== '项目状态', rows: [] };
      groups.push(cur);
    }
    const planPage = p.paired_plan ? (byId.get(p.paired_plan) ?? null) : null;
    cur.rows.push({ page: p, planPage, displayTitle: stripTail(p.title) });
  }
  return groups;
}
```

- [ ] **Step 4: 跑绿** —— Run: `node --test test/shell.test.js`，Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add site/shell.mjs test/shell.test.js
git commit -m "feat(shell): buildDocsRows (group segmentation, spec/plan pairing, title tail-strip)"
```

---

## Task 5: 壳渲染 —— docs 分支 + 折叠 + 搜索穿透

**Files:**
- Modify: `site/index.html`

> 壳 UI 无单测（逻辑已在 Task 4 测）；语法自检 + dogfood 双 cp 验收。**颜色只用 var(--xxx)。**

- [ ] **Step 1: CSS** —— `.links .grp` 规则之后追加：

```css
  .grp-toggle { cursor: pointer; user-select: none; }
  .grp-toggle:hover { color: var(--fg); }
  .grp-toggle .caret { display: inline-block; width: 10px; font-size: 9px; }
  .dgrp.closed .grp-rows { display: none; }
  #sidebar.searching .dgrp .grp-rows { display: block; }   /* 搜索穿透：临时展开全部组 */
  #sidebar.searching .grp-toggle { display: none; }        /* 搜索态平铺命中行，组头让位 */
  .plan-badge { display: inline-block; padding: 0 7px; border-radius: 99px; font-size: 10px;
    border: 1px solid var(--accent-dim); color: var(--accent); margin-left: 6px; cursor: pointer; }
  .plan-badge:hover { border-color: var(--accent); background: var(--panel); }
```

- [ ] **Step 2: import 扩展** —— `<script type="module">` 的 import 块加 `buildDocsRows`：

```js
  baseFromPathname, buildConsoleModel, pollDecide, buildDocsRows,
```

- [ ] **Step 3: docs 渲染分支** —— `buildSidebar` 里 `pagesHtml` 函数替换为（component 分支保持现状，新增 docs 分支）：

```js
  const DOCS_ICON = { '项目状态': '📌', '设计与计划': '📐', 'notes': '📝' };
  const docsGroupsState = () => {
    try { return JSON.parse(localStorage.getItem('lore-docs-groups') || '{}'); } catch { return {}; }
  };
  const docsHtml = (ax) => {
    const opened = docsGroupsState();
    return buildDocsRows(ax.pages).map(g => {
      const open = g.group in opened ? !!opened[g.group] : !g.collapsed;
      const rows = g.rows.map(r => `<a href="#${ax.id}/${r.page.id}" data-key="${ax.id}/${r.page.id}"
         data-search="${(r.page.title + ' ' + (r.page.summary || '')).toLowerCase()}">
        ${r.displayTitle}${r.planPage ? `<span class="plan-badge" data-plan="${ax.id}/${r.planPage.id}" title="查看实施计划">plan</span>` : ''}${r.page.last_updated ? `<span class="when">📅 ${r.page.last_updated}</span>` : ''}</a>`).join('');
      return `<div class="dgrp${open ? '' : ' closed'}" data-group="${g.group}">
        <div class="grp grp-toggle"><span class="caret">${open ? '▾' : '▸'}</span>${DOCS_ICON[g.group] ?? ''} ${g.group} (${g.rows.length})</div>
        <div class="grp-rows">${rows}</div>
      </div>`;
    }).join('');
  };
  const pagesHtml = (ax) => {
    if (ax.id === 'docs') return docsHtml(ax);
    if (ax.id !== 'component') return ax.pages.map(p => linkHtml(ax, p)).join('');
    let out = '', lastGroup = null;                          // component 轴：按连续 group 插小标题
    for (const p of ax.pages) {
      const g = p.group || '';
      if (g && g !== lastGroup) out += `<div class="grp">▸ ${g}</div>`;
      lastGroup = g;
      out += linkHtml(ax, p);
    }
    return out;
  };
```

（docs 行不再走 `linkHtml`——docs 的 `when` 日期与 plan 徽标都在 docsHtml 模板里；linkHtml 的 `ax.id === 'docs'` when 分支随之失效但保留无害——它只对 docs 轴生效而 docs 已不走它。为洁净可顺手把 linkHtml 里 `${ax.id === 'docs' && p.last_updated ? ... : ''}` 删掉。）

- [ ] **Step 4: toggle + 徽标事件** —— `buildSidebar` 末尾（`.axis-h` 绑定之后）追加：

```js
  nav.querySelectorAll('.grp-toggle').forEach(h => h.onclick = () => {
    const box = h.parentElement;
    const nowOpen = box.classList.toggle('closed') === false;
    h.querySelector('.caret').textContent = nowOpen ? '▾' : '▸';
    const st = (() => { try { return JSON.parse(localStorage.getItem('lore-docs-groups') || '{}'); } catch { return {}; } })();
    st[box.dataset.group] = nowOpen;
    localStorage.setItem('lore-docs-groups', JSON.stringify(st));
  });
  nav.querySelectorAll('.plan-badge').forEach(b => b.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();               // 别触发外层 <a> 的 spec 跳转
    location.hash = b.dataset.plan;
  });
```

- [ ] **Step 5: 搜索穿透** —— `wireSearch` 的 input handler 开头加一行：

```js
    document.getElementById('sidebar').classList.toggle('searching', !!term);
```

（CSS `.searching` 已让全部组展开+组头隐藏；非命中行仍被现有 hidden 过滤掉；清空搜索 → class 移除 → 回 localStorage/默认折叠态。）

- [ ] **Step 6: 语法自检 + dogfood 双 cp**

```bash
node -e "const h=require('fs').readFileSync('site/index.html','utf8');const i=h.indexOf('<script type=\"module\">');const j=h.lastIndexOf('</script>');try{new Function(h.slice(i+22,j).replace(/import[^;]+;/g,''));console.log('JS OK')}catch(e){console.log('JS ERR:',e.message)}"
node -e "const f=require('fs');f.copyFileSync('site/index.html','.lore/site/index.html');f.copyFileSync('site/shell.mjs','.lore/site/shell.mjs');console.log('dogfood synced x2')"
node --test test/shell.test.js 2>&1 | tail -3
```

Expected: `JS OK` + `dogfood synced x2` + 测试绿。

- [ ] **Step 7: Commit**

```bash
git add site/index.html .lore/site/index.html .lore/site/shell.mjs
git commit -m "feat(shell): docs sidebar groups (pinned status, collapsible, plan badge, search punch-through)"
```

---

## Task 6: dogfood 验收 + ROADMAP + 全量回归

**Files:**
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: finalize 重建 dogfood**

```bash
node lib/sync.js finalize .lore >/dev/null && node -e "
const m = require('./.lore/wiki/.manifest.json');
const d = m.axes.find(a => a.id === 'docs');
const head = d.pages.slice(0, 4).map(p => p.id + ':' + p.group);
console.log(head.join('  '));
console.log('paired specs:', d.pages.filter(p => p.paired_plan).length);
"
```

Expected: 前几页为 `changelog:项目状态` / `ROADMAP:项目状态` 开头；`paired specs: 20+`（dogfood 同名 spec/plan 对数）。

- [ ] **Step 2: 浏览器验收（Preview 或本地 serve，七项清单）**

1. 侧栏 docs 轴：📌 项目状态（changelog/ROADMAP）置顶展开；📐 设计与计划默认折叠（组头含计数）；📝 notes 折叠。
2. 展开 📐 → 配对行（spec 标题已剥尾 + `plan` 徽标）；点徽标 → 跳 plan 页；点行 → 跳 spec 页。
3. 折叠态刷新后保持（localStorage）。
4. 搜索「console」→ 折叠组自动展开仅显命中行；清空 → 恢复折叠。
5. 被配对 plan 不占行，但直链 `#docs/superpowers-plans-...` 仍可达、搜索可命中。
6. 三主题切换：组头/徽标配色跟随，无硬编码色。
7. component 轴分组（▸ 捕获/▸ 合成）行为不变（回归）。

- [ ] **Step 3: ROADMAP 标记** —— 「壳呈现 ✅（C-呈现 ①）」节末尾的余项句中「docs 轴重构」改为指向本spec的已实现说明，并在该节后新增：

```markdown
### docs 轴重构（分组置顶 + feature 配对 + 默认折叠）✅ 已实现（C-呈现 ②）
- 已实现：docs 轴侧栏三组分流——「📌 项目状态」（changelog/ROADMAP/pitfalls）置顶常开、「📐 设计与计划」spec↔plan 按 date+slug 配对成行（plan 徽标直达）默认折叠、「📝 notes」折叠；折叠态 localStorage 记忆；搜索穿透折叠组。group/paired_plan 由 docs.js 物化进 frontmatter，manifest 组间排序（单一来源）。无 superpowers 结构 repo 零影响。设计见 `docs/superpowers/specs/2026-06-10-lore-docs-axis-regroup-design.md`。
```

- [ ] **Step 4: 全量回归**

Run: `node --test`
Expected: PASS —— 0 failures（基线 338 + 本轮新增 ≈ 345+；记录实际数）。

- [ ] **Step 5: Commit**

```bash
git add docs/ROADMAP.md .lore/wiki .lore/journal .lore/site
git commit -m "docs(roadmap): docs-axis regroup done; dogfood rebuilt with grouped docs"
```

---

## Self-Review（已执行）

**1. Spec 覆盖：** 决策表 10 项——分组启发式→T1；配对规则→T1；frontmatter 落点→T2；group frontmatter 优先+paired_plan 透传→T3；组间排序单一来源→T3；配对行显示名剥尾→T4；按 manifest 序分段→T4；折叠默认+localStorage→T5；搜索穿透→T5；主题硬约束→T5 CSS+验收6。dogfood 清单→T6（spec 测试节 6-9 全对应）。无缺口。

**2. Placeholder 扫描：** 每步完整代码/命令/期望输出。无 TBD。

**3. 类型一致性：** `docGroup(sourcePath) → string`（T1）↔ T2 `spec.group` 赋值；`pairDocs` 标 `s.pairedPlan`（驼峰，T1/T2 实现与测试一致）→ frontmatter 键 `paired_plan`（蛇形，T2 模板）→ manifest entry `paired_plan`（T3）→ `buildDocsRows` 读 `p.paired_plan`（T4）——物化边界处驼峰转蛇形是显式的（T2 模板字符串），两侧测试各自钉死。`buildDocsRows` 返回 `{group, collapsed, rows:[{page, planPage, displayTitle}]}`（T4）↔ T5 `docsHtml` 消费同名字段。localStorage key `lore-docs-groups`（T5 两处一致）。

**4. 风险复核：** 嵌套 a 非法 → 徽标 span+stopPropagation（T5 Step 4）。linkHtml 的 docs when 分支失效处理已注明。原有 docs 测试若钉 frontmatter 形状 → T2 Step 4 注明同步。原有 manifest docs 排序测试 → T3 Step 4 注明空 group 退化兼容。

