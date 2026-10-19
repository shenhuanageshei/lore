# 会话交接文档 · lore 拉起 + mal-analyze-cli wiki 复位（2026-10-20）

> 用途：把本会话的完整上下文交给下一个会话。**读完这一份就能接着干，不需要回看聊天记录。**
> 落盘位置：`docs/superpowers/notes/2026-10-20-session-handoff.md`
> 上一份：`docs/superpowers/notes/2026-09-10-session-handoff.md`（理解层 ⓪/① 期的交接）

---

## 0. 一句话现状

**lore 本体已推到 `56e53bd`（v0.12.0 + 本轮 11 个提交），全量 `node --test` 856 项 / 856 通过 / 0 失败；本机 wiki 从「不存在」合成到 99 页。mal-analyze-cli 的 wiki 停更了 75 天的根因查出并修掉了——是 lore 自己 main 分支上的 claude argv 顺序 bug，那个修复今天才第一次进 main；修完后它的 679 页 wiki 全部重写完、重写队列清空、lint 只剩 1 条既有告警。**

- 仓库：`D:\workspace\lore`，分支 `main`，HEAD `56e53bd`（已推 GitHub）
- 远端：`origin` = https://github.com/shenhuanageshei/lore.git
- 版本：`package.json` / `.claude-plugin/plugin.json` = **0.12.0**（未发新 tag）
- 另一个目标仓库：`D:\workspace\mal-analyze-cli`（**只写了它的 `.lore/wiki/`，一行源码没碰**）

---

## 1. 这一轮到底做了什么（为什么做）

### 1.1 触发点

owner 的要求是「拉取最新代码 + 报告项目进度」，后来追加「可以推 GitHub」+「帮我更新 mal-analyze-cli 的 wiki，但不能动那个仓库的代码」。

### 1.2 拉取：本地落后 50 个提交，且撞上一个同名文件

- fetch 第一次 `TLS unexpected eof`，重试成功。
- **本地有一份未跟踪的 `AGENTS.md` 挡住了合并**（上游已把同名文件纳入版本管理）。上游那份是本地那份的**超集**（多「决策当下就记」约定、统计 83→99 页、claude→Codex 措辞），于是用上游版本覆盖；本地副本备份在 `%TEMP%\AGENTS.md.local-backup-20261019-205425.md`。
- 拉取结果：`b58821b` → 82 文件 / +12158 −478，新 tag `v0.11.0` `v0.12.0`。

### 1.3 体检：4 项红测试，逐条挖到真因

起步状态是 **854 项 / 850 通过 / 4 失败**。没有一项是「测试写错」，四项的根因各不相同：

| 失败用例 | 真实根因 | 处置 |
|---|---|---|
| `cli.test.js` package.json bin | `core.autocrlf=true` 把源码 checkout 成 CRLF，`lib/cli.js` 首行成 `#!/usr/bin/env node\r` → 撞正则 `$` 锚点。**断言没错，是文件被 checkout 改坏了**（shebang 在 POSIX 上带 CR 是失效的） | `.gitattributes` 加 `* text=auto eol=lf`，231 个文件归一 |
| `manifest.test.js` countCommitsSince | 报的是 EPERM（临时目录删不掉）——**EPERM 是假象**。真因：夹具用 `execFileSync('bash', …)`，而本机 PATH 上的 `bash` 是 **WSL 的残缺中继壳**（`execvpe(/bin/bash)` 失败）→ 夹具根本建不起来 → 异常被 `finally` 的清理错误顶掉 | 夹具改纯 Node + git，不经 shell |
| `doctor.test.js` 闸门 | **时间炸弹**：夹具把「现在」写死 2026-09-10，但 CLI 路径走真实时钟 → 2026-10-10 之后必然变红（实测 39d > 30d） | 给 doctor CLI 加 `--now <iso>` 注入 |
| `doctor.test.js` 本仓库 hook 指向 | 本机**从未装过 post-commit hook**（只有 `.sample`），而 `.lore/config.yml` 写着 `journal.hook: true` | 走项目自带 `installHook()` 装上 |

**收尾：856 项 / 856 通过 / 0 失败。**

