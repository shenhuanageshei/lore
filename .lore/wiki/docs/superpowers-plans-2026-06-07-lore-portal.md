---
title: lore 单机共享门户（portal）Implementation Plan
summary: > **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [...
source_path: docs/superpowers/plans/2026-06-07-lore-portal.md
last_updated: 2026-06-07
---
> 源文档：`docs/superpowers/plans/2026-06-07-lore-portal.md`

# lore 单机共享门户（portal）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把每个 repo 独立 server 的现状，升级为「单机一个常驻门户（固定端口 7842）聚合本机所有 lore 仓库、顶层选 repo → 进该 repo 多轴 wiki」的只读 MVP。

**Architecture:** 中央 `~/.lore/repos.json` 登记各仓库（`/lore:init` 自动登记）；从 `server.js` 提取共享 `serveStatic(root, rel, res)`，新增 `createPortalServer(repoMap)` 按 `/<name>/<rest>` 白名单路由复用之；新 `lib/portal.js` 管门户进程生命周期（固定 7842、`~/.lore/portal.pid`、跨平台 kill 复用 `serve.js`）；浏览器壳从 `location.pathname` 推断 base 前缀，fetch 自动带 `/<repo>/`。MVP 只读：`/<name>/api/…` 一律 404，无写面。

**Tech Stack:** Node.js（零运行时依赖、ESM）、`node:http`/`node:fs`/`node:net`、`node --test`（内置测试运行器）、原生 `fetch`。

**前置已并入 main：** `lib/registry.js`（servers.json 模式）、`server.js` 的 `createServer`、`lib/serve.js` 的 `stablePort`/`killPid`/`isAlive`、`site/` 壳。

**设计来源：** `docs/superpowers/specs/2026-06-07-lore-portal-design.md`（设计已批）。

---

## File Structure

新增：
- `lib/repos.js` —— `~/.lore/repos.json` 仓库登记（纯函数 + 路径注入，复用 `registry.js` 模式）。职责：`registerRepo` / `listRepos` / `defaultReposPath`。
- `lib/portal.js` —— 门户进程生命周期（`start`/`stop`/`list` + `__run` 子进程入口 + `toMap` + pid 管理）。职责：把 `createPortalServer` 跑成常驻 detached 进程。
- `test/repos.test.js` —— `lib/repos.js` 纯函数测试。
- `test/portal.test.js` —— `createPortalServer` 路由/安全测试 + `lib/portal.js` 生命周期测试。
- `commands/portal.md` —— `/lore:portal` slash 命令（`lib/portal.js` 薄封装）。

修改：
- `server.js` —— 提取 `serveStatic`（`createServer` 改为调用它，行为不变）；新增 `createPortalServer(repoMap)` + `renderRepoList`。
- `site/shell.mjs` —— 新增并导出 `baseFromPathname(pathname)`。
- `site/index.html` —— import 并计算 `BASE`，4 处 `../wiki/` `../api/` fetch 改为 `BASE + 'wiki/'` / `BASE + 'api/'`。
- `lib/init.js` —— **CLI 块**末尾（非纯函数 `init()`）best-effort 调 `registerRepo` 登记本 repo。
- `test/init.test.js` —— 把现有「CLI: node lib/init.js」测试隔离 HOME 并断言登记（防污染真实 `~/.lore`）。
- `CHANGELOG.md` / `README.md` / `docs/ROADMAP.md` —— 文档同步。

不动（共存）：`lib/registry.js`（servers.json）、`lib/serve.js`（per-repo serve，只 import 其 `killPid`/`isAlive`）。

> **范围外：** `.lore/site/index.html` 是 dogfood 生成副本（由 `/lore:init`/`/lore:sync` 重建），本计划只改源 `site/`，不手改 `.lore/` 副本。

---

## Task 1: `lib/repos.js` —— 仓库登记表（纯函数）

**Files:**
- Create: `lib/repos.js`
- Test: `test/repos.test.js`

- [ ] **Step 1: 写失败测试**

Create `test/repos.test.js`:

```js
// test/repos.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRepo, listRepos } from '../lib/repos.js';

function tmpReposPath() { return join(mkdtempSync(join(tmpdir(), 'lore-repos-')), 'repos.json'); }

// 造一个真实的 <base>/<repoName>/.lore 目录；返回 loreDir。删 join(loreDir,'..','..') 清整个 base。
function makeLore(repoName) {
  const base = mkdtempSync(join(tmpdir(), 'lore-repo-'));
  const loreDir = join(base, repoName, '.lore');
  mkdirSync(loreDir, { recursive: true });
  return loreDir;
}

test('registerRepo: 取 repo 根目录名为 name，并持久化', () => {
  const p = tmpReposPath();
  const loreDir = makeLore('myrepo');
  try {
    const entry = registerRepo(p, { loreDir });
    assert.equal(entry.name, 'myrepo');
    assert.equal(entry.loreDir, loreDir);
    assert.deepEqual(listRepos(p).map(e => e.name), ['myrepo']);
  } finally {
    rmSync(join(p, '..'), { recursive: true, force: true });
    rmSync(join(loreDir, '..', '..'), { recursive: true, force: true });
  }
});

test('registerRepo: 同 loreDir 幂等（不重复登记）', () => {
  const p = tmpReposPath();
  const loreDir = makeLore('repoA');
  try {
    const a = registerRepo(p, { loreDir });
    const b = registerRepo(p, { loreDir });
    assert.deepEqual(a, b);
    assert.equal(listRepos(p).length, 1);
  } finally {
    rmSync(join(p, '..'), { recursive: true, force: true });
    rmSync(join(loreDir, '..', '..'), { recursive: true, force: true });
  }
});

test('registerRepo: 同名不同 loreDir → 加 -2 后缀', () => {
  const p = tmpReposPath();
  const a = makeLore('lore');   // <tmpA>/lore/.lore
  const b = makeLore('lore');   // <tmpB>/lore/.lore（同 basename，不同路径）
  try {
    assert.equal(registerRepo(p, { loreDir: a }).name, 'lore');
    assert.equal(registerRepo(p, { loreDir: b }).name, 'lore-2');
  } finally {
    rmSync(join(p, '..'), { recursive: true, force: true });
    rmSync(join(a, '..', '..'), { recursive: true, force: true });
    rmSync(join(b, '..', '..'), { recursive: true, force: true });
  }
});

test('listRepos: 过滤掉 loreDir 已不存在的条目', () => {
  const p = tmpReposPath();
  const a = makeLore('alive');
  const b = makeLore('gone');
  try {
    registerRepo(p, { loreDir: a });
    registerRepo(p, { loreDir: b });
    rmSync(join(b, '..', '..'), { recursive: true, force: true });   // 删掉 repo b
    assert.deepEqual(listRepos(p).map(e => e.name), ['alive']);
  } finally {
    rmSync(join(p, '..'), { recursive: true, force: true });
    rmSync(join(a, '..', '..'), { recursive: true, force: true });
  }
});

test('listRepos: 文件不存在 → []', () => {
  assert.deepEqual(listRepos(join(tmpdir(), 'lore-repos-nope', 'repos.json')), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/repos.test.js`
Expected: FAIL —— `Cannot find module '../lib/repos.js'`。

- [ ] **Step 3: 写实现**

Create `lib/repos.js`:

```js
// lib/repos.js — ~/.lore/repos.json 仓库登记（portal 发现本机各 repo）。
// 复用 registry.js 模式：纯函数 + 路径注入（reposPath 参数）便于测试。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';

export function defaultReposPath(home = homedir()) {
  return join(home, '.lore', 'repos.json');
}

function read(path) {
  if (!existsSync(path)) return [];
  try { const a = JSON.parse(readFileSync(path, 'utf8')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function write(path, arr) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(arr, null, 2) + '\n');
}

// 读 repos.json，过滤掉 loreDir 已不存在的条目（best-effort 自愈）。
export function listRepos(reposPath = defaultReposPath()) {
  return read(reposPath).filter(e => e && e.loreDir && existsSync(e.loreDir));
}

// 登记本 repo。name = repo 根目录名（loreDir 的父目录 basename）；同 loreDir 幂等返回原条目；
// 同名不同 loreDir 加后缀 -2/-3…。写回 repos.json，返回写入的条目。
export function registerRepo(reposPath, { loreDir }) {
  const arr = read(reposPath);
  const existing = arr.find(e => e.loreDir === loreDir);
  if (existing) return existing;
  const base = basename(dirname(loreDir));
  const taken = new Set(arr.map(e => e.name));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  const entry = { name, loreDir };
  arr.push(entry);
  write(reposPath, arr);
  return entry;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/repos.test.js`
Expected: PASS（5 tests）。

- [ ] **Step 5: Commit**

```bash
git add lib/repos.js test/repos.test.js
git commit -m "feat(repos): ~/.lore/repos.json repo registry for portal discovery"
```

---

## Task 2: `server.js` —— 提取 `serveStatic`（重构，回归保护）

把 `createServer` 里「rel→full、穿越 guard、dir→index.html、stream+MIME」抽成共享函数。**行为必须不变**——现有 `test/server.test.js` + `test/server-api.test.js` 是回归网。

**Files:**
- Modify: `server.js`（新增 `serveStatic`；`createServer` 尾部改为调用它）
- Test（回归，不改）: `test/server.test.js`、`test/server-api.test.js`

- [ ] **Step 1: 跑现有 server 测试建立绿色基线**

Run: `node --test test/server.test.js test/server-api.test.js`
Expected: PASS（全绿；这是重构前基线）。

- [ ] **Step 2: 新增 `serveStatic`**

在 `server.js` 的 `MIME` 常量之后、`createServer` 之前插入：

```js
// Serve <root>/<rel> as a static file: traversal guard, dir→index.html, stream + MIME.
// Extracted so the per-repo server AND the portal share identical static semantics.
export function serveStatic(rootDir, rel, res) {
  const root = normalize(rootDir).replace(/[/\\]+$/, '');
  let full = normalize(join(root, rel));
  // traversal guard: resolved path must stay within root.
  // (full === root is reachable for a bare "" rel, which the dir→index step resolves.)
  if (full !== root && !full.startsWith(root + sep)) {
    res.writeHead(403); return res.end('forbidden');
  }
  let st;
  try { st = statSync(full); } catch { res.writeHead(404); return res.end('not found'); }
  // directory request → serve its index.html, mirroring python http.server.
  if (st.isDirectory()) {
    full = join(full, 'index.html');
    try { st = statSync(full); } catch { res.writeHead(404); return res.end('not found'); }
  }
  if (st.isDirectory()) { res.writeHead(404); return res.end('not found'); }

  const stream = createReadStream(full);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream' });
  stream.pipe(res);
}
```

- [ ] **Step 3: `createServer` 尾部改为调用 `serveStatic`**

在 `server.js` 中，把 `createServer` 内从 `const rel = pathname.replace(/^\/+/, '');` 起到 `stream.pipe(res);` 结束的整段（写 API 之后那段静态 serve 逻辑），替换为两行调用。

把这段：

```js
    const rel = pathname.replace(/^\/+/, '');
    let full = normalize(join(root, rel));

    // traversal guard: resolved path must stay within root.
    // (full === root is reachable for a bare "/" request, which the dir→index
    //  step below resolves to <root>/index.html.)
    if (full !== root && !full.startsWith(root + sep)) {
      res.writeHead(403); return res.end('forbidden');
    }
    let st;
    try { st = statSync(full); } catch { res.writeHead(404); return res.end('not found'); }
    // directory request → serve its index.html, mirroring python http.server.
    // covers paths ending in "/" (e.g. the advertised /site/) and bare dir names.
    if (st.isDirectory()) {
      full = join(full, 'index.html');
      try { st = statSync(full); } catch { res.writeHead(404); return res.end('not found'); }
    }
    if (st.isDirectory()) { res.writeHead(404); return res.end('not found'); }

    const stream = createReadStream(full);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream' });
    stream.pipe(res);
  });
}
```

替换为：

```js
    const rel = pathname.replace(/^\/+/, '');
    return serveStatic(root, rel, res);
  });
}
```

> `createServer` 顶部 `const root = normalize(rootDir).replace(/[/\\]+$/, '');` **保留不动**（写 API 处理器仍用 `root`）。`serveStatic` 内部再 normalize 一次是幂等的，行为不变。

- [ ] **Step 4: 跑回归测试确认仍全绿**

Run: `node --test test/server.test.js test/server-api.test.js`
Expected: PASS（与 Step 1 同样全绿；穿越 403 / 404 / index.html / 尾斜杠 / MIME / 写 API 全不回归）。

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "refactor(server): extract serveStatic from createServer (no behavior change)"
```

---

## Task 3: `server.js` —— `createPortalServer`（聚合路由）

**Files:**
- Modify: `server.js`（新增 `renderRepoList` + `createPortalServer`）
- Test: `test/portal.test.js`（本任务新建，只含 server 路由测试；生命周期测试在 Task 4 追加）

- [ ] **Step 1: 写失败测试**

Create `test/portal.test.js`:

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/portal.test.js`
Expected: FAIL —— `createPortalServer` 未从 `../server.js` 导出（SyntaxError/undefined）。

- [ ] **Step 3: 写实现**

在 `server.js` 末尾（CLI `if (process.argv[1] === ...)` 块**之前**）新增：

```js
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderRepoList(names) {
  const items = names.length
    ? names.map(n => `<li><a href="/${encodeURIComponent(n)}/site/">${escHtml(n)}</a></li>`).join('')
    : '<li class="empty">（暂无登记仓库：在某个 repo 跑 <code>/lore:init</code>）</li>';
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>lore portal</title>
<style>body{font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#1a1b26;color:#c0caf5;max-width:680px;margin:48px auto;padding:0 20px}
h1{color:#fff;font-size:22px}a{color:#7aa2f7;text-decoration:none}a:hover{text-decoration:underline}
ul{list-style:none;padding:0}li{margin:10px 0;font-size:16px}.empty{color:#565f89;font-size:13px}
code{background:#1e202e;padding:2px 6px;border-radius:4px}</style>
</head><body><h1>lore portal</h1><p>本机已登记的 lore 仓库：</p><ul>${items}</ul></body></html>`;
}

