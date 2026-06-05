---
title: lore docs 摄取 → docs 轴 —— 设计
summary: - 日期：2026-06-05 - 状态：设计已批，待写实施计划 - 母 spec：`docs/superpowers/specs/2026-05-31-lore-repo-wiki-design.md`（§4 捕获、§5 呈现） - ROADMAP：`docs/ROADMAP.md` →「文档摄取 —— docs/ + changelog + pitfalls（捕获第 4 源）」
source_path: docs/superpowers/specs/2026-06-05-lore-docs-ingestion-design.md
last_updated: 2026-06-05
---
> 源文档：`docs/superpowers/specs/2026-06-05-lore-docs-ingestion-design.md`

# lore docs 摄取 → docs 轴 —— 设计

- 日期：2026-06-05
- 状态：设计已批，待写实施计划
- 母 spec：`docs/superpowers/specs/2026-05-31-lore-repo-wiki-design.md`（§4 捕获、§5 呈现）
- ROADMAP：`docs/ROADMAP.md` →「文档摄取 —— docs/ + changelog + pitfalls（捕获第 4 源）」

## 背景 / 问题

wiki 只有代码派生的页（component），加上声明的 theme/flow 与 commit 决策史。仓库里**已写好的知识**——`docs/` 的设计文档/spec/plan/note、`CHANGELOG.md`、`CLAUDE.md` 踩坑——对 wiki **完全隐形**，只在 commit message 里间接漏一点。lore 自身 `docs/superpowers/{specs,plans,notes}`、threat-intel 的 `docs/` + CLAUDE.md 都是金矿却看不到。

## 目标 / 非目标

**目标**：把 `docs/**/*.md` + `CHANGELOG.md` + `CLAUDE.md`(踩坑) 收进 wiki 的一个新 **docs 轴**，每源机械生成可导航薄页，零 LLM、永远反映当前文件。

**非目标（YAGNI）**：agent 写摘要、journal 原子层、跨轴 facet 折叠、增量指纹、镜像全文。

## 决策（已锁）

| 项 | 决策 | 理由 |
|---|---|---|
| 范围 | 三源：`docs/**/*.md`、`CHANGELOG.md`、`CLAUDE.md` 踩坑 | 用户选「全三源」 |
| 露出 | 新 **docs 轴**（侧栏多一轴） | 文档必显、可导航；serve 轴泛化免改 |
| 页内容 | **机械薄页**（标题+摘要+源链+日期，零 LLM） | 确定性、便宜、node:test 可测 |
| 架构 | **Y · 物化视图** —— sync 读当前文件直接生成 docs 页，无 journal 原子 | docs/ 文件本身已是 git durable 层；docs 页是其物化视图（同 component 页之于代码）。永远当前、无陈旧/去重坑 |

### 弃用的架构
- **X · journal 原子**：extractor→原子→折入 docs 轴。可跨轴折叠、durable，但文档改了 re-mine 跳过 → 陈旧（需先做 fold-by-id）、dup 风险、更复杂。弃（自由文档难自动匹配 facet，跨轴收益小）。

## 设计

### ① config（`lib/config.js` 加解析器）

`config.yml` 新增 opt-in 轴：
```yaml
axes:
  docs:
    sources: [docs, changelog, claude_md_pitfalls]   # 哪些 extractor 跑
    docs_glob: docs/**/*.md                           # docs 源扫描范围（默认）
```
- `parseConfigDocsAxis(text) → { sources: string[], docsGlob: string }`（零依赖 YAML 子集，仿 `parseConfigThemes`/`parseConfigFlows`）。
- 无 `axes.docs` → 返回 `null` → 不生成 docs 轴（opt-in）。
- `init` 的 `renderConfigYaml` 写注释示例（不默认开）。

### ② 三个 extractor（新 `lib/docs.js`，纯函数）

统一产出 **page-spec**：`{ id, title, summary, sourcePath, date }`。

