---
title: lore 同步控制台 B1（档位 + 控制 API + 壳控制台）Implementation Plan
summary: > **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [...
source_path: docs/superpowers/plans/2026-06-09-lore-sync-console.md
last_updated: 2026-06-09
group: 设计与计划
---
> 源文档：`docs/superpowers/plans/2026-06-09-lore-sync-console.md`

# lore 同步控制台 B1（档位 + 控制 API + 壳控制台）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 壳里一眼可见 sync 状态（顶栏灯）、一键可控（立即机械刷新 / 重写排队 / 档位切换），manifest 轮询自动刷新；零 LLM。

**Architecture:** 新 `lib/syncstate.js` 状态层（mode + rewrite 队列，`.state/` 存储）；`server.js` 加四个控制端点（复用 localHost guard + spawnFn 注入）；`lib/hook.js` 读 mode 分流；壳纯逻辑（`buildConsoleModel`/`pollDecide`）进 `site/shell.mjs` 可测，UI（灯/面板/#console/轮询）进 `site/index.html`。

**Tech Stack:** Node 内置（fs/path/http/child_process）+ `node --test`。零外部依赖。

**Spec:** `docs/superpowers/specs/2026-06-09-lore-sync-console-design.md`（设计已批）。

**硬约束（用户点名）：**
1. 壳 UI **全部用 CSS 主题变量**（`--bg`/`--panel`/`--fg`/`--fg-dim`/`--border`/`--accent` + 新增 `--warn`），dark/light/sepia 自动跟随，禁止硬编码色值。
2. 配置**真实生效全链路**：UI 点击 → POST 落盘 `.state/sync.json` → 刷新读回显示同值 → hook 真读它分流。端到端验收含「切 manual → commit → 验证无 finalize」。
3. **dogfood 壳改动必须同步 `.lore/site/`（index.html + shell.mjs 两个都 cp），serve 读的是 `.lore/site/` 不是 `site/`。**

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `lib/syncstate.js` | 新增 | mode 读写 + rewrite 队列（纯函数+路径注入，best-effort 容错同 `registry.js`） |
| `test/syncstate.test.js` | 新增 | 上述单测 |
| `lib/hook.js` | 修改 | `maybeRefresh` 读 mode：manual 跳过 spawn |
| `test/hook.test.js` | 扩展 | manual/notify/缺文件 三态 |
| `server.js` | 修改 | `createServer(rootDir, opts)` + 四端点 |
| `test/server.test.js` | 扩展 | 四端点 happy+边界 |
| `lib/serve.js` | 修改 | CLI `--node` 旗标 → `start` 透传 `preferNode` |
| `site/shell.mjs` | 修改 | `buildConsoleModel` + `pollDecide` 导出 |
| `test/shell.test.js` | 扩展 | 模型聚合/灯三态/轮询判定 |
| `site/index.html` | 修改 | 灯 + 下拉面板 + `#console` 路由 + 轮询 + 提示条 + CSS |
| `commands/sync.md` | 修改 | rewrite-requests 消化指引 |
| `docs/ROADMAP.md` | 修改 | B1 标记 + B2 预告 |

---

## Task 1: `lib/syncstate.js` —— mode 读写

**Files:**
- Create: `lib/syncstate.js`
- Create: `test/syncstate.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/syncstate.test.js`：

```js
// test/syncstate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSyncMode, writeSyncMode } from '../lib/syncstate.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-ss-')); }

test('writeSyncMode → readSyncMode round-trip', () => {
  const dir = tmp();
  try {
    writeSyncMode(dir, 'manual');
    assert.equal(readSyncMode(dir), 'manual');
    writeSyncMode(dir, 'notify');
    assert.equal(readSyncMode(dir), 'notify');
    // 落盘格式可读（控制台/人都能看）
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'sync.json'), 'utf8')), { mode: 'notify' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readSyncMode: 缺文件 → notify（默认档）', () => {
  const dir = tmp();
  try { assert.equal(readSyncMode(dir), 'notify'); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readSyncMode: 坏 JSON / 未知 mode → notify（best-effort）', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'sync.json'), '{oops');
    assert.equal(readSyncMode(dir), 'notify');
    writeFileSync(join(dir, 'sync.json'), JSON.stringify({ mode: 'warp-speed' }));
    assert.equal(readSyncMode(dir), 'notify');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeSyncMode: 非法值 throw（B1 枚举 manual|notify，auto 留 B2）', () => {
  const dir = tmp();
  try {
    assert.throws(() => writeSyncMode(dir, 'auto'), /invalid sync mode/);
    assert.throws(() => writeSyncMode(dir, ''), /invalid sync mode/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeSyncMode: stateDir 不存在时自动创建', () => {
  const dir = tmp();
  try {
    const nested = join(dir, '.state');
    writeSyncMode(nested, 'manual');
    assert.equal(readSyncMode(nested), 'manual');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑红**

Run: `node --test test/syncstate.test.js`
Expected: FAIL —— `Cannot find module '../lib/syncstate.js'`

- [ ] **Step 3: 最小实现**

创建 `lib/syncstate.js`：

```js
// lib/syncstate.js —— B1 同步控制状态层（.state/ 本地存储，best-effort 容错同 registry.js）
// 档位是 per-machine 工作流偏好：删文件 = 回默认 notify，无损坏（spec 决策）。
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const MODES = new Set(['manual', 'notify']);   // B2 加 'auto'
const MODE_FILE = 'sync.json';
const QUEUE_FILE = 'rewrite-requests.ndjson';

export function readSyncMode(stateDir) {
  const p = join(stateDir, MODE_FILE);
  if (!existsSync(p)) return 'notify';
  try {
    const m = JSON.parse(readFileSync(p, 'utf8')).mode;
    return MODES.has(m) ? m : 'notify';
  } catch { return 'notify'; }
}

export function writeSyncMode(stateDir, mode) {
  if (!MODES.has(mode)) throw new Error(`lore: invalid sync mode "${mode}" (B1: manual|notify)`);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, MODE_FILE), JSON.stringify({ mode }, null, 2) + '\n');
}
```

- [ ] **Step 4: 跑绿**

Run: `node --test test/syncstate.test.js`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add lib/syncstate.js test/syncstate.test.js
git commit -m "feat(syncstate): per-machine sync mode read/write (.state/sync.json, default notify)"
```

