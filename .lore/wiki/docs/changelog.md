---
title: CHANGELOG
summary: 5 个版本，最新 0.4.1
source_path: CHANGELOG.md
last_updated: 2026-06-05
---
> 源文档：`CHANGELOG.md`

# Changelog

All notable changes to **lore** are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [0.4.1] — 2026-06-05

### 修复
- **docs 侧栏显示日期** — docs 轴侧栏每条链接下显示 `📅 last_updated`，让 v0.4.0 的时间降序**可见**（此前只排序不显示日期，肉眼分不出新旧）。仅 docs 轴（其他轴页日期同质、显示无意义）；无日期文档不显示日期。纯壳改动（`site/index.html`：`.links a` flex-wrap + `.when` 行 + 侧栏模板）。

## [0.4.0] — 2026-06-05

### 变更
- **docs 轴页嵌入文档全文** — docs 轴页从 v0.3 的「机械薄页（标题+摘要+链）」改为**嵌入源文档完整正文**，经壳渲染（mermaid / 表格 / `[[wikilink]]` 全活）。从此在 wiki 里直接读全文，无需跳出。源文档引用改为**纯文本** `> 源文档：\`path\``（非 markdown 链接）—— 彻底消除点击 404（旧链接 `../../../docs/X.md` 指向 server 不服务的 repo 根）。`renderDocsPage` 以 `spec.body !== undefined` 区分嵌入正文（docs/changelog）vs pitfalls 条目列表；extractor 携带 FM-stripped `body`。
- **docs 轴按时间降序** — docs 侧栏与 INDEX「Docs」段按 `last_updated` 降序（最新文档置顶；无日期沉底，id 次序 tiebreak）。其他轴保持字母序。两处排序一致：`buildDocsAxis`（按 `spec.date`）+ `emitManifest`（docs 轴按 `last_updated`）。

### 性能
- **mermaid 懒加载** — 3.2MB `mermaid.min.js` 不再每页静态加载；壳改为按需注入：仅当渲染后的页面含 `.mermaid` 节点才动态加载（promise 缓存、`onerror`/`onload` 异常均重置可重试）。无图页（如纯文档页）秒开、零 mermaid 开销。

## [0.3.0] — 2026-06-05

### 新增
- **docs 轴 —— 文档摄取（捕获第 4 源）** — `/lore:sync` 的 finalize 机械把当前 `docs/**/*.md` + `CHANGELOG.md` + `CLAUDE.md`(踩坑) 摄入一个新 **docs 轴**：每文档一页（标题 + 摘要 + repo 相对源链 + 日期），CHANGELOG / 踩坑各折一页。**零 LLM、无 journal、物化视图**——每 sync nuke-rebuild，删源文档则对应页消失，永远反映当前文件（架构 Y：直读文件而非 journal 原子）。新 `lib/docs.js`（`docsExtractor` / `changelogExtractor` / `pitfallsExtractor` + `renderDocsPage` + `buildDocsAxis`）；config `axes.docs` opt-in（`sources` + `docs_glob`）；接入 `finalizeSync` + manifest `AXIS_ORDER` + `buildIndex` + 壳配色，serve 零改（复用多轴机制）。dogfood：lore 自身 28 个 `docs/` 文件 + CHANGELOG → 29 个可导航 `wiki/docs` 页。设计/计划见 `docs/superpowers/{specs,plans}/2026-06-05-lore-docs-ingestion*`。

### 修复
- **INDEX / 侧栏轴序对齐** — `buildIndex` 的轴序（曾 theme 在 flow 之前）对齐 manifest `AXIS_ORDER`（component → flow → theme → docs），消除 INDEX 页与侧栏排序不一致（pre-existing）。

## [0.2.0] — 2026-06-04

