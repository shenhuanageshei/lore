# lore 自动重写 B2（LLM 运行器 + auto 档 + schedule + 质量门）—— 设计

- 日期：2026-06-10
- 状态：设计已批，待写实施计划
- 北极星：人读 + agent 双友好的活文档；本期兑现**「wiki 永远新鲜」的最后一块**——prose 重写不再依赖人开会话
- 前置（已在 main）：A 低摩擦合成（增量 plan/指纹/机械 finalize）、B1 控制面（档位 manual/notify + 控制 API + 壳控制台 + rewrite 队列）、lint 第五检 `mermaidIssues`（质量门复用）
- 拆解出处：B1 spec 的 B2 预告（可插拔 LLM 后端 / auto 档 / schedule / 质量门 / 任务历史）

## 背景 / 问题

B1 落地后控制面完整，但 prose 重写仍要人触发：notify 档只能「排队提醒」，下次开会话才消化。auto 档要做到：commit 后（或定时）**后台自动**把 stale 页的架构正文重写掉——零人工、有质量门、花销可控。

## 决策（已锁，含 B1 时预锁项）

| 项 | 决策 |
|---|---|
| LLM 节奏 | **静默期触发**：commit 后等 `debounce_minutes`（默认 10）静默期，期间再 commit 重新计时——风暴自然合并成一次。机械 finalize 仍每 commit 即刻（不变） |
| 调度模型 | **统一 ticker**：「静默期」与「schedule 定时」是同一问题，统一进 **server 进程的 ticker**（每 60s 醒）。hook 的 auto 分支只写 `.state/auto-pending.json` 时间戳（零等待，永不挡 commit）；ticker 判定触发。**serve 没开 = auto 不跑**（可接受降级，下次开 serve 补跑过期 pending） |
| 写盘模型 | **LLM 只读，runner 写盘**：claude CLI 无头只给 `Read,Grep,Glob`（能读码、零写权限），页面全文吐 stdout；runner（确定性代码）收下跑质量门，过门才写 wiki。质量门天然在写盘前，后台 LLM 攻击面为零 |
| 后端分期 | runner 抽象 **backend 接口**（可插拔位）；B2 只实现 **claude-cli**（即插即用、质量同会话）。裸 Anthropic API / codex 下轮按接口补（key 管理/无工具凑上下文是独立难题） |
| 质量门（B1 预锁） | 全机械：frontmatter 完整（title/summary）、`{{LORE_JOURNAL}}` token 或哨兵区未破坏、`mermaidIssues` 零（复用 lint 第五检）、非空且 ≥ 旧文 1/3（防截断）。过门写盘；不过丢弃 + 记失败历史，页保持原样 |
| 防叠跑 | `.state/runner.pid` 锁：runner 在跑时 ticker 跳过（LLM 重写不幂等，必须防叠）。stale pid（进程已死）视为无锁 |
| 预算阀 | 单次 run 最多 `max_pages`（默认 5）页；单页超时 10 分钟 kill。失败不重试（记历史，下轮再说） |
| 配置 | `.state/sync.json` 向后兼容扩展：`{ mode, debounce_minutes?, schedule?, max_pages? }`。`MODES` 加 `'auto'`（B1 的 throw/400 解除）。B2 不做配置编辑 UI——参数手编或默认（YAGNI） |
| schedule 语义 | `"HH:MM"`（本地时）。ticker 判「到点且今天没跑过」（比对 auto-runs 最后一条的日期）。null/缺省 = 不定时 |
| 任务历史 | `.state/auto-runs.ndjson` 每 run 一条：`{ts, pages:[{page, ok, reason?, ms}], total_ms}`。console「任务历史」区从 🔒 占位变真表格 |
| 失败可见性 | claude CLI 不存在/超时/质量门不过 → 记历史 + console 显示，**不崩 server 不丢页** |
| 灯第四态 | 🔵 busy（runner 在跑，查 runner.pid 活性经 status API）——后台烧额度时用户看得见 |

