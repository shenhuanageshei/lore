# lore 路线图

> v0.1.0 = 捕获三源 + journal + 三轴合成 + lint + serve + ask（核心闭环完整）。
> 下面是后续迭代，按价值/依赖排序。每项仍走 spec → plan → TDD → 审查 → 合并。
> 母 spec：`docs/superpowers/specs/2026-05-31-lore-repo-wiki-design.md`。

## 近期（高价值、自洽）

### 文档摄取 —— docs/ + changelog + pitfalls（捕获第 4 源，⭐ 当前最大缺口）
- **现状**：journal 只来自 commits（hook/mine）+ agent note。`docs/` 下的设计文档/ADR/spec/runbook、`CHANGELOG.md`、`CLAUDE.md` 踩坑 —— 全部不进 wiki（只在 commit message 间接反映）。threat-intel 的 `docs/` + 186KB `CLAUDE.md`、lore 自己的 `docs/superpowers/specs` 都是金矿却隐形。
- **做**：加可插拔 doc extractor（config `journal.mine` gate）：
  - `docs/**/*.md` → 每文档（或每 H2 段）一条 `kind:decision`/`kind:doc` 原子，facet 按路径/关键词标，`refs.files` 指原文档。
  - `CHANGELOG.md`（Keep-a-Changelog `## [x.y.z] - date` 段）→ `kind:decision`。半通用。
  - `CLAUDE.md` 结构化踩坑（Problem/Fix/Prevention）→ `kind:incident` 富 why。格式特定（threat-intel 金矿）。
- **难点**：去重（文档常复述 commit 已说的）、增量（文档改了重摄取）、facet 归属（跨多组件的设计文档）。
- 价值：把团队已写的知识一夜变成可导航 wiki —— 用户明确点的缺口。config `journal.mine: [commits, docs, changelog, claude_md_pitfalls]` gate 哪些源跑。

### per-facet confidence 显示（母 §4 line 190）
- 现 commit 原子整体 `confidence:'EXTRACTED'`。母 spec：component=EXTRACTED、flow/theme=INFERRED（机械推断）。
- 改为 **per-facet confidence**；`renderDecisionHistory` / serve 壳给 INFERRED facet 显「(推断)」；`/lore:lint` 把 AMBIGUOUS 推人确认。
- 小改动，完成 facet 质量故事。

### note enrich 骨架 + journal fold-by-id（母 §4② 后半）
- `/lore:note` 现只产新 decision 原子。加 **enrich 已有 commit 骨架**：同 `commit:<hash>` append 新行补 `why`（append-only 神圣，不改旧行）。
- 配套 **journal fold-by-id**：`readAllAtoms` 之上加按 id 折叠（取并集/最新）；sync / ask / lint 消费 folded 原子。保留 骨架→enriched 演化轨迹，审计友好。
- 中等：碰 journal 读层 + 所有消费者。

## 呈现（wiki 渲染，⭐ 用户明确要）

### mermaid 架构图 + 数据流图
- **现状**：页「当前架构」全文字；壳 `renderMarkdown`（site/shell.mjs）把 ```mermaid``` 当普通代码块渲染（纯文本）。
- **做**：(a) 壳 `renderMarkdown` 识别 ```mermaid``` → `<div class="mermaid">`；vendored `mermaid.min.js` 随 `site/` 由 init 拷入。**不破零依赖**——零依赖是 Node runtime 不变量，静态壳资产不算；vendor 而非 CDN → 保持离线 + 127-only。(b) `/lore:sync` 指引 agent：component 页出架构图、flow 页出数据流图、theme 页涉及流程时也出图。
- **为什么好**：mermaid 是文本 → git 可 diff、随 journal/commit 一起演进（远胜二进制 PNG），完全契合 lore git-native 哲学。flow 轴（m1→m5）天然就是 flowchart。
- 高价值、接缝干净（壳 + sync 命令层，lib 几乎不动）。

### 双语切换（中/EN）
- **现状**：壳有主题切换（暗/亮/护眼）但无语言概念；页是单语（agent 写啥语言就啥）。
- **做**：(a) 壳加 `#lang` 选择器（localStorage，同 `wireTheme` 模式）。(b) agent 写页时出双语 prose —— 配对段（`## Current architecture` + `## 当前架构`）或配对文件（`lib.md`/`lib.en.md`），壳按 lang 切显。
- **诚实约束**：决策历史是 journal 折叠 = commit message 原文（不可变事实），不机械翻译 → 决策史保持源语言（或未来 LLM 翻译折叠，贵）。双语只覆盖 agent 写的「当前架构/状态」prose。
- 中等：agent 2× prose 成本（sync 时）；壳 + sync 模板改。

