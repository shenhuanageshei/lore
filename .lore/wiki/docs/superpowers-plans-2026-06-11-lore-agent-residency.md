---
title: lore agent 常驻消费（resident-mode + 节级检索 + deep 补录）Implementation Plan
summary: > **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [...
source_path: docs/superpowers/plans/2026-06-11-lore-agent-residency.md
last_updated: 2026-06-11
group: 设计与计划
---
> 源文档：`docs/superpowers/plans/2026-06-11-lore-agent-residency.md`

# lore agent 常驻消费（resident-mode + 节级检索 + deep 补录）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 冷启动 agent 自动被引导用 lore（CLAUDE.md 注入 + MCP 注册），且用得起（节级检索 + agent 视图省一半 token）；deep 页补上 B1/B2 新模块。

**Architecture:** 新 `lib/resident.js`（CLAUDE.md 标记节注入/刷新/卸载 + `.mcp.json` merge，纯函数+路径注入）；`manifest.js` pageEntry 加 `sections` 节索引；`ask.js` 节级命中+切片；`mcp.js` 工具描述触发词重写 + `lore_page` 的 `view=agent`/`section` 参数 + `lore_ask` 带回节切片；init/finalize 接线；dogfood deep 补 syncstate/runner。

**Tech Stack:** Node 内置 + `node --test`。零外部依赖。

**Spec:** `docs/superpowers/specs/2026-06-11-lore-agent-residency-design.md`（设计已批，含冷启动实验基线 65.6k tokens）。

**纪律提醒：** 测试代码用 Edit/Write（不用 heredoc）；依赖 Edit 的 Bash 不并行发。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `lib/resident.js` | 新增 | `residentSection`（动态文本）/ `installResident` / `refreshResident` / `removeResident` / `mergeMcpConfig` |
| `test/resident.test.js` | 新增 | 上述全分支 |
| `lib/section.js` | 新增 | `extractSections(body)` / `sliceSection(text, heading)` / `agentView(text)`——节操作纯函数（manifest/ask/mcp 三消费者共享，不塞进任一） |
| `test/section.test.js` | 新增 | 节提取/切片/agent 视图 |
| `lib/manifest.js` | 修改 | `pageEntry` 加 `sections`（调 extractSections） |
| `test/manifest.test.js` | 扩展 | sections 形状 |
| `lib/ask.js` | 修改 | `searchPages` 节级命中；CLI 输出升级 |
| `test/ask.test.js` | 扩展 | 节级命中+切片 |
| `lib/mcp.js` | 修改 | TOOLS 描述重写；`lore_ask` 带节切片；`lore_page` `view`/`section` 参数 |
| `test/mcp.test.js` | 扩展 | 新参数/新输出形状 |
| `lib/init.js` | 修改 | init 主流程挂 `installResident`+`mergeMcpConfig`（`--no-resident`/config 跳过） |
| `lib/sync.js` | 修改 | finalize 尾部挂 `refreshResident` |
| `lib/config.js` | 修改 | `parseConfigResident(text) → bool`（默认 true） |
| `commands/sync.md` | 修改 | 机制档⑤勾稽 spec 决策的指引一句 |
| `.lore/config.yml` | 修改 | deep 合成组补 `syncstate, runner` |
| `docs/ROADMAP.md` | 修改 | resident-mode 标记 |

---

## Task 1: `lib/section.js` —— 节操作纯函数

**Files:** Create `lib/section.js`、`test/section.test.js`

- [ ] **Step 1: 写失败测试** —— 创建 `test/section.test.js`：

```js
// test/section.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSections, sliceSection, agentView } from '../lib/section.js';

const PAGE = `---
title: X
summary: s
---
# component: x

## 概览

**一句话**：比喻给人看的。

一个场景看懂。

## 机制详解

<details>
<summary><b>① 接口 / 能力面</b> —— 导出与签名</summary>

| 导出 | 签名 |
|---|---|
| f | (a) → b |

</details>

<details>
<summary><b>⑤ 边界 / 坑</b> —— 查 BUG 必看</summary>

- 坑一：撕裂读由 notify 兜底。

</details>

## 依赖 / 邻居

- 依赖：a · b

## Decision history

<!-- LORE_JOURNAL:START -->
- old
<!-- LORE_JOURNAL:END -->
`;

test('extractSections: ##/### 标题 + ①-⑧ <summary> 都算节（带行号）', () => {
  const s = extractSections(PAGE);
  const headings = s.map(x => x.heading);
  assert.ok(headings.includes('概览'));
  assert.ok(headings.includes('机制详解'));
  assert.ok(headings.includes('① 接口 / 能力面'));
  assert.ok(headings.includes('⑤ 边界 / 坑'));
  assert.ok(headings.includes('依赖 / 邻居'));
  for (const x of s) assert.equal(typeof x.line, 'number');
  assert.deepEqual(extractSections('no headings at all'), []);
});

test('sliceSection: 切到下一同级/更高级标题；<summary> 节切到 </details>；未知节 → null', () => {
  const gai = sliceSection(PAGE, '概览');
  assert.match(gai, /比喻给人看的/);
  assert.doesNotMatch(gai, /机制详解/);
  const pit = sliceSection(PAGE, '⑤ 边界 / 坑');
  assert.match(pit, /撕裂读由 notify 兜底/);
  assert.doesNotMatch(pit, /接口 \/ 能力面/);
  assert.equal(sliceSection(PAGE, '不存在的节'), null);
});

test('agentView: 剥「## 概览」到「## 机制详解」之间的人读内容；非两档页原样', () => {
  const v = agentView(PAGE);
  assert.doesNotMatch(v, /比喻给人看的/);
  assert.match(v, /机制详解/);
  assert.match(v, /撕裂读由 notify 兜底/);          // 机制档保留
  assert.match(v, /LORE_JOURNAL:START/);             // 决策史保留
  assert.match(v, /^---\ntitle: X/);                 // frontmatter 保留
  const plain = '# 普通页\n\n没有两档结构。\n';
  assert.equal(agentView(plain), plain);             // 容错：原样
});
```

- [ ] **Step 2: 跑红** —— `node --test test/section.test.js` → FAIL（模块不存在）

- [ ] **Step 3: 实现** —— 创建 `lib/section.js`：

```js
// lib/section.js —— wiki 页节级操作（spec 2026-06-11-lore-agent-residency）。
// manifest（节索引）/ ask（节命中+切片）/ mcp（view=agent / section 参数）三消费者共享。
// 全部机械文本操作：无标题/非两档页退化原样，不崩。

const MD_HEADING = /^(#{2,3})\s+(.+?)\s*$/;                       // ## / ### 标题
const SUMMARY_HEADING = /<summary><b>([①②③④⑤⑥⑦⑧][^<]*)<\/b>/;   // 机制档折叠节

// 提取节列表 [{heading, line}]（line 从 0 计，指标题所在行）。
export function extractSections(text) {
  const lines = (text ?? '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(MD_HEADING);
    if (m) { out.push({ heading: m[2], line: i }); continue; }
    const s = lines[i].match(SUMMARY_HEADING);
    if (s) out.push({ heading: s[1].trim(), line: i });
  }
  return out;
}

// 取单节内容：md 标题切到下一同级/更高级标题；<summary> 节切到 </details>。未知节 → null。
export function sliceSection(text, heading) {
  const lines = (text ?? '').split('\n');
  const sections = extractSections(text);
  const hit = sections.find(s => s.heading === heading);
  if (!hit) return null;
  const startLine = lines[hit.line];
  const md = startLine.match(MD_HEADING);
  let end = lines.length;
  if (md) {
    const level = md[1].length;
    for (let i = hit.line + 1; i < lines.length; i++) {
      const m = lines[i].match(MD_HEADING);
      if (m && m[1].length <= level) { end = i; break; }
    }
  } else {
    for (let i = hit.line + 1; i < lines.length; i++) {
      if (lines[i].includes('</details>')) { end = i + 1; break; }
    }
  }
  return lines.slice(hit.line, end).join('\n');
}

// agent 视图：剥「## 概览」（含）到「## 机制详解」（不含）——比喻/场景是给人的，
// agent 只要机制档+依赖+决策史。无两档结构（缺任一标题）→ 原样返回。
export function agentView(text) {
  const lines = (text ?? '').split('\n');
  let start = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+概览\s*$/.test(lines[i]) && start === -1) start = i;
    else if (/^##\s+机制详解\s*$/.test(lines[i])) { end = i; break; }
  }
  if (start === -1 || end === -1 || end <= start) return text;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}
```

- [ ] **Step 4: 跑绿** —— PASS（3 tests）
- [ ] **Step 5: Commit** —— `git add lib/section.js test/section.test.js && git commit -m "feat(section): section extraction/slicing/agent-view pure functions"`

---

## Task 2: manifest 节索引

**Files:** Modify `lib/manifest.js`、`test/manifest.test.js`

- [ ] **Step 1: 写失败测试** —— `test/manifest.test.js` 末尾追加：

```js
test('pageEntry: sections 节索引进 manifest（##/### + ①-⑧）', () => {
  const wiki = mkdtempSync(join(tmpdir(), 'lore-sec-'));
  try {
    mkdirSync(join(wiki, 'component'), { recursive: true });
    writeFileSync(join(wiki, 'component', 'x.md'),
      '---\ntitle: X\ncode_sha: c\n---\n# x\n\n## 概览\n\np\n\n## 机制详解\n\n<details>\n<summary><b>① 接口</b></summary>\nb\n</details>\n');
    const m = emitManifest({ wikiDir: wiki, currentSha: 'c', countCommitsSince: () => 0, now: 't' });
    const page = m.axes.find(a => a.id === 'component').pages[0];
    assert.deepEqual(page.sections.map(s => s.heading), ['概览', '机制详解', '① 接口']);
    assert.equal(typeof page.sections[0].line, 'number');
  } finally { rmSync(wiki, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现** —— `lib/manifest.js`：import 加 `import { extractSections } from './section.js';`；`pageEntry` 里 `const { data } = parseFrontmatter(text);` 改为 `const { data, body } = parseFrontmatter(text);`，return 对象 `paired_plan` 行后加：

```js
    sections: extractSections(body),
```

- [ ] **Step 4: 跑绿** —— `node --test test/manifest.test.js test/shell.test.js test/server.test.js` 全绿（sections 是纯新增字段，向后兼容）
- [ ] **Step 5: Commit** —— `git add lib/manifest.js test/manifest.test.js && git commit -m "feat(manifest): per-page section index (headings + mechanism-detail summaries)"`

---

## Task 3: ask v2 节级命中

**Files:** Modify `lib/ask.js`、`test/ask.test.js`

- [ ] **Step 1: 写失败测试** —— `test/ask.test.js` 末尾追加（先读该文件确认既有 import/fixture 风格，沿用）：

```js
test('searchPages: 节级命中（heading 含词）→ 带 section 字段，分数并入', () => {
  const manifest = { axes: [{ id: 'component', pages: [
    { id: 'fp', title: '指纹层', summary: '', path: 'component/fp.md',
      sections: [{ heading: '⑤ 边界 / 坑', line: 30 }, { heading: '概览', line: 5 }] },
  ] }] };
  const hits = searchPages(manifest, '边界');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].section, '⑤ 边界 / 坑');     // 命中节
  assert.ok(hits[0].score >= 1);
  const pageHit = searchPages(manifest, '指纹');
  assert.equal(pageHit[0].section, undefined);       // 页级命中无 section
});
```

- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现** —— `lib/ask.js` `searchPages` 的 for 循环体改为：

```js
    for (const p of axis.pages ?? []) {
      const hay = `${p.title ?? ''} ${p.summary ?? ''} ${p.id}`.toLowerCase();
      const pageScore = terms.filter(t => hay.includes(t)).length;
      // 节级命中：heading 含词 → 直达该节（agent 链路 lore_page(section) 只取节，省整页 token）
      let bestSection = null, bestSectionScore = 0;
      for (const s of p.sections ?? []) {
        const sc = terms.filter(t => s.heading.toLowerCase().includes(t)).length;
        if (sc > bestSectionScore) { bestSectionScore = sc; bestSection = s.heading; }
      }
      const score = pageScore + bestSectionScore;
      if (score > 0) {
        const hit = { axis: axis.id, id: p.id, title: p.title, summary: p.summary, path: p.path, score };
        if (bestSection) hit.section = bestSection;
        out.push(hit);
      }
    }