## 设计

### A · 配置层（`lib/syncstate.js` 扩展）

```
MODES = {'manual','notify','auto'}                       // B1 的 auto throw 解除
readSyncConfig(stateDir) -> { mode, debounce_minutes, schedule, max_pages }
  // 缺文件/坏 JSON → 全默认（mode notify / debounce 10 / schedule null / max_pages 5）
  // 未知字段忽略（开放式，向后兼容 B1 的 {mode}）
writeAutoPending(stateDir, ts) / readAutoPending(stateDir) -> ts | null
readRunnerPid(stateDir) / writeRunnerPid / clearRunnerPid   // 同 serve.pid 风格
appendAutoRun(stateDir, run) / readAutoRuns(stateDir, limit=20)
```

### B · 触发链路

- **hook**（`lib/hook.js` `maybeRefresh`）：auto 分支 = notify 行为（spawn 机械 finalize）**+ `writeAutoPending(stateDir, now)`**。不 spawn LLM、不等待。
- **server ticker**（`server.js` CLI 块，不进 `createServer` 工厂——测试零影响）：每 60s 调 `tickAuto(loreDir)`。~~portal 进程不带 ticker~~ **2026-06-11 翻转**：portal API 转发落地后（用户需求：portal 下控制台可操作），portal 是更自然的常驻调度宿主——portal `__run` 对全部登记 repo 循环 `tickAuto`；
- **判定纯函数**（`lib/runner.js` 导出，可测）：

```
shouldRunAuto({ config, pendingTs, lastRunDate, now, runnerAlive }) -> { run: bool, reason: 'debounce'|'schedule'|null }
  // runnerAlive → false
  // mode !== 'auto' → false
  // pendingTs && (now - pendingTs) >= debounce_minutes → {run:true, reason:'debounce'}
  // schedule 到点（now ≥ 今天的 HH:MM）且 lastRunDate !== 今天 → {run:true, reason:'schedule'}
```

触发后：detached spawn `node lib/runner.js <loreDir>`，清 pending。

### C · runner（新 `lib/runner.js`）

```
runAuto(loreDir, { backend, maxPages, timeoutMs, now }) -> { pages:[...], total_ms }
  1. writeRunnerPid；try/finally clearRunnerPid
  2. 工单：planSync(loreDir) 的 component worklist + readRewriteRequests 队列页置顶（user-requested 优先），
     去重后截前 maxPages 页
  3. 逐页串行：
     a. oldText = 读页文件
     b. newText = await backend.rewritePage({ page, repoRoot, timeoutMs })
     c. gate = qualityGate(newText, oldText) → ok ? 写盘 + 从 rewrite 队列移除该页 : 丢弃
     d. 记 {page, ok, reason?, ms}
  4. appendAutoRun；spawn finalize（盖章/指纹推进/manifest——stale 归零靠它）
```

- **qualityGate(newText, oldText) → { ok, reason? }**：非空 → frontmatter title+summary → token/哨兵区存在（`{{LORE_JOURNAL}}` 或 `LORE_JOURNAL:START`）→ 全部 ```mermaid 块过 `mermaidIssues` → `newText.length >= oldText.length / 3`。
- **claude-cli backend**（同文件导出 `claudeBackend`）：

```
spawn('claude', ['-p', prompt, '--allowedTools', 'Read,Grep,Glob'], { cwd: repoRoot, timeout })
  // prompt：你是 lore 的页面重写器。读 <code_root 或 sourceFile> 源码与现有页 <page path>，
  //         按 commands/sync.md 的两档标准重写整页。只输出完整 markdown 页面（含 frontmatter
  //         与 {{LORE_JOURNAL}} token 原位保留），不要输出任何解释。
  // stdout 即 newText；超时 kill → {ok:false, reason:'timeout'}；ENOENT → reason:'claude-cli-missing'