// 单机共享门户：一个端口聚合本机所有 lore repo。repoMap: { name -> loreDir }。
// MVP 只读：/<name>/api/… 一律 404（无 write 面 → 无 DNS-rebind 写风险）。配合 .listen 仅绑 127.0.0.1。
export function createPortalServer(repoMap) {
  return http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch { res.writeHead(400); return res.end('bad request'); }

    if (pathname === '/' || pathname === '') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(renderRepoList(Object.keys(repoMap)));
    }

    const m = pathname.match(/^\/([^/]+)(\/.*)?$/);
    const name = m && m[1];
    // hasOwnProperty（非 `in`）：避免 'constructor'/'__proto__' 这类继承键误判为已登记 repo。
    if (!name || !Object.prototype.hasOwnProperty.call(repoMap, name)) {
      res.writeHead(404); return res.end('not found');
    }
    if (m[2] === undefined) {                        // "/<name>" 无尾斜杠 → 跳到壳
      res.writeHead(302, { location: `/${name}/site/` });
      return res.end();
    }
    const rel = m[2].replace(/^\/+/, '');
    if (rel === 'api' || rel.startsWith('api/')) {   // MVP 只读：不路由写接口
      res.writeHead(404); return res.end('not found');
    }
    return serveStatic(repoMap[name], rel, res);
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/portal.test.js`
Expected: PASS（4 tests）。

- [ ] **Step 5: Commit**

```bash
git add server.js test/portal.test.js
git commit -m "feat(portal): createPortalServer aggregates repos by /<name>/ (read-only, whitelisted)"
```

---

## Task 4: `lib/portal.js` —— 门户生命周期 + CLI

**Files:**
- Create: `lib/portal.js`
- Test: `test/portal.test.js`（追加生命周期测试）

- [ ] **Step 1: 追加失败测试**

把以下内容**追加到** `test/portal.test.js` 末尾（复用文件顶部已 import 的 `mkdtempSync/mkdirSync/rmSync/writeFileSync/tmpdir/join`）：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/portal.test.js`
Expected: FAIL —— `Cannot find module '../lib/portal.js'`。