```

（顺手把搜索域补上 `p.id`——英文 slug 可搜，与壳侧栏同款教训。）CLI 输出行改为：

```js
    for (const h of hits) console.log(`${h.path}${h.section ? `#${h.section}` : ''}  [${h.axis}] ${h.title} (score ${h.score})`);
```

- [ ] **Step 4: 跑绿** —— `node --test test/ask.test.js test/mcp.test.js` 全绿
- [ ] **Step 5: Commit** —— `git add lib/ask.js test/ask.test.js && git commit -m "feat(ask): section-level hits (+id in search haystack)"`

---

## Task 4: mcp —— 描述触发词 + view/section 参数 + ask 带切片

**Files:** Modify `lib/mcp.js`、`test/mcp.test.js`

- [ ] **Step 1: 写失败测试** —— 先读 `test/mcp.test.js` 看既有「起 server 喂 JSON-RPC」模式（spawn lib/mcp.js + 写 stdin 读 stdout），沿用追加：

```js
test('lore_page: view=agent 剥概览档；section 取单节；lore_ask 命中带 section', async () => {
  // fixture：建临时 .lore/wiki（两档页 + manifest + graph），cwd 切过去 spawn mcp.js
  // （沿用本文件既有 fixture helper；页面 body 含 ## 概览 / ## 机制详解 / <summary><b>① 接口</b></summary>）
  // 断言三件：
  // 1. tools/list 的 lore_ask description 含「优先」（触发词重写生效）
  // 2. lore_page {id, view:'agent'} 返回 content 不含概览正文、含机制档
  // 3. lore_page {id, section:'① 接口'} 只返回该节
  // 4. lore_ask {query:'接口'} 命中带 section 与 slice 字段（slice = 该节内容）
});
```

（实测落地时按既有 helper 写实断言——上面是意图清单，执行者展开为真代码；mcp 测试文件已有完整的 spawn/rpc helper，扩展成本低。）

- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现** —— `lib/mcp.js`：

import 加 `import { sliceSection, agentView } from './section.js';`

TOOLS 重写（触发词优化，spec A2 文案）：

```js
const TOOLS = [
  { name: 'lore_ask', description: '理解本仓库架构、查找模块职责、查决策原因时优先使用：关键词检索 wiki，返回命中页/节（含节内容切片，比读源码省 token，且含源码没有的决策史）',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'lore_page', description: '取单个 wiki 页。id = page:<axis>/<id> 或 wiki 相对 path；section 参数只取单节；view="agent" 跳过人读概览档（省约 40% token）',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, section: { type: 'string' }, view: { type: 'string', enum: ['agent', 'full'] } }, required: ['id'] } },
  { name: 'lore_neighbors', description: '图谱扩展：给定页/组件节点，返回 1-hop 邻居（依赖组件、相关决策原子、同 flow 页）',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];