```

- backend 接口契约：`rewritePage({page, repoRoot, timeoutMs}) → Promise<string>`（抛错 = 该页失败记历史）。API/codex 后端下轮按此补。

### D · API / UI

- `POST /api/sync/mode`：枚举放开 `auto`。
- `GET /api/sync/status` 扩展：`{ mode, last_finalize, config:{debounce_minutes, schedule, max_pages}, runner_running }`。
- 新 `GET /api/sync/runs` → `{ runs: readAutoRuns(stateDir, 20) }`。
- 壳：auto 按钮解锁（面板+console 两处去 disabled/🔒）；mode=auto 时面板显示参数摘要；灯第四态 `busy`（`buildConsoleModel` 加 `runner_running` 入参 → light `'busy'` 优先于 stale/fresh）；console「任务历史」区渲染 runs 表（时间/页数/✓✗/失败原因）。

### 不变量 / 风险

- **零依赖**不破（spawn claude 是 child_process；claude CLI 是环境能力非 npm 依赖）。
- **hook 永不挡 commit**（auto 分支只多写一个 JSON 文件）。
- **后台 LLM 零写权限**（--allowedTools 白名单 + stdout 收文）。
- **质量门失败无损**：页保持原样、失败入历史、下轮重试机会（stale 仍在）。
- **`.state/` 可重建**：删 pending/pid/runs 任意文件均无损坏。
- 风险：claude CLI 的 `-p` stdout 可能混入非页面文本（工具调用日志等）→ runner 提取「首个 `---` 到文末」作为页面体；提取失败 = 质量门 reason:'no-frontmatter'。
- 风险：长 run 期间用户切回 manual → runner 跑完当前 run 不中断（run 级原子性）；ticker 下轮看 mode 已非 auto 不再触发。

## 测试

1. syncstate：readSyncConfig 默认/扩展字段/向后兼容 B1 形状；auto 进 MODES；pending/pid/runs 读写。**B1 既有断言翻转**：`writeSyncMode('auto') → throw` 改为成功；server `POST mode auto → 400` 改为 200（B1 留位兑现，意图随 spec 演进）。
2. `shouldRunAuto` 全分支：非 auto / runner 活 / debounce 未到与已到 / schedule 到点与今天已跑 / 双触发优先级。
3. `qualityGate` 全分支：好页过；空/缺 frontmatter/token 破坏/mermaid 坏/截断各拒。
4. runner 注入 **fake backend**：好页写盘+队列移除；坏页丢弃+历史 reason；超时/抛错记 reason；maxPages 截断；pid 锁写清。
5. server：mode auto 200；status 扩展形状；GET runs。
6. hook：auto 档写 pending + 仍 spawn finalize。
7. 壳：buildConsoleModel busy 态。
8. 端到端 dogfood（手动）：切 auto → commit → 10 分钟静默（或临时调短 debounce）→ runner 真跑 claude CLI 重写一页 → 质量门过 → 页面真新 + stale 降 + 任务历史可见 + 跑时灯 🔵。

## 改动清单

- 新 `lib/runner.js`（shouldRunAuto / qualityGate / claudeBackend / runAuto + CLI）、`test/runner.test.js`
- 改 `lib/syncstate.js`（MODES+auto、readSyncConfig、pending/pid/runs 读写）+ 测试
- 改 `lib/hook.js`（auto 分支写 pending）+ 测试
- 改 `server.js`（mode 放开 auto、status 扩展、GET runs、CLI 块 ticker）+ 测试
- 改 `site/shell.mjs`（buildConsoleModel busy）+ `site/index.html`（auto 解锁/参数摘要/任务历史表/灯 busy CSS）+ dogfood 双 cp
- `commands/serve.md`/`sync.md` 提及 auto；`docs/ROADMAP.md` 标记

## 实现节奏

spec → writing-plans → plan → TDD → 审查 → 合并。裸 API / codex 后端、配置编辑 UI 另立。
