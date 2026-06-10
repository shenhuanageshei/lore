---
title: lore agent graph 数据层（buildGraph + .graph.json）—— 设计
summary: - 日期：2026-06-06 - 状态：设计已批，待写实施计划 - 前置：fold 已合并（PR #5 → 主线，folded atoms 可用）、`lib/manifest.js`（节点表 + translations 边）、`lib/journal.js` - 北极星：**agent 友好 wiki + graph**（本轮兑现缺失的 agent 端第一步）
source_path: docs/superpowers/specs/2026-06-06-lore-agent-graph-design.md
last_updated: 2026-06-06
group: 设计与计划
paired_plan: superpowers-plans-2026-06-06-lore-agent-graph
---
> 源文档：`docs/superpowers/specs/2026-06-06-lore-agent-graph-design.md`

# lore agent graph 数据层（buildGraph + .graph.json）—— 设计

- 日期：2026-06-06
- 状态：设计已批，待写实施计划
- 前置：fold 已合并（PR #5 → 主线，folded atoms 可用）、`lib/manifest.js`（节点表 + translations 边）、`lib/journal.js`
- 北极星：**agent 友好 wiki + graph**（本轮兑现缺失的 agent 端第一步）

## 背景 / 问题

北极星两端，人读端已 v0.2→v0.5 四连更，**agent 端（机器可遍历 graph + MCP）至今为 0**。现状：

- `manifest.json` 是**节点表**（按轴的页列表），唯一的「边」是 `translations[]`。
- 没有 facet 边（原子↔组件/流/主题）、refs 边（决策链）——agent 无法顺图谱推理，只能逐页读。

本设计做 agent 端的**数据基础**：把 journal 原子 + wiki 页表达成节点 + 边的图，落盘供消费。

## 目标 / 非目标

**目标**：纯函数 `buildGraph(atoms, manifest) → { nodes, edges }`，`sync` 落盘 `wiki/.graph.json`：
- 节点：journal 原子（commit/decision）+ wiki 页（component/theme/flow/docs/HOME）。
- 边：`facet`（原子→component/flow/theme 页）、`refs_related`（原子→原子，决策链）。

**非目标（YAGNI / 后续子项）**：
- **MCP 接口层**（`lore_ask`/`lore_page`/`lore_stale`）——子项 2，独立 spec，消费本层的 `.graph.json`。
- `wikilink` 边（需解析页正文）、`translation_of` 边（i18n，manifest 已有数据）——后续增强，接缝已留。
- graph 查询/遍历 API、serve 壳画图谱。

## 决策（已锁）

| 项 | 决策 |
|---|---|
| 落地 | `buildGraph` 纯函数 + `sync` 落盘 `wiki/.graph.json`（对称 manifest） |
| 节点粒度 | 原子级：journal 原子 + wiki 页（决策图谱） |
| 第一版边 | `facet` + `refs_related`（均来自 atom 结构化字段，无需解析正文） |
| 节点 id | 原子 = `atom.id`；页 = `page:<axis>/<id>` |
| 悬挂边 | 目标节点不存在 → 丢弃（图只连真实节点） |
| 原子来源 | `finalizeSync` 的 **folded** atoms（无孤儿/已合并） |
| INDEX 轴 | 跳过（TOC，非内容节点，同 `ask.js`） |
| 纯函数边界 | `buildGraph` 无 IO；manifest 对象注入 |

## 设计

### A · `lib/graph.js`（新，纯函数）

```
export function buildGraph(atoms, manifest, now) → { generated, nodes, edges }
```

