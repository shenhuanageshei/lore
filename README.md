# lore

> **代码仓库的活文档 —— 同时面向人和 AI agent，缺一不可：**
> **① 人读友好**：为什么这么设计、关键决策、时间线、最新架构、各类数据流，一眼看懂，不用 grep 源码。
> **② agent 友好的 wiki + graph**：机器可遍历的结构（节点 + 边），让 agent 查文档 / 顺图谱推理，而非重读代码。
>
> 捕获每个决策与变更 → 合成多轴 wiki（+graph）→ 人读、agent 查。
> 零外部依赖 · 零侵入目标仓库 · 确定性核心可测 / 创造性 prose 交给 agent。

---

## 是什么 / 为什么

代码会变，但**「为什么这么做」**总在流失——埋在 commit body、CHANGELOG、踩坑记录、和 agent 被压缩掉的上下文里。下次再碰这块代码，人和 agent 都得重头 grep、重读、重推理。

lore 把这些**决策与架构知识沉淀成 git 内的活文档**：

- **捕获**（durable）：每个 commit 自动留一条带 what/when/files/component 的耐久原子（抗上下文压缩的地板）；agent 在决策当下补「为什么」；miner 回填历史。
- **合成**（synthesize）：把代码 + journal 原子合成多轴 wiki 页（component / theme / flow），每页含「当前架构 / 决策历史 / 交叉链接」三段。
- **消费**（consume）：agent 带问题查 wiki（合成页 token 远低于重读代码），浏览器壳给人看。

知识活在 `.lore/` 内、随 git 跟踪 → 「commit X 时架构长啥样」「这条质量主线怎么演进」全靠 git 原生历史免费拿到，分支局部 wiki 匹配分支代码。

## 何时用 lore（优势区）

lore 是**带 `func @ file` 锚点的导航层，不是源码替代**——agent 用 wiki 30 秒建全局框架 + 顺锚点精准下钻，省掉冷启动盲目 grep。冷启动对照测试（3 轮双盲，被测项目脱敏见 [benchmark](docs/superpowers/notes/2026-06-13-lore-agent-consumption-benchmark.md)）显示优势分布不均：

- **强优势**：① **大型多模块 repo 的 agent 冷启动**（跨文件建框架，repo 越大越省）；② **散在多文件的清单型事实**（入口全景 / dispatch 表 / 过滤原因全集——wiki 一张表 vs 源码十几次 grep，实测某子管道问题 wiki 省 55% token、1/3 工具调用）；③ **决策史 / 「为什么不那样做」**（源码注释和 git log 都查不动）。
- **弱优势**：小 repo（几个文件，源码一眼看完）装了优势不明显——lore 的价值随 repo 规模和模块数增长。
- **正确姿势**：wiki 建框架 + 锚点下钻源码的**混合流程**（resident-mode 已把这条路径注入每个 agent 的 CLAUDE.md）；纯 wiki 到不了实现层细节，纯源码冷启动慢——混合才是最优。

**让 agent 真的用起来（三档可选）**：CLAUDE.md 注入是 session 级软提示、长对话会稀释。要更硬的「每轮注入」，可选装 `UserPromptSubmit` hook：

| 档 | 装法 | 行为 |
|---|---|---|
| **软**（默认） | 零配置 | CLAUDE.md resident，session 开头一次 |
| **中** | `node lib/lorehook.js install notice` | 每轮注入「先 lore_ask 建框架 + 锚点下钻」提示 |
| **强** | `node lib/lorehook.js install inject` | 每轮**门控**：代码问题才自动跑 lore_ask、把命中切片注入 context（agent 开局就有框架）；闲聊不注入 |

opt-in，默认写本机 `.claude/settings.local.json`（`--project` 写团队共享）；`uninstall` 回落软档。

注：中/强档为 Claude Code 专有（`UserPromptSubmit`）；codex / opencode 软档封顶——codex 无 prompt 钩子机制，opencode 的 `tui.prompt.append` 经 spike 证实非插件钩子（证据见 `lib/host.js` 注释）。

## 核心理念

| 理念 | 含义 |
|---|---|
| **Journal-first** | `.lore/journal/` 的 append-only 决策原子是**唯一耐久知识层**。wiki 是它的物化视图（可 nuke 重建）。 |
| **三源捕获** | `hook`（每 commit 机械骨架，零 LLM，<50ms，永不阻断 commit）+ `mine`（回填历史）+ `note`（agent 补 why）。 |
| **确定性 / LLM 分层** | 确定性活（捕获、folding、manifest、lint、检索）纯 Node 可测；只有「当前架构」prose 交给 agent。→ 廉价的活 commit 后秒级自刷；贵的 LLM 活三档可选：手动 / 排队提醒 / **auto 档后台自动**（只读 claude CLI + 机械质量门把关）。 |
| **零依赖** | 纯 Node 内置模块，含自写的 config YAML 子集解析器。无 `node_modules`。 |
| **零侵入** | 只写 `.lore/` + 一个 `.git/hooks/post-commit`（git 机制，非业务源码，唯一例外）。卸载 = 删 `.lore/` + 摘 hook，源码丝毫不动。 |

