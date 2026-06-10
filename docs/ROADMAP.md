# lore 路线图

> v0.1.0 = 捕获三源 + journal + 三轴合成 + lint + serve + ask（核心闭环完整）。
> 下面是后续迭代，按价值/依赖排序。每项仍走 spec → plan → TDD → 审查 → 合并。
> 母 spec：`docs/superpowers/specs/2026-05-31-lore-repo-wiki-design.md`。

## 北极星（项目目标 —— 缺一不可）

lore 必须**同时**服务两类读者，任何 roadmap 项都按「是否同时推进这两端」排优先级：

1. **人读友好的代码仓库 wiki** —— 一眼看懂：为什么这么设计、关键决策怎么来的、**时间线**（演进顺序）、**最新架构**、**各类数据流**。读文档像读一本活的项目史，不用 grep 源码。
2. **agent 友好的 wiki + graph** —— 不只是给人看的页面，还是机器可遍历的**结构**：节点（页 / 原子 / 组件）+ 边（wikilink / facet / refs / 决策关系），让 agent 检索、问答、顺图谱推理，而非重读代码。

## 已完成（v0.2 → v0.5，均 spec→plan→TDD→两段审查→opus 终审→合并）

- **v0.2.0** mermaid 架构/数据流图（vendored、客户端渲染、securityLevel strict）· 可安装为 Claude Code 插件 · installHook hooksPath 修复 · sync token exactly-once。
- **v0.3.0** docs 轴 —— 文档摄取（`docs/` + CHANGELOG + CLAUDE.md 踩坑 → 物化视图，零 LLM）。
- **v0.4.0 / 0.4.1** docs 页嵌入文档全文（消 404）· docs 时间降序（侧栏显日期）· mermaid 懒加载 · server 目录索引修复。
- **v0.5.0** 人读 **HOME 首页**（HOME 轴）· 持久化**双语层 i18n**（语言配置 + 翻译 sidecar + `/lore:translate` 命令 + 语言切换器 + 本地 state API + Host-guard 安全）。注：翻译**按需生成**（非 sync 自动），未译时回退源页显「missing」。
- **v0.6.0（portal MVP）** 单机共享门户 —— 固定端口 `7842` 一个常驻 server 聚合本机所有 lore repo（`~/.lore/repos.json` 发现 + init 自动登记 + `/<name>/` 路由 + `/` repo 选择器 + 只读 + 白名单/穿越防护）。`/lore:portal start|stop|list`，与 per-repo `/lore:serve` 共存。设计见 `docs/superpowers/specs/2026-06-07-lore-portal-design.md`。

## 当前迭代（决策 2026-06-06）

人读端已四连更（v0.2→v0.5），边际收益递减；而北极星的 **agent 端（graph + MCP）仍是 0**。本轮按「先清债 → 再补 agent 半边天」推进，已知问题一条不丢、分别归位到下方各节：

1. **journal fold-by-id**（清 ⭐ biting 债，且是 note-enrich / 跨轴折叠的前置）→ 见「待修复」⭐ 与「note enrich 骨架 + journal fold-by-id」。
2. **agent 友好 graph + MCP 暴露**（兑现北极星缺失的另一半）→ 见「待办（北极星 agent 端）」。
3. **server 运维踏脚石**（`serve --list/--stop-all` + `hash(loreDir)→稳定端口`，低风险穿插）→ 见「单机共享 server」的「踏脚石」。

排期收尾（不丢）：HOME 翻译过度 stale、defaultHomePage 空段、docs 页 chips → 见下「待修复」。

## 待修复（known issues）

- **journal fold-by-id（决策史重复）⭐ 已实测 biting** —— amend 的 commit 在 journal 留 pre/post 两条 sha 原子 → 决策史出现重复条目（dogfood `component/lib` 页可见）。按 id 折叠取最新即修（见下「note enrich + fold-by-id」）。
- **HOME 翻译过度 stale** —— `translation_source_hash` 含机械状态块 → 每次 sync 状态变都让 HOME 翻译 stale。应把状态块排除出 hash。
- **defaultHomePage 空段** —— 无 pitfalls/ROADMAP/changelog 的 repo，HOME「排查/决策」段空标题无 bullet。条件渲染。
- **docs 页 chips** —— 「0 atoms · code_sha —」对文档页怪（`buildMeta` 区分 docs 页）。
- **server 堆积** —— 每 repo 独立 server 占端口、易堆（见中期「单机共享 server」+ `serve --list/--stop-all`）。

## 北极星 agent 端 —— ✅ 基本已实现

- **agent 友好 graph + MCP 暴露** ✅ —— `graph.js` 把 wiki 合成机器可遍历结构（节点：页/原子/组件；边：facet/refs_related），`mcp.js` 暴露 `lore_ask`/`lore_page`/`lore_neighbors` 三工具让 agent 顺图谱检索/推理。**内容质量 C 的源文件级深度页让图谱可遍历到模块级**（dogfood：lib 从 1→7 个 component 节点）。**余项**：`lore_stale` 工具 + resident-mode 消费纪律（grep/读大文件前先查 wiki）。

## 近期（高价值、自洽）

