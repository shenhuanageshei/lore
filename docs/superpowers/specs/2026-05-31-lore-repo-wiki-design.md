# Lore — 面向 AI Agent + 开发者的代码仓库活文档 / 决策历史框架

> 设计文档 (spec) · 2026-05-31 · 工作名 **`lore`**（可改名）· 状态: 已评审，待转实施计划

---

## 0. 背景与问题

长期演进的代码仓库会积累大量文档（最初设计、需求讨论、变更记录、部署记录、子模块架构演进、决策记录），散落在多个 `docs/` 目录与子目录中。随时间推移：

- **没有单一的"最新架构说明 + 决策历史 + 变更记录"**。某个流程/架构经多次修改后，没人能快速看到当前形态 + 它怎么演进到这里 + 每步为什么。
- **AI Agent 每次排查问题都要重头理解一遍代码**，无法复用前人/前几次会话沉淀的认知。
- **本地 / git / 服务器运行态代码不一致**（本项目踩坑 #163/#164 即此问题的真实案例）。

参考两个范式：

- **Karpathy LLM Wiki**（<https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f>）：LLM 维护的 markdown 知识库。三层 = Raw Sources（不可变源）/ Wiki（LLM 写的摘要+实体页+交叉链接）/ Schema（CLAUDE.md 式配置）。三操作 = Ingest / Query / Lint。核心洞察："维护知识库的累活不是阅读或思考，是 bookkeeping（更新交叉引用、保持摘要新鲜、标记矛盾）"——LLM 擅长人类会放弃的维护活。底层只是 markdown + git。
- **Graphify**（<https://github.com/safishamsi/graphify>）：代码→知识图谱。两阶段 = 确定性 AST 抽取（tree-sitter，无 LLM）+ 语义抽取（LLM sub-agent 处理 docs/图片）。NetworkX + Leiden 聚类。边标签 EXTRACTED / INFERRED / AMBIGUOUS。SHA256 缓存（只重处理改动文件）、watch 模式、git hooks、resident-mode（hook 让 agent 查图谱先于 grep）。号称查询成本比读原文件低 71x。

**目标**：融合 Karpathy 的「为什么 + 决策历史」与 Graphify 的「代码结构」，做一个**通用、可复用到任意 repo、不绑定本项目**的活文档 / 决策历史框架。本 `threat-intel` repo 仅作试验田。

---

## 1. 范围 (v1)

| 维度 | 决策 |
|---|---|
| **v1 骨架** | 决策 + 架构历史（Karpathy-leaning）。这是唯一无现成工具覆盖的缺口；Graphify 已覆盖结构。决策史顺带交付「agent 不用重头理解代码」的收益。 |
| **存储** | markdown-in-git。便携、免费版本/回溯/diff/对比、Obsidian 可视、agent 原生可读、零 DB。 |
| **交付载体** | Claude Code 插件 + slash 命令 + git hook + resident-mode。合成逻辑写成可移植脚本，结构上为未来 CLI 留口。 |
| **不在 v1** | query 引擎 / 图可视化（v2）、AST 结构抽取（v3）、PPT / 项目介绍生成（v4）、本地/git/服务器一致性漂移工具（v5，独立兄弟项目）。 |

**构建策略 = A「Journal-first 薄合成」**（评审选定）：先把耐久捕获 + 薄合成 + lint 跑通，证明 WAL 耐久性，给后续 query 层留干净接缝。Bootstrap 包含回填现有产物（commits / CHANGELOG / 195 踩坑）。

---

## 2. 核心模型：WAL → materialized view

文档系统的头号失败模式是**陈旧**，以及依赖 agent 上下文导致的**丢失**（长会话上下文被压缩 / 会话中断 / 规则被跳过 / 决策跨多会话）。根本解法：**wiki 永不作为知识的唯一副本，且永不依赖 agent 记忆**。把「耐久」与「合成」解耦，采用写前日志（WAL）→ 物化视图模式。

