# lore MCP 接口层（stdio server + lore_ask/page/neighbors）—— 设计

- 日期：2026-06-07
- 状态：设计已批，待写实施计划
- 前置：graph 数据层已并入 main（`wiki/.graph.json`）、`lib/manifest.js`（`searchPages` 在 `lib/ask.js`）、`lib/graph.js`（`buildGraph`）
- 北极星：**agent 友好 wiki + graph** —— 子项 2：让 agent **可调用地**用上子项 1 建的图

## 背景 / 问题

子项 1（graph 数据层）已交付 `.graph.json`（节点+边），但 agent **还用不上**：消费仍是 slash command（`/lore:ask` 手动调 `ask.js` 打印候选 → agent 手动读页）。本设计把消费变成**程序化 MCP tool**，agent 自动 tool call：**搜 → 读 → 顺决策图谱推理**，兑现 graph 数据的价值。

## 目标 / 非目标

**目标**：零依赖 stdio MCP server（`lib/mcp.js`）+ 3 工具，注册进插件：
- `lore_ask(query)` 检索页、`lore_page(id)` 取页正文、`lore_neighbors(id)` 取图邻居。
- id 统一用 graph node id（`page:<axis>/<id>`），三 tool 可串联。

**非目标（YAGNI / 后续）**：
- `lore_stale` / 任何写工具 / 触发 sync —— **只读消费**。
- 多跳遍历 —— `lore_neighbors` 只 1-hop，agent 迭代调。
- 多 repo 聚合 —— 单 repo `cwd/.lore`。
- 官方 MCP SDK —— 破零依赖，**手写 stdio JSON-RPC**。

## 决策（已锁）

| 项 | 决策 |
|---|---|
| 实现 | 手写 stdio JSON-RPC 2.0（零依赖锁定，无 SDK） |
| transport | newline-delimited JSON（MCP stdio：每行一个 message） |
| 工具集 | `lore_ask` / `lore_page` / `lore_neighbors`（只读三件套） |
| id 语义 | 统一 graph node id（`page:<axis>/<id>`、`commit:<sha>`…），跨 tool 串联 |
| 数据新鲜度 | **每次 tool call 现读** `.manifest.json` / `.graph.json`（不缓存） |
| repo 定位 | server cwd = 项目根 → `cwd/.lore/wiki/*` |
| 注册 | `.claude-plugin/plugin.json` 的 `mcpServers` |
| 纯函数边界 | 工具逻辑（neighbors/resolvePagePath/searchPages）纯函数；`mcp.js` 只做协议壳 + IO |

## 设计

### A · 纯查询函数（`lib/graph.js` 追加）

```
export function neighbors(graph, nodeId) → [{ id, type, title, edge, dir }]
export function resolvePagePath(graph, id) → string | null
```

- `neighbors`：`edges.filter(e=>e.from===nodeId)` → dir `"out"`、`edges.filter(e=>e.to===nodeId)` → dir `"in"`；邻居的 `type`/`title` 从 `graph.nodes` 查（查不到则 type/title 给空串）。`edge` = 边 type。
- `resolvePagePath`：`id` 以 `"page:"` 开头 → 在 `graph.nodes` 找 `node.id===id` 取 `node.path`（无则 `null`）；否则把 `id` 当 wiki 相对 path 原样返回。

### B · 工具逻辑（`lib/mcp.js` 内，每个读最新数据）

`loreDir = join(cwd, '.lore')`，`wikiDir = join(loreDir, 'wiki')`。每 call：

- `lore_ask({query})`：读 `.manifest.json` → `searchPages(manifest, query)` → 映射成 `[{ id:'page:'+axis+'/'+pageId, title, axis, score }]`。
- `lore_page({id})`：读 `.graph.json` → `resolvePagePath(graph, id)` → 读 `wiki/<path>` → `{ id, path, content }`；path 解析不到或文件不存在 → tool error。
- `lore_neighbors({id})`：读 `.graph.json` → `neighbors(graph, id)` → `{ id, neighbors }`。

`.manifest.json` / `.graph.json` 缺失 → tool error「先跑 /lore:sync」。

### C · 协议壳（`lib/mcp.js`）

逐行读 stdin（`readline`），每行 parse JSON-RPC，dispatch：

- `initialize` → `result: { protocolVersion: <params.protocolVersion ?? "2024-11-05">, capabilities: { tools: {} }, serverInfo: { name:"lore", version } }`。
- `notifications/initialized`（无 id 的 notification）→ 忽略，不回。
- `tools/list` → `result: { tools: [ {name, description, inputSchema:{type:"object", properties, required}} ×3 ] }`。
- `tools/call` → 调对应工具逻辑 → `result: { content:[{ type:"text", text: JSON.stringify(payload) }] }`；工具抛错 → `result: { content:[{type:"text", text:<msg>}], isError:true }`。
- 未知 method → `error: { code:-32601, message:"method not found" }`。
- 每条 response：`process.stdout.write(JSON.stringify(msg) + '\n')`。

version 从 `package.json` 读（best-effort，失败给 `"0"`）。

### D · 注册（`.claude-plugin/plugin.json`）

```json
"mcpServers": { "lore": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/lib/mcp.js"] } }
```

### E · 不变量

零依赖（手写 JSON-RPC）、只读（不碰 `.lore`）、每 call 读最新、缺数据友好 error（不崩溃）、纯函数可测。

## 测试

### `test/graph.test.js`（追加纯函数）
1. `neighbors`：out 边（`from===id`）+ in 边（`to===id`）各自带 `dir`；邻居 `type`/`title` 取自节点；`edge` = 边类型。
2. `neighbors`：未知 nodeId → `[]`。
3. `resolvePagePath`：`page:` id → 对应 `path`；非 `page:` id → 原样当 path；`page:` 但无此节点 → `null`。

### `test/mcp.test.js`（集成，spawn server）
4. `spawn('node', ['lib/mcp.js'], {cwd: <fixture repo>})`，写入：
   - `initialize` → 断言 `result.serverInfo.name==='lore'`、`result.capabilities.tools`。
   - `tools/list` → 断言 3 个 tool 名 + 各有 `inputSchema`。
   - `tools/call lore_ask {query}` → 断言 `content[0].text` 解析出候选页（含 `page:` id）。
   - `tools/call lore_page {id}` → 断言返回 `content`（页正文）。
   - `tools/call lore_neighbors {id}` → 断言 `content` 含 neighbors 数组。
   - fixture：临时 git repo + `mine` + `sync`（生成 `.manifest.json`+`.graph.json`）。

## 改动清单
- 新增 `lib/mcp.js`（协议壳 + 工具逻辑）
- 改 `lib/graph.js`（追加 `neighbors` + `resolvePagePath`）
- 改 `.claude-plugin/plugin.json`（`mcpServers`）
- 改 `test/graph.test.js`（neighbors/resolvePagePath 单测）+ 新增 `test/mcp.test.js`（集成）
- `lib/ask.js`（`searchPages`）复用不改