## 快速上手

```bash
# 0. 全局装插件（Claude Code 插件）。lore 引擎本身在 D:\workspace\lore，与目标 repo 隔离。

# 1. 在目标仓库引导：搭 .lore/、自动发现组件、装 post-commit hook
node lib/init.js /path/to/your-repo

# 2.（可选）回填历史：git log → commit 原子
node lib/mine.js /path/to/your-repo

# 3. 合成 wiki：plan → agent 读源码写页 → finalize（折 journal + INDEX + manifest）
node lib/sync.js plan     /path/to/your-repo/.lore   # agent 据 worklist 逐页写
node lib/sync.js finalize /path/to/your-repo/.lore

# 4. 浏览（浏览器，无需 Obsidian）
node lib/serve.js start --lore /path/to/your-repo/.lore   # 打印 127.0.0.1 URL
node lib/serve.js stop  --lore /path/to/your-repo/.lore

# 4b.（可选，推荐常驻）单机共享门户：一个端口（7842）聚合本机所有已登记 lore 仓库
node lib/portal.js start   # 打印 http://127.0.0.1:7842/ ；另有 stop / list
                           # 壳内可切仓库 / 跨仓搜索 / 操作同步控制台；portal 还接管各仓库 auto 档的后台调度

# 5. agent 答问（从 wiki 检索）
node lib/ask.js /path/to/your-repo/.lore "M3 的准确率为什么这么调"

# 漂移检查（只读）
node lib/lint.js /path/to/your-repo/.lore
```

非 Claude 宿主（codex / opencode）一次性机器层安装：

```bash
node lib/host.js install codex opencode   # 全局命令 + 全局 MCP 注册 + 记入机器启用清单 ~/.lore/hosts.json
node lib/host.js status                   # 查状态；node lib/host.js uninstall <name>... 完整还原
```

- **全局命令**（由 `commands/*.md` 单一真源生成，带 lore 版本标记）：codex → `~/.codex/prompts/lore-*.md`（调 `/prompts:lore-*`）；opencode → `~/.config/opencode/commands/lore-*.md`（调 `/lore-*`）。
- **全局 MCP 注册**：codex → `~/.codex/config.toml` `[mcp_servers.lore]`；opencode → `~/.config/opencode/opencode.json` `mcp.lore`。改全局配置前自动留 `*.lore.bak` 备份。
- 启用后 `init` 的 repo 会同时注入 `AGENTS.md`（与 CLAUDE.md 同一 LORE_RESIDENT 机制）。

> 实际使用走 slash 命令（`/lore:init`、`/lore:sync` …，定义在 `commands/`）；上面的 `node lib/*.js` 是其底层 CLI。

## 命令

| 命令 | 角色 | 写什么 | LLM? |
|---|---|---|---|
| `/lore:init` | 脚手架 | `.lore/` 骨架 + `config.yml`（自动发现组件）+ 拷壳 + 装 post-commit hook | 否 |
| **post-commit hook** | 捕获①（自动） | 每 commit 一条 commit 骨架原子（component facet 路径推导） | 否 |
| `/lore:mine` | 捕获③（回填） | `git log` 全历史 → commit 原子（按 sha 去重，幂等） | 否 |
| `/lore:note` | 捕获②（人工 why） | agent 决策当下记 `kind:decision` 原子（why + facets） | agent |
| `/lore:sync` | 合成 | component/theme/flow 三轴页（agent 写架构 prose；Node 折 journal + INDEX + manifest）；theme 多源子页按源增量 | 混合 |
| `/lore:serve` | 浏览 + 控制 | 本地 server + 浏览器壳（侧栏分组/搜索/多主题/mermaid lightbox）+ **同步控制台**（档位切换/立即刷新/重写排队/auto 参数） | 否 |
| `/lore:portal` | 浏览（聚合） | 单机常驻门户（7842）聚合本机所有 lore 仓库：切仓下拉、跨仓搜索、控制台可操作（API 按 repo 转发）、接管各仓 auto 调度；`autostart` 子命令开机自启（Windows） | 否 |
| **migrate**（自动） | 迁移 | 引擎升级后 repo 内资产自动收敛（壳 / hook stub / config 补缺块 / resident），每次 finalize 触发，`node lib/migrate.js <repo>` 可手动 | 否 |
| `/lore:translate` | 双语 | 按需生成翻译 sidecar（语言切换器 + stale 检测） | agent |
| `/lore:ask` | 消费 | 按关键词检索 wiki 页 → agent 从合成页答（resident-mode payoff） | agent |
| `/lore:lint` | 检查 | 只读漂移报告（stale / orphan / missing / unfolded / **mermaid 语法五检**），不自动改 | 否 |
| **auto 档**（壳里切） | 合成（自动） | commit 静默期后 runner 调只读 LLM CLI 重写 stale 页（后端链 failover），机械质量门过门才落盘，任务历史可查 | claude/codex/opencode CLI（`.state/sync.json` 的 `backend` 可选：auto 探测（含 provider 检查）或显式指定；控制台有下拉） |