### 1.4 顺带发现的「lore 正在治的病，发生在 lore 自己身上」

装 hook 之前，`doctor` 报 `hook absent · 指向有效 false`——**这台机器的捕获断了 38 天**（2026-09-10 → 10-19），而 `journal.hook: true` 一直写着「已装」。这正是 lore ⓪ 期实测记录过的病：「hook 曾静默断流 3 个月、85 个提交零原子」。

处置：装 hook + 在 `.lore/config.yml` 配捕获闸门（`capture_rate_min: 5` / `gap_days_max: 30`），并实测闸门会真喊（注入时钟到 12-01 → `gap 42d > 30d` 判红 exit 1；`--capture-rate-min 99` → `12% < 99%` 判红）。

### 1.5 owner 拍板的两件事

1. **锚点漂移语义定案：只认文件级 `fn @ file`，行号不参与判定。**
   依据是实测：全库 548 个原子里 **5 个带行号的锚点 100% 漂移**（+9 到 +139 行），文件级锚点 0 个——行号在这个仓是零价值信息。且项目内本就两套纪律冲突：`commands/sync.md` 对 wiki 页写明「绝不写行号」，而 agent 代记决策原子的 resident 约定还在用行号形态。
2. **先做 P0-C**（修时间炸弹 + 加 `--now` 注入），其余按建议推进。

### 1.6 合成 lore 自己的 wiki（99 页）

本机 `.lore/wiki` 原本**不存在**（fresh clone，wiki 按 facts-only 边界不进库），于是 `lore_ask` / `lore_page` 全部返回「wiki 未构建」——**AGENTS.md 要求每个 agent 会话先查 wiki，而这台机器上每个会话都从一条失效指令开始**。

- agent 手写 11 页：HOME + `component/lib` 鸟瞰 + `component/server.js` 鸟瞰 + 8 张深度页（hook/mine/fold/sync/manifest/fingerprint/syncstate/runner）
- finalize 机械生成 docs 轴 87 页 + INDEX
- 合计 **99 页 / 35491 行**；`lore_ask` 与 `lore_page section=` 均实测可用

### 1.7 转向 mal-analyze-cli：挖出 75 天的静默故障

它的 wiki 从 **2026-08-05 起完全停止更新**——不是慢，是**每页必失败**，连续 75 天、27655 次。根因在 **lore 自己 main 分支上**：

```js
// lore main 上一直是这样（pull 前的 HEAD 79c26db）：
exec('claude', ['-p', '--allowedTools', …, '--disallowedTools', …, prompt])
//                                                     ↑ prompt 排在可变参数之后
```

`--disallowedTools` 是**可变参数**，prompt 排在它后面就被 claude CLI 逐个空格切开当工具名校验 → `Permission deny rule "你是" matches no known tool`。**已原样复现，错误文本逐字吻合。**

三条决定性证据：

- 修复提交 `cb277d9`（2026-09-08）**从来不在 main 上**：`git merge-base --is-ancestor cb277d9 79c26db` → 1。它是**今天 pull 的那 50 个提交里才第一次进 main 的**。
- reflog：这机器的工作副本 **08-05 → 今天 20:55 一直停在 `79c26db`**；而 08-05 恰好是成功率从 30-80% 掉到 **0%** 的分界点（`auto-runs.ndjson` 按天统计：06-30~08-04 正常，08-05 起 0% 连续 75 天）。
- 影响面：只有 mal-analyze-cli 在跑 auto 档（另外 3 个登记仓库没跑或早停），它的捕获链路和 journal 一直是好的，**坏的只有自动重写这一环**。

---

## 2. 交付清单

### 2.1 提交（11 个，已推 GitHub `b58821b..56e53bd`）

