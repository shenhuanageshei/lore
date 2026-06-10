---
title: /lore:note — agent 决策捕获（§4②，MVP）
summary: > 设计文档 · 2026-06-03 · 子项目 **/lore:note v1（新 decision 原子）** · brainstorm 收敛，待转计划 > 母 spec §4②。前置：journal 基座 + sync 折叠（`renderDecisionHistory` 已合并）。
source_path: docs/superpowers/specs/2026-06-03-lore-note-design.md
last_updated: 2026-06-03
group: 设计与计划
paired_plan: superpowers-plans-2026-06-03-lore-note
---
> 源文档：`docs/superpowers/specs/2026-06-03-lore-note-design.md`

# /lore:note — agent 决策捕获（§4②，MVP）

> 设计文档 · 2026-06-03 · 子项目 **/lore:note v1（新 decision 原子）** · brainstorm 收敛，待转计划
> 母 spec §4②。前置：journal 基座 + sync 折叠（`renderDecisionHistory` 已合并）。

## 0. 背景
§4② 第二捕获源：agent/人在**决策当下**记「选 X 弃 Y 因为 Z」→ decision 原子（why + agent 据意图标的语义 facets）。补齐捕获三源（hook 机械骨架 · mine bootstrap · **note 人工 why**）。

## 1. 范围（MVP，用户拍板 A）
- `lib/note.js`：`noteAtom(...)`（纯）+ CLI（结构化 flags → appendAtom）。
- `commands/lore-note.md`：agent 编排（解析决策文本、据意图标 facets、调 note.js）。
- 小改 `lib/sync.js` `renderDecisionHistory`：无 `commit` 的原子（note/decision）渲染省 sha。
**推迟**：enrich 已有骨架（同 id append + journal fold-by-id + 消费者 fold）· Stop-hook flush 提醒 · resident 规则 · 自动 facet 推断（agent 自己标，非引擎）。

## 2. note atom（decision kind）
```jsonc
{ "id": "note:<unique>", "ts": "<now ISO>", "kind": "decision", "commit": null,
  "title": "...", "why": "...", "what_changed": "",
  "facets": { "component": [...], "flow": [...], "theme": [...] },
  "refs": { "files": [...], "pitfall": null, "related": [] },
  "source": "agent", "enriched": true, "confidence": "EXTRACTED" }
```
`noteAtom({ id, ts, title, why, component=[], flow=[], theme=[], files=[] })` 纯函数（接 id+ts 可测）。id 唯一：CLI 生成 `note:${Date.now().toString(36)}${random}`（CLI 用 Date/random 合法）。

## 3. CLI
`node lib/note.js <repoRoot> --title "..." --why "..." [--component lib] [--flow x] [--theme y] [--files a,b]`
- 零依赖手写 arg 解析（`--k v`）。逗号列表 → 数组。
- `journalDir = <repoRoot>/.lore/journal`；`noteAtom` → `appendAtom`；打印 `✓ noted decision atom <id>`。

## 4. 命令 /lore:note
agent 编排：`/lore:note "选 ZSET 弃 SET 因为 O(logN) 范围查"` → agent 解析 title（决策摘要）/why（理由）、据 intent + config 选 component（哪个组件的决策）/flow/theme、调 note.js。提示：决策当下即记，别攒；component 必标（否则不进任何组件页）。

## 5. renderDecisionHistory 小改
```
const meta = a.commit ? `(${sha}, ${date})` : `(${date})`;
```
decision 原子（commit:null）渲 `- **<title>** — <why> (<date>)`（省 sha）。commit 原子不变。

## 6. 测试（确定性 node:test）
- `noteAtom`：全 schema（kind=decision, source=agent, enriched=true, commit=null, facets/refs 对）。
- CLI：`node lib/note.js <tmpRepo> --title T --why W --component lib --flow f --theme t --files a,b` → journal 有该 decision 原子（facets/refs 对）；缺 flag → 空数组/空串。
- `renderDecisionHistory`：decision 原子（commit:null）→ `(date)` 无 sha；混 commit+decision 原子 ts 倒序正确。
- 集成：`node lib/note.js` 写 note 原子 → sync `finalizeSync` 把它折进对应 component 页决策历史（component facet 过滤命中）。
- 全套绿（renderDecisionHistory 改不回归 commit 原子渲染）。

## 7. 验收
1. /lore:note 产 decision 原子（why + facets，source=agent）。
2. component facet 命中 → 该组件页决策历史显该 decision（sync 折叠）。
3. 渲染：decision 原子 `(date)` 无 sha；commit 原子 `(sha, date)` 不变。
4. 零依赖零侵入：只写 `.lore/journal/`；纯确定性 runtime（agent 做语义部分）。

## 8. 不在范围
enrich 已有骨架 + fold-by-id · Stop-hook flush · resident 规则 · 引擎自动推断 facet（agent 标）· note 编辑/删除（append-only）。

## 9. 开放问题
- **id 碰撞**：`Date.now()+random` 极低碰撞；同 ms 多 note 靠 random 后缀区分。
- **多行 why**：CLI 接单串；renderDecisionHistory 已取首行。完整 why 存原子，点进可看。

