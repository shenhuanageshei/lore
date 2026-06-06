# lore docs 轴 v2 + mermaid 懒加载 —— 设计

- 日期：2026-06-05
- 状态：设计已批，待写实施计划
- 前置：`docs/superpowers/specs/2026-06-05-lore-docs-ingestion-design.md`（v1 docs 轴）
- 北极星：人读友好 wiki（本轮主攻）+ agent 友好 wiki+graph（`docs/ROADMAP.md` 北极星节）

## 背景 / 问题（v0.3.0 serve 实测暴露）

docs 轴 v1 用「机械薄页」（仅 标题+摘要+源链），实用上三个坑：
1. **看不到正文** —— 薄页没文档内容，得跳出去读。
2. **源链点击 404** —— `../../../docs/X.md` 指向 repo 根，server 只服务 `.lore/` → 404。
3. **没按时间排序** —— manifest 字母序，ROADMAP/CHANGELOG 浮顶、时间线乱。

外加：mermaid.min.js（3.2MB）在**每个页面**静态加载（连无图的 docs 页）→ 慢、截图超时。

## 目标 / 非目标

**目标**：docs 页**嵌入文档全文**（解 1+2）、docs 轴**按时间降序**（解 3）、mermaid**懒加载**（仅有图页才载）。

**非目标（YAGNI）**：双语切换（单独大件）、agent 摘要页、graph 侧（北极星 agent 端，另立）、其他轴的时间排序。

## 决策（已锁）

| 项 | 决策 |
|---|---|
| 内容呈现 | **嵌入全文**：wiki 页 = front-matter + 源引用 + 文档正文原样渲染（剥源文档自身 FM） |
| 源链 | 改**纯文本引用** `> 源文档：`<path>``（非链接）→ 彻底无 404 |
| 排序 | **仅 docs 轴**按 `last_updated` 降序（tiebreak id）；其他轴不动 |
| mermaid | **懒加载**：删静态 script，仅当页面含 `.mermaid` 才动态注入 + run |

## 设计

### A · 嵌入文档全文（`lib/docs.js`）

**page-spec 加可选 `body`**：`{ id, title, summary, sourcePath, date, body?, entries? }`。

- `docsExtractor`：每文档 spec 加 `body = parseFrontmatter(text).body`（复用已有，剥源文档自己的 front-matter）。
- `changelogExtractor`：spec 加 `body = CHANGELOG.md 全文`（它本就是可读文档）；保留 `entries` 仅供 `summary` 字段计数。
- `pitfallsExtractor`：**不加 body**（CLAUDE.md 太杂，不整篇嵌），仍输出 `entries`。

**`renderDocsPage(spec)` 重写**：
```markdown
---
title: <title>
summary: <summary>
source_path: <sourcePath>
last_updated: <date>
---
> 源文档：`<sourcePath>`

<body 原样  ||  pitfalls：`# <title>\n\n` + renderEntries(entries)>
```
- 有 `body`（docs/changelog）→ 直接嵌 body（其自身 `# H1` 当页标题，**不**再套 `# docs:` 外壳，避免双 H1）。
- 无 body 有 `entries`（pitfalls）→ `# <title>`（如 `# Pitfalls`）+ 条目列表。
- 源引用是**反引号包裹的纯文本路径**（`> 源文档：\`docs/X.md\``），不是 markdown 链接 → 壳渲染成普通文字，点不动也不会 404。
- 嵌入正文经壳 `renderMarkdown` 渲染：mermaid 块（懒加载渲染）、表格、`[[wikilink]]`、代码块全活。

### B · docs 轴时间降序

同一规则两处（各消费自己的数据源）：`date desc, tiebreak id asc`。

- **`lib/manifest.js` `emitManifest`**：对每轴构建完 `pages` 后，若 `ax.id === 'docs'` → `pages.sort((a,b) => (b.last_updated||'').localeCompare(a.last_updated||'') || a.id.localeCompare(b.id))`。其他轴保持文件字母序。（manifest 喂侧栏。）
- **`lib/docs.js` `buildDocsAxis`**：写页/返回前，对 `specs` 按 `date desc, tiebreak id` 排。（返回值喂 `finalizeSync` 的 `axisPages.docs` → `buildIndex` 的 INDEX Docs 段同序。）

### C · mermaid 懒加载（`site/index.html`，壳 only）

- **删**静态 `<script src="./mermaid.min.js">`。
- 加 promise-缓存的按需加载器：
```js
let mermaidLoad = null;
function ensureMermaid() {
  if (!mermaidLoad) {
    mermaidLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = './mermaid.min.js';
      s.onload = () => { window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: mapMermaidTheme(document.documentElement.getAttribute('data-theme')) }); resolve(); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  return mermaidLoad;
}
```
- `route()` 渲染后：`const mNodes = document.querySelectorAll('#content .mermaid'); if (mNodes.length) { try { await ensureMermaid(); await window.mermaid.run({ nodes: mNodes }); } catch {} }`。
- `wireTheme` change：仅当 `mermaidLoad` 非空（已载）才 re-init mermaid 主题 + `route()` 重渲；未载则只切 CSS 主题。
- 无图页 → 永不载 3.2MB。

## 测试（node:test 确定性部分）

- `lib/docs.test.js`：
  - `docsExtractor`：含 FM + H1 + 正文的文档 → `spec.body` = 剥 FM 后正文（以 H1 起）。
  - `renderDocsPage`：有 body → 输出含 body、含 `> 源文档：` 反引号引用、**不**含 `](../../../`（无链接）；pitfalls spec（无 body 有 entries）→ 含 `# Pitfalls` + 条目；docs/changelog body 页无双 H1（不含 `# docs:`）。
  - `buildDocsAxis`：多 date 文档 → 返回 specs 按 date 降序。
- `lib/manifest.test.js`：docs 轴 3 页不同 date → manifest `docs` 轴 pages 按 date 降序；其他轴仍字母序。
- mermaid 懒加载 = 浏览器手验（无图 docs 页不载 mermaid.min.js；有图 component 页载并渲染；主题切换）。

## 不变量

- 零依赖、零侵入（只写 `.lore/`）、确定性 / 物化视图（嵌入=机械文件读、排序确定、nuke-rebuild 字节一致）。
- mermaid 懒加载 = 壳 only，serve/lib 不动。
- **页变大**（嵌全文）—— 接受，是「人能读」的代价。

## 风险 / 注记

- 嵌入正文里若有自定义 HTML/脚本 —— 壳 `renderMarkdown` 已有 raw-`<div>` 透传 + 仅 127-only + 内容来自本 repo 文件（可信），securityLevel strict。无新攻击面。
- 嵌入超大文档（数千行）→ 单页很长。可接受（v1 不分页/不折叠；要的话后续加）。
- changelog 同时嵌 body 又留 entries：entries 仅用于 `summary` 计数，不渲染（body 已含全文），无重复显示。

## 文件结构
- `lib/docs.js` — Modify：3 extractor 加 `body` / `renderDocsPage` 重写嵌入 / `buildDocsAxis` 排序。
- `lib/manifest.js` — Modify：`emitManifest` docs 轴 date 排序。
- `site/index.html` — Modify：mermaid 懒加载。
- `test/docs.test.js`、`test/manifest.test.js` — Modify。
