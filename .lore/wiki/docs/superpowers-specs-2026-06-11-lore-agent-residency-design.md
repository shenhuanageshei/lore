---
title: lore agent 常驻消费（resident-mode + 节级检索 + deep 补录）—— 设计
summary: - 日期：2026-06-11 - 状态：设计已批（对话内逐段确认），待写实施计划 - 北极星：agent 友好的 wiki + graph——本期从「agent 可用」推进到「agent 在用、且用得起」 - 前置（已在 main）：v0.7.0 全量（MCP 三工具、graph、两档页、deep 页、诚实 stale、auto 档）
source_path: docs/superpowers/specs/2026-06-11-lore-agent-residency-design.md
last_updated: 2026-06-11
group: 设计与计划
paired_plan: superpowers-plans-2026-06-11-lore-agent-residency
---
> 源文档：`docs/superpowers/specs/2026-06-11-lore-agent-residency-design.md`

# lore agent 常驻消费（resident-mode + 节级检索 + deep 补录）—— 设计

- 日期：2026-06-11
- 状态：设计已批（对话内逐段确认），待写实施计划
- 北极星：agent 友好的 wiki + graph——本期从「agent 可用」推进到「agent 在用、且用得起」
- 前置（已在 main）：v0.7.0 全量（MCP 三工具、graph、两档页、deep 页、诚实 stale、auto 档）

## 背景：一次诚实的冷启动对照实验（2026-06-11）

**问题缘起**：用户问「lore 对 agent 友好的目标达成了吗？」——而最有发言权的本会话 agent 自己**从未消费过 lore**（热上下文不需要）。于是做对照实验：两个零上下文 subagent 回答同样三道深度机制题（prose_sha 推进条件 / 为什么对折叠后文本算指纹 / sync.json 为何整文件覆写），一个只许读 `.lore/wiki/`，一个只许读 `lib/` 源码。

**结果**：

| 维度 | wiki-only | source-only |
|---|---|---|
| 正确率 | 3/3 全对，字字有出处 | 3/3 全对，行号级引用 |
| tokens | 65.6k | **31.9k（一半）** |
| 耗时 | 235s | 141s |
| 读量 | 9 文件 ~900 行 | 5 文件 ~340 行 |
| why/后果深度 | ✅ 完整故障叙事 + 实测踩坑史 + 用户影响 | ⚠️ 机制推理对，自认「缺运行时反例」 |

**三层结论**：

1. **结构层达成**——零上下文 agent 纯靠 wiki 答对全部 why 级难题（三天前 wiki 只有一页空泛 lib 时不可能）。
2. **效率主张在本 repo 被打脸，且原因有启发**——lore 自己是小仓库（lib ~2000 行）+ 注释写满 why，是「最不需要 lore 的 repo」。token 去向解剖：① 导航开销 ~1/3（agent 不知道答案在哪页，先读 HOME/INDEX/lib 才定位）② 双读者税（概览档的比喻/场景是给人的，agent 被迫连人话一起读）③ 整页读取（答案在一节，却读了 23KB 全页）。
3. **消费纪律未闭环（最大缺口）**——本会话 agent 没主动查过一次 wiki、MCP 三工具零调用：没有任何机制在 agent grep 之前告诉它「wiki 存在且新鲜」。

**实验顺手暴露的两笔新债**（wiki-only 组亲述）：① `syncstate`/`runner` 等 B1/B2 新模块没有深度页（config.deep 仍是 6 个旧模块——「wiki 跟不上代码」的老病在 lore 自己身上复发）；② 决策类信息（覆写 vs rename）藏在 docs 轴 spec，component 页未勾稽，agent 靠 grep 救场。

## 决策（已锁，对话内逐项确认）

| 项 | 决策 |
|---|---|
| 判据校准 | agent 友好的判据是「**冷启动** agent 用 lore 比不用强」，不是「所有 agent 时刻在用」——热上下文 agent 不查 wiki 是合理行为，非 bug |
| 触发机制 | **A+B 组合**：A = `/lore:init` 往目标 repo 的 CLAUDE.md 写一节 resident 指引（带标记可卸载）；B = init 注册 lore MCP server 进 repo `.mcp.json` + 工具描述触发词优化。**弃 C**（PreToolUse hook 拦 Grep 提醒）——噪音大于收益 |
| 自动开关 | **CLAUDE.md 注入默认开**（resident 的全部意义；用户拍板），`/lore:init --no-resident` 关；config `resident: false` 持久关。卸载 = 删标记节 |
| 指引内容动态生成 | CLAUDE.md 节包含 wiki 实时状态（N 页 / M 组件深度页 / 最后更新）——让 agent 知道 wiki 是活的不是摆设 |
| 预算控制三招 | ① **节级检索（ask v2）**：finalize 切节索引进 manifest，`lore_ask` 返回「页#节」并直接带回该节内容——导航成本从读 3 页降到 1 次调用；② **agent 视图**：`lore_page` 加 `view=agent`，机械剥概览档（比喻/场景），只回机制档+决策史；③ **graph 优先协议**：ask.md 指引改「ask 定位 → page(section) 取节 → neighbors 扩展」，废人类导航路径 |
| budget 参数 | **不做**（用户拍板）——节级粒度本身已是最大节流，`--budget N` 截断等实测需要再说（YAGNI） |
| 小 repo 物理事实 | 接受并写明：**小 repo 上 lore 就该输给源码**（340 行代码无法被摘要打败）。ROI 随 repo 体量上升；非对称优势区 = 决策史/踩坑/「为什么不那样做」（源码与 git log 翻找成本爆炸） |
| deep 补录 | dogfood `config.deep` 补 `syncstate`、`runner`（归「合成」组）；**决策勾稽**：deep 页机制档引用相关 spec 决策（sync.md 两档标准补一条指引） |
| 验收方式 | 实现后**重跑冷启动对照实验**（新问题集，2 个 subagent）：wiki 组必须用新链路（MCP/节级），对比本次基线 65.6k——目标显著下降且正确率不降（用户指定） |