```

`callTool` 的 lore_ask 分支：

```js
  if (name === 'lore_ask') {
    const manifest = readJson('.manifest.json');
    const hits = searchPages(manifest, args.query ?? '');
    return hits.slice(0, 8).map(h => {
      const entry = { id: `page:${h.axis}/${h.id}`, title: h.title, axis: h.axis, score: h.score };
      if (h.section) {
        entry.section = h.section;
        try { entry.slice = sliceSection(readFileSync(join(wikiDir, h.path), 'utf8'), h.section) ?? undefined; }
        catch { /* 页文件缺失 → 无切片，条目仍返回 */ }
      }
      return entry;
    });
  }
```

lore_page 分支：

```js
  if (name === 'lore_page') {
    const path = resolvePagePath(readJson('.graph.json'), args.id ?? '');
    if (!path) throw new Error(`unknown page id: ${args.id}`);
    const abs = join(wikiDir, path);
    if (!existsSync(abs)) throw new Error(`page file not found: ${path}`);
    let content = readFileSync(abs, 'utf8');
    if (args.section) {
      const s = sliceSection(content, args.section);
      if (s == null) throw new Error(`unknown section: ${args.section}`);
      content = s;
    } else if (args.view === 'agent') {
      content = agentView(content);
    }
    return { id: args.id, path, content };
  }