| commit | 内容 |
|---|---|
| `da33e61` | fix(test): countCommitsSince 用例去掉 shell 依赖（Windows 上 bash 是残缺 WSL 壳） |
| `9d71771` | feat(cli): doctor `--now` 注入时钟 —— 断流天数不再依赖当天日期 |
| `bbf3b61` | chore(gitattributes): 行尾统一 LF —— shebang / journal 追加 / 逐字断言三处受益 |
| `cf4b920` | chore(lore): 4 条待确认决策落库 + 2 条决策草稿 |
| `3e6d17f` | chore(lore): 补 hook 原子 |
| `904df39` | chore(config): 配捕获闸门 —— 断了会自己喊 |
| `fa499f0` | feat(evidence,resident): 锚点口径统一到文件级 —— 行号不参与判定 |
| `a11dfff` | fix(server): sync/mode 的 400 文案还停在 B1 口径（auto 早已合法） |
| `64650a9` | chore(lore): 刷 resident 区块（99 页 · 2026-10-19）+ 补 hook 原子 |
| `e8a856a` / `56e53bd` | 补 hook 原子（上一提交的骨架 / 跨日分片 2026-10-20） |

代码改动 14 文件 / +137 −17（`lib/cli.js` `lib/evidence.js` `lib/resident.js` `server.js` `test/doctor.test.js` `test/evidence.test.js` `test/manifest.test.js` `test/resident.test.js` `.gitattributes` `.lore/config.yml` `AGENTS.md` `CLAUDE.md` + journal）。

### 2.2 行为变更（owner 拍板的那条，落在 3 个地方）

1. **`lib/resident.js`** —— 约定文案改成 `fn @ file`，示例去掉行号，并写明理由。**这是约定的唯一源头**（CLAUDE.md / AGENTS.md 同源渲染），改一处两份文件同步。
2. **`lib/evidence.js`** —— 账本的**人读渲染**里，带行号的锚点只给文件级定位 + 显式标注「行号 N 为生成时记录，可能已漂移」。理由与壳里 `ANCHOR_NO_LINE` 同源：把旧行号当「确切位置」渲染出来 = 把「不知道」渲染成「确定」，违反不变量⑧。`--json` 的 `anchors` 数组**保留原始字符串**（账本要如实显示记录里写了什么；`EVIDENCE_SCHEMA_VERSION` 的键集是锁定契约，不动）。
3. **`test/resident.test.js`** —— 加一条**行为**断言：resident 区块里不得再出现带行号的锚点形态（`/@ [^\s`"]+:\d+/`）。它不检查具体串，只钉住「不许带行号」——正是本项目自己的教训：验收探针要验行为，验字样只给虚假的通过感。

### 2.3 新增能力

- **`doctor --now <iso>`** —— 注入「现在」，断流天数按它算。给了却没值 / 解析不了 → 用法错误 exit 1，**绝不静默回落成真实时钟**（回落 = 注入被悄悄忽略 = 本仓最忌的「安静地不工作」）。缺省行为不变。

### 2.4 mal-analyze-cli 侧的产出（**只写 `.lore/wiki/`**）

- **54 页按真实源码重写**（6 个 worker 并行，范围互不重叠、倒序做以避开后台自动重写器）：A 组 15 / B 组 12 / C 组 15 / D 组 12
- **14 页补正格式**（`## 机制` → `## 机制详解`、补 mermaid、九节齐全、`{{LORE_JOURNAL}}` 换回 token）
- 终态：**679 页 / 239808 行**；重写队列 **0**；lint 只剩 1 条既有告警

### 2.5 文档

- 本文件（`docs/superpowers/notes/2026-10-20-session-handoff.md`）
- `AGENTS.md` / `CLAUDE.md` 的 resident 区块被 finalize 机械刷新（页数 / 日期 / 新锚点约定）

---

## 3. 当前实测数字

### 3.1 lore 本体

```
git        v0.12.0 · 534 commits · head 56e53bda
hook       ok → D:/workspace/lore/lib/hook.js · 指向有效 ok
capture    last hook 0 天前 · last atom 0 天前（hook）
atoms      558 · decision 7 · pitfall 11（kind=pitfall）· trailer-only 127 · bad lines 0
noise      high 131 · low 78 · none 349
confirm    已确认 3 · 待确认 2 · 已否决 2 · 未署名 1 · 坏确认记录 0（决策 7 · confirmation 记录 7）
rate       window 12%（6 decision / 50 commits）· 累计 1.31%（7 decision / 534 commits）
gate       ok
```