### 文档摄取 —— docs/ + changelog + pitfalls（捕获第 4 源，🚧 进行中 v0.2.x）
- **缺口**：journal 只来自 commits + agent note；`docs/` 设计文档/spec/plan、`CHANGELOG`、`CLAUDE.md` 踩坑全不进 wiki。用户明确点的最大缺口。
- **本轮做（Y · 物化视图）**：spec/plan `docs/superpowers/{specs,plans}/2026-06-05-lore-docs-ingestion*`。新 **docs 轴** + `lib/docs.js` 三 extractor（`docs/**/*.md` 每文件一页、`CHANGELOG`/`CLAUDE.md` 踩坑各折一页）→ `buildDocsAxis` nuke-rebuild `wiki/docs/`。**机械薄页、零 LLM、无 journal、永远当前**；config `axes.docs` opt-in。
- **本轮推迟（后续迭代）**：
  - **X · journal 原子 + 跨轴折叠**：让 doc 决策按 facet 露在相关 component/theme 页决策史。依赖下面的 `journal fold-by-id`。
  - **agent 摘要页**：每文档 LLM 写 2-3 行抽象（比机械薄页丰富）。
  - **增量指纹**：现每 sync 全量 nuke-rebuild docs 页；大 `docs/` 时加每页指纹、只重建变动页。
  - **docs 页 chips**：`buildMeta` 区分 docs 页，去掉「0 atoms · code_sha —」的怪显示。
  - **小项**：折叠页 id 碰撞前缀（doc 名撞 `changelog`/`pitfalls`）、源链本地壳可点（现仅 github 仓库浏览可点）、pitfalls 标签集对齐 threat-intel 实测格式。

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

### 单机共享 wiki server（多 repo 聚合门户）✅ MVP 已实现（v0.6）· 余项待迭代
> MVP 已实现（见上「已完成 v0.6.0」）：单进程聚合 + 中央 registry + `/<name>/` 路由 + repo 选择器 + 只读白名单。**余项（后续迭代）**：跨 repo 全局搜索、write API 多路由、壳内「切 repo」下拉、per-repo serve 自动迁移/端口回收、namespace 高级冲突策略。
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

### 增量 sync（母 §5「增量合成」）✅ 已实现（低摩擦合成 A）
- 已实现：`.state/fingerprints.json` 每页 `{prose_hash, prose_sha}`（`prose_hash` 复用 `translationSourceHash`）；finalize 只在正文变了才推进 `prose_sha`、frontmatter `code_sha` 盖 `prose_sha` → `stale` 诚实（按 code_root 精确）；`planSync` 只挑动过 code_root 的 component 页（`--all` 兜底）；post-commit hook detached 跑机械 `finalize`。设计见 `docs/superpowers/specs/2026-06-08-lore-low-friction-sync-design.md`。余项（B 前端控制台/档位）另立 spec。

### 同步控制台 B1（档位 + 控制 API + 壳控制台）✅ 已实现
- 已实现：档位 `manual`/`notify`（`.state/sync.json`，per-machine，hook 真读分流——manual 档 commit 零后台动作）；控制 API 四端点（status / mode / finalize-spawn / rewrite-requests，localhost-only + safeWikiPage 防越狱，portal 仍只读 404）；壳顶栏状态灯（🟢/🟡/⚪ 三态）+ 下拉面板 + `#console` 整页（全 CSS 主题变量，三主题跟随）；manifest 轮询（15s 慢 + 操作后 1s 快，`no-store` 防 python 缓存）自动刷新灯/侧栏 + 当前页「⟳ 内容已更新」提示条；重写排队（ndjson 队列去重，`/lore:sync` 优先消化）。serve `--node` 给单语 repo 启用控制 API。7 项端到端验收全过（含「切 manual → commit → manifest 纹丝不动」反空壳）。设计见 `docs/superpowers/specs/2026-06-09-lore-sync-console-design.md`。
- **B2（另立 spec）**：LLM 运行器（可插拔后端：默认 spawn claude CLI 无头 / 裸 Anthropic API / codex 扩展位）+ `auto` 档 + `schedule` 定时 + 质量门（机械校验+失败丢弃）+ 自动重写任务历史。

### 内容质量（两档好页 + 源文件级深度页）✅ 已实现（C-内容）
- 已实现：定义「好 wiki 页」**两档标准**（**概览档**零黑话 + **机制档** 9 节 `<details>` 折叠 + **锚点锚符号**），写进 `commands/sync.md` + golden page 标杆（`docs/superpowers/notes/2026-06-08-lore-golden-page-sync.{html,md}`）；**两层粒度**——config `axes.component.deep.<root>:[子模块…]` 声明源文件级深度页，`planSync` 列深度页工单（增量按源文件）、`finalizeSync` 按源文件精确算 stale；深度页是普通 component 页 → manifest/graph 自动支持（**graph 可遍历到模块级**）。dogfood：lib 一页 → 鸟瞰页 + 6 深度页（graph 1→7 节点）。设计见 `docs/superpowers/specs/2026-06-08-lore-content-quality-design.md`。余项（壳深度切换 UX、产出校验、文件级决策史分流）另立。

### 壳呈现（mermaid 放大 + component 排序分组）✅ 已实现（C-呈现 ①）
- 已实现：壳大 mermaid 图点击 → lightbox（弹层内拖拽 + 滚轮缩放，缩放圈在弹层内不扰正文；**按当前主题重渲染**，亮/暗主题大图节点色与正文逐字一致）；`config.deep` 升级分组 map（捕获/合成），`manifest` component 页按流水线序排（lib 鸟瞰置顶）+ 带 `group` 字段，壳侧栏插分组小标题。设计见 `docs/superpowers/specs/2026-06-09-lore-shell-presentation-design.md`。余项（docs 轴重构、mermaid 语法校验+br 统一、server.js 根文件组件+决策史分流）各自另立。

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
