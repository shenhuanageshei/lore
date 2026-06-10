---
title: lore mermaid 图 —— 设计
summary: - 日期：2026-06-04 - 状态：设计已批，待写实施计划 - 母 spec：`docs/superpowers/specs/2026-05-31-lore-repo-wiki-design.md`（§4 合成、§5 呈现） - ROADMAP：`docs/ROADMAP.md` →「呈现（wiki 渲染）→ mermaid 架构图 + 数据流图」
source_path: docs/superpowers/specs/2026-06-04-lore-mermaid-diagrams-design.md
last_updated: 2026-06-04
group: 设计与计划
paired_plan: superpowers-plans-2026-06-04-lore-mermaid-diagrams
---
> 源文档：`docs/superpowers/specs/2026-06-04-lore-mermaid-diagrams-design.md`

# lore mermaid 图 —— 设计

- 日期：2026-06-04
- 状态：设计已批，待写实施计划
- 母 spec：`docs/superpowers/specs/2026-05-31-lore-repo-wiki-design.md`（§4 合成、§5 呈现）
- ROADMAP：`docs/ROADMAP.md` →「呈现（wiki 渲染）→ mermaid 架构图 + 数据流图」

## 背景 / 问题

wiki 页「当前架构」段全是文字。component 页缺**架构图**（模块结构/依赖），flow 页缺**数据流图**——而 flow 轴（入口→各阶段经过的组件→出口）本质就是一张 flowchart，纯文字描述它最别扭。

约束：lore 的呈现层是「哑静态 server + 免构建浏览器壳」（`site/index.html` + `site/shell.mjs`），且守两条硬不变量——**零运行时依赖**（纯 Node 内置，无 node_modules）与**离线 / 127-only**（不连外网）。任何出图方案不能破这两条。

## 目标 / 非目标

**目标**
- component 页出**架构图**、flow 页出**数据流图**（mermaid）。
- 图源是页内 markdown 文本（```mermaid``` 块）→ git 可 diff、随历史演进，远胜二进制 PNG。
- 壳客户端渲染，离线可用。

**非目标（YAGNI，本轮砍）**
- theme 轴强制出图（agent 可自行按需出，但不强制、不专门支持）。
- 每页多图框架（component 1 架构图 / flow 1 数据流图，够）。
- Node 端预编译 SVG、mermaid 主题精细调色、图类型限制裁剪。

## 决策（已锁）

| 项 | 决策 | 理由 |
|---|---|---|
| 覆盖面 | component→架构图，flow→数据流图 | 两个最自然的轴；theme 不强制 |
| 交付 | **方案 A**：vendored 全量 UMD `mermaid.min.js`（~2.8MB），随 `site/` 由 init 拷入 `.lore/site/`，壳客户端渲染 | 唯一同守「零运行时依赖 + 离线/127-only」两不变量 |
| 安全 | `mermaid.initialize({ securityLevel:'strict' })` | 禁 label 内 HTML / click 处理器；内容虽机器生成 + 仅 127-only，仍纵深防御 |
| 版本 | 固定 pin 一个 mermaid 版本（如 `mermaid@11.x` UMD），spec/注释记 URL + 版本 | 可复现、不漂移 |

### 弃用的方案
- **B CDN**：`<script src=cdn…mermaid>` → 破离线 / 127-only、版本漂移、CSP 冲突。弃。
- **C Node 预编译 SVG**：finalize 跑 mermaid→SVG → mermaid CLI 拖 puppeteer/headless chromium，破零依赖、重。弃。

## 设计：4 处改动

### ① vendor 资产 + init 拷贝（`lib/init.js`）
- 插件 repo 加 `site/mermaid.min.js`（pin 版本的全量 UMD，实现时从 unpkg 拉、记版本）。
- `SHELL_FILES`（现 `['index.html','shell.mjs']`，line 12）加 `'mermaid.min.js'`。`copyShell` 随之把它拷进 `.lore/site/`，重跑 init 覆盖刷新。
- **唯一碰的 lib 文件，且仅加一个数组项**——`copyShell` 逻辑零改。

### ② 壳渲染：识别 mermaid fence（`site/shell.mjs` `renderMarkdown`）
- 现 fence 分支（line 38-42）：任何 ` ``` ` → `<pre><code>`。改为抓 info-string：
  - ` ```mermaid ` → `<div class="mermaid">${esc(源)}</div>`
  - 其余 → 照旧 `<pre><code>${esc(源)}</code></pre>`
