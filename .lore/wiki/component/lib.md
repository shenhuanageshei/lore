---
title: lib — lore 引擎
summary: 零依赖 Node 确定性核心，跑「捕获 → 合成 → 消费」全闭环，唯一例外把 prose 交给 agent。
last_updated: 2026-06-04
code_sha: 9f0ab79
atoms: 70
commits: 70
---
# component: lib

## Current architecture

`lib/` 是 lore 的整个引擎：纯 Node 内置模块、零外部依赖、每个文件兼作可 `import` 的库 + `import.meta.url` 守卫的 CLI。按数据流分四层。

### 基座（durable 存储 + 配置）
- **`journal.js`** —— append-only ndjson 原子层（唯一耐久知识源）。`atomPath` 按 `YYYY/MM/YYYY-MM-DD.ndjson` 分片；`appendAtom` 单行追加（永不覆写）；`readAllAtoms` 递归读全树；`existingIds` 做幂等去重。原子 schema：`{id, ts, kind(commit|decision), commit, title, why, what_changed, facets{component,flow,theme}, refs{files,pitfall,related}, source, enriched, confidence}`。
- **`config.js`** —— 手写 YAML 子集解析器（撑零依赖不变量）。`parseConfigCodeRoots`（`axes.component.code_roots`）/ `parseConfigThemes`（`match:` 关键词）/ `parseConfigFlows`（`spans:` 组件列表）。`.lore/config.yml` 是唯一存放 repo 特定信息处。

### 捕获（三源 → journal）
- **`hook.js`** —— `captureHead` 读 HEAD commit 机械产骨架原子，`source:'hook'`。post-commit 自动触发、零 LLM、<50ms；CLI 全程 try/catch + 无条件 `process.exit(0)` → best-effort，绝不阻断 commit。
- **`mine.js`** —— `git log` 全历史回填。`commitAtom(raw, codeRoots, source, themes, flows)` 机械算三轴 facet：component = 变更路径前缀匹配 `code_roots`；`tagThemes` = `title+why` 子串命中（大小写无关）；`tagFlows` = 原子 component ∈ flow 的 `spans`。按 `commit:<sha>` id 去重 → 幂等。`source:'miner:commits'`。
- **`note.js`** —— agent 决策当下手记 `kind:'decision'`、`source:'agent'` 原子（补 hook/mine 取不到的「为什么」）。

### 合成（code + journal → 多轴 wiki）
- **`sync.js`** —— O1 两阶段编排。`planSync` 读 config 出 worklist（`SYNC_AXES=['component','theme','flow']` 各轴一份）；agent 据此写页正文「当前架构」段 + 决策历史占位符；`finalizeSync` 逐轴过滤原子（`facets[axis]` 命中页 id）、ts 倒序、**函数式** `.replace(…, () => md)` 注入决策历史（防 commit 文里 `$&`/`$$` 腐蚀），再 `buildIndex` + emit。`renderDecisionHistory` 出 ts 倒序 bullet（有 sha 显 `(sha, date)`，否则 `(date)`）。
- **`manifest.js`** —— `emitManifest` 扫 wiki 页 `parseFrontmatter` → `.manifest.json`（壳 + ask 的机读投影）。`gitCurrentSha` / `makeCountCommitsSince` 算鲜度（页 `code_sha` 落后 HEAD 几个 commit）。`AXIS_ORDER` 定轴展示序。

### 消费 + 检查
- **`serve.js`**（+ `server.js` 兜底）—— 哑静态服务器，探测 `python3`→`python`→内置 Node。只绑 `127.0.0.1`、只读 `.lore/`。配 `site/` 免构建浏览器壳。
- **`ask.js`** —— `searchPages(manifest, query)` 按 query 词在 page title+summary 的命中数排序（跳过 INDEX 轴），agent 读 top 页从 wiki 答而非重 grep（省 token）。纯函数 + 读 `.manifest.json` 的 CLI。
- **`lint.js`** —— 只读漂移报告：`lintStale`（页落后 HEAD N commit）/ `lintOrphans`（页无对应 code_root）/ `lintMissing`（code_root 无页）。检测与修复分离，CLI `exit 0`。