### 新增
- **mermaid 架构图 / 数据流图** — component 页可含架构图、flow 页可含数据流图，作为页内 ` ```mermaid ` 文本块（git 可 diff、随历史演进，胜过二进制 PNG），浏览器壳客户端渲染。交付：vendored mermaid@11.15.0 全量 UMD（`site/mermaid.min.js`，sha256 记于 commit），由 init 随 shell 拷进 `.lore/site/`；`securityLevel:'strict'`、仅 `127.0.0.1`、不连 CDN——守住零运行时依赖 + 离线两不变量。改动面：壳 `renderMarkdown` 识别 ` ```mermaid ` fence → `<div class="mermaid">`（`site/shell.mjs`）、`index.html` 加载 mermaid + 每次路由后渲染 + 主题联动、`SHELL_FILES` 含 mermaid（`lib/init.js`）、`/lore:sync` 引导 agent 出图（`commands/sync.md`）。向后兼容：旧壳或缺资产时 ` ```mermaid ` 降级为代码块、无报错。设计/计划见 `docs/superpowers/{specs,plans}/2026-06-04-lore-mermaid-diagrams*`。
- **可安装为 Claude Code 插件** — 插件清单 + 本地 marketplace，`/lore:*` 命名空间命令经 `${CLAUDE_PLUGIN_ROOT}` 定位 bundled `lib/`。

### 修复
- **`installHook` 默认 hooksPath 不再误跳过** — 当 `core.hooksPath` 解析后等于仓库默认 hooks 目录（`<git-common-dir>/hooks`）时，照常安装 post-commit hook；仅在指向**不同**目录（真 hook 管理器如 Husky）才跳过返回 `hookspath-set`。修复 lore 自身与 threat-intel 因 `core.hooksPath` 指向默认 `.git/hooks` 而静默无自动捕获 hook 的问题（`lib/init.js`）。
- **`/lore:sync` journal 折叠 exactly-once** — `{{LORE_JOURNAL}}` 占位符精确折叠一次，`/lore:lint` 兜底标记任何残留未替换的 token（`lib/sync.js`、`lib/lint.js`）。

## [0.1.0] — 2026-06-03

First feature-complete v1: the full **capture → synthesize → consume** loop with
three wiki axes, plus drift linting and browser viewing. Zero external
dependencies; zero intrusion to target repos.

### 捕获（三源）
- **post-commit hook** — `/lore:init` 安装 `.git/hooks/post-commit`，每个 commit 自动写一条 commit 骨架原子（`lib/hook.js` `captureHead`）。纯机械、零 LLM、<50ms、best-effort（永不阻断 commit）。安装策略 A（不覆盖已有 hook；`core.hooksPath`/非 git 优雅跳过）；worktree-safe（`git rev-parse --git-common-dir`）。
- **`/lore:mine`** — `git log` 全历史 → commit 原子（`lib/mine.js`），按 `commit:<sha>` 去重、幂等。component facet 由变更路径前缀匹配 `code_roots` 机械推导。
- **`/lore:note`** — agent 决策当下记 `kind:decision`、`source:agent` 原子（why + 语义 facets），`lib/note.js`。

### journal 基座
- `lib/journal.js` — append-only ndjson 原子存储（`atomPath` 按日分片 / `appendAtom` / `readAllAtoms` 递归读 / `existingIds` 去重）。

### 合成（三轴）
- **`/lore:sync`** — O1 两阶段：`plan`（`lib/sync.js` 出 worklist）→ agent 读源码写页正文 → `finalize`（机械盖 front-matter + 折 journal 决策历史 + 建 INDEX + emit `.manifest.json`）。
- **决策历史折叠** — `finalizeSync` 按轴过滤 journal 原子（`facets[axis]`）、ts 倒序、`{{LORE_JOURNAL}}` token 注入（函数式 `.replace` 防 `$`-pattern 腐蚀）。
- **三轴**：`component`（代码结构）· `theme`（横切主线，config `match:` 关键词子串打标）· `flow`（数据流，原子 component ∈ config flow `spans` 打标）。`finalizeSync`/`buildIndex` 按 `SYNC_AXES` 泛化，serve/manifest 零改自动收。

### 消费
- **`/lore:serve`** — 哑静态服务器（探测 `python3`→`python`→内置 Node `server.js` 兜底）+ 免构建浏览器壳（侧栏多轴导航 / Markdown 渲染 / `[[wikilink]]` / 全文搜索 / 鲜度元数据 / 多主题）。仅绑 `127.0.0.1`，只读 `.lore/`。
- **`/lore:ask`** — `lib/ask.js` `searchPages` 按 query 关键词命中页 title+summary 排序，agent 读 top 页从 wiki 答（resident-mode payoff，省 token）。只读，复用 `.manifest.json`。

### 检查
- **`/lore:lint`** — `lib/lint.js` 只读漂移报告：stale（页 `code_sha` 落后 HEAD N commits，复用 manifest stale 逻辑）/ orphan（页无对应 code_root）/ missing（code_root 无页）。exit 0，检测与修复分离。

### 脚手架
- **`/lore:init`** — `lib/init.js` 搭 `.lore/{journal,wiki,site,.state}/`、自动发现组件（兜底顶层代码目录 + Python 包 + JS workspaces）写 `config.yml`、拷浏览器壳、装 hook、追加 `.gitignore`。重跑安全（刷新壳、不毁已编辑 config）。
- **config 解析**（`lib/config.js`，零依赖 YAML 子集）：`parseConfigCodeRoots` / `parseConfigThemes`（`match:`）/ `parseConfigFlows`（`spans:`）。

### 工程
- 152 个 `node --test` 测试，零外部依赖。
- 每功能走 brainstorming → spec → plan → TDD → 两段审查（spec 合规 + 代码质量）→ opus 终审 → fast-forward 合并。
- 设计文档 + 实施计划归档于 `docs/superpowers/{specs,plans,notes}/`。

### 不变量（测试守）
- 零侵入：业务源码 0 改动，唯一写入 `.lore/` + 一个 post-commit hook。
- 物化视图：nuke `wiki/` 重 sync → 同页 + `.manifest.json` 字节一致。
- best-effort hook：失败不阻断 commit。
- journal append-only，永不覆写。

[0.1.0]: https://example.com/lore/releases/tag/v0.1.0

