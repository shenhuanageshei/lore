---
title: Lore — 面向 AI Agent + 开发者的代码仓库活文档 / 决策历史框架
summary: > 设计文档 (spec) · 2026-05-31 · 工作名 **`lore`**（可改名）· 状态: 已评审，待转实施计划
source_path: docs/superpowers/specs/2026-05-31-lore-repo-wiki-design.md
last_updated: 2026-05-31
---
> 源文档：`docs/superpowers/specs/2026-05-31-lore-repo-wiki-design.md`

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
| **本地浏览** | `/lore:serve` 起本地静态服务器 + 单文件浏览器壳，无需 Obsidian 也能看 wiki（侧栏导航 + md 渲染 + 全文搜索 + 鲜度元数据 + 多主题）。详见 §5.5。 |
| **不在 v1** | query 引擎（v2）、**关系图谱可视化**（v2，力导向图 facet↔code↔atom）、AST 结构抽取（v3）、PPT / 项目介绍生成（v4）、本地/git/服务器一致性漂移工具（v5，独立兄弟项目）。 |

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
│   ├── .manifest.json  # INDEX.md 的机器可读孪生 — serve 壳建导航/搜索用（dot 前缀 → Obsidian 隐藏）
│   ├── component/      # 组件轴 — auto-anchored 到代码目录 (m1_crawler.md…)
│   ├── flow/           # 流程轴 — 跨模块 (article-pipeline.md…)
│   └── theme/          # 横切轴 — (timeliness.md, quality.md…)
├── site/               # serve 壳（引擎产物，/lore:init 拷入）— index.html 单文件，非 repo 知识
│   └── index.html      # vanilla JS + 内嵌 marked.js + 多主题；fetch wiki/ 实时渲染
└── .state/             # 引擎缓存（每页 source-SHA + journal-offset + serve.pid）— gitignored
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
/lore:init     # 脚手架 .lore/ + 装 post-commit hook + 起 config.yml(自动发现组件) + 拷 site/index.html
/lore:mine     # bootstrap：挖 commits + CHANGELOG + 踩坑 → journal（一次性 + 追平）
/lore:note     # agent/人 追加/enrich 决策原子（补「为什么」）
/lore:sync     # 增量合成：journal + 代码 → wiki 页 + INDEX + emit .manifest.json
/lore:lint     # 陈旧/矛盾/孤儿报告（只读）
/lore:ask <q>  # 从 wiki 答（agent 消费）
/lore:serve    # 起本地可视化服务器（--port N / --stop）— 浏览器看 wiki，详见 §5.5
```

---

## 5.5 本地可视化：`/lore:serve`

**问题**：§5 消费假定 dev 用 Obsidian 看 wiki/。但没装 Obsidian、或想浏览器直接开的场景，v1 之前是真空。`/lore:serve` 补这个刚需：**一条命令起本地服务器 → 浏览器看 wiki，零 Obsidian 依赖**。

### 架构：哑静态服务器 + 客户端 JS 壳

核心拆分：**服务器只哑服文件，零渲染逻辑；所有渲染在浏览器**。

```
/lore:serve  ──┐
               │ 1. 探测 runtime: python3 -m http.server
               │                → python -m http.server
               │                → 兜底 <plugin>/server.js (Node, CC 环境必有)
               │ 2. 后台 detached 起进程, 根 = .lore/, 绑 127.0.0.1:<port>
               │ 3. 存 .state/serve.pid, 立即返回 URL (不阻塞会话)
               ▼
  浏览器 ──► .lore/site/index.html  (单文件壳, 内嵌 marked.js + 多主题)
               │ fetch ../wiki/.manifest.json → 建侧栏(按轴分组) + 搜索索引
               │ 点页 → fetch ../wiki/<facet>/<page>.md → marked.js 渲染 → 注入
               │ front-matter → 顶部元数据条(鲜度/溯源); 内链 [[x]] → 壳内 hash 路由跳转
               ▼
  /lore:serve --stop ──► 读 serve.pid → 跨平台 kill → 删 pid 文件