- **页节点**：遍历 `manifest.axes`（跳过 `id === 'INDEX'`），每页 → `{ id: 'page:<axis>/<pageId>', type:'page', axis, title, path }`；建 `pageIds: Set` 记录存在的 `page:<axis>/<id>`。
- **原子节点**：每 atom → `{ id: atom.id, type:'atom', kind: atom.kind, title: atom.title, ts: atom.ts }`；建 `atomIds: Set`。
- **facet 边**：每 atom，对 `axis ∈ {component, flow, theme}`、每 `v ∈ (atom.facets?.[axis] ?? [])`，目标 `page:<axis>/<v>`；**仅当 ∈ pageIds** → `{ from: atom.id, to, type:'facet' }`。
- **refs_related 边**：每 atom，每 `rid ∈ (atom.refs?.related ?? [])`；**仅当 ∈ atomIds** → `{ from: atom.id, to: rid, type:'refs_related' }`。
- `generated = now`（调用方传入；`Date.now` 不在纯函数里）。

纯函数、无 IO、确定性（节点/边按输入顺序生成）。

### B · schema（`wiki/.graph.json`）

```json
{
  "generated": "<iso>",
  "nodes": [
    { "id": "commit:<sha>", "type": "atom", "kind": "commit", "title": "…", "ts": "…" },
    { "id": "page:component/lib", "type": "page", "axis": "component", "title": "Lib", "path": "component/lib.md" }
  ],
  "edges": [
    { "from": "commit:<sha>", "to": "page:component/lib", "type": "facet" },
    { "from": "commit:<sha>", "to": "decision:<x>", "type": "refs_related" }
  ]
}
```

### C · 生成接缝（`lib/manifest.js` + `lib/sync.js`）

- `runManifestCli` 现返回 `manifestPath`（string）。改为返回 `{ manifestPath, manifest }`（manifest 即 `emitManifest` 结果对象），避免 graph 重复读盘。
- `finalizeSync`：
  - 取 `const { manifestPath, manifest } = runManifestCli(...)`（对外返回的 `manifestPath` 不变）。
  - manifest 之后落盘：`writeFileSync(join(wikiDir, '.graph.json'), JSON.stringify(buildGraph(allAtoms, manifest, now), null, 2) + '\n')`。
  - `allAtoms` 已 folded → graph 节点天然干净。
  - import `buildGraph`。

### D · 不变量

- 纯函数、零依赖、folded atoms、悬挂边过滤、`.graph.json` git 跟踪（对称 manifest，sync 产物）。
- 不改 manifest schema（`runManifestCli` 返回值内部扩展，`finalizeSync` 对外接口不变）。

## 测试

### `test/graph.test.js`（纯函数，无 git）
1. 空 atoms + 空 manifest（`{axes:[]}`）→ `{ nodes:[], edges:[] }`。
2. 页节点：manifest 含 `component/lib` + `docs/x` + `INDEX/INDEX` → 两个 page 节点（lib、x），**INDEX 轴跳过**。
3. 原子节点：commit + decision atom → 两 atom 节点（type/kind/title/ts 正确）。
4. facet 边：`facets.component=['lib']` + 存在 `page:component/lib` → facet 边；`facets.component=['ghost']`（无页）→ 无边（悬挂过滤）。
5. refs_related 边：`refs.related=['commit:y']` + `commit:y` 原子存在 → 边；`related=['commit:gone']`（无原子）→ 过滤。
6. 多轴 facet：`facets.flow=['pipe']` + `facets.theme=['quality']`，对应页存在 → 各自一条 facet 边。

### `test/sync.test.js`（集成，临时 git repo）
7. 仿现有 fixture（config component `lib` + commit lib 改动 + `mine` + `finalize`）→ 读 `wiki/.graph.json`：含 `page:component/lib` 节点 + 该 commit 的原子节点 + 二者间 `facet` 边。

## 改动清单
- 新增 `lib/graph.js`、`test/graph.test.js`
- 改 `lib/manifest.js`（`runManifestCli` 返回 `{ manifestPath, manifest }`）
- 改 `lib/sync.js`（import `buildGraph` + `finalizeSync` 落盘 `.graph.json` + 解构 `manifestPath`）
- 改 `test/sync.test.js`（集成用例 7；若有断言 `runManifestCli` 返回 string 的测试，更新为 `.manifestPath`）
- `lib/journal.js` 不动