**`docsExtractor(repoRoot, docsGlob) → spec[]`**（`docs/**/*.md`，每文件一页）：
- 递归走 `docs/`（排序、确定性；跳过 `.lore`）。`docsGlob` 现支持 `docs/**/*.md` 形态（前缀目录 + `**/*.md`）。
- `id` = docs 内 relpath 去 `.md`、`/`→`-`（如 `superpowers/specs/2026-06-04-lore-mermaid-diagrams-design.md` → `superpowers-specs-2026-06-04-lore-mermaid-diagrams-design`）。
- `title` = 首个 `# H1` ／ front-matter `title:` ／ 文件名（去扩展）。
- `summary` = front-matter `summary:` ／ H1 后首个非空段（截断 ~200 字）／ 空。
- `date` = 文件名 `YYYY-MM-DD` 串（正则 `/(\d{4}-\d{2}-\d{2})/`）／ 空。
- `sourcePath` = repo-relative（`docs/...`）。

**`changelogExtractor(repoRoot) → spec[]`**（`CHANGELOG.md`，全版本折一页）：
- 解析 `## [x.y.z] — date`（或 `- date`）段。
- 返回**单个** spec：`id='changelog'`、`title='CHANGELOG'`、`summary`=最新版本号+日期、`date`=最新版本日期、`sourcePath='CHANGELOG.md'`，外加 `entries`（各版本 `{version,date,headline}`，供 renderDocsPage 列出）。
- 无 CHANGELOG.md → `[]`。

**`pitfallsExtractor(repoRoot) → spec[]`**（`CLAUDE.md`，全踩坑折一页）：
- 解析结构化踩坑块：以 `**Problem**` / `**问题**`（粗体标签）起，含 `**Fix**`/`**修复**`、`**Prevention**`/`**预防**` 的连续块。
- 返回**单个** spec：`id='pitfalls'`、`title='Pitfalls'`、`sourcePath='CLAUDE.md'`，外加 `entries`（各踩坑 `{problem,fix,prevention}`）。
- 无匹配 / 无 CLAUDE.md → `[]`（lore 自身预期空；threat-intel 才有料）。

**`renderDocsPage(spec) → markdown`**：
```markdown
---
title: <title>
summary: <summary>
source_path: <sourcePath>
last_updated: <date>
---
# docs: <title>

<summary 段>

源文档：[<sourcePath>](<repo-relative 链>)

<若 entries：版本/踩坑列表（机械 bullet）>
```
- 源链 = 从 `.lore/wiki/docs/` 回到 repo 的相对路径（`../../../<sourcePath>`）。github 浏览仓库时可点；本地壳只服务 `.lore/` 故为信息性引用（注记）。

**`buildDocsAxis(loreDir, repoRoot, docsConfig) → void`**：
- **nuke `wiki/docs/` 重建**（`rmSync(recursive)` + mkdir）→ 物化视图：删档自动消失、nuke+重 sync 字节一致。
- 按 `docsConfig.sources` 跑启用的 extractor，合并 specs，逐个 `writeFileSync(wiki/docs/<id>.md, renderDocsPage(spec))`。

### ③ 露出接线

- **`finalizeSync`**（`lib/sync.js`）：现有 agent 轴折叠 + journal 之后、`emitManifest`/`buildIndex` **之前**，插一步：若 `parseConfigDocsAxis` 非空 → `buildDocsAxis(...)`。这样 manifest 扫描时 docs 页已在盘上。
- **`manifest.js`**：`AXIS_ORDER` 加 `'docs'`（现 `['INDEX','component','flow','theme']` → 加 `docs`）。`emitManifest` 已按 AXIS_ORDER 通用扫 `wiki/<axis>/*.md` 读 front-matter，docs 页自动收（title/summary/source_path/last_updated）。docs 页无 `code_sha` → manifest 该字段空，不参与 stale。
- **`buildIndex`**（`lib/sync.js`）：`axisPages` 对象加 docs → 输出 `## Docs` 段（页链接列表）。
- **serve/壳**（`site/`）：`buildNavModel`/`buildMeta` 轴泛化 → **免改**。仅 `index.html` 加 `--docs` 颜色变量 + `.dot.docs { background: var(--docs); }`（侧栏轴圆点配色，1-2 行 CSS）。
- **`commands/sync.md`**：注记「docs 轴由 finalize 机械生成（读 docs/+CHANGELOG+CLAUDE.md），agent 不用写」。

