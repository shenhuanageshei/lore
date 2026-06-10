---
title: lore MCP 接口层 Implementation Plan
summary: > **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [...
source_path: docs/superpowers/plans/2026-06-07-lore-mcp-server.md
last_updated: 2026-06-07
group: 设计与计划
---
> 源文档：`docs/superpowers/plans/2026-06-07-lore-mcp-server.md`

# lore MCP 接口层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 零依赖 stdio MCP server，3 个只读工具（`lore_ask`/`lore_page`/`lore_neighbors`）让 agent 程序化「搜→读→顺图谱」。

**Architecture:** `lib/graph.js` 追加纯查询函数 `neighbors`/`resolvePagePath`；`lib/mcp.js` 手写 newline-delimited JSON-RPC 2.0 over stdio（initialize/tools.list/tools.call），工具逻辑复用 `searchPages` + graph 查询，每 call 现读 `cwd/.lore/wiki/{.manifest.json,.graph.json}`；`plugin.json` 注册 mcpServers。

**Tech Stack:** Node.js (ESM) · `node:readline` + `node:child_process` · `node:test` · 零依赖。

**前置 spec:** `docs/superpowers/specs/2026-06-07-lore-mcp-server-design.md`

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `lib/graph.js` | 追加 `neighbors(graph,nodeId)` + `resolvePagePath(graph,id)` | 改 |
| `lib/mcp.js` | stdio JSON-RPC server + 工具 dispatch | 新建 |
| `test/graph.test.js` | neighbors/resolvePagePath 单测 | 改 |
| `test/mcp.test.js` | spawn server 集成测试 | 新建 |
| `.claude-plugin/plugin.json` | 加 `mcpServers` | 改 |

---

## Task 1: graph 查询纯函数 `neighbors` + `resolvePagePath`

**Files:**
- Modify: `lib/graph.js`
- Test: `test/graph.test.js`

- [ ] **Step 1: 写失败测试**

`test/graph.test.js` 顶部把 `import { buildGraph } from '../lib/graph.js';` 改为：
```js
import { buildGraph, neighbors, resolvePagePath } from '../lib/graph.js';
```

把以下 test 追加到 `test/graph.test.js` 末尾：
```js
test('neighbors: out+in edges, dir + edge type, type/title from node', () => {
  const graph = {
    nodes: [
      { id: 'commit:x', type: 'atom', kind: 'commit', title: 'feat: x', ts: '' },
      { id: 'commit:y', type: 'atom', kind: 'commit', title: 'feat: y', ts: '' },
      { id: 'page:component/lib', type: 'page', axis: 'component', title: 'Lib', path: 'component/lib.md' },
    ],
    edges: [
      { from: 'commit:x', to: 'page:component/lib', type: 'facet' },
      { from: 'commit:x', to: 'commit:y', type: 'refs_related' },
      { from: 'commit:y', to: 'commit:x', type: 'refs_related' },
    ],
  };
  const nb = neighbors(graph, 'commit:x');
  assert.equal(nb.length, 3);
  assert.ok(nb.some(n => n.id === 'page:component/lib' && n.edge === 'facet' && n.dir === 'out' && n.type === 'page' && n.title === 'Lib'));
  assert.ok(nb.some(n => n.id === 'commit:y' && n.edge === 'refs_related' && n.dir === 'out'));
  assert.ok(nb.some(n => n.id === 'commit:y' && n.edge === 'refs_related' && n.dir === 'in'));
});

test('neighbors: unknown node → []', () => {
  assert.deepEqual(neighbors({ nodes: [], edges: [] }, 'nope'), []);
});

test('resolvePagePath: page id → path; plain path passthrough; unknown page id → null', () => {
  const graph = { nodes: [{ id: 'page:component/lib', type: 'page', path: 'component/lib.md' }], edges: [] };
  assert.equal(resolvePagePath(graph, 'page:component/lib'), 'component/lib.md');
  assert.equal(resolvePagePath(graph, 'component/lib.md'), 'component/lib.md');
  assert.equal(resolvePagePath(graph, 'page:component/ghost'), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/graph.test.js`
Expected: FAIL — `neighbors`/`resolvePagePath` 未 export（`undefined is not a function` 或 import 报错）。

- [ ] **Step 3: 写实现**

在 `lib/graph.js` 末尾追加：
```js
// 某节点的 1-hop 邻居：from===id 为 out 边，to===id 为 in 边。
export function neighbors(graph, nodeId) {
  const byId = new Map((graph.nodes ?? []).map(n => [n.id, n]));
  const out = [];
  for (const e of (graph.edges ?? [])) {
    if (e.from === nodeId) {
      const n = byId.get(e.to);
      out.push({ id: e.to, type: n?.type ?? '', title: n?.title ?? '', edge: e.type, dir: 'out' });
    } else if (e.to === nodeId) {
      const n = byId.get(e.from);
      out.push({ id: e.from, type: n?.type ?? '', title: n?.title ?? '', edge: e.type, dir: 'in' });
    }
  }
  return out;
}

// page node id（page:<axis>/<id>）→ wiki 相对 path；非 page: 前缀 → 原样当 path；未知 page id → null。
export function resolvePagePath(graph, id) {
  if (typeof id === 'string' && id.startsWith('page:')) {
    const n = (graph.nodes ?? []).find(x => x.id === id);
    return n ? n.path : null;
  }
  return id;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/graph.test.js`
Expected: PASS（原 6 + 新 3 = 9 tests）。

- [ ] **Step 5: Commit**

```bash
git add lib/graph.js test/graph.test.js
git commit -m "feat(graph): neighbors + resolvePagePath query helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `lib/mcp.js` stdio JSON-RPC server

**Files:**
- Create: `lib/mcp.js`
- Test: `test/mcp.test.js`

- [ ] **Step 1: 写失败集成测试**

Create `test/mcp.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), 'lore-mcp-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  const lore = join(root, '.lore');
  mkdirSync(lore, { recursive: true });
  writeFileSync(join(lore, 'config.yml'), 'axes:\n  component:\n    code_roots: [lib]\n');
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'lib', 'feature.js'), 'export const x = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'feat: thing'], { cwd: root });
  execFileSync('node', ['lib/mine.js', root], { cwd: process.cwd() });
  const compDir = join(lore, 'wiki', 'component');
  mkdirSync(compDir, { recursive: true });
  writeFileSync(join(compDir, 'lib.md'),
    '---\ntitle: Lib\nsummary: core thing\n---\n# component: lib\n\n## Decision history\n\n{{LORE_JOURNAL}}\n');
  execFileSync('node', ['lib/sync.js', 'finalize', lore], { cwd: process.cwd() });
  return root;
}

