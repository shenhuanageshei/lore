# Changelog

All notable changes to **lore** are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [0.8.0] — 2026-06-12

- **runner 可靠性包**（threat-intel 真实战场尸检驱动，四病灶全修）：
  - **token 态重写**：物化决策史哨兵区（可达 95K）不再过 LLM 往返——prompt 要求输出单行 `{{LORE_JOURNAL}}`，finalize 重新物化。根治 3/5 超时，输出量降约 20 倍。
  - **质量门对等比较**：防截断阈值改在 token 态比较（两边剥哨兵区）——物化态旧页 vs token 态新页直接比长度必误杀（实测 96K vs 5K 被拒）。
  - **轮间冷却**：失败页留队时队列时间戳恒旧，ticker 每分钟重启失败轮（实测 5 分钟 3 轮重试风暴）——上次 run 距今 < debounce 一律不再触发。
  - 失败原因记 stderr 300 字符（原 80 字符只是命令行回显，等于零信息）。
- **重写标准加「枚举完整性」**：入口全景/dispatch 表/跳过原因全集必须出表——对照实验实证清单型事实是 wiki 相对源码的最高价值内容（源码组 43 次工具调用 vs wiki 一张表）。
- **自动迁移**：引擎升级后 repo 内资产随下次 finalize 自动收敛（壳/hook stub/.mcp.json/CLAUDE.md 节/config 补缺块），无需重跑 init；`node lib/migrate.js <repo>` 可手动触发；一次性动作（config 块/resident 首装/gitignore/gitattributes）记 .state/migrations.json，用户删除不复活。
- **facts-only git 边界**：`.lore/wiki/`、`.lore/site/` 不再进库（生成物，clone 后 /lore:sync 再生）；journal/config 保留进库；journal ndjson 启用 `merge=union`，多机各自 commit 不再冲突。
- **活 wiki 三缺口**：serve 默认 node（python 须显式 --python）；`node lib/portal.js autostart` 开机自启；auto 重写工单扩到 theme/flow/HOME（stale≥阈值入单，prompt 按轴分支）；壳 stale 徽标点击即排队重写。
- hook stub 不再「装过就永不更新」——引擎路径/stub 文案变更自动刷新（含 lore 标记才动，foreign hook 永不碰；首装仍只在 init）。
- fresh-clone 引导：CLAUDE.md resident 节与 lore_ask 在 wiki 缺失时提示先跑 /lore:sync。

## [0.7.0] — 2026-06-11

### 新增
- **同步控制台 B1** — 档位 `manual`/`notify`（`.state/sync.json`，per-machine，hook 真读分流）；控制 API（status / mode / config / finalize / rewrite-requests / runs，localhost-only + `safeWikiPage` 防越狱）；壳顶栏状态灯（🟢/🟡/⚪/🔵 四态）+ 下拉面板 + `#console` 整页；manifest 轮询（15s 慢 + 操作后 1s 快）自动刷新灯/侧栏 + 当前页「⟳ 内容已更新」提示条；重写排队（ndjson 队列去重，按钮三态反馈）。`serve --node` 给单语仓库启用控制 API。
- **自动重写 B2** — `auto` 档兑现「wiki 永远新鲜」：hook 只写 pending 时间戳；ticker（60s）统一判静默期（默认 10min，可配）/ 每日 schedule / 防叠跑 → spawn runner；runner 串行调**只读 claude CLI**（`--allowedTools Read,Grep,Glob`，stdout 收文，写盘权在 runner）→ 机械质量门（frontmatter / journal 哨兵 / mermaid 五检 / 防截断）→ 过门写盘 → `auto-runs.ndjson` 历史 → finalize 收尾。重写队列非空也触发（排队即意图）。控制台可编辑 auto 参数（静默期/定时/单次页数）。e2e 实测：真 claude 后台 8 分钟重写 23KB 鸟瞰页，1/1 过门。
- **docs 轴重构（C-呈现②）** — 侧栏三组分流：「📌 项目状态」（changelog/ROADMAP/pitfalls）置顶常开；「📐 设计与计划」spec↔plan 按 date+slug 配对成行（plan 徽标直达）默认折叠；「📝 notes」折叠。折叠态 localStorage 记忆；搜索穿透折叠组（搜索域含英文 slug）。group/paired_plan 由 docs.js 物化进 frontmatter，manifest 组间排序单一来源。
- **portal 进化** — ① 写面翻转：全部本地 API 抽成共享 `handleApi(root,…)`，portal 剥 `/<name>` 前缀按 repo 转发（同 localHost 防护，写面限对应 repo 的 `.state`）——控制台在 portal 下完全可操作；② portal 接管全部登记仓库的 auto ticker（每 tick 重读 registry）；③ 壳内仓库切换：🏠 + repo 下拉，per-repo 与 portal 双形态（per-repo 经 `/repos.json` 获知 portal 端口跨端口跳转）；④ **跨 repo 全局搜索**：搜索词懒加载其他仓库 manifest，侧栏底部「🌐 其他仓库」命中直达；⑤ 仓库列表页跟随壳主题（共享 CSS 变量 + localStorage key，自带切换器）。
- **mermaid 语法校验（lint 第五检）** — 启发式抓实测坑：保留字节点 id、断箭头（`== >`）、未知图类型、引号不配对。顺带修掉 lint 两个老误报（deep 页误判孤儿、token 字面引用误判残留）。
- **note enrich** — `/lore:note --enrich <sha> --why "…"` 给历史 commit 骨架补 why（append-only，fold 层演化追加）。
- **server.js 组件页** — 文件级 code_root（`pathComponent` 现成支持），dogfood `code_roots: [lib, server.js]`。