## 测试（node:test，全确定性）

- `lib/docs.test.js`：
  - `docsExtractor`：fixture `docs/` 含 front-matter 页、纯 H1 页、日期前缀页 → 断言 id slug / title / summary / date 提取；嵌套目录递归；空 docs/ → `[]`。
  - `changelogExtractor`：fixture CHANGELOG → 单 spec + entries（版本/日期）；无文件 → `[]`。
  - `pitfallsExtractor`：fixture CLAUDE.md 含 Problem/Fix/Prevention → 单 spec + entries；无标记 → `[]`。
  - `renderDocsPage`：spec → markdown（front-matter + 源链 + entries 列表）。
  - `buildDocsAxis`：临时 repo（docs/ + CHANGELOG）→ 写 `wiki/docs/*.md`；**删一个 doc 后重跑 → 其页消失**（nuke-rebuild 验证）。
  - `parseConfigDocsAxis`：解析 `axes.docs.sources` / 无该轴 → null。
- `manifest.test.js`：`AXIS_ORDER` 含 docs；`wiki/docs/*.md` 被 manifest 收。
- 集成：init → 造 docs/+CHANGELOG → sync finalize → docs 页 + manifest docs 轴 + INDEX 有 `## Docs`。

## 不变量

- **零依赖**：纯 Node（文件走 + 串解析）。
- **零侵入**：只写 `.lore/wiki/docs/`（+ config 注释示例）。
- **确定性 / 物化视图**：零 LLM；nuke `wiki/docs/` 重 sync → 字节一致；删源文档 → 对应页消失。
- **轴泛化**：复用 manifest/serve 既有多轴机制；docs 与 component/theme/flow 并列。

## 风险 / 注记

- **pitfalls 格式特定**：lore 自身 `CLAUDE.md` 无结构化踩坑 → 该 extractor 对 lore 输出空（用 fixture 测）。threat-intel 实测时需核对其 CLAUDE.md 踩坑标记是否匹配 `**Problem/Fix/Prevention**`（impl 时核对，必要时调标签集）。
- **id 碰撞**：docs/ 里若有文件 slug 恰为 `changelog`/`pitfalls` 会撞折叠页 id（罕见；注记，必要时给折叠页加前缀如 `_changelog`）。
- **docs 页 manifest chips**：无 `code_sha`/`synthesized_from` → 壳显示 "0 atoms · code_sha —"，对文档页略怪但无害（v1 接受；后续可让 `buildMeta` 区分 docs 页）。
- **源链**：本地壳不服务 repo 根，故源链是信息性（github 仓库浏览可点）。

## 文件结构

- `lib/docs.js` — Create：三 extractor + `renderDocsPage` + `buildDocsAxis`。单一职责：docs→page-spec→页。
- `lib/config.js` — Modify：加 `parseConfigDocsAxis`。
- `lib/sync.js` — Modify：`finalizeSync` 调 `buildDocsAxis`；`buildIndex` 加 docs 段。
- `lib/manifest.js` — Modify：`AXIS_ORDER` 加 `'docs'`。
- `lib/init.js` — Modify：`renderConfigYaml` 加 `axes.docs` 注释示例。
- `site/index.html` — Modify：`.dot.docs` 配色。
- `commands/sync.md` — Modify：docs 轴机械生成注记。
- `test/docs.test.js` — Create；`test/{manifest,integration}.test.js` — Modify。

## 接缝小结
新 `lib/docs.js`（独立、可单测）承全部 docs 逻辑；sync/manifest/config/init 各加一小接线点；壳 1 行配色。轴机制复用，serve 零改。单 plan 可落（仨 extractor 并行单元）。

