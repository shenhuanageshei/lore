---
title: lore 同步控制台 B1（档位 + 控制 API + 壳控制台）—— 设计
summary: - 日期：2026-06-09 - 状态：设计已批，待写实施计划 - 北极星：人读 + agent 双友好的活文档；本期专攻**可见性与控制面**（sync 状态一眼可见、一键可控） - 前置（已在 main）：A 低摩擦合成（增量 plan + prose 指纹 + post-commit 机械 finalize，`2026-06-08-lore-low-friction-sync-des...
source_path: docs/superpowers/specs/2026-06-09-lore-sync-console-design.md
last_updated: 2026-06-09
---
> 源文档：`docs/superpowers/specs/2026-06-09-lore-sync-console-design.md`

# lore 同步控制台 B1（档位 + 控制 API + 壳控制台）—— 设计

- 日期：2026-06-09
- 状态：设计已批，待写实施计划
- 北极星：人读 + agent 双友好的活文档；本期专攻**可见性与控制面**（sync 状态一眼可见、一键可控）
- 前置（已在 main）：A 低摩擦合成（增量 plan + prose 指纹 + post-commit 机械 finalize，`2026-06-08-lore-low-friction-sync-design.md`）
- 拆解出处：A spec「非目标」划给 B 的四块（前端控制台 / 档位 / 控制 API / 内置 LLM 客户端），本轮经头脑风暴再切两期：**本文 = B1（控制面，零 LLM）**；B2（LLM 自动化）另立 spec。

## 背景 / 问题

A 落地后，机械部分（决策史 / manifest / stale）commit 后自动新鲜，但：

1. **状态不可见** —— stale 散在侧栏每页 ⚠ 上，没有「这个 repo 现在有 N 页待重写、上次刷新是什么时候」的聚合视图。
2. **不可控** —— 想关掉 commit 自动刷新没有开关；想立即机械刷新只能开终端敲命令。
3. **提醒不闭环** —— 看到 stale 页后没有「排队待办」的概念，下次开会话 agent 不知道用户想优先重写哪些页。

## B1 / B2 分期（已锁）

| 期 | 范围 | LLM |
|---|---|---|
| **B1（本文）** | 档位 `manual`/`notify` + 控制 API + 壳控制台（顶栏灯 + 下拉面板 + `#console` 整页）+ manifest 轮询自动刷新 + 重写排队 | 零 LLM |
| **B2（另立）** | LLM 运行器（**可插拔后端**：默认 spawn claude CLI 无头、可选裸 Anthropic API、留 codex 扩展位）+ `auto` 档 + `schedule` 定时参数 + 质量门（机械校验+失败丢弃） | 重头戏 |

B1 给 B2 留位：档位枚举 / UI / API 校验都认识 `auto` 但 B1 拒绝或置灰（🔒 标注 B2）；rewrite-requests 队列 B2 直接换 LLM 消费者。

## 决策（已锁）

| 项 | 决策 |
|---|---|
| 档位 | 三档预设 `manual` / `notify`（默认）/ `auto`（B2）；**schedule 是独立参数**挂在 auto 下（B2），不做两轴自由组合 |
| 档位存储 | `<loreDir>/.state/sync.json` `{ "mode": "notify" }`。**不进 config.yml**：档位是 per-machine 工作流偏好（同 repo 不同机器可不同档）；浏览器切档由 server 写文件，机器写手编 config.yml 会破坏注释格式；删文件 = 回默认，无损坏（同指纹语义） |
| notify 行为 | = A 落地后的现状（hook detached spawn 机械 finalize）→ 默认档零迁移成本 |
| manual 行为 | hook 跳过 spawn（机械刷新也关），一切手动 |
| 控制台形态 | **A+C 组合**（mockup 已确认）：顶栏状态灯（🟢 全新鲜 / 🟡 N 页待重写 / ⚪ manual 档）+ 点击下拉面板（档位切换 / 摘要 / 操作按钮）→「详情」进 `#console` 整页（队列表格 + 状态 + B2 占位） |
| `#console` 路由 | 壳内置路由（同 404 页机制），不是 wiki 页 → 不进 manifest / 侧栏；入口只在灯面板 |
| 壳自动刷新 | **manifest 轮询**：常驻 15s 轮询 `.manifest.json` 的 `generated`；控制台操作后切 1s×10 快轮询直到变化（秒级反馈）。变化 → 灯/侧栏自动重建；当前页条目变了 → 正文顶部提示条「⟳ 内容已更新」点击 re-render（不打断阅读、不丢滚动位置）。**不用 SSE**：finalize 是 detached 进程 server 无感知，且轮询纯静态 GET 三种 serve 形态（Node / python / portal）全兼容 |
| 重写排队 | `POST /api/sync/rewrite-requests` append `.state/rewrite-requests.ndjson`，**照搬 translation-requests 模式**；同页未消化不重复排；下次会话 `/lore:sync` 优先消化并清条目；B2 的 auto 档复用同一队列 |
| 质量门（B2 记录）| 机械校验（frontmatter 完整 / 哨兵区未破坏 / mermaid 可解析 / 非空）→ 过门落盘，不过丢弃 + 控制台记失败 |
| **主题一致性（硬约束）** | 灯 / 面板 / `#console` 全部用壳 CSS 变量（`--bg` / `--panel` / `--fg` / `--fg-dim` 等），dark / light / sepia 自动跟随；**禁止硬编码色值** |
| **配置真实生效（硬约束）** | mode 走通**存→读→行为分流**全链路：UI 点击 POST 落盘 → 刷新读回显示同值 → hook 真读它分流。验收含端到端用例（切 manual → commit → 验证无 finalize），杜绝空壳 |
| portal 降级 | portal 现状不路由 `/api/`（只读 404）→ 灯照常亮（manifest 壳侧计算），操作按钮置灰 + tooltip「portal 只读」 |