### 修复
- **决策史 trailer 噪音** — `stripTrailers`（fold.js）：mine 源头净化 + renderDecisionHistory 防御旧原子，`Co-Authored-By` 等不再出现在 why。
- **Windows 控制台弹窗** — 全部 detached spawn 与 `execFileSync`（git/taskkill/python，共 16 处）加 `windowsHide`。
- **壳白屏（module 缓存）** — serveStatic 加 `Cache-Control: no-cache`；目录请求 301 补尾斜杠（相对路径 `./shell.mjs` 解析错位的根因）。
- ROADMAP 大扫除：8 条长期陈旧的「待修复/余项」逐条核实划掉（fold-by-id、HOME 翻译 stale、空段、docs chips 等均早已修复）。

### 安全
- portal 写面转发沿用 per-repo 全套防护（localHost guard / safeWikiPage / 白名单 loreDir）；零新增暴露面，仍仅绑 `127.0.0.1`。后台 LLM 零写权限（工具白名单 + stdout 收文）。

## [0.6.0] — 2026-06-07

### 新增
- **单机共享门户（portal MVP）** — 一个常驻 server（固定端口 `7842`，仅绑 `127.0.0.1`）聚合本机所有 lore 仓库：顶层 `/` repo 选择器 → `/<name>/site/` 进该仓库多轴 wiki。仓库发现走中央 `~/.lore/repos.json`（`/lore:init` 自动登记、`listRepos` 过滤已失效条目）；路由用 repo 根目录名（同名加 `-2` 后缀兜底）。新 `/lore:portal start|stop|list` 命令；与 per-repo `/lore:serve`（各自 `stablePort`）共存。（`lib/repos.js`、`lib/portal.js`、`server.js`、`commands/portal.md`）
- **共享静态 serve 逻辑** — 从 `server.js` 的 `createServer` 提取 `serveStatic(root, rel, res)`（穿越防护 + dir→index.html + MIME 流式），per-repo server 与 portal 共用同一套静态语义；新 `createPortalServer(repoMap)` 复用之。
- **壳 base 前缀感知** — `site/shell.mjs` 新增 `baseFromPathname`，壳从 `location.pathname` 推断 `/<repo>/site/` 前缀，wiki/api fetch 自动带正确前缀（per-repo 下为 `/`、行为不变；portal 下带 `/<name>/`）。

### 安全
- portal **MVP 只读**：`/<name>/api/…` 一律 404（无 write 面 → 无 DNS-rebind 写风险）；只 serve `~/.lore/repos.json` 白名单内的 loreDir，每 root 独立 normalize 穿越防护；仅绑 `127.0.0.1`。

## [0.5.1] — 2026-06-06

### 修复
- **`parseConfigLanguage` 容忍 `language:` 行的注释 + CRLF** —— v0.5.0 的块正则 `^language:[ \t]*\n` 要求该行仅空白结尾，但 init 生成的 config 在该行带注释、Windows checkout 用 CRLF（`\r\n`）→ 解析失败、**静默退回 `default: en`**，双语 + 语言 sidecar 全失效。修正：尾注释 + `\r` 容忍；块体逐行也加 `\r?`（否则 CRLF 下 JS `.` 不匹配 `\r`，只读到首行、丢失 `available`）。lore 自身（CRLF）与 threat-intel 的 wiki 现正确识别 `default: zh`。v0.5.0 双语在真实 config 上的隐藏 regression（229 测试因都用裸 `language:\n` 未覆盖；dogfood threat-intel 时实测暴露）。

## [0.5.0] — 2026-06-06

### 新增
- **人读 HOME 首页** — 新增 `HOME` 轴（排在 INDEX 前），`/site/` 默认首屏从目录变为「认知入口」：一句话定位 + 机械状态块（版本/sha/轴数/语言/翻译进度，由 finalize 在 `{{LORE_HOME_STATUS}}` 槽位机械替换）+ 核心知识流 mermaid 图 + 理解项目/排查问题/决策时间线入口。INDEX 收窄为完整目录。（`lib/home.js`、`lib/sync.js`、`lib/manifest.js`）
- **持久化双语层（i18n）** — repo 级语言配置（`config.yml` 的 `language: {default, available}`）、用户级偏好（`.lore/.state/preferences.json` + 浏览器 localStorage）、页面级翻译 **sidecar**（`<page>.<lang>.md`，带 `translation_of` + `translation_source_hash` 防陈旧）。manifest 暴露每页 `lang` + `translations[]`（sidecar 不进侧栏）。壳加 `#language` 切换器：当前语言无 sidecar 时回退源页并显示「translation missing/stale」。（`lib/i18n.js`、`lib/config.js`、`lib/manifest.js`、`site/{index.html,shell.mjs}`）
- **页面触发翻译（两段式，agent 可审）** — `/lore:translate` 命令（`lib/translate.js` plan/finalize）：plan 出源正文+目标路径+hash，agent 写 sidecar，finalize 校验并更新 manifest。浏览器「翻译本页」经本地 Node server 写 `.lore/.state/translation-requests.ndjson`（不让浏览器直连 LLM）。翻译**不在 sync 自动跑**——保持确定性核心，LLM 仅此一处且 gated。
- **本地 wiki state API** — 内置 Node `server.js` 新增 `POST /api/preferences` 与 `POST /api/translation-requests`，仅写 `.lore/.state/`；`lore serve` 在启用双语时优先用 Node server（python 静态 server 无 API）。

### 安全
- API 仅绑 `127.0.0.1`、路径白名单防穿越、`Host` 头 loopback 校验防 DNS-rebind 请求伪造；浏览器永不直接写 `.lore/wiki`。

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