```
TIER 0 — SOURCES (已耐久, 非本框架所有)        TIER 1 — JOURNAL              TIER 2 — WIKI (派生)
─────────────────────────────────────        (append-only, 神圣)            (合成, 可重建/可丢弃)
git history (commit msg + diff) ──┐
agent live-enrich ("why") ────────┼──────────► .lore/journal/  ──┐
existing artifacts (mined) ───────┘           (永不覆写)          │
                                                                 ├─ synthesis(LLM) ─► component/*.md
code tree (只读扫描) ──────────────────────────────────────────────┘                   flow/*.md
                                                    │                                   theme/*.md
                                                    │                                   INDEX.md
                                                    └──────── lint ◄──────────────────  (陈旧/矛盾/孤儿)
```

**三层：**

- **Tier 0 — Sources**（已耐久，非本框架所有）：git history、代码树、现有 docs。不可变真相。
- **Tier 1 — Decision Journal**（`.lore/journal/`）：append-only 决策原子。**THE 耐久知识层**。hook 写骨架、agent 补「为什么」、miner 回填。永不覆写。这是抗上下文压缩的层。
- **Tier 2 — Living Wiki**（`.lore/wiki/`）：合成的、可重建的视图。component / flow / theme 页 + INDEX。是 Tier 1 + 代码之上的物化视图。

**核心不变量：知识单向流动 Tier0/1 → Tier2，绝不反向。Journal 神圣，Wiki 可重建。** 随时可 `nuke wiki/` 并从 journal 重建。→ 上下文压缩可以吃掉一个*会话*，但永不丢失*知识*（决策发生那一刻就落盘进 journal）。

---

## 3. 多轴 faceted 组织模型

知识页面沿 **N 个可插拔轴（facet）** 组织。引擎不硬编码轴种类，全读 config：

| 轴 | 类型 | 答什么 | facet 怎么来 |
|---|---|---|---|
| **`component`** | 内置 + auto-discover | "存在什么" | 机械（commit diff 碰了哪些 code_roots） |
| **`flow`** | 声明 | "数据怎么端到端跑"（article-pipeline、dedup） | config match 关键词 + agent + LLM |
| **`theme`** | 自定义横切关注点 | "这条长期主线怎么演进"（时效性、质量保证、安全、性能…） | 同上 |
| **任意自定义轴** | 用户加 | 任意（subsystem / compliance / perf…） | 同上 |

> 评审重点：`theme` 轴是关键泛化。本项目的「质量提升专题」= `theme:quality`，「管道时效治理」= `theme:timeliness`——既跨组件又跨流程的横切主线。开发者可任意加轴，引擎一视同仁。

**每个轴-值页统一三段形状**（= 用户要的"最新架构 + 决策历史 + 变更记录"三合一）：

1. **当前架构** — 合成的最新状态（可重建）
2. **决策历史** — 挂了这个 facet 的 journal 原子按时间线排（`theme:quality` 页能看到 v2→v2.5→v3 整条演进 + 每步为什么）
3. **交叉链接** — 关联的其他 facet + 代码路径 + 源 docs（link 不复制）

→ `theme/quality.md` = 跨全系统的「当前质量保证架构 + 质量处理一路怎么演进过来」的完整活专题。

### config.yml（Schema 层 / Karpathy L3 — 唯一存放 repo 特定信息的地方）

```yaml
# .lore/config.yml  —— 通用皮肤。本 repo 列 M1-M5；别的 repo 列它自己的 / 自动发现
axes:
  component:                              # 内置轴 + 自动发现
    discover: auto
    code_roots: [m1_crawler, m2_ingestion, m3_nlp, m4_report, m5_downstream, shared]
  flow:                                   # 声明轴
    values:
      - { id: article-pipeline, spans: [m1_crawler, m2_ingestion, m3_nlp] }
      - { id: dedup,            spans: [m1_crawler, shared] }
  theme:                                  # 自定义横切轴
    values:
      - { id: timeliness, desc: "数据流时效性 / 跑赢人工",        match: [时效, lag, backlog, throughput, stale] }
      - { id: quality,    desc: "实体/IOC/主题抽取准确率 + 报告质量", match: [质量, 误报, false.positive, accuracy, score] }
  # 想加 perf / security / compliance 轴？再加一条即可，引擎不用改
journal: { hook: true, mine: [commits, changelog, claude_md_pitfalls] }
```