- **转义关键**：mermaid 源**照常 HTML 转义**进 div。浏览器读 `.mermaid` 元素的 `textContent` 时自动解码实体，故 `A--&gt;B`（HTML）→ mermaid 实际拿到 `A-->B`。转义与 code 块一致、且防止源里的 `<`/`&` 破坏 HTML 结构。
- 不与既有 `^<div` 透传逻辑（timeline 标记，line 29-37）冲突：mermaid 源行以 `flowchart`/`graph`/`sequenceDiagram` 开头，非 `<div`；而生成的 `<div class="mermaid">` 是 renderMarkdown 自己产出、不经透传分支。

### ③ index.html：加载 + 渲染（`site/index.html`）
- `<head>` 或 body 末加 `<script src="./mermaid.min.js"></script>`（UMD → 全局 `window.mermaid`）。
- 模块脚本 `boot()` 内初始化一次：`window.mermaid?.initialize({ startOnLoad:false, securityLevel:'strict', theme: mapTheme(currentTheme) })`。
- 每次 `route()` 注入内容 HTML 后渲染：`if (window.mermaid) await mermaid.run({ nodes: content.querySelectorAll('.mermaid') })`。新 innerHTML → 新节点 → run 处理（mermaid 用 `data-processed` 标记，新节点未标记故会渲染）。
- **主题联动**：壳 `dark`→mermaid `'dark'`，其余（`light`/`sepia`）→`'default'`。切主题时 re-init mermaid 主题 + 重跑当前页 `route()`（重渲图）。
- **容错**：
  - `window.mermaid` 缺（旧 `.lore` 未拷 mermaid.js）→ guard 跳过 → ```mermaid``` 降级为普通文本码块，**零 JS 报错**。
  - 坏 mermaid 语法 → `mermaid.run` 内联错误标记（try/catch 包，页其余部分照常可用）。

### ④ sync 命令层引导（`commands/sync.md`）
- component 页模板「## Current architecture」顶部加一节 ` ```mermaid ` 架构图；flow 页模板「## End-to-end path」顶部加 ` ```mermaid ` 数据流图。
- 给 agent 提示：据**真实代码**画（入口/关键模块/依赖、或入口→阶段→出口）；~5-15 节点保持可读；图是文本会随 diff 演进。
- **纯 prompt/模板改，生成侧 lib 零改**——图是 agent 写进页 body 的 markdown，`finalizeSync` 不识别、不触碰（当普通正文带过）。

## 不变量（全保住）

- **零依赖**：mermaid.min.js 是浏览器静态资产，无 node_modules、无 Node `import`。
- **零侵入**：仅写 `.lore/`（含 vendored 资产于 `.lore/site/`）。
- **离线 / 127-only**：vendored 非 CDN。
- **确定性 / LLM 分层**：fence 检测（②）+ 拷贝（①）= 确定性、入单测；图**内容** = agent 写（同「当前架构」prose），不入确定性测。
- **物化视图**：图是页内文本，nuke `wiki/` 重 sync 由 agent 重出（同 prose——「字节一致」不变量本就只约束机械产物，不约束 LLM 段）。

## 测试（node:test，仅确定性部分）

- `renderMarkdown`（`test/` 对应壳测试）：
  - ` ```mermaid\nflowchart TD\nA-->B\n``` ` → 输出含 `<div class="mermaid">`、含转义后的 `--&gt;`、**不**含 `<pre>`。
  - 普通 ` ```js ` fence → 仍 `<pre><code>`。
  - mermaid 源含 `<`/`&`/`-->` → div 内正确转义。
  - 多个 mermaid 块 → 各自成 div。
- `copyShell` / init（`test/init.test.js`）：`SHELL_FILES` 含 mermaid → fixture srcSite 放一个 `mermaid.min.js` 桩 → 断言拷贝落 `.lore/site/mermaid.min.js`。
- **浏览器侧** `mermaid.run` / 主题联动 = 集成/手验，不入自动单测（与「确定性才入测」一致）。

## 风险 / 注记

- **资产体积**：~2.8MB 入每个目标 repo 的 git（用户已确认接受全量 UMD 换省心）。
- **mermaid 版本**：pin 一个版本；升级是显式动作（换 `site/mermaid.min.js` + 记版本），不自动漂移。
- **旧壳/旧 .lore 前向兼容**：有图但旧壳无 mermaid.js → 文本码块降级；重跑 `/lore:init` 升级壳 + 补 mermaid.js。

## 接缝小结
壳（②③）+ init 一行（①）+ sync 模板（④）。`lib` 仅 `init.js` 动一个数组项；`sync.js`/`finalize`/manifest/serve 零改。单 plan 可落。

