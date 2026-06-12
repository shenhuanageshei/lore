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

// 两档页 fixture：概览（人读）+ 机制详解（agent 要的）——view=agent / section 切片的考场。
function setupTwoTierRepo() {
  const root = setupRepo();
  const compDir = join(root, '.lore', 'wiki', 'component');
  writeFileSync(join(compDir, 'lib.md'),
    '---\ntitle: Lib\nsummary: core thing\n---\n# component: lib\n\n## 概览\n\n**一句话**：比喻给人看的。\n\n## 机制详解\n\n<details>\n<summary><b>① 接口</b> —— 导出</summary>\n\n- f(a) → b\n\n</details>\n\n## Decision history\n\n{{LORE_JOURNAL}}\n');
  execFileSync('node', ['lib/sync.js', 'finalize', join(root, '.lore')], { cwd: process.cwd() });
  return root;
}

test('mcp: view=agent 剥概览档；section 取单节；描述含触发词；ask 命中带切片', async () => {
  const root = setupTwoTierRepo();
  try {
    const replies = await rpc(root, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lore_page', arguments: { id: 'page:component/lib', view: 'agent' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lore_page', arguments: { id: 'page:component/lib', section: '① 接口' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'lore_ask', arguments: { query: '接口' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'lore_page', arguments: { id: 'page:component/lib', section: '不存在' } } },
    ]);
    const byId = new Map(replies.map(r => [r.id, r]));
    const askDesc = byId.get(1).result.tools.find(t => t.name === 'lore_ask').description;
    assert.match(askDesc, /优先/);                                        // 触发词重写
    const agent = JSON.parse(byId.get(2).result.content[0].text);
    assert.doesNotMatch(agent.content, /比喻给人看的/);                    // 概览剥了
    assert.match(agent.content, /机制详解/);                              // 机制档在
    const sec = JSON.parse(byId.get(3).result.content[0].text);
    assert.match(sec.content, /f\(a\) → b/);
    assert.doesNotMatch(sec.content, /概览/);                             // 只有该节
    const ask = JSON.parse(byId.get(4).result.content[0].text);
    const hit = ask.find(h => h.id === 'page:component/lib');
    assert.equal(hit.section, '① 接口');
    assert.match(hit.slice, /f\(a\) → b/);                               // 切片直接带回
    assert.equal(byId.get(5).result.isError, true);                       // 未知节报错
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mcp: lore_ask 无 manifest（fresh clone）→ 返回 /lore:sync 引导', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mcpempty-'));
  try {
    mkdirSync(join(root, '.lore', 'wiki'), { recursive: true });        // 有 wiki 目录、无 manifest
    const replies = await rpc(root, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lore_ask', arguments: { query: 'anything' } } },
    ]);
    const payload = JSON.parse(replies.find(r => r.id === 1).result.content[0].text);
    assert.match(payload.notice, /lore:sync/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
