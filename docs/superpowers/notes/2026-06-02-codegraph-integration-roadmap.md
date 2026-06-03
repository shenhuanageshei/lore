# Roadmap note: codegraph integration + adjacent ideas

> 2026-06-02 · 非 spec/plan，是路线图记录。来源：用户提供参考项目 [codegraph](https://github.com/colbymchenry/codegraph)（[docs](https://colbymchenry.github.io/codegraph/getting-started/introduction/)）。**当前不实施**——记录想法 + 推荐形态 + 触发条件。

## codegraph 是什么（一句话）
tree-sitter AST → symbols/edges/files 知识图谱（SQLite + FTS5），给 AI agent 预索引代码**结构**，省 token/工具调用。纯确定性、零 LLM、100% 本地、MCP 暴露、文件监听自动同步。

## codegraph 与 lore：互补，非竞争
- codegraph = 结构层「**是什么 / 怎么连**」（symbols、call graph、impact）。确定性、可查、SQLite（gitignore）。
- lore = 决策层「**为什么 / 怎么演进**」（journal 原子 + 合成架构叙事）。git 跟踪 markdown、可 diff、分支局部、含 why。
- 两者占不同层。lore 不该变 call graph。

## 验证了 lore 的设计（codegraph 同款，反证 lore 走对）
1. provenance/confidence 标注（codegraph `provenance:'heuristic'`/`synthesizedBy:` ↔ lore atom `confidence`/`source`）。
2. 陈旧旗标（codegraph pending-file banner ↔ lore manifest `stale=N`）。
3. **确定性 vs LLM 分层**：codegraph 全确定性 → 能廉价自动同步；lore 把确定性活（journal/manifest/mine）与贵 LLM 活（wiki prose）分开 → **正是 lore wiki 手动 sync、journal 自动（hook）的理由**。
4. git-markdown vs SQLite：各自目标对路，lore 别换 SQLite。
5. auto-discover（codegraph 按扩展名零配置 ↔ lore init `discoverComponents` 提议 config）。

## 三个可借想法（未来，按触发条件动）

### 1. AST 接地的「当前架构」段（最有价值）
- **问题**：lore component 页「当前架构」段现全 agent LLM 写源码 → 有幻觉风险。
- **借**：codegraph 论点「结构别 LLM 摘要、从 AST 抽」。给架构段一个**确定性结构骨架**（入口、关键 symbol、call edge）+ LLM 只写叙事。
- **推荐形态（最轻、零依赖、可选）**：**不是** lore 核心读 `.codegraph/codegraph.db`（要 SQLite reader，破零依赖）。而是 **`/lore:sync` 命令层引导**：agent 合成时**若检测到 codegraph 可用**（`codegraph status` 退 0 / MCP 工具在），就用 `codegraph_explore`/`codegraph_query` 取该 component 的结构事实接地架构段；否则回退现状（纯读源码）。lore 零代码改、零新依赖、纯命令 prompt 增量。
- **触发条件**：lore 架构段幻觉成实测痛点（多个 repo 上 sync 出的架构段与真实不符）。在此之前 YAGNI。

### 2. MCP 暴露（agent 消费）
- codegraph 用 MCP（`codegraph_explore` 等）给 agent。lore §5 的 `/lore:ask` 是同位的消费入口。
- **借**：未来把 lore 消费 MCP 化（`lore_ask` / `lore_page` / `lore_stale`）→ agent 更紧集成（resident-mode 自动查 wiki，不靠 prompt 纪律）。
- **触发条件**：`/lore:ask` 落地后、想从「prompt 软提醒读 wiki」升级到「工具强制查 wiki」时。

### 3. confidence 显示（已在 lore 路线）
- sync 渲染 journal 原子时显「(推断)」标 INFERRED/AMBIGUOUS facet（母 spec §4 line 190 已规划）。
- **触发条件**：mine 产出 INFERRED facet（即 flow/theme 层 2 打标落地）后。当前 mine v1 只产 EXTRACTED component → 暂不需要。

## 不借
- call graph / impact analysis（caller/callee/blast radius）——非 lore 目标（lore 的 flow 轴 + atom `refs.related` 是粗粒度类比，够了）。
- SQLite 存储——lore 故意用 git-markdown。

## 一句话结论
codegraph 与 lore 同向（都省 agent token），但分属结构层 vs 决策层。最值得借 = 想法 1（AST 接地架构段），且走**命令层可选集成**而非核心耦合，保 lore 零依赖。三个想法都 YAGNI 到各自触发条件。
