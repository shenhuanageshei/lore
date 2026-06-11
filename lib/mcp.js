// 零依赖 stdio MCP server。newline-delimited JSON-RPC 2.0。
// 工具 lore_ask/lore_page/lore_neighbors，消费 cwd/.lore/wiki/{.manifest.json,.graph.json}（每 call 现读）。
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { searchPages } from './ask.js';
import { neighbors, resolvePagePath } from './graph.js';
import { sliceSection, agentView } from './section.js';

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

// 描述按触发词优化（spec 2026-06-11-lore-agent-residency）：让冷启动 agent 在工具选择时
// 知道「这类问题先来这里」——工具描述是 agent 决策的一等输入。
const TOOLS = [
  { name: 'lore_ask', description: '理解本仓库架构、查找模块职责、查决策原因时优先使用：关键词检索 wiki，返回命中页/节（含节内容切片，比读源码省 token，且含源码没有的决策史）',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'lore_page', description: '取单个 wiki 页。id = page:<axis>/<id> 或 wiki 相对 path；section 参数只取单节；view="agent" 跳过人读概览档（省约 40% token）',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, section: { type: 'string' }, view: { type: 'string', enum: ['agent', 'full'] } }, required: ['id'] } },
  { name: 'lore_neighbors', description: '图谱扩展：给定页/组件节点，返回 1-hop 邻居（依赖组件、相关决策原子、同 flow 页）',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];

function callTool(name, args) {
  if (name === 'lore_ask') {
    const hits = searchPages(readJson('.manifest.json'), args.query ?? '');
    return hits.slice(0, 8).map(h => {
      const entry = { id: `page:${h.axis}/${h.id}`, title: h.title, axis: h.axis, score: h.score };
      if (h.section) {
        entry.section = h.section;
        try { entry.slice = sliceSection(readFileSync(join(wikiDir, h.path), 'utf8'), h.section) ?? undefined; }
        catch { /* 页文件缺失 → 无切片，条目仍返回 */ }
      }
      return entry;
    });
  }
  if (name === 'lore_page') {
    const path = resolvePagePath(readJson('.graph.json'), args.id ?? '');
    if (!path) throw new Error(`unknown page id: ${args.id}`);
    const abs = join(wikiDir, path);
    if (!existsSync(abs)) throw new Error(`page file not found: ${path}`);
    let content = readFileSync(abs, 'utf8');
    if (args.section) {
      const s = sliceSection(content, args.section);
      if (s == null) throw new Error(`unknown section: ${args.section}`);
      content = s;
    } else if (args.view === 'agent') {
      content = agentView(content);
    }
    return { id: args.id, path, content };
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