- `node --test`：**856 项 / 856 通过 / 0 失败 / 0 跳过**
- wiki：99 页 / 35491 行（HOME 1 + component 10 + docs 87 + INDEX 1）
- lint：仅 127 条历史 `trailer-only`（按设计不删不填不 LLM 回填）

### 3.2 mal-analyze-cli

- wiki **679 页 / 239808 行**（docs 595 + component 71 + theme 10 + flow 1 + HOME/INDEX 2）
- 重写队列 **0**
- 档位 `{ "mode": "auto", "max_pages": 15, "stale_threshold": 15, "debounce_minutes": 2 }`
- lint：仅 `deep-config (1): scripts/e2e_smoke — multiple supported source files found（e2e_smoke.py / e2e_smoke.sh）`——**既有问题，属 config 侧，需在 `.lore/config.yml` 里 pin 一个**
- **零污染证据**：`.lore/` 整个目录在 `.git/info/exclude` 里。基线 628 条 → 终态 650 条，**新增 22 条全是该仓自己并发后台进程产生的源码改动**（`mal_analyze/capability_profiles.py`、`mal_analyze/pre_analysis/file_info.py`、`skills/*/references/capabilities.md`、`*.zip` 等），**`.lore` 相关 0 条、`.lore/` 未跟踪新增 0 个**。本会话在那个仓**一行源码都没碰**。

---

## 4. 未完成的事

### 4.1 立即要处理的

1. **2 条待确认决策**（owner 亲自点，确认动作按设计不能由机器代劳）：
   - `note:mvfaswc1yh2rez` — 给 doctor CLI 加 `--now`
   - `note:mvfaswxyuwo673` — 锚点漂移语义定案：只认文件级
   ```powershell
   node lib/cli.js confirm note:mvfaswc1yh2rez --by shenhuanageshei@163.com --why "已落地并实测：注入两个时刻分别得 0 天过 / 40 天红；给了却没值或解析不了 → 用法错误不静默回落"
   node lib/cli.js confirm note:mvfaswxyuwo673 --by shenhuanageshei@163.com --why "已落地：resident 约定 + 证据账本人读渲染 + 一条行为断言（不许再出现带行号锚点）。依据：全库 5 个带行号锚点 100% 漂移，文件级 0 个"
   ```
   跑完 **confirmed = 5**，② 期闸门 `confirmed ≥ M` 首次可满足。
2. **lore 的 CHANGELOG 该点名那条 argv bug**——它是 3 个月的静默故障，只靠人翻代码才发现。建议在 `lib/backend.js` 加一条**测试钉住**「可变参数旗标后面不能跟位置参数」，防止再犯。
3. **发 v0.13.0**（本轮 11 个提交都在 0.12.0 之上，tag 未打）。

### 4.2 mal-analyze-cli 侧待办