- [ ] **Step 3: 写实现**

Create `lib/portal.js`:

```js
// lib/portal.js — 单机共享门户生命周期：一个固定端口（7842）的常驻 server 聚合本机所有 lore repo。
// 与 per-repo lib/serve.js 共存（只复用其跨平台 killPid/isAlive）。
import net from 'node:net';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createPortalServer } from '../server.js';
import { listRepos, defaultReposPath } from './repos.js';
import { isAlive, killPid } from './serve.js';

export const PORTAL_PORT = 7842;
const SELF = fileURLToPath(import.meta.url);

export function portalPidPath(home = homedir()) {
  return join(home, '.lore', 'portal.pid');
}

function readPidFile(p) {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function writePidFile(p, info) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(info, null, 2) + '\n');
}
function clearPidFile(p) { rmSync(p, { force: true }); }

// [{name, loreDir}] → { name: loreDir }，喂给 createPortalServer。
export function toMap(repos) {
  const map = {};
  for (const r of repos) map[r.name] = r.loreDir;
  return map;
}

// 等子进程绑上端口（复刻 serve.js 的私有 waitForPort，避免改动 serve.js）。
function waitForPort(port, tries = 50) {
  return new Promise((resolve) => {
    const attempt = (n) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => {
        s.destroy();
        if (n <= 0) return resolve(false);
        setTimeout(() => attempt(n - 1), 60);
      });
    };
    attempt(tries);
  });
}

// 启动常驻门户。已在跑（pid alive）则幂等返回 URL（reused:true）。否则 detached spawn
// `node lib/portal.js __run <port>`，写 ~/.lore/portal.pid，等其绑端口。
export async function start({ home = homedir(), port = PORTAL_PORT, spawnFn = spawn } = {}) {
  const pidPath = portalPidPath(home);
  const existing = readPidFile(pidPath);
  if (existing && isAlive(existing.pid)) {
    return { ...existing, url: `http://127.0.0.1:${existing.port}/`, reused: true };
  }
  const child = spawnFn(process.execPath, [SELF, '__run', String(port)], { detached: true, stdio: 'ignore' });
  child.unref();
  const info = { pid: child.pid, port };
  writePidFile(pidPath, info);
  const ready = await waitForPort(port);
  if (!ready) {
    clearPidFile(pidPath);
    throw new Error(`lore portal (pid ${child.pid}) did not bind on port ${port} within ~3s`);
  }
  return { ...info, url: `http://127.0.0.1:${port}/`, reused: false };
}

