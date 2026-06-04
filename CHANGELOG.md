# Changelog

All notable changes to **lore** are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [Unreleased]

### 修复
- **`installHook` 默认 hooksPath 不再误跳过** — 当 `core.hooksPath` 解析后等于仓库默认 hooks 目录（`<git-common-dir>/hooks`）时，照常安装 post-commit hook；仅在指向**不同**目录（真 hook 管理器如 Husky）才跳过返回 `hookspath-set`。修复 lore 自身与 threat-intel 因 `core.hooksPath` 指向默认 `.git/hooks` 而静默无自动捕获 hook 的问题（`lib/init.js`）。

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