## 设计

### A · resident-mode（lib/init.js + commands + mcp）

**A1 CLAUDE.md 注入**（`installResident(repoRoot, loreDir)`，init 调用，幂等）：

- 标记节格式（替换式幂等，同 hook 安装风格）：

```markdown
<!-- LORE_RESIDENT:START -->
## lore wiki（本仓库的活文档）

本 repo 由 lore 维护多轴 wiki（{N} 页 · {M} 个组件深度页 · 最后更新 {date}）。
**理解架构、查找模块职责、查决策原因时，先查 wiki 再 grep 源码**：
- MCP 工具：`lore_ask`（关键词检索，返回命中节）→ `lore_page`（取单页/单节，`view=agent` 省 40% token）→ `lore_neighbors`（图谱扩展）
- 无 MCP 时：读 `.lore/wiki/INDEX.md` 定位 → 读目标页
- 决策史/踩坑/「为什么不那样做」只有 wiki 有——源码注释和 git log 都查不动这类问题。
<!-- LORE_RESIDENT:END -->
```

- N/M/date 从 manifest 实时读；**finalize 末尾顺手刷新该节**（CLAUDE.md 已存在且含标记节时才更新——manual 档下不刷，显示上次 finalize 状态，可接受）。
- `--no-resident` / config `resident: false` → 跳过注入；卸载删标记节。

**A2 MCP 注册**：init 往 repo `.mcp.json` merge 一条 `lore` server（幂等不覆盖既有其他 server）。**路径可移植性**：server 命令写 init 当时解析的引擎绝对路径（`lib/mcp.js` 所在），与 post-commit hook 同策略——引擎挪位置需重跑 init（已有先例，可接受）。工具描述重写（触发词优化）：

- `lore_ask`: "理解本仓库架构、查找模块职责、查决策原因时**优先**使用：关键词检索 wiki，返回命中页的相关小节（比读源码省 token，且含源码没有的决策史）"
- `lore_page`: "按 id 取单个 wiki 页；`section` 参数取单节；`view=agent` 跳过人读概览档"
- `lore_neighbors`: "图谱扩展：给定页/组件，返回相邻节点（依赖、相关决策、同 flow 组件）"

### B · 节级检索 + agent 视图（manifest + ask + mcp）

**B1 节索引**：`pageEntry`（或 finalize 物化时）解析页 body 的 `##`/`###` 标题 → manifest 页条目加 `sections: [{ heading, line }]`（line = 节起始行，供切片）。机制档在 `<details>` 内的 `<summary><b>① …</b></summary>` 也算节（正则提取 ①-⑧ 标题）。

**B2 ask v2**（`lib/ask.js`）：检索命中除页级（title+summary）外加**节级**（heading 文本）；输出每个命中带 `page#heading` 与**该节内容切片**（从节起始行到下一同级标题）。CLI 输出与 MCP `lore_ask` 同步升级。

**B3 agent 视图**（`lib/mcp.js` `lore_page` + serve 的 wiki 读取不动）：`view=agent` 时机械变换页文本——剥掉「## 概览」到「## 机制详解」之间的内容（保 frontmatter、机制档、依赖/邻居、决策史哨兵区）；`section=<heading>` 时只回该节。两参可组合。两档结构缺失的页（如 HOME/docs 页）→ 原样返回（容错）。

### C · deep 补录 + 决策勾稽（dogfood + commands/sync.md）

- `config.deep` 的「合成」组补 `syncstate, runner` → `/lore:sync` 产两张新深度页（按两档标准，agent 写）。
- `commands/sync.md` 两档标准补一条：机制档「⑤ 边界/坑」节**勾稽相关 spec 决策**——格式 `←（决策见 docs 轴 <spec-slug>）`，让 agent 从 component 页一跳到决策出处。

## 不变量 / 风险

- 零依赖不破（全部 Node 内置）。
- CLAUDE.md 是用户文件：只动标记节内、幂等替换、默认开但一键关——侵入克制。
- `.mcp.json` merge 不覆盖用户既有配置；文件不存在则创建最小形态。
- 节切片是机械文本操作（标题行定位），坏页/无标题页退化为整页返回，不崩。
- 风险：CLAUDE.md 指引是软约束，agent 仍可能无视——接受（判据是冷启动可用性，A2 的工具描述是第二道触发面）；resident 节的 N/M/date 刷新挂 finalize，manual 档下会过时（显示的是上次 finalize 时状态，可接受）。

## 测试

1. `installResident`：注入/幂等替换/`--no-resident` 跳过/卸载删节/CLAUDE.md 不存在时创建（仅标记节）。
2. `.mcp.json` merge：空文件/已有其他 server/已有 lore 条目幂等。
3. 节索引：两档页提取 ##/### 与 ①-⑧ `<summary>` 标题；无标题页 `sections: []`。
4. ask v2：节级命中返回 `page#heading` + 切片内容；页级命中向后兼容。
5. `lore_page`：`view=agent` 剥概览档保机制档；`section` 单节；组合；非两档页原样。
6. dogfood：deep 补录后 `/lore:sync` 出 syncstate/runner 两页；勾稽格式抽查。
7. **终验（用户指定）**：重跑冷启动对照——2 个 subagent、新问题集（避免本次三题的记忆效应），wiki 组限定走 MCP 新链路；对比基线 65.6k tokens / 3 题正确率。

## 实现节奏

spec → writing-plans → plan → TDD → 冷启动复测 → 合并。