// 停掉门户：读 pid → 跨平台 kill（复用 serve.js）→ 清 pid 文件。
export async function stop({ home = homedir() } = {}) {
  const pidPath = portalPidPath(home);
  const info = readPidFile(pidPath);
  if (!info) return { stopped: false };
  if (isAlive(info.pid)) killPid(info.pid, process.platform);
  clearPidFile(pidPath);
  return { stopped: true, pid: info.pid };
}

if (process.argv[1] === SELF) {
  const sub = process.argv[2];
  if (sub === '__run') {
    // detached 子进程入口：读 registry → 建门户 → 仅绑 127.0.0.1。
    const port = Number(process.argv[3]) || PORTAL_PORT;
    createPortalServer(toMap(listRepos())).listen(port, '127.0.0.1',
      () => console.log(`lore portal on 127.0.0.1:${port}`));
  } else if (sub === 'start') {
    start().then((info) => {
      const tag = info.reused ? ' (already running)' : '';
      console.log(`▶ lore portal${tag} ${info.url}   stop: /lore:portal stop`);
    }).catch((e) => { console.error(e.message); process.exit(1); });
  } else if (sub === 'stop') {
    stop().then((res) => console.log(res.stopped ? '■ portal stopped' : 'no running portal'))
      .catch((e) => { console.error(e.message); process.exit(1); });
  } else if (sub === 'list') {
    const repos = listRepos();
    if (!repos.length) console.log('no lore repos registered (run /lore:init in a repo)');
    else for (const r of repos) console.log(`${r.name}  ${r.loreDir}`);
  } else {
    console.error('usage: node lib/portal.js start|stop|list');
    process.exit(1);
  }
}
```

> **生命周期测试覆盖范围说明（无静默缺口）：** 复用路径（pid 活）、stop no-op、stop 清死 pid、CLI list 均确定性覆盖。**真实 spawn-and-bind**（start 走 spawn 分支真起一个 7842 进程）不在自动化测试里——固定端口 7842 易与本机真实门户冲突、引入 flake；该胶水层薄且与 `serve.js` 的 start 形态同构（已被 serve.test 充分测过）。改用 Task 9 的手动冒烟验证真实启停。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/portal.test.js`
Expected: PASS（4 路由 + 5 生命周期 = 9 tests）。

- [ ] **Step 5: Commit**

```bash
git add lib/portal.js test/portal.test.js
git commit -m "feat(portal): portal lifecycle CLI (start/stop/list) on fixed port 7842"
```

---

## Task 5: 壳 base 前缀感知（`site/shell.mjs` + `site/index.html`）

**Files:**
- Modify: `site/shell.mjs`（新增导出 `baseFromPathname`）
- Modify: `site/index.html`（import + 计算 `BASE`，4 处 fetch 改前缀）
- Test: `test/shell.test.js`（追加 `baseFromPathname` 测试）

- [ ] **Step 1: 追加失败测试**