```

- [ ] **Step 4: 跑绿** —— `node --test test/mcp.test.js`
- [ ] **Step 5: Commit** —— `git add lib/mcp.js test/mcp.test.js && git commit -m "feat(mcp): trigger-word descriptions, lore_page view=agent/section, lore_ask section slices"`

---

## Task 5: `lib/resident.js` —— CLAUDE.md 注入 + .mcp.json merge

**Files:** Create `lib/resident.js`、`test/resident.test.js`；Modify `lib/config.js`

- [ ] **Step 1: 写失败测试** —— 创建 `test/resident.test.js`：

```js
// test/resident.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { residentSection, installResident, refreshResident, removeResident, mergeMcpConfig } from '../lib/resident.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-res-')); }
const STATS = { pages: 40, deepPages: 8, updated: '2026-06-11' };

test('residentSection: 动态状态进文案 + 标记包裹', () => {
  const s = residentSection(STATS);
  assert.match(s, /<!-- LORE_RESIDENT:START -->/);
  assert.match(s, /40 页 · 8 个组件深度页 · 最后更新 2026-06-11/);
  assert.match(s, /lore_ask/);
  assert.match(s, /<!-- LORE_RESIDENT:END -->/);
});

test('installResident: CLAUDE.md 不存在 → 创建（仅标记节）；已存在 → 追加；重复跑幂等替换', () => {
  const root = tmp();
  try {
    installResident(root, STATS);
    const t1 = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    assert.match(t1, /LORE_RESIDENT:START/);
    writeFileSync(join(root, 'CLAUDE.md'), '# 用户自己的内容\n\n' + t1);
    installResident(root, { ...STATS, pages: 41 });
    const t2 = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    assert.match(t2, /用户自己的内容/);                    // 用户内容保留
    assert.match(t2, /41 页/);
    assert.equal((t2.match(/LORE_RESIDENT:START/g)).length, 1);   // 不重复注入
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refreshResident: 有标记节才更新；无 CLAUDE.md / 无标记节 → no-op 不创建', () => {
  const root = tmp();
  try {
    assert.equal(refreshResident(root, STATS), false);     // 无文件 no-op
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false);
    writeFileSync(join(root, 'CLAUDE.md'), '# mine\n');
    assert.equal(refreshResident(root, STATS), false);     // 无标记节 no-op
    installResident(root, STATS);
    assert.equal(refreshResident(root, { ...STATS, pages: 99 }), true);
    assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /99 页/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('removeResident: 删标记节留其余；mergeMcpConfig: 创建/保既有/幂等', () => {
  const root = tmp();
  try {
    writeFileSync(join(root, 'CLAUDE.md'), '# keep\n');
    installResident(root, STATS);
    removeResident(root);
    const t = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    assert.match(t, /keep/);
    assert.doesNotMatch(t, /LORE_RESIDENT/);

    mergeMcpConfig(root, 'D:/engine/lib/mcp.js');
    const m1 = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    assert.equal(m1.mcpServers.lore.command, 'node');
    assert.deepEqual(m1.mcpServers.lore.args, ['D:/engine/lib/mcp.js']);
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' }, lore: { command: 'old' } } }));
    mergeMcpConfig(root, 'D:/engine/lib/mcp.js');
    const m2 = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    assert.equal(m2.mcpServers.other.command, 'x');        // 既有别家 server 保留
    assert.equal(m2.mcpServers.lore.command, 'node');      // lore 条目刷新
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现** —— 创建 `lib/resident.js`：

```js
// lib/resident.js —— agent 常驻消费的触发面（spec 2026-06-11-lore-agent-residency）。
// CLAUDE.md 是用户文件：只动 LORE_RESIDENT 标记节内、幂等替换、可一键卸载——侵入克制。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const START = '<!-- LORE_RESIDENT:START -->';
const END = '<!-- LORE_RESIDENT:END -->';
const BLOCK_RE = /<!--\s*LORE_RESIDENT:START\s*-->[\s\S]*?<!--\s*LORE_RESIDENT:END\s*-->/;

export function residentSection({ pages, deepPages, updated }) {
  return `${START}
## lore wiki（本仓库的活文档）

本 repo 由 lore 维护多轴 wiki（${pages} 页 · ${deepPages} 个组件深度页 · 最后更新 ${updated}）。
**理解架构、查找模块职责、查决策原因时，先查 wiki 再 grep 源码**：
- MCP 工具：\`lore_ask\`（关键词检索，返回命中节）→ \`lore_page\`（取单页/单节，\`view=agent\` 省 40% token）→ \`lore_neighbors\`（图谱扩展）
- 无 MCP 时：读 \`.lore/wiki/INDEX.md\` 定位 → 读目标页
- 决策史/踩坑/「为什么不那样做」只有 wiki 有——源码注释和 git log 都查不动这类问题。
${END}`;
}

// init 时注入：无 CLAUDE.md 创建；有则替换标记节或末尾追加。幂等。
export function installResident(repoRoot, stats) {
  const p = join(repoRoot, 'CLAUDE.md');
  const block = residentSection(stats);
  if (!existsSync(p)) { writeFileSync(p, block + '\n'); return; }
  const text = readFileSync(p, 'utf8');
  writeFileSync(p, BLOCK_RE.test(text)
    ? text.replace(BLOCK_RE, block)
    : text.replace(/\n*$/, '\n\n') + block + '\n');
}

// finalize 末尾刷新：仅当文件存在且已有标记节（用户关掉/删掉 = 尊重，不复活）。
export function refreshResident(repoRoot, stats) {
  const p = join(repoRoot, 'CLAUDE.md');
  if (!existsSync(p)) return false;
  const text = readFileSync(p, 'utf8');
  if (!BLOCK_RE.test(text)) return false;
  writeFileSync(p, text.replace(BLOCK_RE, residentSection(stats)));
  return true;
}

export function removeResident(repoRoot) {
  const p = join(repoRoot, 'CLAUDE.md');
  if (!existsSync(p)) return;
  const text = readFileSync(p, 'utf8');
  if (!BLOCK_RE.test(text)) return;
  writeFileSync(p, text.replace(BLOCK_RE, '').replace(/\n{3,}/g, '\n\n'));
}

// .mcp.json merge：不覆盖其他 server；lore 条目以本次为准（引擎路径与 hook 同策略——挪位置重跑 init）。
export function mergeMcpConfig(repoRoot, mcpJsPath) {
  const p = join(repoRoot, '.mcp.json');
  let cfg = {};
  if (existsSync(p)) { try { cfg = JSON.parse(readFileSync(p, 'utf8')) ?? {}; } catch { cfg = {}; } }
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), lore: { command: 'node', args: [mcpJsPath] } };
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
}
```

`lib/config.js` 末尾加：

```js
// resident: false 关闭 CLAUDE.md 注入与 MCP 注册（默认开——resident 的全部意义）。
export function parseConfigResident(configText) {
  const m = (configText ?? '').match(/^resident:\s*(\S+)/m);
  return m ? m[1] !== 'false' : true;
}
```

- [ ] **Step 4: 跑绿** —— PASS（4 tests）+ config 的 resident 解析在 Task 6 测试覆盖
- [ ] **Step 5: Commit** —— `git add lib/resident.js test/resident.test.js lib/config.js && git commit -m "feat(resident): CLAUDE.md marker-section install/refresh/remove + .mcp.json merge"`

---

## Task 6: init / finalize 接线

**Files:** Modify `lib/init.js`、`lib/sync.js`、`test/resident.test.js`（集成断言）

- [ ] **Step 1: 写失败测试** —— `test/resident.test.js` 追加（init 集成——fixture 仿 `test/init.test.js` 的 git repo helper，或直接调 init）：

```js
import { init } from '../lib/init.js';
import { execFileSync } from 'node:child_process';

test('init: 默认注入 CLAUDE.md 标记节 + .mcp.json；config resident:false 跳过', () => {
  const root = tmp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'a.js'), 'export const x=1;');
    init({ repoRoot: root, srcSiteDir: join(process.cwd(), 'site') });
    assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /LORE_RESIDENT:START/);
    assert.ok(existsSync(join(root, '.mcp.json')));
    // resident:false 的 repo
    const root2 = tmp();
    execFileSync('git', ['init', '-q'], { cwd: root2 });
    mkdirSync(join(root2, '.lore'), { recursive: true });
    writeFileSync(join(root2, '.lore', 'config.yml'), 'resident: false\n');
    mkdirSync(join(root2, 'lib'), { recursive: true });
    writeFileSync(join(root2, 'lib', 'a.js'), 'export const x=1;');
    init({ repoRoot: root2, srcSiteDir: join(process.cwd(), 'site') });
    assert.equal(existsSync(join(root2, 'CLAUDE.md')), false);
    rmSync(root2, { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

（init 签名/前置以 `lib/init.js` 实际为准——执行时先读 init 函数与既有 init 测试，按真实形态落 fixture；意图：默认注入、`resident: false` 跳过。）

- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现** ——

`lib/init.js`：import 加 `installResident, mergeMcpConfig`（from './resident.js'）与 `parseConfigResident`（扩 config import）；`const hook = installHook(repoRoot);` 之后加：

```js
  // resident-mode（spec 2026-06-11）：CLAUDE.md 注入 + MCP 注册（config resident:false 关）
  const cfgText = existsSync(join(loreDir, 'config.yml')) ? readFileSync(join(loreDir, 'config.yml'), 'utf8') : '';
  let resident = false;
  if (parseConfigResident(cfgText)) {
    const stats = residentStats(loreDir);
    installResident(repoRoot, stats);
    mergeMcpConfig(repoRoot, join(dirname(fileURLToPath(import.meta.url)), 'mcp.js'));
    resident = true;
  }
```

（`residentStats(loreDir)` 放 `lib/resident.js` 导出：读 manifest 算 `{pages, deepPages, updated}`——pages = 全轴页数、deepPages = component 轴 group 非空页数、updated = generated 日期；无 manifest → `{pages: 0, deepPages: 0, updated: '尚未 sync'}`。补进 Task 5 实现与测试。）

`lib/sync.js` finalize 尾部（`runManifestCli` 行后、return 前）加：

```js
  // resident 节刷新：CLAUDE.md 已有标记节才更新（用户删了 = 尊重）。
  try {
    const { refreshResident, residentStats } = await import('./resident.js');
    refreshResident(join(resolve(loreDir), '..'), residentStats(loreDir));
  } catch { /* best-effort */ }
```

（finalizeSync 若是同步函数则改静态 import——以落地为准，保持模块加载风格一致。）

- [ ] **Step 4: 跑绿** —— `node --test test/resident.test.js test/init.test.js test/sync.test.js`
- [ ] **Step 5: Commit** —— `git add lib/init.js lib/sync.js lib/resident.js test/resident.test.js && git commit -m "feat(init,sync): wire resident-mode (inject on init, refresh on finalize, resident:false opt-out)"`

---

## Task 7: deep 补录 + 勾稽指引 + dogfood

**Files:** Modify `.lore/config.yml`、`commands/sync.md`

- [ ] **Step 1: config.deep 补两模块**

```yaml
        合成: [sync, manifest, fingerprint, syncstate, runner]
```

- [ ] **Step 2: sync.md 勾稽指引** —— 两档标准的机制档⑤说明处加一句：

```markdown
- 机制档「⑤ 边界 / 坑」里源自设计决策的条目，勾稽 spec 出处：`←（决策见 docs 轴 <spec-slug>）`——agent 能从 component 页一跳到决策原文。
```

- [ ] **Step 3: 写两张深度页** —— `/lore:sync` 流程（inline 时本会话直接写）：`component/syncstate.md`、`component/runner.md` 按两档标准（含勾稽：syncstate 的覆写决策 ← sync-console spec；runner 的只读 LLM/质量门 ← auto-rewrite spec）。finalize 重建。
- [ ] **Step 4: 本仓库吃自己的 resident** —— `node lib/init.js .`？不——init 全量会重拷壳。直接调：`node -e "import('./lib/resident.js').then(m => { m.installResident('.', m.residentStats('.lore')); m.mergeMcpConfig('.', require('path').resolve('lib/mcp.js')); })"`，验证 lore 自己的 CLAUDE.md/.mcp.json 生效。
- [ ] **Step 5: Commit** —— `git add .lore commands/sync.md CLAUDE.md .mcp.json && git commit -m "dogfood: deep pages for syncstate/runner, decision cross-refs, eat own resident-mode"`

---

## Task 8: 终验（冷启动复测）+ ROADMAP + 回归

- [ ] **Step 1: 全量回归** —— `node --test` → 0 fail（预计 400±）。
- [ ] **Step 2: 冷启动对照复测（用户指定）** —— 2 个 subagent、**新问题集**（防记忆效应），例：① runner 的质量门四道检查分别是什么、不过门时页面与历史各发生什么？② auto 档在 serve 没开时还会触发吗、靠什么进程调度？③ docs 轴的 spec/plan 配对靠什么键、配不上对的页怎么显示？wiki 组限定：**只许走 MCP 链路**（lore_ask → lore_page(section/view=agent)，模拟真实 agent 消费）；source 组只读 lib/+server.js。记录 tokens/正确率，对比基线 65.6k。
- [ ] **Step 3: ROADMAP** —— resident-mode 节标 ✅（含复测数据）；agent 端余项更新（`lore_stale` 仍开）。
- [ ] **Step 4: Commit + push 按用户指令。**

---

## Self-Review（已执行）

**1. Spec 覆盖：** A1 注入/刷新/卸载/动态状态→T5+T6；A2 MCP merge+描述触发词→T5+T4；默认开+resident:false→T5 config+T6 init；B1 节索引→T2；B2 ask v2→T3；B3 view=agent/section→T4（含 lore_ask 切片）；C deep 补录+勾稽→T7；终验复测→T8（新问题集+MCP 限定链路，用户指定）。判据校准/小 repo 物理事实是认知决策无代码对应 ✓。

**2. Placeholder 扫描：** T4 Step1 与 T6 Step1 的测试给的是意图清单+「以落地为准」注记（mcp/init 的既有 fixture 复杂，植入真代码需先读文件）——执行者展开为真断言，主体实现代码全部完整。其余无占位。

**3. 类型一致性：** `extractSections → [{heading, line}]`（T1）↔ manifest sections（T2）↔ ask 读 `p.sections`（T3）；`sliceSection(text, heading) → string|null`（T1）↔ mcp T4 两处调用；`residentSection/installResident/refreshResident/removeResident/mergeMcpConfig/residentStats`（T5）↔ T6/T7 调用同名；`parseConfigResident → bool`（T5）↔ T6。