### 文件布局（lives in 目标 repo，git-tracked）

```
<any-repo>/.lore/
├── config.yml          # Schema 层 — 唯一存放 repo 特定信息处
├── journal/            # TIER 1 — append-only 决策原子
│   └── 2026/05/2026-05-31.ndjson   # 按日分片 → append 友好、低 merge 冲突
├── wiki/               # TIER 2 — 可重建
│   ├── INDEX.md        # 目录 + 导航（Karpathy index.md + log.md 合一）
│   ├── component/      # 组件轴 — auto-anchored 到代码目录 (m1_crawler.md…)
│   ├── flow/           # 流程轴 — 跨模块 (article-pipeline.md…)
│   └── theme/          # 横切轴 — (timeliness.md, quality.md…)
└── .state/             # 引擎缓存（每页 source-SHA + journal-offset）— gitignored
```

`.lore/` 放**目标 repo 内** + git 跟踪：git 直接给"commit X 时架构长啥样"+ 分支局部 wiki 匹配分支代码 + 回溯/对比全免费。**插件（引擎）全局装一次，ship 零 repo 知识。**

---

## 4. 捕获：3 源 + 原子 schema + facet 打标管线

### Journal 原子 schema（ndjson，一行一原子）

```jsonc
{
  "id":   "commit:b5d4100",        // 稳定唯一 id（commit:<hash> / pit:<N> / note:<ulid>）
  "ts":   "2026-05-31T08:00:00Z",
  "kind": "commit|decision|incident|mined",
  "commit": "b5d4100",             // 关联 commit（可空）
  "title": "default per-run item cap",
  "why":   "anti 数据源爆炸",        // 骨架时可空，后续 enrich 填
  "what_changed": "WebFetch max_links 截断 + 每源每轮上限",
  "facets": { "component":["m1_crawler"], "flow":["article-pipeline"], "theme":["timeliness"] },
  "refs":  { "files":["m1_crawler/fetchers.py"], "pitfall":42, "related":["commit:1ee85e3"] },
  "source": "hook|agent|miner:commits|miner:changelog|miner:claude_md",
  "enriched": false,               // 骨架 vs 已补 why
  "confidence": "EXTRACTED|INFERRED|AMBIGUOUS"   // 借 Graphify 边标签；给 facet / why 标可信度
}
```

### 3 个捕获源

**① post-commit hook — 耐久地板（机械、零上下文、离线）**
每次 commit 写一条骨架原子。**硬约束：hook 内禁 LLM**（会阻塞 commit + 要联网），只做本地机械活 `<50ms`，失败 best-effort 不阻断 commit：
- `title`=commit subject，`why`=commit body，`refs.files`=`git diff --name-only`
- **`facets.component` 机械推导**：改动路径 → 映射 config `code_roots`（免 LLM、语言无关）
- `flow` / `theme` 跑 config `match:` 关键词正则 → 快路径打标（标 INFERRED）
- `source=hook`, `enriched=false`

→ **每个 commit 必留一条带 what + when + files + component 的耐久原子**，即使 agent 没跑 / 上下文被压都不丢。**这是抗压缩地板。** `/lore:init` 装进 `.git/hooks/post-commit`（或 `core.hooksPath`）。

**② agent live-enrich — 补「为什么」（即时、尽力）**
slash `/lore:note`，agent / 人在**决策当下**调用："选 X 弃 Y 因为 Z" → 写 / 补原子的 `why` + 语义 `facets`（agent 知意图 → 标 flow / theme）+ `refs`。resident 规则 + Stop-hook 轻提醒收尾前 flush。跳了也有 ① 兜底。
**补已有骨架**：同 `commit:<hash>` 的 enrich **append 新行**（不改旧行，保持 append-only 神圣），synthesis 读时**按 id fold**（取并集 / 最新）。保留 骨架→enriched 演化轨迹，审计友好。

**③ artifact miner — bootstrap 回填 + 持续补**
读现有耐久产物 emit 原子，幂等、SHA 跟踪、按 hash / 内容去重：
- `commits`：hook 之前的 `git log` 历史 → commit 原子
- `changelog`：解析 CHANGELOG 版本段 → decision 原子
- `claude_md_pitfalls`：**195 踩坑是金矿** —— 已是 Problem / Fix / Prevention 结构化决策记录，直接 → 富 why 原子：