把以下内容追加到 `test/shell.test.js` 末尾：

```js
import { baseFromPathname } from '../site/shell.mjs';

test('baseFromPathname: per-repo serve (/site/...) → "/"', () => {
  assert.equal(baseFromPathname('/site/'), '/');
  assert.equal(baseFromPathname('/site/index.html'), '/');
});

test('baseFromPathname: portal (/<repo>/site/...) → "/<repo>/"', () => {
  assert.equal(baseFromPathname('/lore/site/'), '/lore/');
  assert.equal(baseFromPathname('/lore/site/index.html'), '/lore/');
  assert.equal(baseFromPathname('/ti/site/'), '/ti/');
});

test('baseFromPathname: 无 /site 段 → "/" 兜底', () => {
  assert.equal(baseFromPathname('/'), '/');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/shell.test.js`
Expected: FAIL —— `baseFromPathname` 未从 `../site/shell.mjs` 导出。

- [ ] **Step 3: 实现 `baseFromPathname`**

在 `site/shell.mjs` 末尾追加：

```js
// 壳被 serve 在 <base>site/(index.html)：per-repo 下 <base> 为 "/"，portal 下为 "/<repo>/"。
// 从文档路径推断该前缀，让 wiki/api fetch 不写死、自动命中正确前缀。
export function baseFromPathname(pathname) {
  const i = pathname.lastIndexOf('/site');
  return i >= 0 ? pathname.slice(0, i + 1) : '/';
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/shell.test.js`
Expected: PASS（含原有用例 + 3 个新用例）。

- [ ] **Step 5: `site/index.html` import + 计算 BASE**

把 import 块：

```js
import {
  stripFrontmatter, renderMarkdown, buildPageIndex, preprocessWikilinks,
  buildNavModel, buildMeta, chooseInitialLanguage, resolveLocalizedPage,
} from './shell.mjs';
```

改为：

```js
import {
  stripFrontmatter, renderMarkdown, buildPageIndex, preprocessWikilinks,
  buildNavModel, buildMeta, chooseInitialLanguage, resolveLocalizedPage,
  baseFromPathname,
} from './shell.mjs';

// per-repo serve 下 BASE="/"（行为同旧 ../wiki）；portal 下 BASE="/<repo>/"。
const BASE = baseFromPathname(location.pathname);
```

- [ ] **Step 6: 4 处 fetch 改前缀**

在 `site/index.html` 内逐处替换（各处唯一）：

`boot()` 里：
```js
  MANIFEST = await (await fetch('../wiki/.manifest.json')).json();
```
→
```js
  MANIFEST = await (await fetch(BASE + 'wiki/.manifest.json')).json();
```

`wireLanguage()` 里：
```js
      await fetch('../api/preferences', {
```
→
```js
      await fetch(BASE + 'api/preferences', {
```

`route()` 里：
```js
  const raw = await (await fetch('../wiki/' + localized.path)).text();
```
→
```js
  const raw = await (await fetch(BASE + 'wiki/' + localized.path)).text();
```

`route()` 里（translate 按钮）：
```js
        await fetch('../api/translation-requests', {
```
→
```js
        await fetch(BASE + 'api/translation-requests', {
```

> `s.src = './mermaid.min.js'`（同目录相对路径）**不改**——portal/per-repo 下都正确解析。

- [ ] **Step 7: 跑全量测试确认无回归**

Run: `node --test`
Expected: PASS（全绿）。`site/index.html` 的内联脚本无单测；改动是纯前缀拼接，per-repo 下 `BASE="/"` 使 `/wiki/...` 与旧 `../wiki/...`（在 `/site/` 下）解析到同一处。真实浏览器行为在 Task 9 手动冒烟。

- [ ] **Step 8: Commit**

```bash
git add site/shell.mjs site/index.html test/shell.test.js
git commit -m "feat(shell): base-prefix aware fetch (portal /<repo>/ + per-repo /)"
```

---

## Task 6: `lib/init.js` —— init 自动登记本 repo

把登记放在 **CLI 块**（仅 `node lib/init.js` 跑时执行），**不放进纯函数 `init()`**——`init()` 被 9 个测试文件在进程内调用，放进去会污染真实 `~/.lore/repos.json`。

**Files:**
- Modify: `lib/init.js`（顶部 import + CLI 块末尾 `registerRepo`）
- Test: `test/init.test.js`（改现有「CLI: node lib/init.js」用例：隔离 HOME + 断言登记）

- [ ] **Step 1: 改失败测试**

在 `test/init.test.js` 中，把现有用例：