## 设计

### A · 状态层（新 `lib/syncstate.js`，纯函数 + 路径注入）

```
readSyncMode(stateDir)  -> 'manual' | 'notify'        // 缺文件/坏 JSON → 'notify'（best-effort，同 registry 风格）
writeSyncMode(stateDir, mode) -> void                  // 校验枚举（B1 拒 'auto'）+ 整文件覆写 sync.json（撕裂读由 notify 默认兜底）
appendRewriteRequest(stateDir, { page }) -> { queued } // 同页已在队列（未消化）→ 不重复 append，返回 queued:false
readRewriteRequests(stateDir) -> [{ ts, page }]        // 缺文件 → []；坏行跳过
```

- `sync.json` 结构 `{ "mode": "notify" }`，B2 加 `auto` / `schedule` 字段（解析器开放式，未知字段忽略）。
- rewrite 队列复用 ndjson append-only 风格；「消化」= 会话 agent 重写该页后**重写整个文件去掉该条目**（队列小、非并发，简单覆盖写可接受）。

### B · 控制 API（`server.js` `createServer` 扩展）

全部走现有 `localHost` guard（防 DNS-rebind）；只读写 `<root>/.state/` 与读 manifest；portal `createPortalServer` 不路由（现状不变）。

| 端点 | 行为 |
|---|---|
| `GET /api/sync/status` | `{ mode, last_finalize }`；mode 读 syncstate，last_finalize 读 manifest `generated`。stale 列表**不在此回**——壳已加载 manifest 自行聚合，不做重复数据源 |
| `POST /api/sync/mode` | body `{ mode }`；枚举校验（B1 仅 manual/notify，`auto` → 400 提示 B2）→ `writeSyncMode` |
| `POST /api/sync/finalize` | detached spawn `node lib/sync.js finalize <loreDir>`（同 hook 与 A 接缝③），立即返回 `{ spawned: true }`。不加防抖锁：finalize 幂等、最后写赢（A 已论证），连点无害 |
| `GET/POST /api/sync/rewrite-requests` | GET 返回队列；POST body `{ page }` → `appendRewriteRequest`（校验 page 是合法 wiki 相对路径，复用 `safeWikiPage` 思路仅作格式校验） |

spawn 经参数注入（`spawnFn`）便于测试。

### C · hook 分流（`lib/hook.js`）

`maybeRefresh` 开头加：`readSyncMode(join(loreDir,'.state')) === 'manual'` → `return { spawned:false, reason:'manual' }`。notify（默认/缺文件）走现状。B2 在此加 `auto` 分支（spawn finalize + LLM 运行器）。

### D · 壳（`site/index.html` + `site/shell.mjs`）

**纯函数进 `shell.mjs`（可测）**：

```
buildConsoleModel(manifest, status) -> {
  light: 'fresh' | 'stale' | 'off',     // off = manual 档
  staleTotal, stalePages: [{ key, title, stale, last_updated }],
  mode, lastFinalize,
}
pollDecide(prevGenerated, nowGenerated, currentPageEntryChanged) -> {
  changed: bool, rebuildSidebar: bool, showUpdateBar: bool,   // changed 在 pollTick 里承担 console 重渲染职责
}
```

**`index.html`**：

- 顶栏灯（主题切换旁）：`buildConsoleModel().light` 三态渲染；点击 toggle 下拉面板。manual 档（`off`）显示灰点但**待重写数字照常显示**（「⚪ 2」，tooltip「手动档——自动刷新已关」）：关自动 ≠ 藏信息。
- 下拉面板：档位 segmented control（manual / notify 可点，auto 置灰 🔒 B2）、待重写摘要（前 2 页 + 总数）、上次刷新、按钮 ⟳ 立即刷新（POST finalize → 快轮询）/ ✍ 重写排队（对全部 stale 页逐个 POST）/ 详情 →（`location.hash = 'console'`）。
- `#console` 路由：`route()` 里 hash === 'console' → 渲染内置页（不 fetch wiki）：档位区（同 segmented + 当前档说明）、待重写队列表（页名 / ⚠N / 正文最后重写日期 / 单页 ✍ 排队按钮，已排队显示 ✓）、状态区（上次刷新 / 已排队请求数 / B2 任务历史 🔒 占位）。
- 轮询：`setInterval` 15s fetch manifest（仅比对 `generated`，变了才走 `pollDecide`）；操作后切 1s×10 快轮询；页面隐藏（`document.hidden`）暂停。
- 提示条：当前页 manifest 条目变化 → `#content` 顶部插入「⟳ 内容已更新，点击刷新」，点击 re-render 当前页。
- **全部样式用 CSS 变量**；面板/console 复用现有 `.panel`/chip 风格类。
- portal 降级：任一 POST 404/403 → 按钮置灰 + tooltip「portal 只读」。

