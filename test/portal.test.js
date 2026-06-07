// test/portal.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortalServer } from '../server.js';

function listen(server) {
  return new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

// 造一个最小 loreDir（含 wiki/.manifest.json，内容里带 tag 便于断言命中哪个 repo）。
function makeLoreDir(tag) {
  const loreDir = mkdtempSync(join(tmpdir(), 'lore-portal-' + tag + '-'));
  mkdirSync(join(loreDir, 'wiki'), { recursive: true });
  writeFileSync(join(loreDir, 'wiki', '.manifest.json'), `{"tag":"${tag}"}`);
  return loreDir;
}

test('portal: /<name>/wiki/... 命中对应 repo（白名单路由）', async () => {
  const loreA = makeLoreDir('A');
  const loreB = makeLoreDir('B');
  const server = createPortalServer({ lore: loreA, ti: loreB });
  const port = await listen(server);
  try {
    const a = await fetch(`http://127.0.0.1:${port}/lore/wiki/.manifest.json`);
    assert.equal(a.status, 200);
    assert.deepEqual(await a.json(), { tag: 'A' });
    const b = await fetch(`http://127.0.0.1:${port}/ti/wiki/.manifest.json`);
    assert.equal(b.status, 200);
    assert.deepEqual(await b.json(), { tag: 'B' });
  } finally {
    server.close();
    rmSync(loreA, { recursive: true, force: true });
    rmSync(loreB, { recursive: true, force: true });
  }
});

test('portal: GET / 列出每个登记仓库的链接', async () => {
  const loreA = makeLoreDir('A');
  const loreB = makeLoreDir('B');
  const server = createPortalServer({ lore: loreA, ti: loreB });
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /href="\/lore\/site\/"/);
    assert.match(html, /href="\/ti\/site\/"/);
  } finally {
    server.close();
    rmSync(loreA, { recursive: true, force: true });
    rmSync(loreB, { recursive: true, force: true });
  }
});

test('portal: 未登记 repo → 404；穿越 → 403', async () => {
  const loreA = makeLoreDir('A');
  const server = createPortalServer({ lore: loreA });
  const port = await listen(server);
  try {
    const unknown = await fetch(`http://127.0.0.1:${port}/unknown/wiki/x.md`);
    assert.equal(unknown.status, 404);
    // 编码 ../ 绕过 fetch 归一化（同 server.test 的穿越向量）；forward-slash ../ 两平台都拦
    const escape = await fetch(`http://127.0.0.1:${port}/lore/..%2f..%2fetc%2fpasswd`);
    assert.equal(escape.status, 403);
  } finally {
    server.close();
    rmSync(loreA, { recursive: true, force: true });
  }
});

test('portal: 写接口不路由（MVP 只读）→ 404', async () => {
  const loreA = makeLoreDir('A');
  const server = createPortalServer({ lore: loreA });
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/lore/api/preferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'zh' }),
    });
    assert.equal(r.status, 404);
  } finally {
    server.close();
    rmSync(loreA, { recursive: true, force: true });
  }
});

// ── lib/portal.js 生命周期（确定性：注入 home/spawnFn + 本进程 pid/不可能 pid，不碰 7842）──
import { toMap, start, stop, portalPidPath, PORTAL_PORT } from '../lib/portal.js';
import { registerRepo } from '../lib/repos.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

test('toMap: [{name,loreDir}] → { name: loreDir }', () => {
  assert.deepEqual(
    toMap([{ name: 'a', loreDir: '/x' }, { name: 'b', loreDir: '/y' }]),
    { a: '/x', b: '/y' });
});

test('portal start: pid 活着则复用、不 spawn', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lore-portal-home-'));
  let spawned = false;
  try {
    // 预写一个指向本进程（必活）的 pid 文件
    mkdirSync(join(home, '.lore'), { recursive: true });
    writeFileSync(portalPidPath(home), JSON.stringify({ pid: process.pid, port: PORTAL_PORT }));
    const info = await start({ home, spawnFn: () => { spawned = true; return { pid: 0, unref() {} }; } });
    assert.equal(info.reused, true);
    assert.equal(info.pid, process.pid);
    assert.equal(spawned, false);               // 复用路径绝不 spawn 子进程
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('portal stop: 无 pid 文件 → no-op', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lore-portal-home-'));
  try {
    assert.deepEqual(await stop({ home }), { stopped: false });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('portal stop: 死 pid → 不 kill、清掉 pid 文件', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lore-portal-home-'));
  try {
    mkdirSync(join(home, '.lore'), { recursive: true });
    writeFileSync(portalPidPath(home), JSON.stringify({ pid: 2 ** 31 - 1, port: PORTAL_PORT })); // 不可能的 pid
    const res = await stop({ home });
    assert.equal(res.stopped, true);
    assert.equal(existsSync(portalPidPath(home)), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('CLI: portal list 打印已登记仓库', () => {
  const home = mkdtempSync(join(tmpdir(), 'lore-portal-home-'));
  const repoBase = mkdtempSync(join(tmpdir(), 'lore-portal-repo-'));
  try {
    const loreDir = join(repoBase, 'demo', '.lore');
    mkdirSync(loreDir, { recursive: true });
    registerRepo(join(home, '.lore', 'repos.json'), { loreDir });
    const env = { ...process.env, HOME: home, USERPROFILE: home };   // 隔离 registry 到临时 HOME
    const out = execFileSync('node', ['lib/portal.js', 'list'], { cwd: process.cwd(), env }).toString();
    assert.match(out, /demo/);
    assert.match(out, /\.lore/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoBase, { recursive: true, force: true });
  }
});
