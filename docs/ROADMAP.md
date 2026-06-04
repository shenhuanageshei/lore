# lore 路线图

> v0.1.0 = 捕获三源 + journal + 三轴合成 + lint + serve + ask（核心闭环完整）。
> 下面是后续迭代，按价值/依赖排序。每项仍走 spec → plan → TDD → 审查 → 合并。
> 母 spec：`docs/superpowers/specs/2026-05-31-lore-repo-wiki-design.md`。

## 近期（高价值、自洽）

### changelog / pitfalls miner（母 §4③ 另两源）
- `/lore:mine` 现只挖 commits。加两个可插拔 source extractor：
  - **changelog**：解析 `CHANGELOG.md`（Keep-a-Changelog `## [x.y.z] - date` 段）→ `kind:decision` 原子。半通用。
  - **pitfalls**：解析 CLAUDE.md 的 Problem/Fix/Prevention 结构化踩坑 → `kind:incident` 富 why 原子。格式特定（试验田 threat-intel 的金矿）。
- config `journal.mine: [commits, changelog, claude_md_pitfalls]` 已声明哪些源跑；按 config gate。
- 触发：想把现有产物（CHANGELOG / 踩坑）一夜变成可导航原子流时。

### per-facet confidence 显示（母 §4 line 190）
- 现 commit 原子整体 `confidence:'EXTRACTED'`。母 spec：component=EXTRACTED、flow/theme=INFERRED（机械推断）。
- 改为 **per-facet confidence**；`renderDecisionHistory` / serve 壳给 INFERRED facet 显「(推断)」；`/lore:lint` 把 AMBIGUOUS 推人确认。
- 小改动，完成 facet 质量故事。

### note enrich 骨架 + journal fold-by-id（母 §4② 后半）
- `/lore:note` 现只产新 decision 原子。加 **enrich 已有 commit 骨架**：同 `commit:<hash>` append 新行补 `why`（append-only 神圣，不改旧行）。
- 配套 **journal fold-by-id**：`readAllAtoms` 之上加按 id 折叠（取并集/最新）；sync / ask / lint 消费 folded 原子。保留 骨架→enriched 演化轨迹，审计友好。
- 中等：碰 journal 读层 + 所有消费者。

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
