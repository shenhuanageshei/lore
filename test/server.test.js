// test/server.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { writeSyncMode, readSyncMode, writeBudgetConfig } from '../lib/syncstate.js';
import { appendCost } from '../lib/cost.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, createPortalServer } from '../server.js';
import { buildCrossRepoIndex } from '../site/shell.mjs';
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
    assert.deepEqual(body.config, { mode: 'notify', debounce_minutes: 10, schedule: null, max_pages: 5, stale_threshold: 15, backend: 'auto' });
    assert.equal(body.runner_running, false);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

// 审计 D4：预算闸超限时 auto 静默停摆，原因必须能从状态接口读到（壳状态行的数据源）。
test('GET /api/sync/status: budget{configured,dimension,budget,used,exceeded}——闸的原因出口', async () => {
  const root = syncFixture();
  const state = join(root, '.state');
  // 版本戳注入固定值：临时仓库无 tag，不注入就断言不了窗口键
  const exec = () => 'v1.0.0\n';
  const server = createServer(root, { exec });
  const port = await listen(server);
  try {
    const status = () => fetch(`http://127.0.0.1:${port}/api/sync/status`).then(r => r.json());
    // 未配置预算：照报 budget（configured:false）——「为什么没跑」要能一眼区分没配 vs 超了
    assert.deepEqual((await status()).budget,
      { configured: false, dimension: 'calls', budget: null, used: 0, exceeded: false, version: 'v1.0.0' });

    // 一行账（无 tokens——三个 CLI 后端都不回报）+ calls 维度预算 1 → 闸红（审计 D3/D4）
    appendCost(state, { ts: 't', page: 'component/lib.md', backend: 'claude', ms: 1500, ok: true, version: 'v1.0.0' });
    writeBudgetConfig(state, { budget: 1, dimension: 'calls' });
    assert.deepEqual((await status()).budget,
      { configured: true, dimension: 'calls', budget: 1, used: 1, exceeded: true, version: 'v1.0.0' });

    // 换维度/上限 → 数值跟着变（ms 维度用注入的耗时）
    writeBudgetConfig(state, { budget: 5000, dimension: 'ms' });
    const ms = (await status()).budget;
    assert.equal(ms.dimension, 'ms');
    assert.equal(ms.used, 1500);
    assert.equal(ms.exceeded, false);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

// --- 壳阶段 B：GET /api/sync/status 的 fuel（设计 §5.3 状态行 / §5.5 燃料读数）---
// 验收口径：契约只增不改（既有 mode/last_finalize/config/runner_running/budget 一个不动）；
// fuel 的派生**唯一在 lib/doctor.js 的 fuelReadout**，server.js 只传仓库根——不重写一套（计划 D3）。
// 关键口径：createServer(root) 的 root 是 **.lore 目录本身**（见本文件 :420 与 lib/serve.js:219），
// 而 fuelReadout 要的仓库根 = 它的父目录（与同处 budgetStatus 的 repoRoot 一致）。
const FUEL_NUMERIC_KEYS = ['capture_pct', 'window_commits', 'days_since_capture'];

// 取不到一律 'unknown'，绝不用 0 冒充——这个断言是阶段 B 的「不许把 unknown 渲染成 0」在数据侧的闸。
function assertFuelShape(fuel) {
  assert.equal(typeof fuel, 'object');
  assert.deepEqual(Object.keys(fuel).sort(),
    ['capture_pct', 'capture_state', 'days_since_capture', 'last_hook_ts', 'window_commits']);
  assert.equal(['ok', 'none', 'unknown'].includes(fuel.capture_state), true,
    `capture_state 只能是 ok|none|unknown，实际 ${fuel.capture_state}`);
  for (const k of FUEL_NUMERIC_KEYS) {
    assert.equal(Number.isFinite(fuel[k]) || fuel[k] === 'unknown', true,
      `fuel.${k} 只能是有限数或 'unknown'，实际 ${JSON.stringify(fuel[k])}`);
  }
  // last_hook_ts 是**时间戳字符串**（口径同 doctor.capture.lastHookTs），取不到才 'unknown'
  assert.equal(fuel.last_hook_ts === 'unknown'
    || (typeof fuel.last_hook_ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(fuel.last_hook_ts)), true,
    `fuel.last_hook_ts 只能是 ISO 时间戳或 'unknown'，实际 ${JSON.stringify(fuel.last_hook_ts)}`);
}

function fuelFixture({ journal = [], initialized = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'lore-fuel-'));
  const root = join(repo, '.lore');                      // 传给 createServer 的就是 .lore 目录
  if (initialized) {
    mkdirSync(join(root, 'wiki'), { recursive: true });
    writeFileSync(join(root, 'wiki', '.manifest.json'),
      JSON.stringify({ generated: '2026-06-09T05:00:00Z', axes: [] }));
  }
  if (journal.length) {
    mkdirSync(join(root, 'journal'), { recursive: true });
    writeFileSync(join(root, 'journal', '2026-09-10.ndjson'),
      journal.map(a => JSON.stringify(a)).join('\n') + '\n');
  }
  return { repo, root, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

test('GET /api/sync/status: 未 init / 非 git → 200 且 fuel 五项全 unknown（不崩、不用 0 冒充）', async () => {
  const { root, cleanup } = fuelFixture({ initialized: false });
  const server = createServer(root);
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sync/status`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assertFuelShape(body.fuel);
    assert.deepEqual(body.fuel, {
      capture_state: 'unknown', capture_pct: 'unknown',
      window_commits: 'unknown', days_since_capture: 'unknown', last_hook_ts: 'unknown',
    });
    // 既有契约字段一个都没被改名/删除（只增不改）
    assert.equal(body.mode, 'notify');
    assert.equal(body.last_finalize, null);                              // 无 manifest
    assert.equal(body.runner_running, false);
    assert.deepEqual(body.config,
      { mode: 'notify', debounce_minutes: 10, schedule: null, max_pages: 5, stale_threshold: 15, backend: 'auto' });
    assert.equal(typeof body.budget, 'object');
    assert.equal(existsSync(root), false);                               // 只读端点：没有凭空造目录
  } finally { server.close(); cleanup(); }
});

test('GET /api/sync/status: fuel 与 doctor 同源同口径（hook 捕获过 → ok + 窗口读数真值）', async () => {
  const { root, cleanup } = fuelFixture({ journal: [
    { id: 'decision:x', kind: 'decision', ts: '2026-09-01T00:00:00Z', source: 'hook', commit: 'sha1', title: 't', why: 'w' },
  ] });
  // 注入 git：版本戳（budgetStatus）与窗口（fuelReadout 的 git log）走同一个 exec 口径。
  const exec = (cmd, args) => {
    if (args[0] === 'describe') return 'v9.9.9\n';
    if (args[0] === 'log') return 'sha1\x1f2026-09-01T00:00:00+00:00\nsha2\x1f2026-09-02T00:00:00+00:00\n';
    return '';
  };
  const server = createServer(root, { exec });
  const port = await listen(server);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/sync/status`)).json();
    assertFuelShape(body.fuel);
    assert.equal(body.fuel.capture_state, 'ok');                         // 捕获过（hook 来源的原子在上）
    assert.equal(body.fuel.last_hook_ts, '2026-09-01T00:00:00Z');
    assert.equal(body.fuel.window_commits, 2);                           // 窗口内提交数（N=50 默认）
    assert.equal(body.fuel.capture_pct, 50);                             // 窗口率 = 1 decision / 2 commits
    assert.equal(Number.isInteger(body.fuel.days_since_capture), true);  // 断流天数：数字（口径同 doctor.capture.gapDays）
    assert.equal(body.budget.version, 'v9.9.9');                         // 既有预算字段：repoRoot 口径未被改动
  } finally { server.close(); cleanup(); }
});

test('GET /api/sync/status: fuel 区分「测得出但从未捕获」(none) 与「测不出」(unknown)', async () => {
  // 有记录层但没有一条 source==='hook' 的原子 = 「hook 断流 3 个月」的最危险形态：
  // 能测（capture_state 有值）却从未捕获过 → 必须与 unknown 分列，不许混成一个词。
  const { root, cleanup } = fuelFixture({ journal: [
    { id: 'commit:1', kind: 'commit', ts: '2026-09-05T00:00:00Z', source: 'mine', title: 't', why: 'w' },
  ] });
  const server = createServer(root);
  const port = await listen(server);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/sync/status`)).json();
    assertFuelShape(body.fuel);
    assert.equal(body.fuel.capture_state, 'none');                       // 测得出：从未捕获
    assert.equal(body.fuel.last_hook_ts, 'unknown');                     // 从未有过 hook 原子 → 无时间戳（不是 0）
    assert.notEqual(body.fuel.capture_state, 'unknown');                 // 与「测不出」严格区分
  } finally { server.close(); cleanup(); }
});

// --- 审计 🟡#3：fuel 的短 TTL 缓存（每次 status 请求都同步 spawn git 的性能修复）---
// 缓存的是 fuelReadout 的**返回值**——派生点仍在 lib/doctor.js（D3），server.js 不重写口径。
// 两条断言分别钉住缓存的两个方向：① 命中时不重复派生；② 过期后必须重新派生（不是「一次定终身」）。
// 为什么用 fuelTtlMs=0 而不是 sleep 30s 验过期：同一段代码路径，TTL 为 0 时每次请求都走「未命中」分支。
function fuelExecStub() {
  const calls = { log: 0, describe: 0 };
  return {
    calls,
    exec: (cmd, args) => {
      if (args[0] === 'describe') { calls.describe += 1; return 'v9.9.9\n'; }
      if (args[0] === 'log') { calls.log += 1; return 'sha1\x1f2026-09-01T00:00:00+00:00\n'; }
      return '';
    },
  };
}

test('GET /api/sync/status: fuel 走 TTL 缓存 —— 连续 3 次请求只 spawn 一次 git log', async () => {
  const { root, cleanup } = fuelFixture({ journal: [
    { id: 'decision:x', kind: 'decision', ts: '2026-09-01T00:00:00Z', source: 'hook', commit: 'sha1', title: 't', why: 'w' },
  ] });
  const { calls, exec } = fuelExecStub();
  const server = createServer(root, { exec });        // 默认 TTL（30s）：三次请求落在同一窗口内
  const port = await listen(server);
  try {
    const bodies = [];
    for (let i = 0; i < 3; i += 1) bodies.push(await (await fetch(`http://127.0.0.1:${port}/api/sync/status`)).json());
    assert.equal(calls.log, 1, `连续 3 次 status 只该 spawn 一次 git log，实测 ${calls.log} 次`);
    for (const b of bodies) {
      assertFuelShape(b.fuel);
      assert.deepEqual(b.fuel, bodies[0].fuel);        // 命中缓存不改变 fuel 的键名/取值（语义零改动）
    }
    assert.equal(bodies[0].fuel.window_commits, 1);    // 缓存里存的就是真值，不是空壳
    assert.equal(bodies[0].fuel.capture_pct, 100);
  } finally { server.close(); cleanup(); }
});