// 把多条 JSON-RPC 消息喂给 server（newline-delimited），收集所有回复行。
function rpc(root, messages) {
  return new Promise((resolve, reject) => {
    const srv = spawn('node', [join(process.cwd(), 'lib', 'mcp.js')], { cwd: root });
    let out = '';
    srv.stdout.on('data', d => { out += d.toString(); });
    srv.stderr.on('data', () => {});
    srv.on('error', reject);
    srv.on('close', () => {
      try { resolve(out.split('\n').filter(Boolean).map(l => JSON.parse(l))); }
      catch (e) { reject(e); }
    });
    for (const m of messages) srv.stdin.write(JSON.stringify(m) + '\n');
    srv.stdin.end();
  });
}

test('mcp: initialize + tools/list + ask + neighbors', async () => {
  const root = setupRepo();
  try {
    const replies = await rpc(root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lore_ask', arguments: { query: 'core' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'lore_neighbors', arguments: { id: 'page:component/lib' } } },
    ]);
    const byId = new Map(replies.map(r => [r.id, r]));
    assert.equal(byId.get(1).result.serverInfo.name, 'lore');
    assert.ok(byId.get(1).result.capabilities.tools);
    const names = byId.get(2).result.tools.map(t => t.name).sort();
    assert.deepEqual(names, ['lore_ask', 'lore_neighbors', 'lore_page']);
    assert.ok(byId.get(2).result.tools.every(t => t.inputSchema && t.inputSchema.type === 'object'));
    const ask = JSON.parse(byId.get(3).result.content[0].text);
    assert.ok(ask.some(h => h.id === 'page:component/lib'));
    const nb = JSON.parse(byId.get(4).result.content[0].text);
    assert.equal(nb.id, 'page:component/lib');
    assert.ok(Array.isArray(nb.neighbors));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mcp: lore_page returns content; unknown tool → isError', async () => {
  const root = setupRepo();
  try {
    const replies = await rpc(root, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lore_page', arguments: { id: 'page:component/lib' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lore_bogus', arguments: {} } },
    ]);
    const byId = new Map(replies.map(r => [r.id, r]));
    const page = JSON.parse(byId.get(1).result.content[0].text);
    assert.equal(page.path, 'component/lib.md');
    assert.match(page.content, /component: lib/);
    assert.equal(byId.get(2).result.isError, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/mcp.test.js`
Expected: FAIL — `lib/mcp.js` 不存在，spawn 的 server 立即退出、无回复行，`rpc` resolve 空数组 → `byId.get(1)` undefined。

- [ ] **Step 3: 写实现**

Create `lib/mcp.js`:
```js
// 零依赖 stdio MCP server。newline-delimited JSON-RPC 2.0。
// 工具 lore_ask/lore_page/lore_neighbors，消费 cwd/.lore/wiki/{.manifest.json,.graph.json}（每 call 现读）。
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { searchPages } from './ask.js';
import { neighbors, resolvePagePath } from './graph.js';

const wikiDir = join(process.cwd(), '.lore', 'wiki');

function readJson(name) {
  const p = join(wikiDir, name);
  if (!existsSync(p)) throw new Error(`${name} not found — run /lore:sync first`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

const VERSION = (() => {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(p, 'utf8')).version ?? '0';
  } catch { return '0'; }
})();

const TOOLS = [
  { name: 'lore_ask', description: '检索 lore wiki 页（query 命中 title+summary），返回候选 [{id,title,axis,score}]',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'lore_page', description: '取某页正文。id = graph page node id（page:<axis>/<id>）或 wiki 相对 path',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'lore_neighbors', description: '取某节点 1-hop 图邻居（facet/refs_related 边）',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];

function callTool(name, args) {
  if (name === 'lore_ask') {
    const hits = searchPages(readJson('.manifest.json'), args.query ?? '');
    return hits.map(h => ({ id: `page:${h.axis}/${h.id}`, title: h.title, axis: h.axis, score: h.score }));
  }
  if (name === 'lore_page') {
    const path = resolvePagePath(readJson('.graph.json'), args.id ?? '');
    if (!path) throw new Error(`unknown page id: ${args.id}`);
    const abs = join(wikiDir, path);
    if (!existsSync(abs)) throw new Error(`page file not found: ${path}`);
    return { id: args.id, path, content: readFileSync(abs, 'utf8') };
  }
  if (name === 'lore_neighbors') {
    return { id: args.id, neighbors: neighbors(readJson('.graph.json'), args.id ?? '') };
  }
  throw new Error(`unknown tool: ${name}`);
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'lore', version: VERSION },
    } };
  }
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    try {
      const payload = callTool(params?.name, params?.arguments ?? {});
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e?.message ?? e) }], isError: true } };
    }
  }
  if (id === undefined) return null;                       // 未知 notification
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }          // 忽略坏行
  const reply = handle(msg);
  if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
});
// stdin EOF → readline 'close' → event loop 空 → 进程自然退出（Node 退出时 flush stdout）。
// 不用 process.exit(0)：会截断未 drain 的 stdout pipe，集成测试可能丢最后一条回复。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/mcp.test.js`
Expected: PASS（2 tests）。