```js
test('CLI: node lib/init.js <repo> initializes and prints summary', () => {
  const root = tmpRepo();
  try {
    const out = execFileSync('node', ['lib/init.js', root], { cwd: process.cwd() }).toString();
    assert.match(out, /lore initialized/);
    assert.match(out, /shell copied: index\.html, shell\.mjs, mermaid\.min\.js/);
    // uses the REAL plugin site/ (self-located) — both shell files land in the temp repo
    assert.equal(existsSync(join(root, '.lore', 'site', 'index.html')), true);
    assert.equal(existsSync(join(root, '.lore', 'site', 'shell.mjs')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

替换为：

```js
test('CLI: node lib/init.js <repo> initializes, prints summary, registers for portal', () => {
  const root = tmpRepo();
  const home = mkdtempSync(join(tmpdir(), 'lore-init-home-'));   // 隔离 ~/.lore/repos.json，防污染
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const out = execFileSync('node', ['lib/init.js', root], { cwd: process.cwd(), env }).toString();
    assert.match(out, /lore initialized/);
    assert.match(out, /shell copied: index\.html, shell\.mjs, mermaid\.min\.js/);
    // uses the REAL plugin site/ (self-located) — both shell files land in the temp repo
    assert.equal(existsSync(join(root, '.lore', 'site', 'index.html')), true);
    assert.equal(existsSync(join(root, '.lore', 'site', 'shell.mjs')), true);
    // init 把本 repo 登记进（隔离的）portal registry
    const repos = JSON.parse(readFileSync(join(home, '.lore', 'repos.json'), 'utf8'));
    assert.equal(repos.some(e => e.loreDir === join(root, '.lore')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
```

> `test/init.test.js` 顶部已 import `mkdtempSync`、`readFileSync`（fs）与 `tmpdir`（os），无需新增 import。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/init.test.js`
Expected: FAIL —— `home/.lore/repos.json` 不存在（init CLI 还没登记），`readFileSync` 抛错。

- [ ] **Step 3: 写实现**

在 `lib/init.js` 顶部 import 区（现有 imports 之后）加：

```js
import { registerRepo, defaultReposPath } from './repos.js';
```

在 `lib/init.js` 底部 CLI 块中，把：

```js
  const r = init({ repoRoot, srcSiteDir });
  console.log(`✓ lore initialized at ${r.loreDir}`);
  console.log(`  shell copied: ${r.copied.join(', ')}`);
  console.log(`  components discovered: ${r.codeRoots.length ? r.codeRoots.join(', ') : '(none — edit .lore/config.yml)'}`);
  console.log(`  config.yml: ${r.configWritten ? 'written' : 'kept (already existed)'}`);
  console.log(`  .gitignore: ${r.gitignore}`);
  console.log('  next: edit .lore/config.yml if needed, then /lore:sync');
```

替换为（在 `.gitignore` 行后插入登记 + 提示，best-effort）：

```js
  const r = init({ repoRoot, srcSiteDir });
  console.log(`✓ lore initialized at ${r.loreDir}`);
  console.log(`  shell copied: ${r.copied.join(', ')}`);
  console.log(`  components discovered: ${r.codeRoots.length ? r.codeRoots.join(', ') : '(none — edit .lore/config.yml)'}`);
  console.log(`  config.yml: ${r.configWritten ? 'written' : 'kept (already existed)'}`);
  console.log(`  .gitignore: ${r.gitignore}`);
  let registered = null;
  try { registered = registerRepo(defaultReposPath(), { loreDir: r.loreDir }); }
  catch { /* portal 登记 best-effort：失败不阻断 init */ }
  console.log(`  portal: ${registered ? `已登记为 “${registered.name}”（/lore:portal start 聚合浏览）` : '(登记跳过)'}`);
  console.log('  next: edit .lore/config.yml if needed, then /lore:sync');
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/init.test.js`
Expected: PASS（全部用例绿；新用例断言登记成功）。

- [ ] **Step 5: 确认其他 init() 调用方零污染**

Run: `node --test test/ask.test.js test/hook.test.js test/integration.test.js test/lint.test.js test/mine.test.js test/note.test.js test/sync.test.js`
Expected: PASS。这些文件在进程内调用纯函数 `init()`（未走 CLU 块），登记只在 CLI 块发生，故不写 `~/.lore/repos.json`，无污染、无回归。

- [ ] **Step 6: Commit**

```bash
git add lib/init.js test/init.test.js
git commit -m "feat(init): auto-register repo in ~/.lore/repos.json on init CLI (best-effort)"
```

---

## Task 7: `commands/portal.md` —— `/lore:portal` slash 命令

**Files:**
- Create: `commands/portal.md`

> 命令由 `commands/*.md` 自动发现，`.claude-plugin/plugin.json` 不列命令清单 → 无需改 manifest。

- [ ] **Step 1: 写命令文档**

Create `commands/portal.md`:

```md
---
description: 启动/停止单机共享门户，一个端口聚合本机所有 lore 仓库
---

# /lore:portal

启动一个**常驻共享门户**（固定端口 `7842`，仅绑 `127.0.0.1`），在一个浏览器入口聚合本机所有已登记的 lore 仓库：顶层选 repo → 进该 repo 的多轴 wiki。与 per-repo 的 `/lore:serve` 共存（serve 仍各用各的稳定端口）。

## 用法

- `/lore:portal start` —— 启动门户（已在跑则幂等返回 URL）
- `/lore:portal stop` —— 停止门户
- `/lore:portal list` —— 列出本机已登记的 lore 仓库

## 行为

本命令是 `lib/portal.js` 的薄封装，可在任意目录运行（门户读 `~/.lore/repos.json` 发现各仓库，与当前目录无关）。

**启动**：

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/portal.js" start
```

**停止**：

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/portal.js" stop
```

**列出仓库**：

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/portal.js" list
```

## 给 agent 的提示

- 仓库通过 `/lore:init` 自动登记到 `~/.lore/repos.json`；门户启动时读取该清单。新初始化仓库后，重启门户（`stop` 再 `start`）即可纳入。
- 门户 **MVP 只读**：不路由任何写接口（`/<repo>/api/…` 返回 404）。需要语言偏好持久化 / 翻译请求等写操作时，用 per-repo `/lore:serve`。
- 仅绑 `127.0.0.1`（绝不暴露到局域网）。把打印出的 URL（`http://127.0.0.1:7842/`）告诉用户；进程后台常驻，不阻塞会话。
- 顶层 `/` 是 repo 选择器；点某仓库进入 `/<name>/site/` 浏览其 wiki。
- 不要修改任何目标仓库源码；门户只读各仓库的 `.lore/`。
```

- [ ] **Step 2: Commit**

```bash
git add commands/portal.md
git commit -m "docs(portal): add /lore:portal slash command"
```

---

## Task 8: 文档同步（CHANGELOG / README / ROADMAP）

**Files:**
- Modify: `CHANGELOG.md`、`README.md`、`docs/ROADMAP.md`

- [ ] **Step 1: CHANGELOG —— 新增 0.6.0 段**

在 `CHANGELOG.md` 中，把：

```md
## [0.5.1] — 2026-06-06
```

替换为（在其上方插入新段）：

```md
## [0.6.0] — 2026-06-07

### 新增
- **单机共享门户（portal MVP）** — 一个常驻 server（固定端口 `7842`，仅绑 `127.0.0.1`）聚合本机所有 lore 仓库：顶层 `/` repo 选择器 → `/<name>/site/` 进该仓库多轴 wiki。仓库发现走中央 `~/.lore/repos.json`（`/lore:init` 自动登记、`listRepos` 过滤已失效条目）；路由用 repo 根目录名（同名加 `-2` 后缀兜底）。新 `/lore:portal start|stop|list` 命令；与 per-repo `/lore:serve`（各自 `stablePort`）共存。（`lib/repos.js`、`lib/portal.js`、`server.js`、`commands/portal.md`）
- **共享静态 serve 逻辑** — 从 `server.js` 的 `createServer` 提取 `serveStatic(root, rel, res)`（穿越防护 + dir→index.html + MIME 流式），per-repo server 与 portal 共用同一套静态语义；新 `createPortalServer(repoMap)` 复用之。
- **壳 base 前缀感知** — `site/shell.mjs` 新增 `baseFromPathname`，壳从 `location.pathname` 推断 `/<repo>/site/` 前缀，wiki/api fetch 自动带正确前缀（per-repo 下为 `/`、行为不变；portal 下带 `/<name>/`）。

### 安全
- portal **MVP 只读**：`/<name>/api/…` 一律 404（无 write 面 → 无 DNS-rebind 写风险）；只 serve `~/.lore/repos.json` 白名单内的 loreDir，每 root 独立 normalize 穿越防护；仅绑 `127.0.0.1`。

## [0.5.1] — 2026-06-06
```

- [ ] **Step 2: README —— 快速上手加 portal**

在 `README.md` 中，把：

```bash
# 4. 浏览（浏览器，无需 Obsidian）
node lib/serve.js start --lore /path/to/your-repo/.lore   # 打印 127.0.0.1 URL
node lib/serve.js stop  --lore /path/to/your-repo/.lore
```

替换为：

```bash
# 4. 浏览（浏览器，无需 Obsidian）
node lib/serve.js start --lore /path/to/your-repo/.lore   # 打印 127.0.0.1 URL
node lib/serve.js stop  --lore /path/to/your-repo/.lore

# 4b.（可选）单机共享门户：一个端口（7842）聚合本机所有已登记 lore 仓库
node lib/portal.js start   # 打印 http://127.0.0.1:7842/ ；另有 stop / list
```

- [ ] **Step 3: README —— 命令表加 portal 行**

在 `README.md` 命令表中，把：

```md
| `/lore:serve` | 浏览 | 起本地哑服务器 + 浏览器壳（侧栏/渲染/搜索/多主题），只读 | 否 |
```

替换为：

```md
| `/lore:serve` | 浏览 | 起本地哑服务器 + 浏览器壳（侧栏/渲染/搜索/多主题），只读 | 否 |
| `/lore:portal` | 浏览（聚合） | 单机一个常驻门户（7842）聚合本机所有 lore 仓库，顶层选 repo，只读 | 否 |
```

- [ ] **Step 4: ROADMAP —— 标记 portal MVP 完成**

在 `docs/ROADMAP.md` 中，把「已完成」段的 v0.5.0 bullet：

```md
- **v0.5.0** 人读 **HOME 首页**（HOME 轴）· 持久化**双语层 i18n**（语言配置 + 翻译 sidecar + `/lore:translate` 命令 + 语言切换器 + 本地 state API + Host-guard 安全）。注：翻译**按需生成**（非 sync 自动），未译时回退源页显「missing」。
```

替换为（其后追加 v0.6.0 行）：

```md
- **v0.5.0** 人读 **HOME 首页**（HOME 轴）· 持久化**双语层 i18n**（语言配置 + 翻译 sidecar + `/lore:translate` 命令 + 语言切换器 + 本地 state API + Host-guard 安全）。注：翻译**按需生成**（非 sync 自动），未译时回退源页显「missing」。
- **v0.6.0（portal MVP）** 单机共享门户 —— 固定端口 `7842` 一个常驻 server 聚合本机所有 lore repo（`~/.lore/repos.json` 发现 + init 自动登记 + `/<name>/` 路由 + `/` repo 选择器 + 只读 + 白名单/穿越防护）。`/lore:portal start|stop|list`，与 per-repo `/lore:serve` 共存。设计见 `docs/superpowers/specs/2026-06-07-lore-portal-design.md`。
```

在 `docs/ROADMAP.md` 的中期段，把：

```md
### 单机共享 wiki server（多 repo 聚合门户）⚑ 待头脑风暴
```

替换为：

```md
### 单机共享 wiki server（多 repo 聚合门户）✅ MVP 已实现（v0.6）· 余项待迭代
> MVP 已实现（见上「已完成 v0.6.0」）：单进程聚合 + 中央 registry + `/<name>/` 路由 + repo 选择器 + 只读白名单。**余项（后续迭代）**：跨 repo 全局搜索、write API 多路由、壳内「切 repo」下拉、per-repo serve 自动迁移/端口回收、namespace 高级冲突策略。
```

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md README.md docs/ROADMAP.md
git commit -m "docs(portal): changelog 0.6.0 + README portal + ROADMAP MVP done"
```

---

## Task 9: 全量验证 + 手动冒烟

**REQUIRED SUB-SKILL:** Use superpowers:verification-before-completion —— 先看到证据再宣称完成。

**Files:** 无（仅验证）

- [ ] **Step 1: 全量测试全绿**

Run: `node --test`
Expected: PASS —— 0 failures。记录 `# tests` / `# pass` / `# fail` 实际数字（不臆断）。

- [ ] **Step 2: 手动冒烟门户真实启停（验证 spawn-and-bind 胶水层）**

> 这步真起一个 7842 端口的进程；若本机已有门户在跑，先 `node lib/portal.js stop`。

在 bash 跑（用临时 HOME 隔离，不碰真实 `~/.lore`）：

```bash
TMPH=$(mktemp -d)
mkdir -p "$TMPH/demo/.lore/wiki"
echo '{"axes":[]}' > "$TMPH/demo/.lore/wiki/.manifest.json"
mkdir -p "$TMPH/demo/.lore/site"
echo '<!doctype html>PORTAL_SMOKE_OK' > "$TMPH/demo/.lore/site/index.html"
HOME="$TMPH" USERPROFILE="$TMPH" node -e "import('./lib/repos.js').then(m=>m.registerRepo(m.defaultReposPath('$TMPH'),{loreDir:'$TMPH/demo/.lore'}))"
HOME="$TMPH" USERPROFILE="$TMPH" node lib/portal.js start
sleep 1
echo "--- GET / ---";                 curl -s http://127.0.0.1:7842/ | grep -o 'href="/demo/site/"'
echo "--- GET /demo/site/ ---";       curl -s http://127.0.0.1:7842/demo/site/ | grep -o PORTAL_SMOKE_OK
echo "--- GET /demo/wiki/.manifest.json ---"; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7842/demo/wiki/.manifest.json
echo "--- GET /demo/api/preferences (期望 404) ---"; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7842/demo/api/preferences
echo "--- GET /nope/wiki/x (期望 404) ---"; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7842/nope/wiki/x.md
HOME="$TMPH" USERPROFILE="$TMPH" node lib/portal.js stop
rm -rf "$TMPH"
```

Expected:
- `GET /` 输出 `href="/demo/site/"`（repo 选择器列出 demo）
- `GET /demo/site/` 输出 `PORTAL_SMOKE_OK`（壳命中）
- `GET /demo/wiki/.manifest.json` → `200`
- `GET /demo/api/preferences` → `404`（MVP 只读）
- `GET /nope/wiki/x.md` → `404`（白名单）
- stop 打印 `■ portal stopped`

- [ ] **Step 3: 零侵入自检**

Run: `git status`
Expected: 工作区干净（所有改动已 commit）；无对业务源码的意外改动。

- [ ] **Step 4:（可选）合并收尾**

实现完成、全绿后，用 superpowers:finishing-a-development-branch 决定合并/PR/清理。

---

## Self-Review（计划自查，已执行）

**1. Spec 覆盖：** 设计 A（repos registry）→ Task 1；B.1（serveStatic 提取）→ Task 2；B.2（createPortalServer：`/`、`/<name>/<rest>`、`/<name>` 302、`api/` 404、仅绑 127）→ Task 3 + Task 4 `__run`；C（portal CLI start/stop/list、固定 7842、portal.pid、复用 killPid、与 serve 共存）→ Task 4；D（壳 base 前缀感知）→ Task 5；E（白名单/穿越/127-only/零依赖/serve 不回归）→ Task 2 回归 + Task 3 安全测试。init 登记 → Task 6。测试 1-7（spec §测试）：repos 1-2 → Task 1；portal 3-6 → Task 3；serve 回归 7 → Task 2 Step 1/4。改动清单 5 文件全覆盖（含 commands/portal.md）。

**2. Placeholder 扫描：** 每个代码步骤含完整代码；每个命令步骤含确切命令 + 期望输出。无 TBD/“类似上文”。

**3. 类型/签名一致性：** `registerRepo(reposPath, {loreDir})`、`listRepos(reposPath?)`、`defaultReposPath(home?)`、`serveStatic(rootDir, rel, res)`、`createPortalServer(repoMap)`、`toMap(repos)`、`start({home?,port?,spawnFn?})`、`stop({home?})`、`portalPidPath(home?)`、`PORTAL_PORT`、`baseFromPathname(pathname)` —— 各任务定义与调用处签名一致。`__run` 子进程入口与 `start` 的 spawn 参数 `[SELF, '__run', String(port)]` 对齐。

**4. 测试卫生：** init 登记只在 CLI 块（9 个进程内 `init()` 调用方不污染）；CLI init 测试 + portal list 测试用 `HOME/USERPROFILE` 临时隔离（同 serve.test 既有模式）；生命周期测试用注入 `home`/`spawnFn` + 本进程 pid（必活）/不可能 pid（必死），确定性、不碰 7842。