test('GET /api/sync/status: TTL 过期（fuelTtlMs=0）→ 每次请求都重新派生，缓存不改变新鲜度语义', async () => {
  const { root, cleanup } = fuelFixture({ journal: [
    { id: 'decision:x', kind: 'decision', ts: '2026-09-01T00:00:00Z', source: 'hook', commit: 'sha1', title: 't', why: 'w' },
  ] });
  const { calls, exec } = fuelExecStub();
  const server = createServer(root, { exec, fuelTtlMs: 0 });
  const port = await listen(server);
  try {
    for (let i = 0; i < 3; i += 1) {
      const b = await (await fetch(`http://127.0.0.1:${port}/api/sync/status`)).json();
      assertFuelShape(b.fuel);
      assert.equal(b.fuel.window_commits, 1);
    }
    assert.equal(calls.log, 3, `TTL=0 时每次请求都该重新派生，实测 ${calls.log} 次`);
  } finally { server.close(); cleanup(); }
});

// --- 代码评审 🟡#1：fuel 缓存键必须含 exec 维度 ---
// 根因：FUEL_CACHE 原先只按 repoRoot 键控，而它派生的 fuelReadout 是**由某个 exec 口径算出来的**；
// 同一进程里两个 createServer 用不同 exec stub 但同 root 时，后者会读到前者口径下的陈旧 fuel。
// 这与同文件 VERSION_STAMP_CACHE 自己声明的不变量（server.js:145-147「同一个目录换一个 exec……就应该重算」）
// 直接矛盾。修法：fuelCached 与 versionStampCached 同构（WeakMap<exec, Map<repoRoot, {at,value}>>）。
// 断言方向：① 同 root 换 exec → 必须重算，不得串用；② 同一 (exec, repoRoot) 在 TTL 内仍命中（性能不回退）。
test('GET /api/sync/status: fuel 缓存按 (exec, repoRoot) 键控 —— 同 root 不同 exec 不共享缓存', async () => {
  const { root, cleanup } = fuelFixture({ journal: [
    { id: 'decision:x', kind: 'decision', ts: '2026-09-01T00:00:00Z', source: 'hook', commit: 'sha1', title: 't', why: 'w' },
  ] });
  const mkExec = commits => {
    const calls = { log: 0, describe: 0 };
    return {
      calls,
      exec: (cmd, args) => {
        if (args[0] === 'describe') { calls.describe += 1; return 'v9.9.9\n'; }
        if (args[0] === 'log') {
          calls.log += 1;
          return commits.map((sha, i) => `${sha}\x1f2026-09-0${i + 1}T00:00:00+00:00`).join('\n') + '\n';
        }
        return '';
      },
    };
  };
  const a = mkExec(['sha1']);                       // 口径 A：窗口内 1 个提交
  const b = mkExec(['sha1', 'sha2', 'sha3']);       // 口径 B：窗口内 3 个提交
  const serverA = createServer(root, { exec: a.exec });
  const serverB = createServer(root, { exec: b.exec });
  const portA = await listen(serverA);
  const portB = await listen(serverB);
  const status = port => fetch(`http://127.0.0.1:${port}/api/sync/status`).then(r => r.json());
  try {
    const fa = (await status(portA)).fuel;
    assertFuelShape(fa);
    assert.equal(fa.window_commits, 1);
    assert.equal(fa.capture_pct, 100);                       // 1 decision / 1 commit

    // 同 root、换 exec → 必须按新村口径重新派生（读到 1 个提交就是串用了 A 的陈旧值）
    const fb = (await status(portB)).fuel;
    assertFuelShape(fb);
    assert.equal(fb.window_commits, 3, `同 root 换 exec 必须重算，实测 window_commits=${fb.window_commits}`);
    assert.equal(fb.capture_pct, 33.33);                     // 1 decision / 3 commits
    assert.equal(b.calls.log, 1);

    // 各自 (exec, repoRoot) 在 TTL 内仍命中：再各请求一次，派生次数不增、取值不变
    assert.deepEqual((await status(portA)).fuel, fa);
    assert.deepEqual((await status(portB)).fuel, fb);
    assert.equal(a.calls.log, 1, `命中缓存不得重复派生，实测 ${a.calls.log} 次`);
    assert.equal(b.calls.log, 1, `命中缓存不得重复派生，实测 ${b.calls.log} 次`);
  } finally { serverA.close(); serverB.close(); cleanup(); }
});