```jsonc
{"id":"pit:195","kind":"incident","ts":"2026-05-30",
 "title":"M3 串行消费瓶颈 — 读 BATCH 但 await 串行处理",
 "why":"批量读≠批量处理；IO-bound LLM 串行阻塞。CPU 0%+内存富余+吞吐低=串行非资源不足",
 "what_changed":"批内 asyncio.gather + Semaphore(m3_article_concurrency)",
 "facets":{"component":["m3_nlp"],"flow":["article-pipeline"],"theme":["timeliness"]},
 "refs":{"pitfall":195,"files":["m3_nlp/main.py"]},"source":"miner:claude_md","confidence":"EXTRACTED"}
```

→ 178KB CLAUDE.md / 210KB CHANGELOG 一夜变成可导航的多 facet 原子流。

### facet 打标管线（最便宜优先，层层兜底）

| 层 | 机制 | 轴 | 可信度 | LLM? |
|---|---|---|---|---|
| 1 | diff 路径 → code_roots | component | EXTRACTED | 否 |
| 2 | config `match:` 正则 | flow / theme | INFERRED | 否 |
| 3 | agent enrich 标意图 | 全部 | EXTRACTED | 否（agent 本身） |
| 4 | synthesis 时 LLM 兜底分类 | flow / theme | INFERRED / AMBIGUOUS | 是 |

可信度随每个 facet 走 → wiki 显示"(推断)"；lint 把 AMBIGUOUS 推给人确认。物理落地 `.lore/journal/YYYY/MM/YYYY-MM-DD.ndjson` 按日分片，append-only，跨分支 / 并发 agent 低冲突。

---

## 5. 合成 + lint + 消费

### 合成（journal + 代码 → wiki 页）— `/lore:sync`

**增量**（借 Graphify SHA 缓存控成本）：`.state/` 存每页指纹 `{code_sha, journal_offset, synthesized_at}`。页 `component/m3_nlp.md` 依赖 = `m3_nlp/` 代码 hash + facet=`component:m3_nlp` 的原子。sync 时算当前指纹，变了才重建该页，没变跳过 → **只有被碰的页重新 LLM**。

每页 LLM 输入 = 该 facet 的折叠原子 + 跨越组件的当前代码结构 + 上一版页面（连续性）；输出统一三段（当前架构 / 决策历史 / 交叉链接）。决策历史段**多为机械拼装**（journal 已存原子，LLM 只写串联 + 按子专题分组）。页 front-matter 带 `synthesized_from:{commits,atoms,code_sha}` → 溯源 + 陈旧锚点。`INDEX.md` = 全轴全页目录 + 一行摘要 + last-updated + 陈旧旗标。

成本：增量 + 决策历史段机械 → 每次 sync 主要花在变动页的「当前架构」段，便宜。

### lint — `/lore:lint`（只读，机械为主 + 小 LLM）

| 检查 | 机制 | LLM? |
|---|---|---|
| **陈旧页** | 页 code_sha ≠ 当前 → "页 X 落后 N commits" | 否 |
| **孤儿** | 页引用的代码路径 / facet 已不存在 | 否 |
| **未打标原子** | 只有 component、缺 flow / theme | 否 |
| **AMBIGUOUS facet** | LLM 低可信度猜的标签 → 推人确认 | 否 |
| **矛盾** | 页「当前架构」声明 vs 更新原子冲突（页说 dedup 用 SET，但 pit:193 已迁 ZSET） | 轻 LLM |

输出 = drift 清单，**不自动改**。→ "变更及时更新"的实现：**hook 自动保 journal 鲜活；lint 报警 synthesized wiki 落后；sync 修复**。检测 / 修复分离。

### 消费