---

## Task 2: `lib/syncstate.js` —— rewrite 队列

**Files:**
- Modify: `lib/syncstate.js`
- Modify: `test/syncstate.test.js`

- [ ] **Step 1: 写失败测试**

`test/syncstate.test.js` 末尾追加（import 行同步加 `appendRewriteRequest, readRewriteRequests`）：

```js
import { appendRewriteRequest, readRewriteRequests } from '../lib/syncstate.js';

test('appendRewriteRequest + readRewriteRequests round-trip', () => {
  const dir = tmp();
  try {
    const r1 = appendRewriteRequest(dir, { page: 'component/sync.md', now: '2026-06-09T01:00:00Z' });
    assert.equal(r1.queued, true);
    const list = readRewriteRequests(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].page, 'component/sync.md');
    assert.equal(list[0].ts, '2026-06-09T01:00:00Z');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendRewriteRequest: 同页未消化不重复排（去重）', () => {
  const dir = tmp();
  try {
    appendRewriteRequest(dir, { page: 'component/sync.md' });
    const r2 = appendRewriteRequest(dir, { page: 'component/sync.md' });
    assert.equal(r2.queued, false);
    assert.equal(readRewriteRequests(dir).length, 1);
    const r3 = appendRewriteRequest(dir, { page: 'component/hook.md' });
    assert.equal(r3.queued, true);
    assert.equal(readRewriteRequests(dir).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readRewriteRequests: 缺文件 → []；坏行跳过好行保留', () => {
  const dir = tmp();
  try {
    assert.deepEqual(readRewriteRequests(dir), []);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rewrite-requests.ndjson'),
      '{"ts":"t1","page":"component/a.md"}\n{oops\n{"ts":"t2","page":"component/b.md"}\n{"nopage":1}\n');
    const list = readRewriteRequests(dir);
    assert.deepEqual(list.map(r => r.page), ['component/a.md', 'component/b.md']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑红**

Run: `node --test test/syncstate.test.js`
Expected: FAIL —— `appendRewriteRequest is not a function`

- [ ] **Step 3: 实现**

`lib/syncstate.js` 末尾追加：

```js
// rewrite 队列：壳「✍ 排队」→ append；会话 /lore:sync 优先消化后从文件移除该行（命令层职责）。
// B2 的 auto 档复用同一队列（LLM 运行器消费）。
export function readRewriteRequests(stateDir) {
  const p = join(stateDir, QUEUE_FILE);
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r.page === 'string' && r.page) out.push(r); }
    catch { /* skip bad line */ }
  }
  return out;
}

export function appendRewriteRequest(stateDir, { page, now = new Date().toISOString() }) {
  if (readRewriteRequests(stateDir).some(r => r.page === page)) return { queued: false };
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, QUEUE_FILE), JSON.stringify({ ts: now, page }) + '\n');
  return { queued: true };
}
```

- [ ] **Step 4: 跑绿**

Run: `node --test test/syncstate.test.js`
Expected: PASS（8 tests）

- [ ] **Step 5: Commit**

```bash
git add lib/syncstate.js test/syncstate.test.js
git commit -m "feat(syncstate): rewrite-request queue (ndjson append, per-page dedupe)"
```

---

## Task 3: hook 分流 —— manual 档不 spawn

**Files:**
- Modify: `lib/hook.js`
- Modify: `test/hook.test.js`

- [ ] **Step 1: 写失败测试**

`test/hook.test.js` 末尾追加（文件顶部已有 mkdtempSync/join/tmpdir/rmSync/writeFileSync/mkdirSync imports 与 `maybeRefresh` import，直接用）：

```js
import { writeSyncMode } from '../lib/syncstate.js';