- 剩 1 条 lint：`scripts/e2e_smoke` 同名 `.py`/`.sh` 歧义 → 在它的 `.lore/config.yml` 里 pin 一个。
- **40+ 条「旧页/文档 与源码不符」**，其中**确定性代码 bug**（不是文档问题）优先：

  | 位置 | 问题 |
  |---|---|
  | `mal_analyze/output.py` | `format_text` 读 `sr.get("file")`，但 `cli.py:1800` 写的是 `entry["path"]` → **目录模式下每个子项名字都显示 `?`** |
  | `mal_analyze/dga.py:365` | 字符表只查「含全部 26 字母」不提取**顺序** → **翻译出的域名是错的** |
  | `native_enrichment/function_profiles.py:399` | 用 `startswith("a")` 判远程句柄 → `addr`/`arg` 被误判成远程，影响 `self_shellcode_execution` |
  | `native_semantics/static_deobf.py:247` | `int(item, 0)` 遇前导零（`010`）抛 ValueError 未捕获 → **整份产物全丢** |
  | `native_enrichment/indicators.py` | `MAX_BONUS_SCORE` 40 恰等于四项加分之和 → **永不生效**；「references_suspicious_string」几乎恒真（`strings_xrefs.json` 存的是全部字符串） |
  | `native_enrichment/network_sink` | 子串匹配 → `SuspendThread` 因含 "pend" 被误标成网络汇 |
  | `tests/test_sandbox.py` | 模块级 `importorskip("pyseccomp")` 在文件**中部** → 没装 pyseccomp 的环境**整个模块跳过**，`scrub_env` 一条不跑 |
  | `server/sse.py` | owner 恒为 `"default"` → 「每 owner 5 条」实为全局 5 条；触发上限返回 **500 而非 429**；`get_connection_stats()` 无调用方 |
  | `server/webhook.py` | 旧页称加载失败会降级继续推送，**源码是 fail-closed**（五项校验任一不过就 raise，根本不发请求） |
  | `server/jobproto_pg.py` | 自身 docstring 说用 `FOR UPDATE SKIP LOCKED`，**实际是批量 SELECT + 条件 UPDATE 的 CAS** |
  | `mal_analyze/common.py` | **2026-10-19 刚被拆成 facade + 3 个模块**，旧页整篇描述的是拆分前结构 |
  | `native_enrichment/data_literals.py` | 正则 `[0-9a-fA-F]+` 吞掉 IDA 的 `h` 后缀 → **PE fallback 对 IDA 样本永不触发**；返回 dict 带活的 `pefile.PE`（不可 JSON 序列化） |

### 4.3 后续期（②–⑤，设计已定未实施）

| 期 | 内容 | 关键约束 |
|---|---|---|
| **②** | 一条端到端理解切片：再入简报 + 证据 + 一个模块打通；**锚点漂移语义**（本轮已定案） | 纯派生、零新增义务；用 85 天断流期做夹具或 `--as-of` |
| **③** | 机械化扩展：docs 轴索引化、痛点雷达、digest 骨架、auto 追版本 + 版本切分、**纯文本导出** | 零 LLM、可并行 |
| **④** | 理解检查与回归：任务式检查（opt-in + 预立死亡条款）、变更影响回归；`lore check` verb | 默认被动模式 |
| **⑤** | `lore prep` 事件驱动答辩准备 | 静态题库会腐，按需生成 |

**阶段闸门**：② 开工条件 = ① 之后 N 周 `confirmed ≥ M`。① 交付于 2026-09-10，至今 5.6 周；M 取 4 或 5 均可满足（见 4.1 第 1 条）。

### 4.4 已知缺口（未修）

- 127 条历史 trailer-only 让 `lore lint` 的 `clean` 恒为 false（**若拿 `clean` 当门禁会被卡住**——需要 owner 定口径）。
- `journal.hook: true` 是**死声明**（全仓只读 `hook: false`）。
- `journal.mine` 里的 `changelog` 是**死键**（changelog 实际由 docs 轴处理）。
- hook 的「写入侧可见性」在真实 post-commit 场景**不可见**（桩是 `>/dev/null 2>&1`，那行诊断只有手动跑才看得见）。
- `readSyncConfig` 的 `schedule` 校验比写侧松（`99:99` 能被读出来）。
- `finalizeSync` 在非 git 仓库会**半 finalize**（页盖了戳、manifest 没出来）。
- 壳的交互层（F1–F5 / F4 / `[` `]` / 窄屏）**无浏览器实证**（本环境 headless Chrome 产不出 DOM）。
- `lore_stale` 工具未做（agent 端图谱消费的长尾）。

---

## 5. 环境与工具约束（新会话必读）

1. **bash 删除通道不可用**：`rm --` 与 `Move-Item` 到工作区外都被本地安全策略拦（`mavis-trash` 不可调用）。**工作区内**的移动可以用（把临时文件挪进 `.lore/.state/` 这种 git 忽略目录即可）。
2. **PATH 上的 `bash` 是 WSL 的残缺中继壳**（`execvpe(/bin/bash)` 失败）。**不要在测试里依赖 shell**——本轮那条假 EPERM 就是这么来的。
3. **`core.autocrlf=true`**：本仓已用 `.gitattributes` 统一 LF；**别的仓没有**，`lib/cli.js` 这类带 shebang 的文件在别处 checkout 出来会是 CRLF。
4. **PATH 上有两个 claude**：`.local\bin\claude.exe` = **2.1.177**（靠前，实际生效）、WinGet Links = 2.1.175。都不含 2.1.191。
5. **PowerShell 陷阱（本轮踩了 3 次）**：
   - 双引号串里写 JS 的 `$1` 会被当变量吃掉 → 改用脚本文件 + `node` 跑。
   - `ConvertFrom-Json` 把 ISO 时间串解析成 DateTime → `.Substring()` 直接抛错 → 统一用 node 处理 JSON。
   - 缓存基线用 `Set-Content` 存会带 CRLF，与后来读出的 LF 逐行不匹配 → 对比前先归一化。
