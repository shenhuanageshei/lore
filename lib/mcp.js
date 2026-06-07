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