// --- 窄修复：版本戳（预算窗口键）的短 TTL 缓存 ---
// 根因：status 处理里除 fuel 外还有 budgetStatus → versionStamp（lib/cost.js:41）会**同步 spawn 一次
// `git describe --tags`**；fuel 缓存命中后它成了热路径上唯一的 git 冷启动（实测 hot 仍有 ~850ms）。
// 做法：只缓存「版本戳」这一个派生结果（派生点仍在 lib/cost.js，D3），把它当 `version` 注入 budgetStatus，
// 让它跳过内部的 versionStamp 调用——**不**把整个 status 载荷一起缓存（那会把 config / runner_running /
// last_finalize / used / exceeded 一并冻住 TTL 秒，是语义降级而非单纯取舍），也**不改** budget 的任何子字段。
// 下面两条分别钉住缓存的两个方向：① 热态零 git spawn；② 过期后版本戳必须真的重取（不是一次定终身）。
function budgetExecStub(describeValues = ['v9.9.9']) {
  const calls = { describe: 0, log: 0 };
  return {
    calls,
    exec: (cmd, args) => {
      if (args[0] === 'describe') {
        // 连续取值模拟「缓存过期后 repo 出现了新 tag」——用于证明窗口键不会被缓存冻死
        const v = describeValues[Math.min(calls.describe, describeValues.length - 1)];
        calls.describe += 1;
        return `${v}\n`;
      }
      if (args[0] === 'log') { calls.log += 1; return 'sha1\x1f2026-09-01T00:00:00+00:00\n'; }
      return '';
    },
  };
}

