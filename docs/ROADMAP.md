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

## 当前迭代（决策 2026-06-06）✅ 全部收尾（2026-06-10 核实）

当时排的三项均已落地：① journal fold-by-id（`lib/fold.js`：孤儿过滤+按 id 合并，sync 消费，8 测试）② agent 端 graph+MCP（见下节 ✅）③ server 运维踏脚石（`serve --list/--stop-all` + `stablePort` 均已在 `lib/serve.js`）。

## 待修复（known issues）✅ 全部已修（2026-06-10 逐条核实，此前条目长期陈旧）

- ~~journal fold-by-id（决策史重复）~~ ✅ A 轮 `lib/fold.js` 实现（孤儿过滤 + mergeById + why 演化追加）；本轮补刀 `stripTrailers`——决策史 why 不再显示 Co-Authored-By 等 commit trailer 噪音（mine 源头净化 + renderDecisionHistory 防御旧原子）。
- ~~HOME 翻译过度 stale~~ ✅ `i18n.js` `SENTINEL_RE` 把所有 `LORE_*` 机械哨兵区剔出 `translationSourceHash`。
- ~~defaultHomePage 空段~~ ✅ `home.js` `section()` 空段整段省略（含标题）。
- ~~docs 页 chips~~ ✅ `shell.mjs` `buildMeta` docs 轴单独返回 `📄 last-updated` chip。
- ~~server 堆积~~ ✅ 大半解决：portal v0.6 聚合 + `stablePort`（同 repo URL 恒定）+ `--list/--stop-all`；余项见「单机共享 server」。

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
  - ~~docs 页 chips~~ ✅ 已修（`buildMeta` docs 分支）。
  - **小项**：折叠页 id 碰撞前缀（doc 名撞 `changelog`/`pitfalls`）、源链本地壳可点（现仅 github 仓库浏览可点）、pitfalls 标签集对齐 threat-intel 实测格式。

### per-facet confidence 显示（母 §4 line 190）
- 现 commit 原子整体 `confidence:'EXTRACTED'`。母 spec：component=EXTRACTED、flow/theme=INFERRED（机械推断）。
- 改为 **per-facet confidence**；`renderDecisionHistory` / serve 壳给 INFERRED facet 显「(推断)」；`/lore:lint` 把 AMBIGUOUS 推人确认。
- 小改动，完成 facet 质量故事。

### note enrich 骨架（母 §4② 后半）· fold-by-id 半边已实现
- `/lore:note` 现只产新 decision 原子。加 **enrich 已有 commit 骨架**：同 `commit:<hash>` append 新行补 `why`（append-only 神圣，不改旧行）。
- ~~配套 journal fold-by-id~~ ✅ 已实现（`lib/fold.js` mergeById：同 id 合并、why 演化追加、refs 并集，sync 消费）——enrich 落地时折叠层零改动直接可用。注：ask 读 manifest、lint 读 frontmatter，均不消费原子，无需接入。

## 呈现（wiki 渲染，⭐ 用户明确要）

### ~~mermaid 架构图 + 数据流图~~ ✅ 已实现（v0.2 + C-呈现①增强）
- vendored 客户端渲染 + securityLevel strict（v0.2）；点击 lightbox 放大 + 主题感知重渲染（C-呈现①）。余项：mermaid 语法校验 lint + `<br/>` 统一（另立）。

### ~~双语切换（中/EN）~~ ✅ 已实现（v0.5 持久化双语层）
- 语言配置 + 翻译 sidecar + `/lore:translate` + 切换器 + state API（v0.5）。决策史保持源语言（诚实约束已落实）。

## 中期（消费纪律 + 质量）

### 单机共享 wiki server（多 repo 聚合门户）✅ MVP 已实现（v0.6）· 余项待迭代
> MVP 已实现（见上「已完成 v0.6.0」）：单进程聚合 + 中央 registry + `/<name>/` 路由 + repo 选择器 + 只读白名单。**余项（后续迭代）**：跨 repo 全局搜索、write API 多路由、壳内「切 repo」下拉、per-repo serve 自动迁移/端口回收、namespace 高级冲突策略。
- ~~现状痛点 / 待定 / 踏脚石~~ ✅ 均已被 v0.6 MVP + `serve --list/--stop-all` + `stablePort` 落地（旧计划文本删除，2026-06-10 清理）。

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
- 已实现：壳大 mermaid 图点击 → lightbox（弹层内拖拽 + 滚轮缩放，缩放圈在弹层内不扰正文；**按当前主题重渲染**，亮/暗主题大图节点色与正文逐字一致）；`config.deep` 升级分组 map（捕获/合成），`manifest` component 页按流水线序排（lib 鸟瞰置顶）+ 带 `group` 字段，壳侧栏插分组小标题。设计见 `docs/superpowers/specs/2026-06-09-lore-shell-presentation-design.md`。余项（mermaid 语法校验+br 统一、server.js 根文件组件+决策史分流）各自另立。

### docs 轴重构（分组置顶 + feature 配对 + 默认折叠）✅ 已实现（C-呈现 ②）
- 已实现：docs 轴侧栏三组分流——「📌 项目状态」（changelog/ROADMAP/pitfalls）置顶常开、「📐 设计与计划」spec↔plan 按 date+slug 配对成行（plan 徽标直达，dogfood 25 对）默认折叠、「📝 notes」折叠；折叠态 localStorage 记忆；搜索穿透折叠组（data-search 含英文 slug）。group/paired_plan 由 `docs.js` 物化进 frontmatter，manifest 组间排序（单一来源），壳 `buildDocsRows` 纯函数可测。无 superpowers 结构 repo 零影响。设计见 `docs/superpowers/specs/2026-06-10-lore-docs-axis-regroup-design.md`。

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