- [ ] **Step 5: Commit**

```bash
git add lib/mcp.js test/mcp.test.js
git commit -m "feat(mcp): zero-dep stdio MCP server — lore_ask/page/neighbors

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: 插件注册 `mcpServers`

**Files:**
- Modify: `.claude-plugin/plugin.json`

- [ ] **Step 1: 改 plugin.json**

把 `.claude-plugin/plugin.json` 整体替换为（在现有字段基础上加 `mcpServers`）：
```json
{
  "name": "lore",
  "version": "0.1.0",
  "description": "Repo living-docs / decision-history framework — capture (hook/mine/note) → synthesize (3-axis wiki) → consume (ask/serve)",
  "author": { "name": "lore" },
  "mcpServers": {
    "lore": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/lib/mcp.js"] }
  }
}
```

- [ ] **Step 2: 验证 JSON 有效 + 全量回归**

Run: `node -e "JSON.parse(require('node:fs').readFileSync('.claude-plugin/plugin.json','utf8')).mcpServers.lore.args[0]" && echo OK`
Expected: 打印 `OK`（JSON 合法、`mcpServers.lore.args` 可达）。

Run: `node --test`
Expected: 全量 PASS、0 fail。

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/plugin.json
git commit -m "feat(plugin): register lore MCP server (mcpServers)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: 冒烟 + 收尾（非 TDD）

**Files:** 无（验证）

- [ ] **Step 1: 真实冒烟（本 repo 已有 `.manifest.json` + `.graph.json`）**

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"lore_ask","arguments":{"query":"graph"}}}' | node lib/mcp.js
```
Expected: 两行 JSON-RPC 回复；id=1 含 `serverInfo.name":"lore"`；id=2 的 `content[0].text` 是候选页 JSON（含 `page:` id）。

- [ ] **Step 2: 全量绿**

Run: `node --test`
Expected: 全量 PASS。

---

## Spec 覆盖核对（self-review 映射）

| spec 决策 | 落地于 |
|---|---|
| 手写 stdio JSON-RPC、newline-delimited | Task 2（mcp.js `readline` + `JSON.stringify+'\n'`） |
| 三工具 lore_ask/page/neighbors | Task 2 `TOOLS` + `callTool` |
| id 统一 graph node id，可串联 | Task 1 `resolvePagePath` + Task 2 `lore_ask` 映射 `page:<axis>/<id>` |
| 每 call 现读 manifest/graph | Task 2 `callTool` 内每次 `readJson` |
| initialize/tools.list/tools.call + 未知 method error | Task 2 `handle` |
| 缺数据友好 error（isError） | Task 2 `readJson` throw → `tools/call` catch → isError |
| 注册 mcpServers | Task 3 |
| 纯函数可测 + 集成 spawn | Task 1 单测 + Task 2 集成 |