### E · agent 消化（`commands/sync.md`）

`/lore:sync` 指引追加：plan 之前读 `.state/rewrite-requests.ndjson`，队列页**优先**进 worklist（即使指纹判 fresh 也入，reason: `user-requested`）；每重写完一页，从队列移除该条目（重写文件）。

## 测试

### `test/syncstate.test.js`
1. `writeSyncMode` → `readSyncMode` round-trip；缺文件 → `'notify'`；坏 JSON → `'notify'`。
2. `writeSyncMode('auto')` → throw（B1 枚举拒绝）；非法值 → throw。
3. `appendRewriteRequest` 去重：同页二次 append → `queued:false`、文件单条；不同页 → 两条。
4. `readRewriteRequests`：缺文件 → `[]`；坏行跳过好行保留。

### `test/server.test.js`（扩展）
5. `GET /api/sync/status`：返回 mode + last_finalize（从 fixture manifest）。
6. `POST /api/sync/mode`：合法 → 200 + sync.json 落盘；`auto` → 400；非法 → 400；非 local Host → 403。
7. `POST /api/sync/finalize`：注入 spawnFn 断言被调（detached、参数含 finalize + loreDir）；返回 `{ spawned:true }`。
8. `GET/POST /api/sync/rewrite-requests`：POST 排队 + GET 读回；非法 page 格式 → 400。
9. portal：`/<name>/api/sync/status` → 404（只读不变）。

### `test/hook.test.js`（扩展）
10. mode=manual → `maybeRefresh` 不 spawn；mode=notify → spawn；缺 sync.json → spawn（默认 notify）。

### `test/shell.test.js`（扩展）
11. `buildConsoleModel`：0 stale → light `fresh`；N stale → `stale` + stalePages 按 stale 降序；mode=manual → `off`。
12. `pollDecide`：generated 不变 → 全 false；变化且当前页条目变 → showUpdateBar true。

### 端到端验收（dogfood 手动清单）
13. 切 manual → commit → **验证 hook 未 spawn finalize**（journal 有原子但 manifest generated 不变）；切回 notify → commit → 15s 内灯变黄。
14. 点 ⟳ → 秒级「✓ 已刷新」；点 ✍ 排队 → ndjson 落盘 → 会话 `/lore:sync` 看到 user-requested 工单。
15. 三主题切换：灯 / 面板 / console 页配色全部跟随，无硬编码色残留。

## 改动清单

- 新增 `lib/syncstate.js`、`test/syncstate.test.js`
- 改 `server.js`（四端点 + spawnFn 注入）
- 改 `lib/hook.js`（maybeRefresh 读 mode 分流）
- 改 `site/index.html`（灯 + 面板 + `#console` 路由 + 轮询 + 提示条 + CSS 变量）
- 改 `site/shell.mjs`（`buildConsoleModel` + `pollDecide` 导出）
- 改 `lib/serve.js`（`--node` 旗标 → `probeRuntime` `preferNode`，让单语 repo 也能启用控制 API）
- 改 `commands/sync.md`（rewrite-requests 消化指引）
- 改 `docs/ROADMAP.md`（B1 标记；B2 范围预告）
- dogfood：`.lore/site/` 同步（index.html + shell.mjs 都要 cp）+ 手动验收清单

## 不变量 / 风险

- **零依赖**不破（Node 内置 + 复用现有模式）。
- **hook 永不挡 commit**（分流只是提前 return）。
- **portal 只读**不变（无新 write 面暴露）。
- **`.state/` 可重建**：删 sync.json → 回 notify；删 rewrite-requests → 队列清空，无损坏。
- 轮询是纯 GET，三 serve 形态兼容；`document.hidden` 暂停避免后台 tab 空转。
- 风险：双语 repo 已强制 Node server，但**单语 repo 默认 python 静态 server → 控制 API 不可用**。处理：壳探测 API 404 → 操作按钮置灰 + tooltip「需 Node server（/lore:serve 会在双语或显式 --node 时启用）」；`serve.js` 加 `--node` 旗标让单语 repo 也能选 Node。**B1 接受此降级**（dogfood repo 是双语，主路径完整）。

## 实现节奏

spec → writing-plans → plan → TDD → 审查 → 合并。B2（LLM 运行器 + auto + schedule）另起 spec。

