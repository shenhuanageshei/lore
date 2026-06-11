// test/server.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { writeSyncMode, readSyncMode } from '../lib/syncstate.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, createPortalServer } from '../server.js';

function listen(server) {
  return new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

test('serves a file with correct mime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-srv-'));
  mkdirSync(join(root, 'wiki'), { recursive: true });
  writeFileSync(join(root, 'wiki', '.manifest.json'), '{"ok":true}');
  const server = createServer(root);
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/wiki/.manifest.json`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/json');
    assert.deepEqual(await r.json(), { ok: true });
  } finally {
    server.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('404 for missing file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-srv-'));
  const server = createServer(root);
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/nope.md`);
    assert.equal(r.status, 404);
  } finally {
    server.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('rejects path traversal with 403', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-srv-'));
  writeFileSync(join(root, 'inside.txt'), 'in');
  const server = createServer(root);
  const port = await listen(server);
  try {
    // encoded ../ to dodge fetch normalization
    const r = await fetch(`http://127.0.0.1:${port}/..%2f..%2fetc%2fpasswd`);
    assert.equal(r.status, 403);
  } finally {
    server.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('rejects backslash-encoded traversal with 403 (Windows %5c vector)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-srv-'));
  writeFileSync(join(root, 'inside.txt'), 'in');
  const server = createServer(root);
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/..%5c..%5cwindows%5chosts`);
    assert.equal(r.status, 403);
  } finally {
    server.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('serves index.html for a bare directory request ending in slash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-srv-'));
  mkdirSync(join(root, 'site'), { recursive: true });
  writeFileSync(join(root, 'site', 'index.html'),
    '<!doctype html><title>lore</title><div id="app">MARKER_LORE_SHELL</div>');
  const server = createServer(root);
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/site/`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await r.text(), /MARKER_LORE_SHELL/);
  } finally {
    server.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('serves correctly when rootDir has a trailing slash', async () => {
  const base = mkdtempSync(join(tmpdir(), 'lore-srv-'));
  writeFileSync(join(base, 'a.txt'), 'hello');
  const server = createServer(base + '/');     // trailing slash
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/a.txt`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'hello');
  } finally {
    server.close(); rmSync(base, { recursive: true, force: true });
  }
});

function syncFixture() {
  const root = mkdtempSync(join(tmpdir(), 'lore-sync-api-'));
  mkdirSync(join(root, 'wiki'), { recursive: true });
  writeFileSync(join(root, 'wiki', '.manifest.json'),
    JSON.stringify({ generated: '2026-06-09T05:00:00Z', axes: [] }));
  return root;
}

test('GET /api/sync/status → mode + last_finalize', async () => {
  const root = syncFixture();
  const server = createServer(root);
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sync/status`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.mode, 'notify');                              // 缺 sync.json → 默认
    assert.equal(body.last_finalize, '2026-06-09T05:00:00Z');       // manifest.generated
    writeSyncMode(join(root, '.state'), 'manual');
    const r2 = await (await fetch(`http://127.0.0.1:${port}/api/sync/status`)).json();
    assert.equal(r2.mode, 'manual');
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('POST /api/sync/mode：合法落盘；auto/非法 → 400；非 local Host → 403', async () => {
  const root = syncFixture();
  const server = createServer(root);
  const port = await listen(server);
  try {
    const post = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/api/sync/mode`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const ok = await post({ mode: 'manual' });
    assert.equal(ok.status, 200);
    assert.equal(readSyncMode(join(root, '.state')), 'manual');     // 配置真实生效（硬约束②）
    assert.equal((await post({ mode: 'auto' })).status, 200);       // B2 解锁
    assert.equal(readSyncMode(join(root, '.state')), 'auto');
    assert.equal((await post({ mode: 'manual' })).status, 200);     // 复位，供下面「非法不改盘」断言
    assert.equal((await post({ mode: 'hyper' })).status, 400);
    const status403 = await new Promise((resolve, reject) => {
      const r = http.request(
        { host: '127.0.0.1', port, path: '/api/sync/mode', method: 'POST',
          headers: { 'content-type': 'application/json', host: 'evil.example' } },
        res => { res.resume(); resolve(res.statusCode); });
      r.on('error', reject);
      r.end(JSON.stringify({ mode: 'notify' }));
    });
    assert.equal(status403, 403);
    assert.equal(readSyncMode(join(root, '.state')), 'manual');     // 403/400 都没改盘
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('POST /api/sync/finalize → detached spawn finalize（注入断言）', async () => {
  const root = syncFixture();
  const calls = [];
  const server = createServer(root, { spawnFn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() {} }; } });
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sync/finalize`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { spawned: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, process.execPath);
    assert.equal(calls[0].args[0].endsWith('sync.js'), true);
    assert.equal(calls[0].args[1], 'finalize');
    assert.equal(calls[0].args[2], root);
    assert.equal(calls[0].opts.detached, true);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('GET/POST /api/sync/rewrite-requests：排队 + 读回 + 去重 + 非法 page 400', async () => {
  const root = syncFixture();
  mkdirSync(join(root, 'wiki', 'component'), { recursive: true });
  writeFileSync(join(root, 'wiki', 'component', 'sync.md'), '# x');
  const server = createServer(root);
  const port = await listen(server);
  try {
    const post = page => fetch(`http://127.0.0.1:${port}/api/sync/rewrite-requests`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page }),
    });
    const r1 = await post('component/sync.md');
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).queued, true);
    assert.equal((await (await post('component/sync.md')).json()).queued, false);   // 去重
    assert.equal((await post('../../etc/passwd')).status, 400);                     // 越狱拒绝（正则分支）
    assert.equal((await post('../../evil.md')).status, 400);                        // 越狱拒绝（normalize 分支：过正则但出 wiki 根）
    assert.equal((await post('not-md.txt')).status, 400);
    const list = await (await fetch(`http://127.0.0.1:${port}/api/sync/rewrite-requests`)).json();
    assert.equal(list.requests.length, 1);
    assert.equal(list.requests[0].page, 'component/sync.md');
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('GET /api/sync/status: B2 扩展形状（config + runner_running）', async () => {
  const root = syncFixture();
  const server = createServer(root);
  const port = await listen(server);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/sync/status`)).json();
    assert.deepEqual(body.config, { mode: 'notify', debounce_minutes: 10, schedule: null, max_pages: 5 });
    assert.equal(body.runner_running, false);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('GET /api/sync/runs: 历史最近 N 条', async () => {
  const root = syncFixture();
  const { appendAutoRun } = await import('../lib/syncstate.js');
  appendAutoRun(join(root, '.state'), { ts: 't1', pages: [], total_ms: 5 });
  const server = createServer(root);
  const port = await listen(server);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/sync/runs`)).json();
    assert.equal(body.runs.length, 1);
    assert.equal(body.runs[0].ts, 't1');
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('portal: /<name>/api/sync/status 仍 404（只读不变）', async () => {
  const root = syncFixture();
  const server = createPortalServer({ demo: root });
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/demo/api/sync/status`);
    assert.equal(r.status, 404);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('GET /api/sync/status: 无 manifest → last_finalize null', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-sync-api-'));
  const server = createServer(root);
  const port = await listen(server);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/sync/status`)).json();
    assert.equal(body.mode, 'notify');
    assert.equal(body.last_finalize, null);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('POST /api/sync/mode: 坏 JSON body → 400', async () => {
  const root = syncFixture();
  const server = createServer(root);
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sync/mode`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    });
    assert.equal(r.status, 400);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});