const BUDGET_KEYS = ['budget', 'configured', 'dimension', 'exceeded', 'used', 'version'];

test('GET /api/sync/status: 版本戳走 TTL 缓存 —— 连续 3 次请求 describe 与 log 各只 spawn 一次（热态零 git）', async () => {
  const { root, cleanup } = fuelFixture({ journal: [
    { id: 'decision:x', kind: 'decision', ts: '2026-09-01T00:00:00Z', source: 'hook', commit: 'sha1', title: 't', why: 'w' },
  ] });
  const { calls, exec } = budgetExecStub();
  const server = createServer(root, { exec });           // 默认 TTL（30s）：三次请求落在同一窗口内
  const port = await listen(server);
  try {
    const bodies = [];
    for (let i = 0; i < 3; i += 1) bodies.push(await (await fetch(`http://127.0.0.1:${port}/api/sync/status`)).json());
    assert.equal(calls.describe, 1, `连续 3 次 status 只该 spawn 一次 git describe，实测 ${calls.describe} 次`);
    assert.equal(calls.log, 1, `连续 3 次 status 只该 spawn 一次 git log，实测 ${calls.log} 次`);
    // 缓存命中不改内容：既有 budget 子字段一个不多一个不少，取值与首次一致
    for (const b of bodies) {
      assert.deepEqual(Object.keys(b.budget).sort(), BUDGET_KEYS);
      assert.deepEqual(b.budget, bodies[0].budget);
      assertFuelShape(b.fuel);
    }
    assert.equal(bodies[0].budget.version, 'v9.9.9');    // 缓存里存的是真版本戳，不是空壳
  } finally { server.close(); cleanup(); }
});