6. **`node --test` 在本机约 5–7 分钟**（856 项）。别在等待时发呆。
7. **子 agent 并发上限 4**。

---

## 6. 接着干的标准流程（照抄即可）

```text
1) 若 owner 要动 ② 期 → 先写计划 docs/superpowers/plans/YYYY-MM-DD-<slug>.md
   （每阶段：目标 / 文件清单 / 验收 / 自检命令；≤4 阶段）
2) 设计评审 → 拿 designToken
3) 实施 → 复验自检 → 提交检查点
4) 偏离审计（只读 subagent 核对「实现 vs 设计」）→ 有偏离再派一轮
5) 交付代码评审 → 逐条响应表（| # | Action | Detail |，Action ∈ Fixed / Not an issue | Deferred）
6) 全量 node --test → 更新 CHANGELOG / README / ROADMAP → 提交
```

**本轮新增的两条经验**：

- **验收探针要验行为，不验字样。** 本轮 worker 们自己发现我给的页面模板有错（`## 机制` vs lint 要求的 `## 机制详解`），去读 `lib/lint.js` 源码纠正了。**给 agent 的模板必须先自己跑一遍 lint 验证**，否则错会复制到几十页上。
- **改完立刻验证副作用。** 我给 4 张页的 `<summary>` 加 `<b>` 时把 `$1` 写成字面量，**把 9 个节标题清空了**，靠 finalize 后发现 manifest 少节才抓到。**批量改动后立刻查 manifest 的节索引**，别等到下一次 lint。

---

## 7. 立即可用的命令

```bash
# lore 本体
node --test                                          # 全量回归（856 项，约 5–7 分钟）
node lib/cli.js doctor                               # 体检：捕获率 / 噪音 / 确认 / 闸门
node lib/cli.js confirm --list                       # 确认清单
node lib/cli.js evidence                             # 证据账本
node lib/cli.js note --draft --title "…" --why "…" --anchors "fn @ file"   # 记决策草稿（文件级锚点）
node lib/migrate.js .                                # 资产对齐（resident / 壳 / hook stub）
node lib/lint.js .lore                               # 漂移检查
node lib/sync.js plan .lore --all                    # 算要重写的页
node lib/sync.js finalize .lore                      # 机械盖章 + 物化决策史 + 建 manifest
git log --oneline origin/main..main                  # 未推送的提交

# mal-analyze-cli（wiki 在 .lore/，不进 git）
node D:/workspace/lore/lib/sync.js plan  D:/workspace/mal-analyze-cli/.lore --all
node D:/workspace/lore/lib/sync.js finalize D:/workspace/mal-analyze-cli/.lore
node D:/workspace/lore/lib/lint.js D:/workspace/mal-analyze-cli/.lore
```

---

## 8. 一句话给下一个会话

**lore 主体已经健康（856/856 全绿、99 页 wiki、闸门装上、锚点口径统一到文件级）；mal-analyze-cli 的 75 天静默故障是 lore main 上的 argv 顺序 bug、今天随 pull 首次进 main，它的 679 页 wiki 已全部重写完、队列清空。下一件事只有三件：owner 点掉那 2 条待确认（→ confirmed=5，② 期闸门才开）、给 CHANGELOG 点名那条 argv bug 并加测试钉住、mal-analyze-cli 那 40 条源码级发现里挑确定性 bug 修（`output.py` 字段名不一致和 `dga.py` 字符表丢序是首选）。**