**Agent（resident-mode = "不用每次重头理解代码"的 payoff）：**
- 插件注入 CLAUDE.md 规则 / PreToolUse 提醒：**grep / 读大文件排查前，先查 `.lore/wiki/INDEX.md` + 相关 facet 页**
- `/lore:ask "<q>"` — 从 wiki 答（读合成页 + journal，不读 raw 代码），兜底指向 wiki link 的代码路径
- wiki 是 repo 内 markdown，agent 直接读，无特殊协议，token 远低于重读代码

**Dev（浏览）：**
- git 内 markdown → 编辑器 / GitHub / **Obsidian**（wiki/ 即 Obsidian vault，facet 页间 `[[链接]]` 免费给图视图）
- **历史 / 对比 = git 原生**：`git log -- .lore/wiki/theme/quality.md`（质量架构何时变）、`git diff <旧> <新> -- ...`（版本对比）、checkout 分支看该分支架构

### v1 命令面（CC 插件）

```
/lore:init     # 脚手架 .lore/ + 装 post-commit hook + 起 config.yml(自动发现组件)
/lore:mine     # bootstrap：挖 commits + CHANGELOG + 踩坑 → journal（一次性 + 追平）
/lore:note     # agent/人 追加/enrich 决策原子（补「为什么」）
/lore:sync     # 增量合成：journal + 代码 → wiki 页 + INDEX
/lore:lint     # 陈旧/矛盾/孤儿报告（只读）
/lore:ask <q>  # 从 wiki 答（agent 消费）
```

---

## 6. 通用引擎内核（零 repo 耦合）

插件 = 纯引擎，repo 特定只在 `.lore/config.yml` + `.lore/` 内容。

- **组件自动发现**：按生态扫"模块状"顶层单元 — Python（含 `__init__.py` 的包）/ JS-TS（package.json workspaces）/ Go（cmd 包）/ 兜底（含代码的顶层目录，排除 config / docs / tests / vendor）→ 产出建议 `code_roots`，人改 config 重命名 / 分组 / 删。
- **语言无关**：hook 的 component 映射 = 纯路径前缀匹配（path → code_root），任何语言都行（只是目录映射）。
- **LLM 无关**：synthesis / mine / lint 走 CC 会话当前模型，不硬编码 provider。
- **一切 keyed on config**：axes / code_roots / match / mine / hook。引擎从不假设 M1-M5。

→ 全局装插件 → `cd 任意 repo && /lore:init` → 扫描 + 提议 config + 你微调 → 跑。本 repo 和下个 repo 共享同一引擎，只 config 不同。

---

## 7. Bootstrap 计划（本 repo 当试验田，守规则 #21 小批验证 / #24 落代码非一次性运维）

