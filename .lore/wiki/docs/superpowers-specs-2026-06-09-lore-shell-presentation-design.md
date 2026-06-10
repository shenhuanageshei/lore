---
title: lore 壳呈现（mermaid 放大 + component 排序分组）—— 设计
summary: - 日期：2026-06-09 - 状态：设计已批，待写实施计划 - 北极星：人读 + agent 双友好的活文档；本期专攻**呈现层（C-呈现）的图可读性 + 导航** - 前置（已在 main）：C-内容（两档好页 + 源文件级深度页）、`site/index.html`（壳 + vendored `mermaid.min.js`，`securityLevel: strict`）、`co...
source_path: docs/superpowers/specs/2026-06-09-lore-shell-presentation-design.md
last_updated: 2026-06-09
group: 设计与计划
paired_plan: superpowers-plans-2026-06-09-lore-shell-presentation
---
> 源文档：`docs/superpowers/specs/2026-06-09-lore-shell-presentation-design.md`

# lore 壳呈现（mermaid 放大 + component 排序分组）—— 设计

- 日期：2026-06-09
- 状态：设计已批，待写实施计划
- 北极星：人读 + agent 双友好的活文档；本期专攻**呈现层（C-呈现）的图可读性 + 导航**
- 前置（已在 main）：C-内容（两档好页 + 源文件级深度页）、`site/index.html`（壳 + vendored `mermaid.min.js`，`securityLevel: strict`）、`config.deep`（flat list）、`manifest`（component 页字母序）
- 拆解出处：C dogfood review（serve 浏览 6 深度页）发现的下一轮，跨三块（壳 UX / 内容 v2 / 图质量）。**本文 = 第一个 spec「壳呈现」**（S1 mermaid 放大 + S2 component 排序分组）；后续 spec②（docs 轴重构）、spec③（mermaid 语法校验 + br 统一）、spec④（server.js 根文件组件 + 决策史文件级分流）各自另立。

## 背景 / 问题

dogfood review 实测两个呈现痛点：

1. **大 mermaid 图无法放大** —— `fingerprint` 等深度页主干图节点多、字小看不清；壳只静态渲染 SVG，无缩放/平移，超大图等于看不清。
2. **component 侧栏字母序** —— `fingerprint / fold / hook / lib / manifest / mine / sync`：鸟瞰页 `lib` 埋在中间（找不到「总览入口」），模块排列也看不出「捕获 → 合成」的流水线逻辑。

## 目标 / 非目标

**目标（壳呈现）**：
1. mermaid 图可放大细看（lightbox + 弹层内 pan/zoom）。
2. component 侧栏「鸟瞰置顶 + 流水线序 + 分组小标题」。

**非目标（后续 spec）**：
- docs 轴重构（changelog/roadmap/pitfalls 从 docs 分出）→ spec②
- mermaid 语法校验 + br 统一 → spec③
- server.js 根级单文件组件 + 决策史文件级分流 → spec④
- 壳其它 UX（搜索 / 主题 / 排版）不在本期。

## 决策（已锁）

| 项 | 决策 |
|---|---|
| mermaid 放大 | **C 组合**：点图 → 全屏 lightbox；弹层内 SVG 拖拽平移 + 滚轮/按钮（+/−/⟲）缩放；ESC / 点遮罩关。滚轮**只在弹层内捕获**（不扰正文）。零依赖 |
| component 排序 | `lib` 鸟瞰**置顶** + 按 `config.deep` 的 `order` 流水线序 |
| 分组小标题 | **A**：侧栏按 group 显示灰色小标题（▸ 捕获 / ▸ 合成）|
| config.deep schema | 升级为**分组 map**（`捕获:[…]` / `合成:[…]`），保留顺序；**向后兼容** flat list |
| 壳测试 | 壳 JS 无单测惯例 → 手动 `serve` 验证（**诚实缺口**）；lib 部分 TDD |

## 设计

### S1 · mermaid 放大（C 组合）

- 改 `site/index.html` —— 在 mermaid 渲染（`mermaid.run`，第 251 行附近）**之后**给每个 `.mermaid` SVG 绑点击。
- 点击 → 弹**全屏 lightbox**（半透遮罩 + 居中放大的 SVG）。
- lightbox 内：SVG 外包一层 `transform: translate()+scale()` 容器，支持**拖拽平移** + **滚轮/按钮缩放**（+ / − / ⟲ reset）；ESC 或点遮罩关闭。
- **关键**：滚轮缩放只在 lightbox 内 `wheel` 监听 + `preventDefault` → 正文滚动完全不受影响（这是选 C 而非纯 inline pan/zoom 的理由）。
- **零依赖**：原生 JS + CSS transform；vendored `mermaid.min.js` 不动；`securityLevel: strict` 不变。

### S2 · component 排序 + 分组（A）

- **`config.deep` 升级**为分组 map（保留书写顺序）：
  ```yaml
  deep:
    lib:
      捕获: [hook, mine, fold]
      合成: [sync, manifest, fingerprint]
  ```
- **`parseConfigDeep`** 返回 `{ lib: { order: [hook,mine,fold,sync,manifest,fingerprint], groups: [{name:'捕获', mods:[…]}, {name:'合成', mods:[…]}] } }` —— `order` 给 planSync（保序展平），`groups` 给壳渲染小标题。**向后兼容**：旧 flat list（`lib: [a,b,c]`）仍解析为 `{order:[a,b,c], groups:[]}`。
- **`planSync`** 按 `order` 列深度页工单（顺序 = 各分组拼接）。
- **`manifest`**（`emitManifest`/`pageEntry`）：component 页按 `order` 排（`lib` 鸟瞰置顶，深度页随后按流水线序），每个 component page entry 带 `group` 字段（`lib` 鸟瞰 → `''`（空串 = 置顶、不归组），深度页 → 所属分组名 `'捕获'` / `'合成'`）。
- **壳 `site/index.html`** 渲染 component 侧栏时，按 page 的 `group` 在组首插入灰色小标题（▸ 捕获 / ▸ 合成）。

## 测试

- **TDD（lib 部分）**：
  1. `parseConfigDeep`：分组 map → `{order, groups}`；旧 flat list → `{order, groups:[]}`（向后兼容）；缺 deep → `{}`。
  2. `planSync`：按 `order` 列深度页工单（顺序断言）。
  3. `manifest`：component 页按 `order` 排（lib 置顶）+ page entry 带正确 `group`。
- **手动（壳部分）**：`site/` 是客户端 JS、lore 无壳单测惯例 → mermaid 放大（lightbox + pan/zoom + 滚轮不扰正文）+ 分组侧栏靠 `node lib/serve.js start .lore` 浏览验证。**这是诚实缺口**（壳改动无自动化兜底）。

## 改动清单

- `site/index.html`（mermaid 放大 lightbox/pan-zoom + component 分组侧栏渲染）
- `lib/config.js`（`parseConfigDeep` 升级分组 map + 向后兼容）
- `lib/sync.js`（`planSync` 用 `order`）
- `lib/manifest.js`（component 页按 `order` 排 + `group` 字段）
- `.lore/config.yml`（dogfood：deep 改分组 map）
- 扩展 `test/{config,sync,manifest}.test.js`
- `docs/ROADMAP.md`（壳呈现标记）

## 不变量 / 风险

- **零依赖**不破（壳原生 JS + CSS）。
- **向后兼容**：flat list deep 仍解析（`groups:[]`、无分组小标题）；不配 deep 的 repo 行为不变。
- `securityLevel: strict` 不变。
- **风险 1**：壳放大/分组无自动化测试 → 手动验证（lore 壳一贯如此）。
- **风险 2**：`config.deep` schema 升级，dogfood 的 `.lore/config.yml` 需同步改成分组 map（否则深度页无分组，但 order 仍工作——向后兼容兜底）。

## 讨论轨迹 / 决策演变

1. C dogfood review（serve 浏览深度页）暴露两个呈现痛点（大图看不清、字母序乱）→ 下一轮分解为三块（壳 UX / 内容 v2 / 图质量），第一个 spec 聚焦「壳呈现」（纯前端 + manifest、用户最在意、独立快、不碰核心模型）。
2. S1 放大选 **C 组合**（lightbox + 弹层内 pan/zoom）而非纯 inline pan/zoom —— 因为滚轮缩放圈在弹层内、绝不干扰正文滚动，同时超大图也能细看。
3. S2 排序选「流水线序 + 分组小标题 A」—— 鸟瞰置顶解决「找总览」，流水线序 + 分组解决「看不出阶段」。
4. 分组信息来源选 `config.deep` 升级为分组 map（最自然，顺带保留顺序），向后兼容旧 flat list。

## 实现节奏

spec → writing-plans → plan → TDD（lib）+ 手动验证（壳）→ dogfood 验证 → 合并。spec②③④ 各自另起。