test('maybeRefresh: mode=manual → 不 spawn（自动刷新关闭）', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mr-'));
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    writeFileSync(join(lore, 'wiki', '.manifest.json'), '{"axes":[]}');
    writeSyncMode(join(lore, '.state'), 'manual');
    let spawned = false;
    const r = maybeRefresh({ loreDir: lore, spawnFn: () => { spawned = true; return { unref() {} }; } });
    assert.equal(r.spawned, false);
    assert.equal(r.reason, 'manual');
    assert.equal(spawned, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('maybeRefresh: mode=notify（显式写入）→ spawn 照旧', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mr-'));
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    writeFileSync(join(lore, 'wiki', '.manifest.json'), '{"axes":[]}');
    writeSyncMode(join(lore, '.state'), 'notify');
    const calls = [];
    const r = maybeRefresh({ loreDir: lore, spawnFn: (cmd, args) => { calls.push(args); return { unref() {} }; } });
    assert.equal(r.spawned, true);
    assert.equal(calls.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

（缺 sync.json → spawn 的默认行为由现有「有 manifest → spawn」测试覆盖：那个 fixture 没写过 sync.json。）

- [ ] **Step 2: 跑红**

Run: `node --test test/hook.test.js`
Expected: FAIL —— manual 用例 `r.spawned` 为 true（hook 还没读 mode）

- [ ] **Step 3: 实现**

`lib/hook.js` 顶部 import 区加：

```js
import { readSyncMode } from './syncstate.js';
```

`maybeRefresh` 的 try 块开头（`if (!existsSync(...))` 之前）加：

```js
    if (readSyncMode(join(loreDir, '.state')) === 'manual') return { spawned: false, reason: 'manual' };
```

- [ ] **Step 4: 跑绿**

Run: `node --test test/hook.test.js`
Expected: PASS（原有 + 新 2 个）

- [ ] **Step 5: Commit**

```bash
git add lib/hook.js test/hook.test.js
git commit -m "feat(hook): manual mode skips commit-time auto finalize"
```

---

## Task 4: server API —— `GET /api/sync/status` + `POST /api/sync/mode`

**Files:**
- Modify: `server.js`
- Modify: `test/server.test.js`

- [ ] **Step 1: 写失败测试**

`test/server.test.js` 末尾追加：

```js
import { writeSyncMode, readSyncMode } from '../lib/syncstate.js';

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
    assert.equal((await post({ mode: 'auto' })).status, 400);       // B2 才解锁
    assert.equal((await post({ mode: 'hyper' })).status, 400);
    assert.equal((await post({ mode: 'notify' }, { host: 'evil.example' })).status, 403);
    assert.equal(readSyncMode(join(root, '.state')), 'manual');     // 403/400 都没改盘
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑红**

Run: `node --test test/server.test.js`
Expected: FAIL —— status 路由不存在走静态分支返回 404

- [ ] **Step 3: 实现**

`server.js`：

import 区加（合并进现有行）：

```js
import { readSyncMode, writeSyncMode, appendRewriteRequest, readRewriteRequests } from './lib/syncstate.js';
```

`createServer` 里 `/api/translation-requests` 块之后、`const rel = ...` 之前插入：

```js
    // --- B1 同步控制 API（spec 2026-06-09-lore-sync-console）---
    if (req.method === 'GET' && pathname === '/api/sync/status') {
      const mode = readSyncMode(join(root, '.state'));
      let lastFinalize = null;
      try { lastFinalize = JSON.parse(readFileSync(join(root, 'wiki', '.manifest.json'), 'utf8')).generated ?? null; }
      catch { /* 无 manifest（未 sync）→ null */ }
      return sendJson(res, 200, { mode, last_finalize: lastFinalize });
    }

    if (req.method === 'POST' && pathname === '/api/sync/mode') {
      try {
        const body = await readJson(req);
        writeSyncMode(join(root, '.state'), String(body.mode ?? ''));   // 非法值 throw → 400
        return sendJson(res, 200, { ok: true, mode: body.mode });
      } catch {
        return sendJson(res, 400, { error: 'invalid mode (B1: manual|notify; auto lands in B2)' });
      }
    }
```

（POST 自动受现有 `localHost` guard 保护——guard 在所有 `/api/` POST 之前。）

- [ ] **Step 4: 跑绿**

Run: `node --test test/server.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat(server): sync status + mode control API (localhost-only, enum-guarded)"
```

---

## Task 5: server API —— `POST /api/sync/finalize` + `GET/POST /api/sync/rewrite-requests`

**Files:**
- Modify: `server.js`
- Modify: `test/server.test.js`

- [ ] **Step 1: 写失败测试**

`test/server.test.js` 追加：

```js
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
    assert.equal((await post('../../etc/passwd')).status, 400);                     // 越狱拒绝
    assert.equal((await post('not-md.txt')).status, 400);
    const list = await (await fetch(`http://127.0.0.1:${port}/api/sync/rewrite-requests`)).json();
    assert.equal(list.requests.length, 1);
    assert.equal(list.requests[0].page, 'component/sync.md');
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('portal: /<name>/api/sync/status 仍 404（只读不变）', async () => {
  const root = syncFixture();
  const { createPortalServer } = await import('../server.js');
  const server = createPortalServer({ demo: root });
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/demo/api/sync/status`);
    assert.equal(r.status, 404);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑红**

Run: `node --test test/server.test.js`
Expected: FAIL —— finalize/rewrite 路由 404；`createServer` 不收第二参（spawnFn 被忽略 → calls 空）

- [ ] **Step 3: 实现**

`server.js`：

顶部加（spawn import + HERE）：

```js
import { spawn } from 'node:child_process';
```

`const LANG_RE = ...` 行后加：

```js
const HERE = dirname(fileURLToPath(import.meta.url));
```

（`dirname`/`fileURLToPath` 已在 import 里。）

`createServer` 签名改为：

```js
export function createServer(rootDir, { spawnFn = spawn } = {}) {
```

Task 4 加的 mode 块之后追加：

```js
    if (req.method === 'POST' && pathname === '/api/sync/finalize') {
      try {
        // 与 hook.maybeRefresh 同款 detached finalize（A 接缝③）。不加防抖：finalize 幂等、最后写赢。
        const child = spawnFn(process.execPath, [join(HERE, 'lib', 'sync.js'), 'finalize', root],
          { detached: true, stdio: 'ignore' });
        child.unref();
        return sendJson(res, 200, { spawned: true });
      } catch { return sendJson(res, 500, { error: 'spawn failed' }); }
    }

    if (pathname === '/api/sync/rewrite-requests') {
      if (req.method === 'GET') {
        return sendJson(res, 200, { requests: readRewriteRequests(join(root, '.state')) });
      }
      if (req.method === 'POST') {
        try {
          const body = await readJson(req);
          const page = String(body.page ?? '');
          if (!safeWikiPage(root, page)) return sendJson(res, 400, { error: 'invalid page' });
          return sendJson(res, 200, { ok: true, ...appendRewriteRequest(join(root, '.state'), { page }) });
        } catch { return sendJson(res, 400, { error: 'bad json' }); }
      }
    }
```

- [ ] **Step 4: 跑绿**

Run: `node --test test/server.test.js`
Expected: PASS（含 portal 404 不变）

- [ ] **Step 5: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat(server): finalize-spawn + rewrite-request queue API (safeWikiPage-guarded)"
```

---

## Task 6: serve `--node` 旗标（单语 repo 控制 API 逃生门）

**Files:**
- Modify: `lib/serve.js`

> `probeRuntime(can, { preferNode })` 已存在且有测试；本任务只是 CLI 透传，无新可测纯逻辑 → 不加测试，跑回归即可。

- [ ] **Step 1: 实现**

`lib/serve.js` 三处小改：

`start` 签名加 `preferNode`：

```js
export async function start({ loreDir, port, canRun, spawnFn = spawn, now = new Date().toISOString(), preferNode = false }) {
```

`start` 内 `probeRuntime` 调用改为（原 `preferNode: language.available.length > 1`）：

```js
  const runtime = probeRuntime(can, { preferNode: preferNode || language.available.length > 1 });
```

`parseArgs` 的 for 循环加一分支：

```js
    else if (a === '--node') out.node = true;
```

CLI `start` 分支的 `start({...})` 调用加参数：

```js
      const info = await start({ loreDir, port: args.port, now: new Date().toISOString(), preferNode: !!args.node });
```

- [ ] **Step 2: 回归**

Run: `node --test test/serve.test.js`
Expected: PASS（全部原有用例）

- [ ] **Step 3: Commit**

```bash
git add lib/serve.js
git commit -m "feat(serve): --node flag forces bundled Node server (enables control API on monolingual repos)"
```

---

## Task 7: `site/shell.mjs` —— `buildConsoleModel` + `pollDecide`

**Files:**
- Modify: `site/shell.mjs`
- Modify: `test/shell.test.js`

- [ ] **Step 1: 写失败测试**

`test/shell.test.js` 末尾追加：

```js
import { buildConsoleModel, pollDecide } from '../site/shell.mjs';

const mkManifest = pages => ({ axes: [{ id: 'component', label: 'Component', pages }] });

test('buildConsoleModel: 0 stale → fresh 绿灯', () => {
  const m = buildConsoleModel(mkManifest([{ id: 'lib', title: 'lib', stale: 0 }]), { mode: 'notify', last_finalize: 't0' });
  assert.equal(m.light, 'fresh');
  assert.equal(m.staleTotal, 0);
  assert.equal(m.mode, 'notify');
  assert.equal(m.lastFinalize, 't0');
});

test('buildConsoleModel: N stale → stale 黄灯 + 按 stale 降序', () => {
  const m = buildConsoleModel(mkManifest([
    { id: 'a', title: 'A', stale: 1, last_updated: 'd1' },
    { id: 'b', title: 'B', stale: 5, last_updated: 'd2' },
    { id: 'c', title: 'C', stale: 0 },
  ]), { mode: 'notify', last_finalize: null });
  assert.equal(m.light, 'stale');
  assert.equal(m.staleTotal, 2);
  assert.deepEqual(m.stalePages.map(p => p.key), ['component/b', 'component/a']);
  assert.equal(m.stalePages[0].stale, 5);
});

test('buildConsoleModel: manual → off 灰灯但 stale 数照算（关自动 ≠ 藏信息）', () => {
  const m = buildConsoleModel(mkManifest([{ id: 'a', title: 'A', stale: 3 }]), { mode: 'manual', last_finalize: null });
  assert.equal(m.light, 'off');
  assert.equal(m.staleTotal, 1);
});

test('buildConsoleModel: status null（python server / portal 无 API）→ 默认 notify', () => {
  const m = buildConsoleModel(mkManifest([]), null);
  assert.equal(m.mode, 'notify');
  assert.equal(m.lastFinalize, null);
});

test('pollDecide: generated 未变 → 全 false；变了 → 重建；当前页变了 → 提示条', () => {
  assert.deepEqual(pollDecide('t1', 't1', false), { changed: false, rebuildSidebar: false, showUpdateBar: false });
  assert.deepEqual(pollDecide('t1', null, false), { changed: false, rebuildSidebar: false, showUpdateBar: false });
  assert.deepEqual(pollDecide('t1', 't2', false), { changed: true, rebuildSidebar: true, showUpdateBar: false });
  assert.deepEqual(pollDecide('t1', 't2', true),  { changed: true, rebuildSidebar: true, showUpdateBar: true });
});
```

- [ ] **Step 2: 跑红**

Run: `node --test test/shell.test.js`
Expected: FAIL —— `buildConsoleModel is not a function`

- [ ] **Step 3: 实现**

`site/shell.mjs` 末尾追加：

```js
// B1 控制台模型：灯三态 + stale 聚合（spec 2026-06-09-lore-sync-console）。
// status 来自 GET /api/sync/status；python 静态 server / portal 下无 API → 传 null，降级默认。
export function buildConsoleModel(manifest, status) {
  const stalePages = [];
  for (const ax of manifest.axes ?? []) {
    for (const p of ax.pages ?? []) {
      if ((p.stale ?? 0) > 0) {
        stalePages.push({ key: `${ax.id}/${p.id}`, title: p.title ?? p.id, stale: p.stale, last_updated: p.last_updated ?? '', path: p.path });
      }
    }
  }
  stalePages.sort((a, b) => b.stale - a.stale || a.key.localeCompare(b.key));
  const mode = status?.mode ?? 'notify';
  return {
    light: mode === 'manual' ? 'off' : (stalePages.length ? 'stale' : 'fresh'),
    staleTotal: stalePages.length,
    stalePages,
    mode,
    lastFinalize: status?.last_finalize ?? null,
  };
}

// manifest 轮询判定：generated 变了 → 灯/侧栏重建；当前页条目也变了 → 正文提示条（不强刷、不丢滚动位置）。
export function pollDecide(prevGenerated, nowGenerated, currentPageChanged) {
  if (!nowGenerated || nowGenerated === prevGenerated) {
    return { changed: false, rebuildSidebar: false, showUpdateBar: false };
  }
  return { changed: true, rebuildSidebar: true, showUpdateBar: !!currentPageChanged };
}
```

- [ ] **Step 4: 跑绿**

Run: `node --test test/shell.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add site/shell.mjs test/shell.test.js
git commit -m "feat(shell): buildConsoleModel + pollDecide (console state pure-logic, tested)"
```

---

## Task 8: 壳 UI —— 顶栏灯 + 下拉面板

**Files:**
- Modify: `site/index.html`

> 壳 UI 无单测惯例（核心逻辑已在 Task 7 进 node --test）；本任务以「JS 语法自检 + Task 11 dogfood 清单」验收。
> **硬约束①：所有颜色只用 CSS 变量。**

- [ ] **Step 1: 三主题加 `--warn` 变量**

`site/index.html` `<style>` 里：

`:root {` 块（dark，约 line 9-15）的变量末尾加：

```css
    --warn: #e0af68;
```

`:root[data-theme="light"] {` 块加：

```css
    --warn: #b15c00;
```

`:root[data-theme="sepia"] {` 块加：

```css
    --warn: #9a6a3a;
```

- [ ] **Step 2: 灯 + 面板 CSS**

`#serve-badge` 的现有 CSS 规则**整条删除**（搜 `#serve-badge`），原位置替换为：

```css
  #sync-light { display: flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 99px;
    border: 1px solid var(--border); background: var(--panel); color: var(--fg);
    cursor: pointer; font-size: 12px; user-select: none; white-space: nowrap; }
  #sync-light:hover { border-color: var(--accent); }
  #sync-light .ind { width: 8px; height: 8px; border-radius: 50%; background: var(--green); }
  #sync-light.stale .ind { background: var(--warn); box-shadow: 0 0 6px var(--warn); }
  #sync-light.off .ind { background: var(--fg-dim); }
  #sync-panel { position: absolute; top: 46px; right: 12px; z-index: 50; width: 280px;
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 12px 14px; box-shadow: 0 10px 28px rgba(0,0,0,.35); font-size: 12.5px; color: var(--fg); }
  #sync-panel .row { display: flex; justify-content: space-between; align-items: center; margin: 6px 0; gap: 8px; }
  #sync-panel .dim { color: var(--fg-dim); }
  #sync-panel .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  #sync-panel .seg button { background: none; border: none; padding: 3px 10px; cursor: pointer;
    color: var(--fg); font-size: 12px; }
  #sync-panel .seg button.on { background: var(--accent); color: var(--bg); font-weight: 600; }
  #sync-panel .seg button:disabled { color: var(--fg-dim); cursor: not-allowed; opacity: .6; }
  #sync-panel .actions button { background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 4px 10px; margin-right: 6px; margin-top: 8px; cursor: pointer; color: var(--fg); font-size: 12px; }
  #sync-panel .actions button:hover { border-color: var(--accent); }
  #sync-panel .actions button:disabled { color: var(--fg-dim); cursor: not-allowed; opacity: .6; }
  #sync-panel[hidden] { display: none; }
```

（注意 `#sync-light .ind` 不叫 `.dot` —— 侧栏轴已用 `.dot` 类，避免样式串扰。）

- [ ] **Step 3: 顶栏 DOM 替换**

`<div id="serve-badge">● serving</div>` 整行替换为：

```html
    <div id="sync-light" title="sync 状态"><span class="ind"></span><span id="sync-light-text">…</span></div>
```

`</div>`（`#topbar` 收尾）与 `<nav id="sidebar">` 之间插入面板骨架：

```html
  <div id="sync-panel" hidden>
    <div class="row"><span class="dim">档位</span>
      <span class="seg">
        <button data-mode="manual">手动</button>
        <button data-mode="notify">提醒</button>
        <button data-mode="auto" disabled title="B2 解锁">全自动 🔒</button>
      </span>
    </div>
    <div class="row"><span class="dim">待重写</span><span id="sync-stale-summary">—</span></div>
    <div class="row"><span class="dim">上次机械刷新</span><span id="sync-last">—</span></div>
    <div class="actions">
      <button id="sync-finalize">⟳ 立即刷新</button>
      <button id="sync-queue-all">✍ 重写排队</button>
      <button id="sync-detail">详情 →</button>
    </div>
  </div>
```

- [ ] **Step 4: 控制台 JS（wireSyncConsole）**

`<script type="module">` 内、`wireTheme()` 函数定义之后加：

```js
// --- B1 同步控制台（spec 2026-06-09-lore-sync-console）---
let SYNC_STATUS = null;        // GET /api/sync/status 结果；API 不可用（python/portal）→ null
let SYNC_API_OK = false;
let QUEUED_PAGES = new Set();  // 已排队 page path（渲染「已排队 ✓」）

async function fetchSyncStatus() {
  try {
    const r = await fetch(BASE + 'api/sync/status');
    if (!r.ok) throw new Error();
    SYNC_STATUS = await r.json();
    SYNC_API_OK = true;
    const q = await (await fetch(BASE + 'api/sync/rewrite-requests')).json();
    QUEUED_PAGES = new Set((q.requests ?? []).map(x => x.page));
  } catch { SYNC_STATUS = null; SYNC_API_OK = false; }
}

function renderSyncLight() {
  const m = buildConsoleModel(MANIFEST, SYNC_STATUS);
  const light = document.getElementById('sync-light');
  light.className = m.light === 'fresh' ? '' : m.light;          // '' | 'stale' | 'off'
  document.getElementById('sync-light-text').textContent =
    m.light === 'off' ? `手动 · ${m.staleTotal} 待写`
    : m.staleTotal ? `${m.staleTotal} 待重写` : '全新鲜';
  // 面板内容
  document.querySelectorAll('#sync-panel .seg button').forEach(b =>
    b.classList.toggle('on', b.dataset.mode === m.mode));
  document.getElementById('sync-stale-summary').textContent = m.staleTotal
    ? m.stalePages.slice(0, 2).map(p => `${p.key.split('/').pop()} ⚠${p.stale}`).join(' · ') + (m.staleTotal > 2 ? ` 等${m.staleTotal}页` : '')
    : '无';
  document.getElementById('sync-last').textContent = m.lastFinalize
    ? new Date(m.lastFinalize).toLocaleString() : '—';
  // portal / python server 降级：操作按钮禁用
  for (const id of ['sync-finalize', 'sync-queue-all']) {
    const btn = document.getElementById(id);
    btn.disabled = !SYNC_API_OK;
    btn.title = SYNC_API_OK ? '' : '只读模式（portal 或 python server）——本地 /lore:serve --node 可操作';
  }
  document.querySelectorAll('#sync-panel .seg button:not([data-mode="auto"])').forEach(b => {
    if (!SYNC_API_OK) { b.disabled = true; b.title = '只读模式'; }
  });
}

function wireSyncConsole() {
  const light = document.getElementById('sync-light');
  const panel = document.getElementById('sync-panel');
  light.onclick = () => { panel.hidden = !panel.hidden; };
  document.addEventListener('click', e => {
    if (!panel.hidden && !panel.contains(e.target) && !light.contains(e.target)) panel.hidden = true;
  });
  document.querySelectorAll('#sync-panel .seg button[data-mode]').forEach(b => {
    if (b.dataset.mode === 'auto') return;                       // B2
    b.onclick = async () => {
      try {
        await fetch(BASE + 'api/sync/mode', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: b.dataset.mode }) });
        await fetchSyncStatus(); renderSyncLight();              // 读回显示（硬约束②：存→读全链路）
      } catch { /* 降级模式下按钮已禁用 */ }
    };
  });
  document.getElementById('sync-finalize').onclick = async () => {
    try {
      await fetch(BASE + 'api/sync/finalize', { method: 'POST' });
      startFastPoll();                                           // Task 9：快轮询秒级反馈
    } catch { /* disabled in degraded mode */ }
  };
  document.getElementById('sync-queue-all').onclick = async () => {
    const m = buildConsoleModel(MANIFEST, SYNC_STATUS);
    for (const p of m.stalePages) {
      if (p.path && !QUEUED_PAGES.has(p.path)) {
        try { await fetch(BASE + 'api/sync/rewrite-requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page: p.path }) }); } catch {}
      }
    }
    await fetchSyncStatus(); renderSyncLight();
  };
  document.getElementById('sync-detail').onclick = () => { panel.hidden = true; location.hash = 'console'; };
}
```

`shell.mjs` import 行加 `buildConsoleModel, pollDecide`：

```js
import {
  stripFrontmatter, renderMarkdown, buildPageIndex, preprocessWikilinks,
  buildNavModel, buildMeta, chooseInitialLanguage, resolveLocalizedPage,
  baseFromPathname, buildConsoleModel, pollDecide,
} from './shell.mjs';
```

`boot()` 里 `wireTheme();` 之后加：

```js
  await fetchSyncStatus();
  wireSyncConsole();
  renderSyncLight();
```

（`startFastPoll` 在 Task 9 定义；本任务结束时为避免 ReferenceError，先加占位一行在 wireSyncConsole 之前：`function startFastPoll() {}` —— Task 9 用真实现替换。）

- [ ] **Step 5: 语法自检 + 手动冒烟**

```bash
node -e "const h=require('fs').readFileSync('site/index.html','utf8');const i=h.indexOf('<script type=\"module\">');const j=h.lastIndexOf('</script>');try{new Function(h.slice(i+22,j).replace(/import[^;]+;/g,''));console.log('JS OK')}catch(e){console.log('JS ERR:',e.message)}"
node -e "require('fs').copyFileSync('site/index.html','.lore/site/index.html');require('fs').copyFileSync('site/shell.mjs','.lore/site/shell.mjs');console.log('dogfood synced')"
```

Expected: `JS OK` + `dogfood synced`。浏览器打开本地 serve（双语 repo 自动 Node server）：灯显示真实 stale 数、点灯出面板、切档后刷新页面档位保持（落盘生效）、三主题切换无硬编码色残留。

- [ ] **Step 6: Commit**

```bash
git add site/index.html
git commit -m "feat(shell): topbar sync light + dropdown panel (mode switch, finalize, queue; theme-var only)"
```

---

## Task 9: 壳 —— `#console` 整页 + manifest 轮询 + 提示条

**Files:**
- Modify: `site/index.html`

- [ ] **Step 1: console 页 + 提示条 CSS**

`#sync-panel[hidden]` 规则后追加：

```css
  .console-sec { background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 14px 16px; margin-bottom: 14px; }
  .console-sec h3 { margin: 0 0 10px; color: var(--fg-bright); font-size: 15px; }
  .console-sec table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .console-sec th { text-align: left; color: var(--fg-dim); font-weight: 500; font-size: 11px;
    text-transform: uppercase; letter-spacing: .5px; padding: 4px 8px; border-bottom: 1px solid var(--border); }
  .console-sec td { padding: 6px 8px; border-bottom: 1px solid var(--border); }
  .console-sec .tag { padding: 1px 8px; border-radius: 99px; font-size: 11px; }
  .console-sec .tag.w { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
  .console-sec .tag.q { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
  .console-sec button { background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 3px 10px; cursor: pointer; color: var(--fg); font-size: 12px; }
  .console-sec button:hover { border-color: var(--accent); }
  .console-sec button:disabled { color: var(--fg-dim); cursor: not-allowed; opacity: .6; }
  #update-bar { background: color-mix(in srgb, var(--accent) 12%, transparent); border: 1px solid var(--accent);
    border-radius: 8px; padding: 8px 14px; margin-bottom: 14px; cursor: pointer; color: var(--fg); font-size: 13px; }
  #update-bar:hover { background: color-mix(in srgb, var(--accent) 20%, transparent); }
```

- [ ] **Step 2: console 路由**

`route()` 里 `const page = FLAT[hash];` 之后、`document.querySelectorAll('#sidebar a')...` 之前插入：

```js
  if (hash === 'console') {
    document.querySelectorAll('#sidebar a').forEach(a => a.classList.remove('active'));
    renderConsolePage();
    return;
  }
```

`route()` 函数之后加渲染函数：

```js
function renderConsolePage() {
  const m = buildConsoleModel(MANIFEST, SYNC_STATUS);
  const modeDesc = { manual: '一切手动——commit 不触发任何后台动作', notify: 'commit 后自动机械刷新（决策史/manifest/stale），prose 重写排队提醒' };
  const rows = m.stalePages.map(p => `
    <tr><td><a href="#${p.key}">${p.key}</a></td>
      <td><span class="tag w">⚠ ${p.stale} commits</span></td>
      <td>${p.last_updated || '—'}</td>
      <td>${QUEUED_PAGES.has(p.path)
        ? '<span class="tag q">已排队 ✓</span>'
        : `<button data-queue="${p.path}" ${SYNC_API_OK ? '' : 'disabled'}>✍ 排队</button>`}</td></tr>`).join('');
  document.getElementById('meta').innerHTML = '';
  document.getElementById('content').innerHTML = `
    <h1>⚙ 同步控制台</h1>
    <div class="console-sec">
      <h3>档位</h3>
      <div class="row" style="display:flex;align-items:center;gap:12px">
        <span class="seg" id="console-seg" style="display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden">
          <button data-mode="manual" ${SYNC_API_OK ? '' : 'disabled'}>手动</button>
          <button data-mode="notify" ${SYNC_API_OK ? '' : 'disabled'}>提醒</button>
          <button data-mode="auto" disabled title="B2 解锁">全自动 🔒</button>
        </span>
        <span style="color:var(--fg-dim);font-size:12.5px">${modeDesc[m.mode] ?? ''}</span>
      </div>
    </div>
    <div class="console-sec">
      <h3>待重写队列（manifest stale &gt; 0）</h3>
      ${m.staleTotal ? `<table><tr><th>页面</th><th>落后</th><th>正文最后重写</th><th></th></tr>${rows}</table>` : '<p style="color:var(--fg-dim)">全部新鲜 ✓</p>'}
      <div style="margin-top:10px">
        <button id="console-queue-all" ${SYNC_API_OK && m.staleTotal ? '' : 'disabled'}>✍ 全部排队</button>
        <button id="console-finalize" ${SYNC_API_OK ? '' : 'disabled'}>⟳ 立即机械刷新</button>
      </div>
    </div>
    <div class="console-sec">
      <h3>状态</h3>
      <table>
        <tr><td style="color:var(--fg-dim)">上次机械刷新</td><td>${m.lastFinalize ? new Date(m.lastFinalize).toLocaleString() : '—'}</td></tr>
        <tr><td style="color:var(--fg-dim)">已排队请求</td><td>${QUEUED_PAGES.size} 条 —— 下次会话 /lore:sync 优先消化</td></tr>
        <tr><td style="color:var(--fg-dim);opacity:.55">自动重写任务历史</td><td style="opacity:.55">🔒 B2 全自动档解锁后显示</td></tr>
      </table>
    </div>`;
  // seg 高亮 + 事件（与面板同款行为）
  document.querySelectorAll('#console-seg button').forEach(b => {
    b.classList.toggle('on', b.dataset.mode === m.mode);
    if (b.dataset.mode !== 'auto') b.onclick = async () => {
      try {
        await fetch(BASE + 'api/sync/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: b.dataset.mode }) });
        await fetchSyncStatus(); renderSyncLight(); renderConsolePage();
      } catch {}
    };
  });
  document.querySelectorAll('#content button[data-queue]').forEach(b => b.onclick = async () => {
    try {
      await fetch(BASE + 'api/sync/rewrite-requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page: b.dataset.queue }) });
      await fetchSyncStatus(); renderConsolePage();
    } catch {}
  });
  const qa = document.getElementById('console-queue-all');
  if (qa) qa.onclick = async () => {
    for (const p of m.stalePages) if (p.path && !QUEUED_PAGES.has(p.path)) {
      try { await fetch(BASE + 'api/sync/rewrite-requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page: p.path }) }); } catch {}
    }
    await fetchSyncStatus(); renderSyncLight(); renderConsolePage();
  };
  const fz = document.getElementById('console-finalize');
  if (fz) fz.onclick = async () => { try { await fetch(BASE + 'api/sync/finalize', { method: 'POST' }); startFastPoll(); } catch {} };
  document.getElementById('main').scrollTop = 0;
}
```

（`#console-seg .on` 样式沿用 `#sync-panel .seg button.on` —— 给该规则加并列选择器：`#sync-panel .seg button.on, #console-seg button.on { ... }`，或把 seg 样式改为类选择器 `.seg button.on`。选后者：把 Task 8 CSS 里 `#sync-panel .seg` 系列前缀去掉改成 `.seg`，作用域仍受结构限制。）

- [ ] **Step 3: 轮询 + 提示条 + 快轮询**

删掉 Task 8 的 `function startFastPoll() {}` 占位，在 `wireSyncConsole` 之前加：

```js
// --- manifest 轮询：15s 慢轮询常驻；操作后 1s×10 快轮询（秒级反馈）。纯 GET，三 serve 形态全兼容。
let LAST_GENERATED = null, POLL_TIMER = null, FAST_LEFT = 0;

async function pollTick() {
  if (document.hidden) return;                                   // 后台 tab 不空转
  let fresh;
  try { fresh = await (await fetch(BASE + 'wiki/.manifest.json')).json(); }
  catch { return; }
  const currentKey = location.hash.slice(1);
  const before = JSON.stringify(FLAT[currentKey] ?? null);
  const flatNew = {};
  for (const ax of fresh.axes) for (const p of ax.pages) flatNew[`${ax.id}/${p.id}`] = p;
  const d = pollDecide(LAST_GENERATED, fresh.generated, JSON.stringify(flatNew[currentKey] ?? null) !== before);
  LAST_GENERATED = fresh.generated;
  if (!d.changed) return;
  MANIFEST = fresh; PAGE_INDEX = buildPageIndex(MANIFEST); FLAT = flatNew;
  if (d.rebuildSidebar) buildSidebar();
  await fetchSyncStatus(); renderSyncLight();
  if (location.hash.slice(1) === 'console') renderConsolePage();
  if (d.showUpdateBar) showUpdateBar();
  if (FAST_LEFT > 0) { FAST_LEFT = 0; schedulePoll(15000); }     // 快轮询命中 → 回落慢轮询
}

function schedulePoll(ms) {
  clearInterval(POLL_TIMER);
  POLL_TIMER = setInterval(async () => {
    await pollTick();
    if (FAST_LEFT > 0 && --FAST_LEFT === 0) schedulePoll(15000); // 快轮询用尽未命中 → 回落
  }, ms);
}

function startFastPoll() { FAST_LEFT = 10; schedulePoll(1000); }

function showUpdateBar() {
  if (document.getElementById('update-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'update-bar';
  bar.textContent = '⟳ 内容已更新，点击刷新本页';
  bar.onclick = () => { bar.remove(); route(); };
  document.getElementById('content').prepend(bar);
}
```

`boot()` 里 `renderSyncLight();` 之后加：

```js
  LAST_GENERATED = MANIFEST.generated ?? null;
  schedulePoll(15000);
```

- [ ] **Step 4: 语法自检 + dogfood 同步**

```bash
node -e "const h=require('fs').readFileSync('site/index.html','utf8');const i=h.indexOf('<script type=\"module\">');const j=h.lastIndexOf('</script>');try{new Function(h.slice(i+22,j).replace(/import[^;]+;/g,''));console.log('JS OK')}catch(e){console.log('JS ERR:',e.message)}"
node -e "require('fs').copyFileSync('site/index.html','.lore/site/index.html');require('fs').copyFileSync('site/shell.mjs','.lore/site/shell.mjs');console.log('dogfood synced')"
```

Expected: `JS OK` + `dogfood synced`。

- [ ] **Step 5: Commit**

```bash
git add site/index.html
git commit -m "feat(shell): #console page + manifest polling (15s slow / 1s fast) + update bar"
```

---

## Task 10: `commands/sync.md` —— rewrite 队列消化指引

**Files:**
- Modify: `commands/sync.md`

- [ ] **Step 1: 加消化指引**

`commands/sync.md` 的 plan 阶段说明附近（「增量」相关段落之后）追加一节：

```markdown
## 用户排队的重写请求（B1 控制台）

plan 之前先读 `<loreDir>/.state/rewrite-requests.ndjson`（每行 `{ts, page}`；缺文件 = 无请求）：

1. 队列里的页**优先**进 worklist——即使指纹判 fresh 也入（`reason: "user-requested"`）：用户点名 = 显式意图，高于机械判定。
2. 每重写完一页，从队列移除该条目：读全文件 → 过滤掉该 page 的行 → 整体重写文件（队列小、无并发，覆盖写可接受）。
3. 全部消化后若文件空，删除或留空文件皆可（readRewriteRequests 都按空处理）。
```

- [ ] **Step 2: 验证 commands/sync.md 已有测试不破**

Run: `node --test test/commands.test.js 2>/dev/null || node --test`
Expected: 引用 `commands/sync.md` 内容的测试（two-tier 标准断言等）仍 PASS。

- [ ] **Step 3: Commit**

```bash
git add commands/sync.md
git commit -m "docs(sync-cmd): consume rewrite-request queue (user-requested pages first)"
```

---

## Task 11: dogfood 验收 + ROADMAP + 全量回归

**Files:**
- Modify: `docs/ROADMAP.md`
- Dogfood: `.lore/site/`（已在 Task 8/9 cp）

- [ ] **Step 1: 端到端验收（硬约束②反空壳清单）**

```bash
node lib/serve.js start --lore .lore    # 双语 repo 自动 Node server
```

浏览器逐项确认（每项必须真实通过）：

1. **灯真实**：顶栏灯显示与侧栏 ⚠ 一致的待重写数；全新鲜时绿。
2. **档位全链路**：面板切「手动」→ `.lore/.state/sync.json` 内容变 `{"mode":"manual"}`（cat 验证）→ 硬刷新页面 → 档位仍显「手动」（读回）→ 做一次 commit → **manifest `generated` 不变**（hook 没 spawn，机械刷新关了）→ 切回「提醒」→ 再 commit → 15s 内灯/侧栏自动更新（轮询生效）。
3. **立即刷新**：点 ⟳ → 数秒内面板「上次机械刷新」时间戳前进（快轮询反馈）。
4. **排队**：console 页对 stale 页点「✍ 排队」→ `.lore/.state/rewrite-requests.ndjson` 出现该页 → 按钮变「已排队 ✓」→ 重复点不重复排。
5. **#console 页**：面板「详情 →」进入；队列表/状态区数据真实；B2 占位 🔒 显示。
6. **三主题**：dark/light/sepia 切换，灯/面板/console 页全部跟随，无突兀硬编码色。
7. **提示条**：开着某 stale 页 → 另开终端 commit → 15s 内正文顶出现「⟳ 内容已更新」→ 点击后页面刷新不丢状态。

- [ ] **Step 2: ROADMAP 标记**

`docs/ROADMAP.md`「壳呈现 ✅（C-呈现 ①）」节之后加：

```markdown
### 同步控制台 B1（档位 + 控制 API + 壳控制台）✅ 已实现
- 已实现：档位 `manual`/`notify`（`.state/sync.json`，per-machine，hook 分流）；控制 API 四端点（status / mode / finalize-spawn / rewrite-requests，localhost-only + safeWikiPage 防越狱）；壳顶栏状态灯 + 下拉面板 + `#console` 整页（全 CSS 主题变量）；manifest 轮询（15s 慢 + 操作后 1s 快）自动刷新灯/侧栏/提示条；重写排队（ndjson 队列，`/lore:sync` 优先消化）。serve `--node` 旗标给单语 repo 启用控制 API。设计见 `docs/superpowers/specs/2026-06-09-lore-sync-console-design.md`。
- **B2（另立 spec）**：LLM 运行器（可插拔后端：默认 spawn claude CLI 无头 / 裸 Anthropic API / codex 扩展位）+ `auto` 档 + `schedule` 定时 + 质量门（机械校验+失败丢弃）+ 自动重写任务历史。
```

- [ ] **Step 3: 全量回归**

Run: `node --test`
Expected: PASS —— 0 failures（基线 311 + 本轮新增 ≈ 330+；记录实际数）。

- [ ] **Step 4: Commit**

```bash
git add docs/ROADMAP.md .lore/site .lore/wiki .lore/config.yml 2>/dev/null; git add docs/ROADMAP.md .lore/site
git commit -m "docs(roadmap): sync console B1 done; dogfood shell synced"
```

---

## Self-Review（已执行）

**1. Spec 覆盖：** 决策表 13 项——档位三档预设→T1/T3/T8（auto 置灰）；`.state` 存储→T1；notify=现状→T3 测试；控制台 A+C→T8/T9；console 内置路由→T9；轮询 15s/快轮询→T9；重写排队→T2/T5/T8/T9/T10；质量门→B2（spec 已注明）；主题变量硬约束→T8/T9 CSS + T11 验收 6；配置全链路硬约束→T4 测试（落盘断言）+ T11 验收 2；portal 降级→T5 测试（404）+ T8 降级渲染；`--node`→T6。manual 灯显数字→T7 测试 + T8 渲染（`手动 · N 待写`）。无缺口。

**2. Placeholder 扫描：** 每步含完整代码/命令/期望输出；壳任务（8/9）以语法自检+T11 真实清单兜底（壳无单测惯例，核心逻辑已在 T7 测）。无 TBD/TODO。

**3. 类型一致性：** `readSyncMode/writeSyncMode(stateDir, mode)`（T1）↔ hook（T3）/server（T4）调用一致；`appendRewriteRequest(stateDir, {page, now}) → {queued}`（T2）↔ server T5 ↔ 壳 `queued` 渲染；`createServer(rootDir, {spawnFn})`（T5）向后兼容单参调用（T4 及现有测试不传 opts）；`buildConsoleModel(manifest, status) → {light, staleTotal, stalePages[{key,title,stale,last_updated,path}], mode, lastFinalize}`（T7）↔ T8/T9 的 `m.stalePages[].path`/`m.light` 用法一致；`pollDecide(prev, now, changed) → {changed, rebuildSidebar, showUpdateBar}`（T7）↔ T9 `pollTick`；`startFastPoll` T8 占位 → T9 真实现（plan 内显式交接）。

**4. 风险复核：** `color-mix` 需较新 Chromium——本地工具自用可接受；若需兼容旧浏览器改 rgba 近似值（执行者可在 T9 遇渲染异常时降级，色值仍从变量派生不硬编码）。`.seg` 类选择器改造（T9 括号注）执行时与 T8 一并落地避免漏改。