1. `/lore:init` → 脚手架 + 自动发现 → 提议 `code_roots:[m1..m5,shared]`，种子 `theme:[timeliness,quality]`、`flow:[article-pipeline,dedup,...]`，人改 config
2. `/lore:mine` → 195 踩坑 → incident 原子（最富）+ CHANGELOG 版本段 → decision 原子 + git log → commit 原子，按 hash / 内容去重
3. `/lore:sync` → 首次全量合成 → component / flow / theme/* + INDEX
4. **验证**（小批量，规则 #21）：肉眼核 `theme/quality.md`、`theme/timeliness.md`、`component/m3_nlp.md` 对不对 → 调 config match-rule 重 sync → 用户签字

---

## 8. Phases 路线

| 版本 | 内容 |
|---|---|
| **v1（本 spec）** | 捕获 (hook + note + mine) + journal + 增量合成 + lint + resident-mode + git 原生历史。CC 插件。策略 A。 |
| **v2** | B 的 query 层：`/lore:history-of X`、`/lore:diff <facet> <v1> <v2>` 富渲染、交叉链接图、AMBIGUOUS 自动消解 |
| **v3** | Graphify 结构：可选 AST 抽取喂 component 页（调用图 / 依赖）—— 倾向**集成 / 借用 Graphify 而非重造** |
| **v4** | 输出生成：`/lore:present` → 从 wiki 出项目介绍 / PPT / 架构图（wiki 为源 → 准确） |
| **v5** | 一致性真相（踩坑 #163/#164 本地 / git / 服务器漂移）：**独立兄弟项目**，diff 部署态 vs git vs 本地。lore-wiki 范围外。 |

---

## 9. 测试策略

引擎多为确定性管道 + 边缘 LLM；狠测管道、mock LLM。

- **单元（无 LLM）**：component facet 推导（diff → code_roots 表驱动）、match-rule 打标、journal append + fold-by-id（骨架→enrich 合并正确性）、ndjson 读写往返 + 分片、SHA 指纹陈旧检测、lint 机械检查、踩坑 / CHANGELOG miner 解析（幂等重跑无 dup）
- **LLM-mock**：synthesis 给定 fixture 原子 + 代码 → 断言结构（3 段 + front-matter 溯源），mock 返罐头 prose
- **集成（真 LLM，可选小）**：tiny fixture repo 上 `/lore:sync` 断言出页有效
- **不变量显式测**：nuke `wiki/` 重 sync → 同样页（materialized-view 性质）；并发 commit 下 hook append 不损坏 journal

---

## 10. 风险 + 缓解

| 风险 | 缓解 |
|---|---|
| Synthesis 成本失控（大 repo 全量 LLM） | 增量 SHA 指纹只重建变动页；决策历史段机械拼装；首次全量分批 |
| facet 误标污染（LLM 乱归类） | 可信度标签 EXTRACTED/INFERRED/AMBIGUOUS；lint 推 AMBIGUOUS 给人确认；config match-rule 优先 |
| journal 膨胀（fold-by-id 多行） | 按日分片；定期 compact（可选，仍保 append 审计）；ndjson 流式读 |
| hook 拖慢 commit | 硬约束：hook 内禁 LLM / 网络，纯本地 `<50ms`，失败不阻断 commit（best-effort 写） |
| wiki 陈旧没人 sync | lint 报警 +（Phase B）CI / cron 定期 lint + sync；resident-mode 让 agent 顺手 sync |
| agent 不查 wiki 仍 grep | resident 规则 + INDEX.md 放显眼；`/lore:ask` 比 grep 更快形成习惯 |
| 跨 repo 假设泄漏 | 引擎零硬编码全走 config；CI 在 2+ 不同语言 repo 上跑 init + sync 冒烟 |

---

## 11. 验收指标 (success criteria)

v1 视为完成当且仅当：

1. **便携冒烟**：`/lore:init` 在 `threat-intel` + 至少 1 个其他语言 repo 上均产出有效 `.lore/` + 装好 hook，引擎无任何 repo 硬编码。
2. **捕获地板**：一次只 commit、不跑任何 agent → journal 仍多出一条带 `component` facet 的耐久原子（抗压缩验证）。
3. **挖矿幂等**：`/lore:mine` 把 195 踩坑 + CHANGELOG + git log 转为原子；重跑无 dup。
4. **合成结构**：`/lore:sync` 产出 component / flow / theme 页 + INDEX，每页含三段 + `synthesized_from` front-matter。
5. **物化视图不变量**：`nuke wiki/` 后重 sync → 页内容一致（journal 为唯一真相源）。
6. **lint 漂移检测**：改一处代码不 sync → `/lore:lint` 报对应页陈旧。
7. **内容验证（规则 #21）**：`theme/quality.md`、`theme/timeliness.md`、`component/m3_nlp.md` 经用户核为基本准确。
8. **消费习惯**（定性）：agent 回答"X 怎么工作"时优先读 wiki 而非重 grep 代码。

---

## 12. 开放问题 / 待定

- **命名**：工作名 `lore`，最终名待定（备选：RepoLore / Lorebook / Chronicle / Almanac）。
- **CC 插件打包形态**：单插件含全部 skill+hook+command，还是拆 skill？转实施计划时定。
- **`/lore:note` 触发纪律**：仅靠 resident 软提醒，还是加更强的 Stop-hook 强制 flush？v1 先软，观察跳步率。
- **journal compact 策略**：v1 不做，膨胀到何阈值才引入待观察。
- **spec 与代码位置**：本 spec 在 `D:\workspace\lore`（独立 repo，不绑 threat-intel）。插件代码同 repo。

---

*参考：Karpathy LLM Wiki gist · Graphify (safishamsi/graphify) · 本 spec 经多轮交互式 brainstorming 收敛，决策链见 git 历史。*
