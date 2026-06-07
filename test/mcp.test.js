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