### 脚手架
- **`init.js`** —— `scaffold` 建 `.lore/{journal,wiki,site,.state}`；`discoverComponents` 三策略（顶层代码目录兜底 + Python 包 `__init__.py` + JS workspaces）；`renderConfigYaml` 写自动发现的 `code_roots`；`copyShell` 拷浏览器壳；`installHook` 装 post-commit（worktree-safe `git rev-parse --git-common-dir`；已有 hook / 设了 `core.hooksPath` / 非 git → 优雅跳过，不抢你的 hook 管理器）；`ensureGitignore` 忽略 `.state/`。

### 不变量（测试显式守）
零侵入（只写 `.lore/` + 一个 post-commit hook）；物化视图（nuke `wiki/` 重 sync → 字节一致）；journal append-only；best-effort hook。确定性活全 `node --test` 覆盖，只有「当前架构」prose 交给 agent。

## Decision history

- **feat(ask): searchPages (manifest keyword retrieval) + CLI** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (a2d92d0, 2026-06-03)
- **feat(sync): planSync flow worklist + SYNC_AXES includes flow** — Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com> (1da0a61, 2026-06-03)
- **feat(hook): captureHead tags flow from config flows** (c673a96, 2026-06-03)
- **feat(mine): thread config flows through mineCommits/mine/CLI** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (e43c1ac, 2026-06-03)
- **feat(mine): commitAtom flows param → facets.flow** (f1c875a, 2026-06-03)
- **feat(mine): tagFlows (component-membership in flow spans)** (10655b5, 2026-06-03)
- **feat(config): parseConfigFlows (flow id + spans)** (65bacd5, 2026-06-03)
- **feat(sync): finalizeSync + buildIndex generalize to multi-axis (component + theme)** — Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com> (dc6ab17, 2026-06-03)
- **feat(sync): planSync adds theme worklist items (axis field)** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (f707b63, 2026-06-03)
- **feat(hook): captureHead tags theme from config themes** (81edefb, 2026-06-03)
- **feat(mine): thread config themes through mineCommits/mine/CLI** — Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com> (cbebc0f, 2026-06-03)
- **feat(mine): commitAtom themes param → facets.theme** (9e14cc4, 2026-06-03)
- **feat(mine): tagThemes (case-insensitive keyword substring)** (3caff5a, 2026-06-03)
- **feat(config): parseConfigThemes (theme id + match keywords)** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (9f9ad5a, 2026-06-03)
- **feat(lint): CLI prints drift report (exit 0, advisory)** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (5c9b40b, 2026-06-03)
- **fix(lint): use real sha in test; revert unrequested manifest stale change** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (6e45c4c, 2026-06-03)
- **feat(lint): lintStale + lint orchestrator (config/wiki/git, read-only)** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (94b8074, 2026-06-03)
- **feat(lint): lintOrphans + lintMissing (page↔code_root diff)** (8ee9658, 2026-06-03)
- **refactor(manifest): export gitCurrentSha + makeCountCommitsSince (for lint reuse)** (fec5607, 2026-06-03)
- **feat(sync): renderDecisionHistory omits sha for commit-less (decision) atoms** (389bb21, 2026-06-03)
- **feat(note): noteAtom + CLI (agent decision atom, source=agent)** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (51de636, 2026-06-03)
- **feat(init): init installs post-commit hook + config hook: true** — Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com> (36849b2, 2026-06-03)
- **fix(init): installHook resolves common git dir (worktree-safe)** — Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com> (01676f9, 2026-06-03)
- **feat(init): installHook writes post-commit stub (install-if-absent, strategy A)** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (80b7df1, 2026-06-02)
- **feat(hook): captureHead writes HEAD commit atom (best-effort, source=hook)** (60a2727, 2026-06-02)
- **refactor(mine): export GIT_FORMAT + commitAtom source param (for hook reuse)** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (1f9a6b2, 2026-06-02)
- **feat(sync): finalizeSync folds journal atoms into decision-history (token + per-page counts)** — Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com> (5b872a2, 2026-06-02)
- **feat(sync): renderDecisionHistory (mechanical ts-desc atom bullets)** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (494097b, 2026-06-02)
- **feat(mine): CLI entry + init→mine integration (component facets, idempotent)** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (2c80419, 2026-06-02)
- **feat(mine): mine orchestration with id-based dedup (idempotent)** (e21d14d, 2026-06-02)
- **feat(mine): mineCommits runs git log → commit atoms** (055bc17, 2026-06-02)
- **feat(mine): commitAtom builds full journal atom + component facets** (1167930, 2026-06-02)
- **feat(mine): parseGitLog (RS/US-delimited git log → raw commits)** (868581b, 2026-06-02)
- **feat(mine): pathComponent maps file path to component (longest code_root)** — Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com> (4bab629, 2026-06-02)
- **feat(journal): readAllAtoms + existingIds (recursive ndjson walk)** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (4498a29, 2026-06-02)
- **feat(journal): appendAtom (append-only ndjson per day)** (75068b3, 2026-06-01)
- **feat(journal): atomPath shards atoms by ISO date** (f411914, 2026-06-01)
- **refactor: extract parseConfigCodeRoots into lib/config.js (shared by sync + mine)** (f6bd6a2, 2026-06-01)
- **feat(sync): CLI plan/finalize subcommands** (0b8eb4f, 2026-06-01)
- **fix(sync): resolve loreDir for repoRoot parity with manifest.js** (f25df5a, 2026-06-01)
- **feat(sync): finalizeSync stamps pages + builds INDEX + emits manifest** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (0bb9f1f, 2026-06-01)
- **feat(sync): buildIndex renders mechanical component TOC** (f89bf6c, 2026-06-01)
- **feat(sync): stampFrontmatter merges mechanical fields (reuses manifest.parseFrontmatter)** (38bf660, 2026-06-01)
- **feat(sync): planSync builds component worklist from config** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (1b3846a, 2026-06-01)
- **feat(sync): parseConfigCodeRoots (zero-dep YAML subset)** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (b877739, 2026-06-01)
- **feat(init): CLI entry (self-locates plugin site/, prints summary)** — Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com> (d362fd1, 2026-06-01)
- **feat(init): init orchestrator (config write-if-absent, shell refresh)** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (ff39a3d, 2026-06-01)
- **fix(init): quote code_roots containing YAML-special chars** — Adds a fmt predicate that single-quotes any root whose name contains (c7b6015, 2026-06-01)
- **feat(init): renderConfigYaml (component auto + flow/theme seeds + hook:false)** (08f01ff, 2026-06-01)
- **feat(init): discover JS workspaces (dir/* + object form)** (81b798f, 2026-06-01)
- **feat(init): discover Python packages + src layout, ancestor dedup** (86ffd7d, 2026-06-01)
- **feat(init): discoverComponents fallback layer (top-level code dirs)** (30a4401, 2026-06-01)
- **feat(init): ensureGitignore keeps .lore/.state ignored (3-state)** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (e93d723, 2026-06-01)
- **feat(init): copyShell copies browser shell into .lore/site (overwrite)** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (cfc2487, 2026-06-01)
- **feat(init): scaffold .lore subdirs (idempotent)** (58d7610, 2026-06-01)
- **feat(shell): nav model, wikilink rewrite, search, meta chips** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (fe81cca, 2026-06-01)
- **fix(serve): clean CLI error handling + URL spacing + assert sync hint** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (1410f81, 2026-06-01)
- **feat(serve): start/stop CLI entry with manifest precheck** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (4cf9152, 2026-06-01)
- **fix(serve): throw on server-never-binds, default now, document edge cases** — Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com> (473f4b7, 2026-06-01)
- **feat(serve): port selection + idempotent start/stop orchestration** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (2a5cdcb, 2026-05-31)
- **feat(serve): cross-platform process kill (taskkill/SIGTERM)** (617bdbc, 2026-05-31)
- **feat(serve): pid file read/write + liveness check** (72c0219, 2026-05-31)
- **feat(serve): runtime probe chain python3->python->node fallback** (4d66da3, 2026-05-31)
- **fix(manifest): clear git-error message, silence rev-list stderr, normalize loreDir** — Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com> (857d90f, 2026-05-31)
- **feat(manifest): CLI entry wiring real git (rev-parse/rev-list)** (51e5bed, 2026-05-31)
- **refactor(manifest): symmetric file-type filter + deterministic unknown-axis sort** — Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com> (f93be9b, 2026-05-31)
- **feat(manifest): emitManifest with injected git/clock (deterministic)** (741d8f1, 2026-05-31)
- **feat(manifest): derive ordered axes from wiki subdirs** (2b2beba, 2026-05-31)
- **test(manifest): CRLF + NaN-guard regression tests for front-matter parser** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (94ca472, 2026-05-31)
- **feat(manifest): flat front-matter parser** — Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com> (eace1c1, 2026-05-31)

## Cross-links

- [[INDEX]] —— 全轴目录
- 本 repo 单组件（`code_roots:[lib]`）；flow/theme 轴待 `config.yml` 声明后由 `/lore:sync` 自动出页。
