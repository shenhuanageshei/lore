// test/server.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { writeSyncMode, readSyncMode } from '../lib/syncstate.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, createPortalServer } from '../server.js';
import { execFileSync } from 'node:child_process';
import net from 'node:net';

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

// The CLI binds a port handed to it by lib/serve.js start(). If that port was stolen in
// the findPort→bind TOCTOU window, listen() emits EADDRINUSE — which must exit cleanly with
// a diagnostic (start() detects the exit and re-rolls), not crash as an uncaught exception.
test('CLI: server.js exits cleanly with a diagnostic when the port is already taken', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-bind-'));
  mkdirSync(join(root, 'site'), { recursive: true });
  writeFileSync(join(root, 'site', 'index.html'), 'ok');
  const squatter = net.createServer();
  const port = await new Promise(res => squatter.listen(0, '127.0.0.1', () => res(squatter.address().port)));
  let err = null;
  try {
    execFileSync('node', ['server.js', root, String(port)], { cwd: process.cwd(), stdio: 'pipe', timeout: 8000 });
  } catch (e) { err = e; }
  squatter.close();
  rmSync(root, { recursive: true, force: true });
  assert.notEqual(err, null);                            // non-zero exit, did not hang or bind
  assert.match(String(err.stderr), /failed to bind/i);  // clean message, not an uncaught EADDRINUSE stack
});

test('目录请求无尾斜杠 → 301 加斜杠（相对 import 解析基准）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-srv-'));
  mkdirSync(join(root, 'site'), { recursive: true });
  writeFileSync(join(root, 'site', 'index.html'), '<html></html>');
  const server = createServer(root);
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/site`, { redirect: 'manual' });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '/site/');
    const r2 = await fetch(`http://127.0.0.1:${port}/site/`);          // 带斜杠正常吐 index
    assert.equal(r2.status, 200);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('portal: /<name>/site 无尾斜杠 → 301 带 repo 前缀', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-srv-'));
  mkdirSync(join(root, 'site'), { recursive: true });
  writeFileSync(join(root, 'site', 'index.html'), '<html></html>');
  const server = createPortalServer({ demo: root });
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/demo/site`, { redirect: 'manual' });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '/demo/site/');            // 前缀不能丢
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
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
    // 带 instruction 的重写 → 透传 + 更新同页条目（重写/改进语义）
    await fetch(`http://127.0.0.1:${port}/api/sync/rewrite-requests`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: 'component/sync.md', instruction: '精简概览段' }),
    });
    const list2 = await (await fetch(`http://127.0.0.1:${port}/api/sync/rewrite-requests`)).json();
    assert.equal(list2.requests.length, 1);                          // 同页更新非新增
    assert.equal(list2.requests[0].instruction, '精简概览段');       // 指令透传持久化
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('GET /api/sync/status: B2 扩展形状（config + runner_running）', async () => {
  const root = syncFixture();
  const server = createServer(root);
  const port = await listen(server);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/sync/status`)).json();
    assert.deepEqual(body.config, { mode: 'notify', debounce_minutes: 10, schedule: null, max_pages: 5, stale_threshold: 15 });
    assert.equal(body.runner_running, false);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('POST /api/sync/config: 部分更新落盘+读回；非法 400 不落盘；非 local 403', async () => {
  const root = syncFixture();
  const server = createServer(root);
  const port = await listen(server);
  try {
    const post = body => fetch(`http://127.0.0.1:${port}/api/sync/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const ok = await post({ debounce_minutes: 5, schedule: '02:00' });
    assert.equal(ok.status, 200);
    const status = await (await fetch(`http://127.0.0.1:${port}/api/sync/status`)).json();
    assert.equal(status.config.debounce_minutes, 5);
    assert.equal(status.config.schedule, '02:00');
    assert.equal((await post({ max_pages: 99 })).status, 400);          // 超上限
    assert.equal((await post({ schedule: 'bad' })).status, 400);
    const after = await (await fetch(`http://127.0.0.1:${port}/api/sync/status`)).json();
    assert.equal(after.config.max_pages, 5);                            // 非法没落盘
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

test('per-repo: GET /repos.json → 中央注册表 + portal 端口 + 当前 repo（壳跳转 portal 用）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-srv-'));
  const reposPath = join(root, 'repos.json');
  writeFileSync(reposPath, JSON.stringify([
    { name: 'alpha', loreDir: root },               // 匹配当前 server root → current
    { name: 'beta', loreDir: 'D:/elsewhere/.lore' },
  ]));
  const server = createServer(root, { reposPath });
  const port = await listen(server);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/repos.json`)).json();
    assert.deepEqual(body.repos, ['alpha', 'beta']);
    assert.equal(body.portal, 7842);
    assert.equal(body.current, 'alpha');
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('per-repo: 注册表缺失 → repos 空（壳不显示切换器）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-srv-'));
  const server = createServer(root, { reposPath: join(root, 'nope.json') });
  const port = await listen(server);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/repos.json`)).json();
    assert.deepEqual(body, { repos: [], portal: 7842, current: null });
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('portal: GET /repos.json → 仓库名列表（壳切换下拉数据源）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-srv-'));
  const server = createPortalServer({ alpha: root, beta: root });
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/repos.json`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { repos: ['alpha', 'beta'] });
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('portal: /<name>/api/* 转发到对应 repo（控制台在 portal 下可操作）', async () => {
  const rootA = syncFixture();
  const rootB = syncFixture();
  const server = createPortalServer({ alpha: rootA, beta: rootB });
  const port = await listen(server);
  try {
    // GET status 经转发可达
    const st = await fetch(`http://127.0.0.1:${port}/alpha/api/sync/status`);
    assert.equal(st.status, 200);
    assert.equal((await st.json()).mode, 'notify');
    // POST mode 写到「对应 repo」的 .state（隔离：beta 不受影响）
    const r = await fetch(`http://127.0.0.1:${port}/alpha/api/sync/mode`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'manual' }),
    });
    assert.equal(r.status, 200);
    assert.equal(readSyncMode(join(rootA, '.state')), 'manual');
    assert.equal(readSyncMode(join(rootB, '.state')), 'notify');
    // localHost guard 在 portal 转发路径同样生效
    const status403 = await new Promise((resolve, reject) => {
      const rq = http.request(
        { host: '127.0.0.1', port, path: '/alpha/api/sync/mode', method: 'POST',
          headers: { 'content-type': 'application/json', host: 'evil.example' } },
        res => { res.resume(); resolve(res.statusCode); });
      rq.on('error', reject);
      rq.end(JSON.stringify({ mode: 'notify' }));
    });
    assert.equal(status403, 403);
    assert.equal(readSyncMode(join(rootA, '.state')), 'manual');   // 403 没改盘
    // 未登记 repo 的 api 仍 404
    assert.equal((await fetch(`http://127.0.0.1:${port}/ghost/api/sync/status`)).status, 404);
  } finally { server.close(); rmSync(rootA, { recursive: true, force: true }); rmSync(rootB, { recursive: true, force: true }); }
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