test('GET /api/sync/status: 版本戳 TTL 过期（versionTtlMs=0）→ 每次请求重取窗口键，缓存不改变新鲜度语义', async () => {
  const { root, cleanup } = fuelFixture({ journal: [
    { id: 'decision:x', kind: 'decision', ts: '2026-09-01T00:00:00Z', source: 'hook', commit: 'sha1', title: 't', why: 'w' },
  ] });
  const { calls, exec } = budgetExecStub(['v1.0.0', 'v2.0.0', 'v2.0.0']);
  const server = createServer(root, { exec, versionTtlMs: 0 });
  const port = await listen(server);
  try {
    const versions = [];
    for (let i = 0; i < 3; i += 1) {
      versions.push((await (await fetch(`http://127.0.0.1:${port}/api/sync/status`)).json()).budget.version);
    }
    assert.equal(calls.describe, 3, `TTL=0 时每次请求都该重取版本戳，实测 ${calls.describe} 次`);
    assert.deepEqual(versions, ['v1.0.0', 'v2.0.0', 'v2.0.0']);   // 新 tag 在 TTL 外一定会被看见
  } finally { server.close(); cleanup(); }
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

// --- 代码评审 R4 🟡#1：per-repo 形态的跨仓 manifest **同源**路由 ---
// 背景：per-repo 壳读其它仓的 manifest 做跨仓搜索，而其它仓只在 portal 端口上有——原实现直接跨端口
// fetch，被浏览器 CORS 拦（本 server 刻意不发 ACAO），于是每次按键重发一批注定失败的请求。
// 修法是 per-repo server 自己提供同源只读路由（读本机注册表，连 portal 没起也能用）。
// 这里断言的是**服务端可见**的效果——CORS 本身是浏览器行为，stub fetch 证明不了「浏览器里好了」。
test('per-repo: /cross/<repo>/wiki/.manifest.json → 同源读出其它仓的 manifest（R4 🟡#1）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-srv-'));
  const other = mkdtempSync(join(tmpdir(), 'lore-srv-'));
  mkdirSync(join(other, 'wiki'), { recursive: true });
  writeFileSync(join(other, 'wiki', '.manifest.json'), '{"generated":"t1","axes":[{"id":"docs","pages":[]}]}');
  writeFileSync(join(other, 'wiki', 'secret.md'), '# 不该被 /cross 读出来');
  const reposPath = join(root, 'repos.json');
  writeFileSync(reposPath, JSON.stringify([{ name: 'alpha', loreDir: root }, { name: 'beta', loreDir: other }]));
  const server = createServer(root, { reposPath });
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/cross/beta/wiki/.manifest.json`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/json');
    assert.equal(r.headers.get('cache-control'), 'no-store');      // 本地工具的动态内容不缓存
    assert.equal((await r.json()).generated, 't1');
    // 选 (b) 而不是 (a)：本 server 依然**不发** ACAO——本机任意端口上的任意页面都读不走它的响应。
    assert.equal(r.headers.get('access-control-allow-origin'), null, '不许开 CORS 读口子（本地工具不设 ACAO）');

    // 未登记的仓名 → 404（不猜目录、不泄露本机结构）
    assert.equal((await fetch(`http://127.0.0.1:${port}/cross/gamma/wiki/.manifest.json`)).status, 404);
    // 只放行这一条 rel：别的路径走静态（当前仓下不存在 → 404），绝不退化成任意文件读器
    const sneak = await fetch(`http://127.0.0.1:${port}/cross/beta/wiki/secret.md`);
    assert.equal(sneak.status, 404);
    assert.equal((await sneak.text()).includes('不该被'), false);

    // 注册表缺失 → 404（不是 500，也不是 200 空 manifest）
    const noReg = createServer(root, { reposPath: join(root, 'nope.json') });
    const p2 = await listen(noReg);
    try { assert.equal((await fetch(`http://127.0.0.1:${p2}/cross/beta/wiki/.manifest.json`)).status, 404); }
    finally { noReg.close(); }
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('portal: 不开 /cross 读路径（portal 本就是聚合者，壳在它下面走 /<repo>/ 天然同源）', async () => {
  const other = mkdtempSync(join(tmpdir(), 'lore-srv-'));
  mkdirSync(join(other, 'wiki'), { recursive: true });
  writeFileSync(join(other, 'wiki', '.manifest.json'), '{"axes":[]}');
  const server = createPortalServer({ beta: other });
  const port = await listen(server);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/cross/beta/wiki/.manifest.json`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/beta/wiki/.manifest.json`)).status, 200);   // 既有路径不受影响
  } finally { server.close(); rmSync(other, { recursive: true, force: true }); }
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
// --- S7 壳打开传感器：POST /api/human/visit（localhost-only，写 <root>/human/visits.jsonl）---
// 注：createServer(root) 的 root 就是 .lore 目录（server.js 里 wiki/ 与 .state/ 都挂在它下面）。
function visitFixture() {
  const root = mkdtempSync(join(tmpdir(), 'lore-visit-'));
  mkdirSync(join(root, 'wiki', 'component'), { recursive: true });
  writeFileSync(join(root, 'wiki', 'component', 'lib.md'), '# lib');
  return root;
}
const visitLines = root => {
  try { return readFileSync(join(root, 'human', 'visits.jsonl'), 'utf8').split('\n').filter(Boolean); }
  catch { return []; }
};
const postVisit = (port, body, headers = {}) => fetch(`http://127.0.0.1:${port}/api/human/visit`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('POST /api/human/visit 写入一条 visit（kind/page/ts 形状由 lib/human.js 定）', async () => {
  const root = visitFixture();
  const server = createServer(root);
  const port = await listen(server);
  try {
    const r = await postVisit(port, { page: 'component/lib.md' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, page: 'component/lib.md', deduped: false });
    const lines = visitLines(root);
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.kind, 'visit');
    assert.equal(rec.page, 'component/lib.md');
    assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T/);
    // 带点的文件级页（component/server.js.md）同样在白名单内
    writeFileSync(join(root, 'wiki', 'component', 'server.js.md'), '# s');
    assert.equal((await postVisit(port, { page: 'component/server.js.md' })).status, 200);
    assert.equal(visitLines(root).length, 2);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('POST /api/human/visit 同一页短窗重复打开 → 去重不写第二行；换页照写', async () => {
  const root = visitFixture();
  writeFileSync(join(root, 'wiki', 'component', 'hook.md'), '# hook');
  const server = createServer(root);
  const port = await listen(server);
  try {
    assert.equal((await (await postVisit(port, { page: 'component/lib.md' })).json()).deduped, false);
    const again = await (await postVisit(port, { page: 'component/lib.md' })).json();
    assert.equal(again.deduped, true);                          // 短窗内重复打开 → 去重（窗口 = lib/human.js DEDUPE_WINDOW_MS）
    assert.equal(visitLines(root).length, 1);
    assert.equal((await (await postVisit(port, { page: 'component/hook.md' })).json()).deduped, false);
    assert.equal(visitLines(root).length, 2);                   // 换页是新记录
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('POST /api/human/visit 非法/越界 page → 400 且不写盘', async () => {
  const root = visitFixture();
  const server = createServer(root);
  const port = await listen(server);
  try {
    for (const page of ['../../etc/passwd.md', '../../evil.md', 'not-md.txt', '', 'component/lib.md.bak', 42, null]) {
      const r = await postVisit(port, { page });
      assert.equal(r.status, 400, `page=${String(page)} 应被拒`);
    }
    assert.equal(visitLines(root).length, 0);                   // 拒绝路径零副作用
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('POST /api/human/visit 非 localhost Host → 403（沿用 DNS-rebind 防护）且不写盘', async () => {
  const root = visitFixture();
  const server = createServer(root);
  const port = await listen(server);
  try {
    const status = await new Promise((resolve, reject) => {
      const rq = http.request(
        { host: '127.0.0.1', port, path: '/api/human/visit', method: 'POST',
          headers: { 'content-type': 'application/json', host: 'evil.example' } },
        res => { res.resume(); resolve(res.statusCode); });
      rq.on('error', reject);
      rq.end(JSON.stringify({ page: 'component/lib.md' }));
    });
    assert.equal(status, 403);
    assert.equal(visitLines(root).length, 0);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('POST /api/human/visit 无 .lore（未 init）→ 404 not-initialized，不崩、不写散文件', async () => {
  const root = join(tmpdir(), `lore-visit-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const server = createServer(root);
  const port = await listen(server);
  try {
    const r = await postVisit(port, { page: 'component/lib.md' });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'not-initialized' });
    assert.equal(existsSync(root), false);                      // 没有凭空造目录
  } finally { server.close(); }
});

test('POST /api/human/visit 坏 JSON body → 400', async () => {
  const root = visitFixture();
  const server = createServer(root);
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/human/visit`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    });
    assert.equal(r.status, 400);
    assert.equal(visitLines(root).length, 0);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

// --- 代码评审 🔵#4：请求处理器缺顶层 try/catch ---
// 根因：per-repo 处理器是 async 的，处理体里 handleApi 的**未预期**抛错会让返回的 promise reject
// → unhandledRejection → 长时运行的 serve 进程整个挂掉（Node 默认把未处理 rejection 当致命错误）。
// 注入点用确定的 fs 错误，不依赖 exec stub：把 `.state/auto-runs.ndjson` 做成**目录**——
// existsSync 为真、readFileSync 抛 EISDIR，而 readAutoRuns（lib/syncstate.js:203）只 catch 了
// JSON.parse、没 catch 读取本身，于是抛出穿过 handleApi。修复后必须回 500，且进程照旧存活。
const injectFsThrow = root => mkdirSync(join(root, '.state', 'auto-runs.ndjson'), { recursive: true });

test('server: 处理器内未预期抛错 → 500 且响应结束（不变成 unhandledRejection 击落进程）', async () => {
  const root = syncFixture();
  injectFsThrow(root);
  const server = createServer(root);
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sync/runs`);
    assert.equal(r.status, 500, `未预期抛错必须回 500，实际 ${r.status}`);
    assert.equal(typeof (await r.text()), 'string');        // 响应已结束（可读体，连接可复用）
    // 同一个 server 仍活着且正常路径未被兜底吞掉：显式 404 分支照旧 404、正常端点照旧 200
    assert.equal((await fetch(`http://127.0.0.1:${port}/nope.md`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/sync/status`)).status, 200);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('portal: 处理器内未预期抛错 → 500（portal 同样是长时进程，不能被打挂）', async () => {
  const root = syncFixture();
  injectFsThrow(root);
  const server = createPortalServer({ alpha: root });
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/alpha/api/sync/runs`);
    assert.equal(r.status, 500, `portal 转发的未预期抛错必须回 500，实际 ${r.status}`);
    await r.text();
    // portal 自身正常路径不受影响（首页 / repos.json / 未登记 repo 的 404）
    assert.equal((await fetch(`http://127.0.0.1:${port}/repos.json`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/ghost/site/`)).status, 404);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

// --- 代码评审 🔵#3：server.js 的未引用 import ---
// 根因：`readSyncMode` / `readAutoPending` / `clearAutoPending` 被 import 进来却全文件无引用
// （pending 状态实际由 lib/runner.js 读写）。死 import 会误导读者以为 server 读了 pending 状态，
// 下次排查「谁改的 pending」会先来这里翻半天。故立一条**通用**不变量：server.js 里每个具名
// import 都必须在 import 行以外真的出现过——不是只盯这三个名字，下次再冒出死 import 一样会被抓。
test('server.js: 没有未被引用的 import（死 import 会误导读者以为 server 读了这些状态）', () => {
  const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const withoutImports = src.replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '');
  const names = [...src.matchAll(/^import\s*\{([^}]*)\}\s*from/gm)]
    .flatMap(m => m[1].split(','))
    .map(s => s.trim().split(/\s+as\s+/).pop())
    .filter(Boolean);
  assert.ok(names.length > 5, '没解析出 server.js 的具名 import——解析器失效，需同步更新本测试');
  for (const name of names) {
    assert.equal(withoutImports.includes(name), true,
      `server.js 的 import「${name}」在 import 行以外全文件无引用（死 import）`);
  }
});

// --- 代码评审 🟡#2：跨仓索引一次失败即永死 ---
// 注意：被测对象是**壳**的 site/index.html（ensureCrossIndex），与 server.js 无关——放在本文件
// 只因它和上面的死 import 是同一次评审修复的两半，一起回归。壳是 SPA、内联脚本依赖 DOM，
// 本仓零依赖无 jsdom，所以把 ensureCrossIndex 连同它的状态声明抽出来在 Node 里跑：测行为，不测字样。
const SHELL_HTML_SRC = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');

// 从 header 起按花括号配对切出整段函数（跳过字符串/模板/行注释里的花括号）。
// 抽不到就直接失败：抽取器静默失真 = 测试假装通过，比不测更糟。
function sliceShellFn(header) {
  const at = SHELL_HTML_SRC.indexOf(header);
  assert.notEqual(at, -1, `site/index.html 里找不到「${header}」——抽取器失效，需同步更新本测试`);
  let depth = 0, quote = null, i = SHELL_HTML_SRC.indexOf('{', at);
  for (; i < SHELL_HTML_SRC.length; i++) {
    const c = SHELL_HTML_SRC[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '/' && SHELL_HTML_SRC[i + 1] === '/') { i = SHELL_HTML_SRC.indexOf('\n', i); if (i === -1) break; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { i++; break; }
  }
  return SHELL_HTML_SRC.slice(at, i);
}

function buildCrossIndexApi(fetchStub, reposInfo, { urls = [] } = {}) {
  const decls = SHELL_HTML_SRC.match(/let CROSS_INDEX = null;[\s\S]*?const CROSS_BACKOFF_MS = \d+;/);
  assert.ok(decls, 'site/index.html 的跨仓索引状态声明抽取失败——需同步更新本测试');
  const body = [
    decls[0],
    sliceShellFn('async function ensureCrossIndex'),
    'return { ensureCrossIndex, peek: () => CROSS_INDEX,',
    '  retryAt: () => CROSS_RETRY_AT, backoffMs: CROSS_BACKOFF_MS, clearBackoff: () => { CROSS_RETRY_AT = 0; } };',
  ].join('\n');
  // 记下每次请求的 URL：单源同源断言（跨仓 manifest 一旦走绝对 URL 就是跨源，浏览器必拦）靠它。
  const spy = async (url, ...rest) => { urls.push(String(url)); return fetchStub(url, ...rest); };
  const api = new Function('fetch', 'REPOS_INFO', 'buildCrossRepoIndex', body)(spy, reposInfo, buildCrossRepoIndex);
  api.urls = urls;
  return api;
}

const okManifest = { ok: true, json: async () => ({ axes: [{ id: 'docs', pages: [{ id: 'x', title: 'X' }] }] }) };
// per-repo 形态：壳跑在本仓端口、跳转仍去 portal（绝对 URL），但 **fetch 必须同源**（走本 server 的 /cross/）。
const REPO_INFO_PER_REPO = { cur: 'alpha', repos: ['alpha', 'beta'], portalRoot: 'http://127.0.0.1:7842/', manifestRoot: '/cross/' };

test('ensureCrossIndex: per-repo 形态下 manifest 请求必须同源（跨端口会被 CORS 拦，本机 server 刻意不发 ACAO）', async () => {
  const api = buildCrossIndexApi(async () => okManifest, REPO_INFO_PER_REPO);
  await api.ensureCrossIndex();
  assert.deepEqual(api.urls, ['/cross/beta/wiki/.manifest.json']);
  for (const u of api.urls) {
    assert.equal(/^https?:/i.test(u), false, `跨仓 manifest 走了跨源绝对 URL（浏览器会拦掉，且每次按键重发）：${u}`);
  }
  assert.equal(api.peek().length, 1);          // 同源路由真的取到了 manifest
});

test('ensureCrossIndex: 瞬时失败（响应都没拿到）→ 复位「未加载」可重试，但压退避窗口挡住按键级重发（R4 🟡#1）', async () => {
  const api = buildCrossIndexApi(async () => { throw new Error('瞬时不可用'); }, REPO_INFO_PER_REPO);
  await api.ensureCrossIndex();
  assert.equal(api.urls.length, 1);
  assert.equal(api.peek(), null);              // 关键：不是「加载过的空结果」，而是「没拿到、可重试」
  assert.ok(api.retryAt() > Date.now(), '瞬时失败必须压上退避窗口');
  assert.ok(api.backoffMs >= 5000, '退避窗口太短挡不住按键级重发');
  await api.ensureCrossIndex();                // 下一次按键（窗口内）
  assert.equal(api.urls.length, 1, '窗口内不得重发——那正是「每次按键重发一批注定失败的请求」的 bug');
  api.clearBackoff();                          // 窗口过去
  await api.ensureCrossIndex();
  assert.equal(api.urls.length, 2, '窗口过后必须真能重试——修复前这里永久停在 1（一次故障即永死）');
});

test('ensureCrossIndex: 确定性失败（拿到 404 = 别的仓没有 manifest）→ 落空数组，不再按键级重发（R4 🟡#1）', async () => {
  const api = buildCrossIndexApi(async () => ({ ok: false, status: 404 }),
    { cur: 'alpha', repos: ['alpha', 'beta'], portalRoot: '/', manifestRoot: '/' });
  await api.ensureCrossIndex();
  assert.deepEqual(api.peek(), [], '确定性失败 = 没有可索引的内容：用空数组（已加载语义），不是 null（可重试语义）');
  assert.equal(api.retryAt(), 0);
  await api.ensureCrossIndex();
  assert.equal(api.urls.length, 1, '404 再试一万次还是 404 —— 不许每次按键重发');
});

test('ensureCrossIndex: 拿到过结果（含真的没有其它仓、含部分成功）→ 保留空数组语义，不再重复请求', async () => {
  let calls = 0;
  const api = buildCrossIndexApi(async () => { calls++; return okManifest; },
    { cur: 'alpha', repos: ['alpha', 'beta'], portalRoot: '/', manifestRoot: '/' });
  await api.ensureCrossIndex();
  assert.equal(api.peek().length, 1);        // 索引真的建起来了
  await api.ensureCrossIndex();
  assert.equal(calls, 1);                    // 已加载 → 不重复请求

  // 真的没有其它仓：空数组（不是 null）——没有更多可拉，不该每次输入都再试
  let solo = 0;
  const apiSolo = buildCrossIndexApi(async () => { solo++; throw new Error('nope'); },
    { cur: 'alpha', repos: ['alpha'], portalRoot: '/', manifestRoot: '/' });
  await apiSolo.ensureCrossIndex();
  assert.deepEqual(apiSolo.peek(), []);
  assert.equal(solo, 0);                     // 一个请求都不发
  await apiSolo.ensureCrossIndex();
  assert.equal(solo, 0);

  // 部分成功 = 结果可用：不复位 null（否则失败的仓会被每次输入反复重拉 → 请求风暴）
  let part = 0;
  const apiPart = buildCrossIndexApi(async url => {
    part++;
    if (url.includes('beta')) throw new Error('beta down');
    return okManifest;
  }, { cur: 'alpha', repos: ['alpha', 'beta', 'gamma'], portalRoot: '/', manifestRoot: '/' });
  await apiPart.ensureCrossIndex();
  assert.equal(apiPart.peek().length, 1);
  await apiPart.ensureCrossIndex();
  assert.equal(part, 2);                     // 只发了一轮（beta + gamma），第二次输入不再请求
});

test('ensureCrossIndex: 重入防护仍生效——在途期间再输入不产生重复请求风暴', async () => {
  let calls = 0, release;
  const gate = new Promise(r => { release = r; });
  const api = buildCrossIndexApi(async () => { calls++; await gate; return okManifest; },
    { cur: 'alpha', repos: ['alpha', 'beta', 'gamma'], portalRoot: '/', manifestRoot: '/' });
  const first = api.ensureCrossIndex();
  const second = api.ensureCrossIndex();     // 在途期间的第二次输入（旧实现靠 CROSS_INDEX=[] 占位挡）
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 2);                    // 每个其它仓各一次：并发输入没有翻倍
  assert.equal(api.peek().length, 2);
});

// 两个「根」的接线（R4 🟡#1）：跳转用 portalRoot（per-repo 下得是 portal 的绝对 URL），
// fetch 用 manifestRoot（必须同源）。抽 wireRepoSwitch 的真源码跑，断的是它写进 REPOS_INFO 的接线结果；
// DOM 当桩（它只 createElement + after）。
function buildRepoSwitch({ fetchStub, base }) {
  const body = [
    'let REPOS_INFO = null;',
    sliceShellFn('async function wireRepoSwitch'),
    'return { wireRepoSwitch, peek: () => REPOS_INFO };',
  ].join('\n');
  const doc = { createElement: () => ({ after() {} }), getElementById: () => ({ after() {} }) };
  return new Function('fetch', 'BASE', 'document', 'location', body)(fetchStub, base, doc, { href: '' });
}

test('wireRepoSwitch: per-repo → manifestRoot 同源 /cross/、portalRoot 仍是 portal 绝对 URL；portal → 两者都是 /', async () => {
  const api = buildRepoSwitch({
    fetchStub: async () => ({ json: async () => ({ repos: ['alpha', 'beta'], portal: 7842, current: 'alpha' }) }),
    base: '/',
  });
  await api.wireRepoSwitch();
  assert.equal(api.peek().manifestRoot, '/cross/', 'per-repo 形态的 manifest 请求必须同源');
  assert.equal(api.peek().portalRoot, 'http://127.0.0.1:7842/', '跳转仍要去 portal（跨仓导航本来就跨源，无 CORS 问题）');
  assert.equal(api.peek().cur, 'alpha');

  const onPortal = buildRepoSwitch({
    fetchStub: async () => ({ json: async () => ({ repos: ['alpha', 'beta'] }) }),
    base: '/alpha/',
  });
  await onPortal.wireRepoSwitch();
  assert.equal(onPortal.peek().manifestRoot, '/', 'portal 形态下壳与其它仓同源，保持相对根');
  assert.equal(onPortal.peek().portalRoot, '/');
  assert.equal(onPortal.peek().cur, 'alpha');
});

