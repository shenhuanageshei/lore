# lore 排队/同步 与 重写/改进 分离（带指令重写）

> 2026-06-14 · 来源：用户洞察「排队跟重写应该是两个概念」。排队=stale 同步（机械、追代码），重写=质量改进（主观、该带指令）。

## 问题

当前 lore 把两个语义混成一个 `rewrite-requests` 队列 + 一套通用 prompt：

| | 排队 / 同步 | 重写 / 改进 |
|---|---|---|
| 触发 | stale / 缺图 / 缺机制档（**机械可判**） | 内容没过时，但表述/结构/角度不满意（**主观**） |
| 语义 | wiki 落后代码，追上 | wiki 没落后，提质量 |
| 该带 | 无，通用重写 | **用户的具体指令** |

三个缺口：① **fresh 页无重写入口**（徽标只在 stale/缺图/缺档出现）；② **指令传不进重写器**（队列只记 page path，runner 通用重写大概率改不到点子上）；③ 措辞「点击排队重写」把两概念绑死。且 wiki 是 facts-only 不进库、手改会被覆盖——**带指令重写是用户对 wiki 内容反馈的唯一闭环途径**，现在缺失。

## 决策

- **底层同一队列 + runner**（执行机制不变，省改动）；**上层分两个入口 + `instruction` 字段**区分意图。
- 排队/同步：现状徽标保持，措辞正名「排队同步」，无 instruction。
- 重写/改进：新增「✏️ 重写这页」入口（不限 stale，fresh 也能点）+ 可填指令 → 注入重写 prompt。
- web 输入用 `prompt()`（lore 极简壳无框架，最小实现）；不做自定义 UI、不做指令历史（YAGNI）。

## 设计

### 数据：rewrite-requests.ndjson

每行 `{ts, page, instruction?}`。`instruction` 可选——无 = 通用重写（同步语义）；有 = 带指令重写（改进语义）。向后兼容（旧 `{ts,page}` 行照常）。

### `appendRewriteRequest(stateDir, { page, instruction, now })`（lib/syncstate.js）

- **无 instruction**：同页存在则跳过（现状去重，同步意图无需重复）。
- **有 instruction**：**更新同页条目**（删旧行 + 加新行）——指令可改写，用户改主意能覆盖。
- `readRewriteRequests` 已透传整行（含 instruction），无需改。

### runner（lib/runner.js）

- `runAuto` 逐页消化时读队列项的 `instruction`，传 `backend.rewritePage({ page, repoRoot, timeoutMs, instruction })`。
- `claudeBackend.rewritePage` 的 prompt 改 `axisPrompt(page, page.instruction)`。
- `axisPrompt(page, instruction)`：有 instruction 时尾部追加一段——
  `\n\n【用户对本页的额外要求（在保持上述页面标准的前提下满足）】：${instruction}`
  无 instruction 时行为不变（通用重写）。
- 工单项需带上 instruction：queued 项从 `readRewriteRequests` 取（已含），component/stale 项无 instruction（通用）。

### server（server.js）

POST `/api/sync/rewrite-requests` 透传 `body.instruction`（字符串，截断 ~500 字符防滥用）→ `appendRewriteRequest(stateDir, { page, instruction })`。

### 壳（site/shell.mjs + index.html）

- `#meta` 区加 **「✏️ 重写这页」** 按钮（每个非 docs 页都有，不限 stale）。
- 点击 → `prompt('重写要求（留空 = 通用重写/追代码；填写 = 按你的要求改进）')` → 非 null 则 POST `{ page, instruction }`（空串也发 = 通用重写）。
- `buildMeta` 的 stale 徽标措辞正名：`落后 N commits · 点击排队同步`（同步语义）；缺图/缺机制档徽标保持「点击排队重写」（补结构也算重写动作，但本质同步——可统一为「排队」）。
- 复用现有 `button[data-queue-page]` 绑定 + 新「重写这页」按钮的指令输入。

### commands/sync.md

会话消化队列时：读每条的 `instruction`，有则按指令重写该页（在两档标准前提下满足用户要求），无则通用重写。

## 测试要点

- `appendRewriteRequest`：无指令同页去重；有指令更新同页条目（删旧加新）；instruction 持久化 + `readRewriteRequests` 读回。
- `axisPrompt(page, instruction)`：有指令注入「额外要求」段；无指令行为不变（既有断言回归）。
- `runAuto`：队列项带 instruction → 传给 backend（fake backend 断言收到 instruction）。
- server：POST 带 instruction 透传 + 截断；无 instruction 兼容。
- 壳：buildMeta stale 徽标正名「同步」；「重写这页」按钮渲染（每页）。

## 不做（YAGNI）

- 自定义指令输入 UI（`prompt()` 够）。
- 指令历史/多版本（一次性，重写完出队）。
- 指令注入的安全沙箱（重写器本就只读 Read/Grep/Glob，指令只影响 prose 走向，写盘仍过质量门）。

## 实施顺序（给 plan）

T1 syncstate 队列带 instruction（去重/更新语义）→ T2 axisPrompt + runAuto + claudeBackend 注入 instruction → T3 server 透传 → T4 壳「重写这页」按钮 + 指令输入 + stale 徽标正名 → T5 sync.md + dogfood + 全量回归。