```

**核心不变量**：服务器哑服 `.lore/`，壳读 `.manifest.json`（不自己解析目录/markdown），进程后台跑命令秒回，知识仍只在 wiki/（serve 是又一只读渲染器，与 Obsidian 平行共存）。

### 双渲染器兼容约束（serve 壳 + Obsidian 并存）

两者都是 `wiki/*.md` 的**只读消费者**，无根本冲突。强化「wiki = 视图、多渲染器各取所需」模型。3 条兼容约束：

1. **链接语法**：synthesis 出 Obsidian 原生 `[[x]]` 双链。壳加 ~10 行预处理正则 `[[x]]`→`<a href="#axis/x">` → 两个渲染器都能跳。Obsidian 保持一等公民，壳适配它。
2. **manifest 隐藏**：`.lore/wiki/.manifest.json` dot 前缀 → Obsidian 默认隐藏 dotfile，壳照 `fetch` → 零污染 vault。
3. **front-matter**：Obsidian 渲属性面板 / 壳 strip 成元数据条 — 各自处理同一 YAML，已覆盖。

### 壳页面（`.lore/site/index.html` 单文件）

**设计原则**：单文件（HTML+CSS+JS+marked.js 全内嵌，零构建零 npm），vanilla 无框架（总量目标 <400 行），hash 路由（`#component/m3_nlp` 可分享/前进后退/刷新不丢），离线（marked.js 内嵌非 CDN）。

**四功能（全客户端零后端）**：

| # | 功能 | 实现 | 行数估 |
|---|---|---|---|
| 1 | 侧栏 facet 导航 | 读 `.manifest.json` → 按轴分组渲染 `<nav>`，⚠N 标陈旧页 | ~40 |
| 2 | md 渲染 + 内链 | marked.js + `[[x]]`/相对路径预处理 → hashchange 壳内跳转 | ~50 |
| 3 | 全文搜索 | manifest 含 title+summary → client filter 侧栏（v1 不搜正文） | ~40 |
| 4 | 元数据条 | 解析当前页 front-matter → 渲 last-updated/synthesized_from/陈旧旗 | ~25 |

**多主题**：CSS 变量驱动全部配色。≥3 主题 — **暗**（Tokyo Night）/ **亮**（白底深字）/ **护眼**（暖米黄低蓝光）。顶栏切换器 + `localStorage` 记忆，`<html data-theme=x>` + 变量覆盖（~30 行，用户可加主题只加一组 var）。

### 进程生命周期

**启动序列**：
1. 已在跑？读 `serve.pid` → 进程活 → 直接返回现有 URL（幂等，不重起）
2. `.manifest.json` 不存在 → 提示先 `/lore:sync` → 退出
3. 选端口：`--port` 给则用，否则从 7842 起探空闲口
4. 探测 runtime 链起哑服务（根 = `.lore/`）
5. 后台 detached 起进程，存 `{pid,port,runtime,started}` → `.state/serve.pid`
6. 立即返回 URL + 停法提示

**`--stop`**：读 `serve.pid` → kill → 删 pid 文件（幂等：已死/无文件 → "无运行中服务"）。

**关键设计点**：

| 点 | 决策 | 理由 |
|---|---|---|
| 绑定 | `127.0.0.1` only（非 `0.0.0.0`） | 安全 — 本地专用不暴露局域网，wiki 含代码架构不外泄 |
| 端口 | 默认 7842，占用自增，可 `--port` 覆盖 | 避免撞常用口 |
| 后台 | detached 进程命令秒回 | CC slash 命令禁阻塞（否则卡死会话） |
| PID | `.state/serve.pid`（JSON，gitignored） | `--stop` 找得到 + 幂等检测 |
| 跨平台 kill | Win `taskkill /PID` · *nix `kill` | 探测 OS 选命令 |
| site/ 来源 | `/lore:init` 拷壳进 `.lore/site/` | 引擎产物，非 repo 知识 |

**兜底 Node 服务器**（`<plugin>/server.js`，~30 行）：零依赖纯 `http`+`fs`，只服 `.lore/` 静态文件，**path 规范化防目录穿越（`../` 攻击）**，MIME 覆盖 `.html/.js/.css/.json/.md`。CC 插件环境保证能跑的最终兜底。

### `.manifest.json` schema + sync 集成

manifest = **sync 已持有信息的机器可读投影**（零额外 LLM/扫描，纯结构化吐出）：

```jsonc
{
  "generated":        "2026-05-31T08:14:00Z",  // sync 跑的时刻
  "current_code_sha": "abc1234",               // 当前 HEAD short sha (算陈旧)
  "axes": [                                     // 顺序 = 侧栏序
    { "id":"component", "label":"Component", "pages": [
      { "id":"m3_nlp", "title":"M3 NLP", "summary":"实体/IOC/主题抽取 — 批内并发",
        "path":"component/m3_nlp.md", "stale":3, "code_sha":"def5678" } ] }
  ]
}
```

字段来源：`axes` ← config；`id/title/summary/path` ← 页 front-matter + H1；`stale` ← lint 同款 code_sha diff；`current_code_sha` ← `git rev-parse`。

**sync 集成**：`emit_manifest()` 是 `/lore:sync` **最后一步**，纯机械（读全页 front-matter 拼 JSON），**无条件全量重写**（manifest 小，全量比增量简单无陈旧风险）。`INDEX.md`（人读）与 `.manifest.json`（机读）= 同源孪生，一次 sync 同时更新。

### 新增引擎文件

```
<plugin>/
├── commands/lore-serve.md   # slash 命令定义
├── site/index.html          # 壳 (init 拷到 .lore/site/) — vanilla + marked.js + 多主题
├── server.js                # Node 兜底静态服务器 (~30 行零依赖, 防穿越)
└── lib/
    ├── emit_manifest.*       # sync 收尾: front-matter → .manifest.json
    └── serve_runtime.*       # 探测链 + 后台起停 + PID + 跨平台 kill
```

碰现有命令仅 2 处（最小侵入）：`/lore:init` 末尾拷壳、`/lore:sync` 末尾 emit manifest。

---

## 6. 通用引擎内核（零 repo 耦合）

插件 = 纯引擎，repo 特定只在 `.lore/config.yml` + `.lore/` 内容。

- **组件自动发现**：按生态扫"模块状"顶层单元 — Python（含 `__init__.py` 的包）/ JS-TS（package.json workspaces）/ Go（cmd 包）/ 兜底（含代码的顶层目录，排除 config / docs / tests / vendor）→ 产出建议 `code_roots`，人改 config 重命名 / 分组 / 删。
- **语言无关**：hook 的 component 映射 = 纯路径前缀匹配（path → code_root），任何语言都行（只是目录映射）。
- **LLM 无关**：synthesis / mine / lint 走 CC 会话当前模型，不硬编码 provider。
- **一切 keyed on config**：axes / code_roots / match / mine / hook。引擎从不假设 M1-M5。
- **目标 repo 源码只读（核心不变量）**：lore **永不改目标 repo 的业务源码 / 配置**。所有捕获（hook / mine / scan）= 纯读。lore 只写自己的地盘：`.lore/` 目录 + 一个 post-commit hook（`.git/hooks/post-commit` 或 `core.hooksPath` —— git 机制非业务源码，唯一例外，且仅追加捕获骨架不碰源码）。→ 装 lore 对目标项目零侵入，卸载 = 删 `.lore/` + 摘 hook，源码丝毫不动。

→ 全局装插件 → `cd 任意 repo && /lore:init` → 扫描 + 提议 config + 你微调 → 跑。本 repo 和下个 repo 共享同一引擎，只 config 不同。

---

## 7. Bootstrap 计划（threat-intel 当试验田，守规则 #21 小批验证 / #24 落代码非一次性运维）

> **试验田访问约束**：threat-intel repo 作试验田时，lore **只读其源码**（永不改业务代码/配置，见 §6 核心不变量）。允许写入仅限 lore 自有产物：`.lore/` 目录 + post-commit hook。bootstrap 全流程（含 hook 捕获）据此可在真 threat-intel 上跑。**lore 引擎代码本身在 `D:\workspace\lore`（独立 repo），与 threat-intel 物理隔离。**

1. `/lore:init` → 脚手架 + 自动发现 → 提议 `code_roots:[m1..m5,shared]`，种子 `theme:[timeliness,quality]`、`flow:[article-pipeline,dedup,...]`，人改 config
2. `/lore:mine` → 195 踩坑 → incident 原子（最富）+ CHANGELOG 版本段 → decision 原子 + git log → commit 原子，按 hash / 内容去重
3. `/lore:sync` → 首次全量合成 → component / flow / theme/* + INDEX
4. **验证**（小批量，规则 #21）：肉眼核 `theme/quality.md`、`theme/timeliness.md`、`component/m3_nlp.md` 对不对 → 调 config match-rule 重 sync → 用户签字

---

## 8. Phases 路线

| 版本 | 内容 |
|---|---|
| **v1（本 spec）** | 捕获 (hook + note + mine) + journal + 增量合成 + lint + resident-mode + git 原生历史 + **`/lore:serve` 本地静态浏览（壳 + 哑服务器 + manifest，§5.5）**。CC 插件。策略 A。 |
| **v2** | B 的 query 层：`/lore:history-of X`、`/lore:diff <facet> <v1> <v2>` 富渲染、**关系图谱可视化（facet↔code↔atom 力导向图，扩 manifest 交叉链接数据，serve 壳加图视图）**、AMBIGUOUS 自动消解 |
| **v3** | Graphify 结构：可选 AST 抽取喂 component 页（调用图 / 依赖）—— 倾向**集成 / 借用 Graphify 而非重造** |
| **v4** | 输出生成：`/lore:present` → 从 wiki 出项目介绍 / PPT / 架构图（wiki 为源 → 准确） |
| **v5** | 一致性真相（踩坑 #163/#164 本地 / git / 服务器漂移）：**独立兄弟项目**，diff 部署态 vs git vs 本地。lore-wiki 范围外。 |

---

## 9. 测试策略

引擎多为确定性管道 + 边缘 LLM；狠测管道、mock LLM。

- **单元（无 LLM）**：component facet 推导（diff → code_roots 表驱动）、match-rule 打标、journal append + fold-by-id（骨架→enrich 合并正确性）、ndjson 读写往返 + 分片、SHA 指纹陈旧检测、lint 机械检查、踩坑 / CHANGELOG miner 解析（幂等重跑无 dup）
- **LLM-mock**：synthesis 给定 fixture 原子 + 代码 → 断言结构（3 段 + front-matter 溯源），mock 返罐头 prose
- **集成（真 LLM，可选小）**：tiny fixture repo 上 `/lore:sync` 断言出页有效
- **不变量显式测**：nuke `wiki/` 重 sync → 同样页（materialized-view 性质）；并发 commit 下 hook append 不损坏 journal；nuke `wiki/` 重 sync → `.manifest.json` 一致（manifest 也是物化视图）
- **serve（全确定性，零 LLM）**：manifest emit 确定性（同 wiki 状态 → 同字节）+ front-matter 缺字段降级（无 summary 不崩）；端口探测（占用→自增）+ PID 写/读/死进程检测；runtime 探测链（mock which → 选对二进制）+ 跨平台 kill 命令选择；**路径穿越防护（`../` 拒服）**；集成冒烟 `init→sync→serve`：起进程 → curl 200 拿到 index.html + manifest → `--stop` 杀干净

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
| serve 进程泄漏（起了没停/僵尸） | PID 存盘 + 启动幂等检测（活进程直接复用 URL）；`--stop` 幂等；绑 127.0.0.1 限本地 |
| serve 暴露代码架构 | 仅绑 `127.0.0.1` 非 `0.0.0.0`；兜底 Node 服务器 path 规范化防 `../` 穿越 |
| 目标 repo 无 Python/Node runtime | 探测链兜底到插件自带 Node 服务器（CC 环境必有 Node），永不落空 |

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
9. **本地浏览冒烟**：`/lore:sync` 后 `/lore:serve` 起服务、返回 `127.0.0.1` URL；浏览器开壳 → 侧栏列全 facet 页、点页渲染 md、`[[链接]]` 壳内跳转、元数据条显鲜度、≥3 主题可切；`--stop` 杀干净无僵尸。`.manifest.json` 经 `nuke wiki/` 重 sync 后字节一致。
10. **目标 repo 源码零改动**：在 threat-intel 跑完整 `init→mine→sync→serve` 后，`git -C threat-intel status` 对**业务源码 0 改动**；唯一写入 = `.lore/` 目录 + post-commit hook。卸载（删 `.lore/` + 摘 hook）后 repo 回到原状。

---

## 12. 开放问题 / 待定

- **命名**：工作名 `lore`，最终名待定（备选：RepoLore / Lorebook / Chronicle / Almanac）。
- **CC 插件打包形态**：单插件含全部 skill+hook+command，还是拆 skill？转实施计划时定。
- **`/lore:note` 触发纪律**：仅靠 resident 软提醒，还是加更强的 Stop-hook 强制 flush？v1 先软，观察跳步率。
- **journal compact 策略**：v1 不做，膨胀到何阈值才引入待观察。
- **spec 与代码位置**：本 spec 在 `D:\workspace\lore`（独立 repo，不绑 threat-intel）。插件代码同 repo。
- **serve 壳布局已出 mockup**：`docs/superpowers/specs/2026-05-31-lore-serve-mockup.html`（内嵌假数据，`file://` 双击即看）——布局/配色/信息层次已用户核可，实现壳照此还原（真壳换内嵌 marked.js）。
- **serve 默认端口 7842**：暂定，撞口自增。无强约束，实现可调。

---

*参考：Karpathy LLM Wiki gist · Graphify (safishamsi/graphify) · serve 壳 mockup 见同目录 `*-lore-serve-mockup.html` · 本 spec 经多轮交互式 brainstorming 收敛，决策链见 git 历史。*