## 架构

```
目标仓库/
├── .lore/                       # facts-only 进库：journal+config 跟踪；wiki/site/.state gitignored
│   ├── config.yml               # 唯一存放本 repo 特定信息处（axes / code_roots / theme.match / theme.deep / flow.spans / journal）——进库
│   ├── journal/YYYY/MM/*.ndjson # append-only 决策原子（耐久知识层）——进库，merge=union 多机不冲突
│   ├── wiki/                    # 合成的物化视图（生成物，clone 后 /lore:sync 再生）——gitignored
│   │   ├── INDEX.md             # 全轴目录（人读）
│   │   ├── .manifest.json       # 机读投影（壳 + ask 消费）
│   │   ├── component/<id>.md    # 轴：代码结构
│   │   ├── theme/<id>.md        # 轴：横切主线（关键词 match 打标）
│   │   ├── theme/<id>--<child>.md # 主题多源子页（axes.theme.deep 声明，源级陈旧度 + 源过滤决策史 + 机制级质量门）
│   │   └── flow/<id>.md         # 轴：数据流（component ∈ spans 打标）
│   ├── site/index.html          # 浏览器壳（引擎领地，对齐器自动刷新）——gitignored
│   └── .state/                  # 引擎缓存 + serve.pid + migrations.json（gitignored）
└── .git/hooks/post-commit       # lore 装的唯一 .git 产物（引擎升级自动刷新 stub）
```

**原子 schema**（ndjson 一行一原子）：`id · ts · kind(commit|decision) · commit · title · why · what_changed · facets{component,flow,theme} · refs{files,pitfall,related} · source(hook|agent|miner:commits) · enriched · confidence`。

**三轴打标**：component = 变更路径前缀匹配 `code_roots`；theme = `title+why` 含 config `match:` 关键词（子串，大小写无关）；flow = 原子的 component ∈ config flow 的 `spans`。

**引擎文件**（`lib/`，全零依赖）：`config` `journal` `mine` `hook` `note` `sync` `fold` `fingerprint` `manifest` `graph` `docs` `home` `i18n` `translate` `syncstate` `runner` `serve` `portal` `repos` `registry` `lint` `ask` `mcp` `init` `host` `backend` + 根 `server.js`（静态壳 + 控制 API + auto ticker + 门户）。

## 不变量（测试显式守）

- **零侵入**：跑完整 `init→mine→sync→serve` 后，`git status` 对业务源码 0 改动；唯一写入 = `.lore/` + `.git/hooks/post-commit`。
- **物化视图**：nuke `wiki/` 重 sync → 同结构页 + 同 `.manifest.json`。
- **best-effort hook**：hook 失败/坏 repo → exit 0，绝不阻断 commit。
- **journal 神圣**：append-only，永不覆写。

## 开发

```bash
node --test test/*.test.js        # 全部测试（420+，零外部依赖）
```

- 流程：每功能走 brainstorming → spec（`docs/superpowers/specs/`）→ plan（`docs/superpowers/plans/`）→ TDD → 双审 → 合并。
- 设计文档 + 路线图见 `docs/superpowers/`。

## 路线图

见 [`docs/ROADMAP.md`](docs/ROADMAP.md)。核心链路已完整：捕获三源 + journal + 多轴合成（component/theme/flow/docs + 深度页两档标准）+ lint + serve/portal + ask 节级检索 + **resident-mode**（CLAUDE.md 注入 + MCP，agent 冷启动实测省 25% token）+ **auto 档**（runner token 态重写 + 五道质量门）+ **自动迁移**（引擎升级资产自动收敛）。后续：docs 自动发现、ask-miss 质量环（查询落空→补页工单）、裸 API/codex 后端、codegraph 可选集成。

## 变更

见 [`CHANGELOG.md`](CHANGELOG.md)。
