---
title: flow 轴端到端（§4，对称 theme）
summary: > 设计文档 · 2026-06-03 · 子项目 **flow 轴 v1** · 母 spec §4（flow facet：component-成员 ∈ spans）+ §5（多轴合成）。前置：theme 轴已铺好多轴泛化（`SYNC_AXES` / `buildIndex` 对象形 / `facets[axis]` 过滤）。lore 第三轴，完成 component+theme+flow...
source_path: docs/superpowers/specs/2026-06-03-lore-flow-design.md
last_updated: 2026-06-03
group: 设计与计划
paired_plan: superpowers-plans-2026-06-03-lore-flow
---
> 源文档：`docs/superpowers/specs/2026-06-03-lore-flow-design.md`

# flow 轴端到端（§4，对称 theme）

> 设计文档 · 2026-06-03 · 子项目 **flow 轴 v1** · 母 spec §4（flow facet：component-成员 ∈ spans）+ §5（多轴合成）。前置：theme 轴已铺好多轴泛化（`SYNC_AXES` / `buildIndex` 对象形 / `facets[axis]` 过滤）。lore 第三轴，完成 component+theme+flow 三轴。

## 0. 背景
flow = **声明轴「数据怎么端到端跑」**（article-pipeline、dedup…）。一条 flow 由 `spans:` 列它跨的组件；原子的 component ∈ 某 flow 的 spans → 该原子属那条 flow。与 theme（关键词 match）不同模型——flow 靠 **component-成员**。

## 1. 范围
- 扩 `lib/config.js`：`parseConfigFlows`（id + spans）。
- 扩 `lib/mine.js`：`tagFlows`（纯，component-成员）+ `commitAtom` 加 `flows` 参 → `facets.flow`。
- `mineCommits`/`mine`/CLI + `captureHead` 读 config flows 传。
- 扩 `lib/sync.js`：`planSync` 加 flow worklist；`SYNC_AXES += 'flow'`（`finalizeSync`/`buildIndex` 已泛化 → 自动产 flow 页）。
- 改 `commands/lore-sync.md`：agent 写 flow 页。
**推迟**：regex/glob spans · flow `desc` 渲染 · note 自动 flow 推断。

## 2. config flow 解析
`parseConfigFlows(configText) -> [{id, spans:[...]}]`：扫 `- { ... }` 行含 `spans:`（flow 项；theme 用 `match:` 区分），抽 `id` + `spans` 数组（字段序无关、去引号）；注释行跳过 → init 默认（示例注释）→ `[]`。

## 3. flow 打标（层2，纯）
`tagFlows(components, flows) -> string[]`：`components` = atom 的 component facet 数组；某 flow 的 `spans` 与 `components` 交集非空 → 收该 `flow.id`；去重排序。

## 4. producer 打标
`commitAtom(raw, codeRoots, source='miner:commits', themes=[], flows=[])` 加第 5 参 → 先算 `component`，`facets.flow = tagFlows(component, flows)`（其余不变；默认 flows=[] → flow:[] 同现在，旧调用不回归）。
- `mineCommits(repoRoot, codeRoots, themes, flows)` / `mine({...flows})` / mine CLI 读 `parseConfigFlows` 传。
- `captureHead({...flows})` / hook CLI 同。

## 5. sync
- `planSync`：worklist 加 flow 项（每 config flow.id 一页 `flow/<id>.md`，`{axis:'flow', id, path, priorExists}`）；返回加 `flows`。
- `finalizeSync`：`SYNC_AXES = ['component','theme','flow']`（其余不变，按轴循环 + `facets?.[axis]?.includes(id)` 已泛化）。`buildIndex` 已列 `flow` → 自动出 `## Flow` 段。manifest `AXIS_ORDER` 含 flow → serve 自动收。

## 6. 命令改（`commands/lore-sync.md`）
合成步骤：agent 对每个 `axis:'flow'` worklist 项写 `flow/<id>.md`，讲「这条数据流端到端怎么跑」（入口→各阶段→出口）+ `{{LORE_JOURNAL}}` token（finalize 折该 flow 标的原子）。

## 7. 测试（确定性 node:test）
- `parseConfigFlows`：注释→[]；取消注释多项（字段序无关）；theme 项（match 无 spans）不误收。
- `tagFlows`：component ∩ spans 非空→标；多 flow；无交集→[]；不改入参。
- `commitAtom`：flows 参 → facets.flow（默认[]）；旧 ≤4 参调用不回归。
- `mineCommits`/`captureHead`：临时 repo + config flow（spans 含某 code_root）+ commit 碰该 root → 原子 facets.flow 含该 id。
- `planSync`：worklist 含 flow 项（axis:'flow'）+ 返回 flows。
- `finalizeSync`：写 flow/ token 页 + journal 有 flow 标原子 → flow 页折对；INDEX 含 `## Flow`。
- 集成：init→config 填 flow(spans:[lib])→commit 碰 lib→mine→sync finalize（手放 flow token 页）→flow 页含该 commit。
- 全套绿（component/theme 不回归）。

## 8. 验收
1. config flow spans → commit 原子 `facets.flow` 自动打标（component-成员，mine+hook）。
2. sync 产 `flow/<id>.md` 折该 flow 原子；INDEX/manifest/serve 含 flow 轴 → **lore 三轴齐**。
3. component/theme 不回归。
4. 零依赖。

## 9. 不在范围
regex/glob spans · flow desc · note 自动 flow · 增量。

## 10. 开放问题
- **commitAtom 5 位参**：themes/flows 都位置参（对称、向后兼容）。未来可重构成 axes 对象，但本版保最小 churn。