## 中期（消费纪律 + 质量）

### 单机共享 wiki server（多 repo 聚合门户）⚑ 待头脑风暴
- **现状痛点**：每 repo 独立 server，各占一个端口（7842 先到先得、其余随机），`detached` 常驻 → 易堆积、无 stop-all、2+ repo 端口不固定、无中央登记。
- **目标**：**单机一个常驻 server** 聚合本机所有 lore repo；顶层先选 repo → 再进该 repo 的多轴 wiki（按 repo 切分页/导航）。
- **待定（brainstorm 项）**：
  - 注册表：server 怎么发现本机各 repo 的 `.lore/`？中央 `~/.lore/registry.json`（init 时登记）vs 扫描 vs 手动 add。
  - 路由 + namespace：`/<repo>/wiki/…` 路径前缀？manifest 怎么按 repo 命名空间聚合。
  - 单一稳定端口（固定 7842）+ 单进程生命周期（替代 per-repo `.state/serve.pid`）。
  - 安全：仍只绑 `127.0.0.1`；跨 repo 只读；repo 路径白名单 + 防目录穿越（聚合多路径放大攻击面）。
  - 壳改造：顶层 repo 选择器 UI；跨 repo 搜索（全局 vs 当前 repo）。
  - 与现有 per-repo serve 的兼容/迁移（保留单 repo fallback？）。
- **踏脚石（低风险过渡）**：先做 `/lore:serve --list` / `--stop-all`（扫已知 `.state/serve.pid`）+ 每 repo 稳定端口（`hash(loreDir)→7000-7999`，同 repo URL 永远一致），再演进到聚合门户。

### resident-mode（母 §5 消费）
- 让 agent **grep / 读大文件排查前先查 `.lore/wiki/INDEX.md` + 相关 facet 页**。
- 形态：插件注入 CLAUDE.md 规则 / PreToolUse 提醒（plugin 打包 / hook 配置活，非可测 lib）。把 `/lore:ask` 的「按需查」升级成「always-on 纪律」。

### 增量 sync（母 §5「增量合成」）
- 现全量重建（每 sync 重渲所有页）。加 `.state/` 每页指纹 `{code_sha, journal_offset}`；只重建被碰的页 → 只有变动页重新 LLM。控成本。

### lint：未打标 / 矛盾检查（母 §5）
- 现 lint 三检（stale/orphan/missing）。加：未打标原子（只 component 缺 flow/theme，flow/theme 落地后才有意义）、矛盾（页「当前架构」声明 vs 更新原子冲突 → 轻 LLM）。

## 远期（结构接地 + 集成）

### codegraph 可选集成（AST 接地架构段）
- 见 `docs/superpowers/notes/2026-06-02-codegraph-integration-roadmap.md`。
- 「当前架构」段现全 agent LLM 写源码（有幻觉风险）。最轻形态：`/lore:sync` 命令层引导——agent 合成时若检测到 [codegraph](https://github.com/colbymchenry/codegraph) 可用，用其 MCP/CLI 取结构事实接地架构段；否则回退现状。lore 零代码改、保零依赖。
- 触发：lore 架构段幻觉成实测痛点。

### MCP 暴露
- 把消费 MCP 化（`lore_ask` / `lore_page` / `lore_stale`）→ agent 紧集成。

### 其他生态 / 检索升级
- mine 的 `pathComponent` / discover：Go 等更多生态探测器（YAGNI，按需）。
- `/lore:ask` 检索：正文全文 / TF-IDF 权重 / 语义向量（v1 只 title+summary 命中计数）。
- theme/flow match：regex（v1 子串）。

## 不做（明确 out of scope）
- call graph / impact analysis（caller/callee/blast radius）—— 非 lore 目标（那是 codegraph 的地盘；lore 的 flow 轴 + atom `refs.related` 是粗粒度类比，够了）。
- SQLite 存储 —— lore 故意用 git 跟踪 markdown（历史/diff/分支局部全免费）。

---

*v1 把耐久捕获 + 薄合成 + lint + 消费跑通，给后续 query 层留了干净接缝（策略 A「Journal-first 薄合成」，母 spec §1）。*
