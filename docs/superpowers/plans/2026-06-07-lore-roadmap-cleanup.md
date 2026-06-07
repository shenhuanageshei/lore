# lore roadmap 收尾 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清掉 roadmap 4 项：#3 server 运维踏脚石（稳定端口 + registry + list/stop-all）、#4 HOME 翻译 stale、#5 HOME 空段、#6 docs 页 chips。

**Architecture:** 新 `lib/registry.js`（`~/.lore/servers.json` 纯函数 CRUD）；`serve.js` 加 `stablePort`/`listRunning`/`stopAllRunning`（可注入）+ CLI registry 接入（start/stop 函数保持纯）；`i18n.js` hash 剔哨兵；`home.js` 空段省略；`manifest.js pageEntry` 带 `axis` + `shell.mjs buildMeta` docs 分支。

**Tech Stack:** Node.js (ESM) · `node:crypto`/`node:os` · `node:test` · 零依赖。

**前置 spec:** `docs/superpowers/specs/2026-06-07-lore-roadmap-cleanup-design.md`

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `lib/registry.js` | `~/.lore/servers.json` CRUD（path 可注入） | 新建 |
| `test/registry.test.js` | registry 单测 | 新建 |
| `lib/serve.js` | `stablePort` + `listRunning`/`stopAllRunning` + CLI 接入 | 改 |
| `lib/i18n.js` | `translationSourceHash` 剔哨兵 | 改 |
| `lib/home.js` | `defaultHomePage` 空段省略 | 改 |
| `lib/manifest.js` | `pageEntry` 加 `axis` | 改 |
| `site/shell.mjs` | `buildMeta` docs 分支 | 改 |
| `test/{serve,i18n,home,manifest,shell}.test.js` | 各追加用例 | 改 |

---

## Task 1: `lib/registry.js`（#3 registry）

**Files:** Create `lib/registry.js`, `test/registry.test.js`

- [ ] **Step 1: 写失败测试** — Create `test/registry.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerServer, unregisterServer, listServers } from '../lib/registry.js';

function tmpPath() { return join(mkdtempSync(join(tmpdir(), 'lore-reg-')), 'servers.json'); }

test('registry: missing file → []', () => {
  assert.deepEqual(listServers(join(tmpdir(), 'lore-reg-nope', 'x.json')), []);
});

test('registry: register, dedupe by loreDir, unregister', () => {
  const p = tmpPath();
  try {
    registerServer({ loreDir: '/a', pid: 1, port: 7001, started: 't' }, p);
    registerServer({ loreDir: '/b', pid: 2, port: 7002, started: 't' }, p);
    registerServer({ loreDir: '/a', pid: 3, port: 7003, started: 't' }, p);   // 替换 /a
    let all = listServers(p);
    assert.equal(all.length, 2);
    assert.equal(all.find(e => e.loreDir === '/a').pid, 3);
    unregisterServer('/a', p);
    all = listServers(p);
    assert.deepEqual(all.map(e => e.loreDir), ['/b']);
  } finally { rmSync(join(p, '..'), { recursive: true, force: true }); }
});

test('registry: corrupt JSON → []', () => {
  const p = tmpPath();
  try { writeFileSync(p, '{bad'); assert.deepEqual(listServers(p), []); }
  finally { rmSync(join(p, '..'), { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/registry.test.js` → FAIL（模块不存在）。

- [ ] **Step 3: 写实现** — Create `lib/registry.js`:
```js
// ~/.lore/servers.json 中央登记（活跃 lore server）。path 可注入便于测。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export function registryPath(home = homedir()) {
  return join(home, '.lore', 'servers.json');
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

export function listServers(path = registryPath()) { return read(path); }

export function registerServer(entry, path = registryPath()) {
  const arr = read(path).filter(e => e.loreDir !== entry.loreDir);
  arr.push(entry);
  write(path, arr);
  return arr;
}

export function unregisterServer(loreDir, path = registryPath()) {
  const arr = read(path).filter(e => e.loreDir !== loreDir);
  write(path, arr);
  return arr;
}
```

- [ ] **Step 4: 跑测试确认通过** — Run: `node --test test/registry.test.js` → PASS（3）。

- [ ] **Step 5: Commit**
```bash
git add lib/registry.js test/registry.test.js
git commit -m "feat(registry): ~/.lore/servers.json server registry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `serve.js` stablePort + list/stop-all（#3）

**Files:** Modify `lib/serve.js`, `test/serve.test.js`

- [ ] **Step 1: 写失败测试** — `test/serve.test.js` 顶部 import 行加入 `stablePort, listRunning, stopAllRunning`（与现有 `start, stop` 同一条 from `'../lib/serve.js'`）。追加到末尾：
```js
import { mkdtempSync as _mkdtemp2, rmSync as _rm2 } from 'node:fs';
import { tmpdir as _tmp2 } from 'node:os';
import { join as _join2 } from 'node:path';
import { registerServer as _reg } from '../lib/registry.js';

test('stablePort: deterministic + in 7000-7999', () => {
  const a = stablePort('/repo/x');
  assert.equal(a, stablePort('/repo/x'));
  assert.ok(a >= 7000 && a <= 7999);
});

test('listRunning: keeps alive, prunes dead from registry', () => {
  const p = _join2(_mkdtemp2(_join2(_tmp2(), 'lore-lr-')), 'servers.json');
  try {
    _reg({ loreDir: '/alive', pid: 111, port: 7001, started: 't' }, p);
    _reg({ loreDir: '/dead', pid: 222, port: 7002, started: 't' }, p);
    const alive = (pid) => pid === 111;
    const running = listRunning(p, alive);
    assert.deepEqual(running.map(s => s.loreDir), ['/alive']);
    // dead 已从 registry 清掉
    assert.deepEqual(listRunning(p, () => true).map(s => s.loreDir), ['/alive']);
  } finally { _rm2(_join2(p, '..'), { recursive: true, force: true }); }
});

test('stopAllRunning: kills alive + clears registry', () => {
  const p = _join2(_mkdtemp2(_join2(_tmp2(), 'lore-sa-')), 'servers.json');
  try {
    _reg({ loreDir: '/a', pid: 1, port: 7001, started: 't' }, p);
    _reg({ loreDir: '/b', pid: 2, port: 7002, started: 't' }, p);
    const killed = [];
    const n = stopAllRunning(p, () => true, (pid) => killed.push(pid), 'linux');
    assert.equal(n, 2);
    assert.deepEqual(killed.sort(), [1, 2]);
    assert.deepEqual(listRunning(p, () => true), []);
  } finally { _rm2(_join2(p, '..'), { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/serve.test.js` → FAIL（`stablePort` 等未 export）。

- [ ] **Step 3: 写实现** — `lib/serve.js`：

3a. 顶部 import 区加：
```js
import { createHash } from 'node:crypto';
import { registryPath, registerServer, unregisterServer, listServers } from './registry.js';
```

3b. 在 `findPort` 之前（约 64 行后）加：
```js
export function stablePort(loreDir) {
  const h = createHash('sha1').update(loreDir).digest('hex').slice(0, 6);
  return 7000 + (parseInt(h, 16) % 1000);
}

// registry 中活着的 server；顺带把死条目从 registry 清掉。path/alive 可注入便于测。
export function listRunning(path = registryPath(), alive = isAlive) {
  const running = [];
  for (const s of listServers(path)) {
    if (alive(s.pid)) running.push(s);
    else unregisterServer(s.loreDir, path);
  }
  return running;
}

// 停掉 registry 里所有 server 并注销。返回 kill 数。可注入。
export function stopAllRunning(path = registryPath(), alive = isAlive, kill = killPid, platform = process.platform) {
  let n = 0;
  for (const s of listServers(path)) {
    if (alive(s.pid)) { kill(s.pid, platform); n++; }
    unregisterServer(s.loreDir, path);
  }
  return n;
}
```

3c. `start` 签名把 `port = 7842` 改为 `port`（无默认），并在函数体顶部加：
```js
  const stateDir = join(loreDir, '.state');
  const targetPort = port ?? stablePort(loreDir);
```
然后把 `const chosen = await findPort(port);` 改为 `const chosen = await findPort(targetPort);`。（`start`/`stop` 函数本身不碰 registry → 保持纯、测试不污染 `~/.lore`。）

3d. CLI block 改造：`start` 成功后登记、`stop` 后注销、加 `list`/`stop-all`：
```js
    if (sub === 'start') {
      if (!existsSync(join(loreDir, 'wiki', '.manifest.json'))) {
        console.error('No .lore/wiki/.manifest.json — run /lore:sync first.');
        process.exit(1);
      }
      const info = await start({ loreDir, port: args.port, now: new Date().toISOString() });
      registerServer({ loreDir, pid: info.pid, port: info.port, started: info.started ?? new Date().toISOString() });
      const tag = info.reused ? ' (already running)' : '';
      console.log(`▶ lore wiki${tag} ${info.url}   stop: /lore:serve --stop`);
    } else if (sub === 'stop') {
      const res = await stop({ loreDir });
      unregisterServer(loreDir);
      console.log(res.stopped ? '■ stopped' : 'no running lore server');
    } else if (sub === 'list') {
      const running = listRunning();
      if (!running.length) console.log('no running lore servers');
      else for (const s of running) console.log(`▶ ${s.port}  ${s.loreDir}  (pid ${s.pid})`);
    } else if (sub === 'stop-all') {
      const n = stopAllRunning();
      console.log(n ? `■ stopped ${n} server(s)` : 'no running lore servers');
    } else {
      console.error('usage: node lib/serve.js start|stop|list|stop-all [--lore <dir>] [--port N]');
      process.exit(1);
    }
```
（注：`info.started` 来自 start 返回的 info；start 返回对象已含 `started`。reused 分支 info 也含 started。）

- [ ] **Step 4: 跑测试确认通过** — Run: `node --test test/serve.test.js` → PASS（含原有 + 新 3）。

- [ ] **Step 5: Commit**
```bash
git add lib/serve.js test/serve.test.js
git commit -m "feat(serve): stable per-repo port + registry list/stop-all

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `i18n.js` 翻译 hash 剔哨兵（#4）

**Files:** Modify `lib/i18n.js`, `test/i18n.test.js`

- [ ] **Step 1: 写失败测试** — 追加到 `test/i18n.test.js` 末尾（文件已 import `translationSourceHash`；若没有则在顶部加 `import { translationSourceHash } from '../lib/i18n.js';`）:
```js
test('translationSourceHash: ignores sentinel region changes', () => {
  const mk = (status) =>
    '---\ntitle: Home\n---\n# Home\n\n<!-- LORE_HOME_STATUS:START -->\n' + status + '\n<!-- LORE_HOME_STATUS:END -->\n\n## Body\n\nprose\n';
  assert.equal(translationSourceHash(mk('v1 stuff')), translationSourceHash(mk('v2 different')));
});

test('translationSourceHash: still reflects real body changes', () => {
  const base = '---\ntitle: X\n---\n# X\n\n## Body\n\nprose one\n';
  const changed = '---\ntitle: X\n---\n# X\n\n## Body\n\nprose two\n';
  assert.notEqual(translationSourceHash(base), translationSourceHash(changed));
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/i18n.test.js` → FAIL（第一个：状态块变 hash 也变）。

- [ ] **Step 3: 写实现** — `lib/i18n.js` 把 `translationSourceHash` 改为：
```js
const SENTINEL_RE = /<!--\s*LORE_[A-Z_]+:START\s*-->[\s\S]*?<!--\s*LORE_[A-Z_]+:END\s*-->/g;
export function translationSourceHash(text) {
  const body = parseFrontmatter(text).body.replace(/\r\n/g, '\n').replace(SENTINEL_RE, '').trimEnd();
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}
```

- [ ] **Step 4: 跑测试确认通过** — Run: `node --test test/i18n.test.js` → PASS。

- [ ] **Step 5: Commit**
```bash
git add lib/i18n.js test/i18n.test.js
git commit -m "fix(i18n): exclude sentinel regions from translation source hash

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `home.js` 空段省略（#5）

**Files:** Modify `lib/home.js`, `test/home.test.js`

- [ ] **Step 1: 写失败测试** — 追加到 `test/home.test.js` 末尾（文件已 import `defaultHomePage`）:
```js
test('defaultHomePage: omits empty sections (no INDEX fallback)', () => {
  const md = defaultHomePage({ axisPages: { component: [{ id: 'lib' }] } });
  assert.match(md, /## Understand the project/);
  assert.match(md, /- \[\[lib\]\]/);
  assert.doesNotMatch(md, /## Debug a problem/);
  assert.doesNotMatch(md, /## Decisions and timeline/);
  assert.doesNotMatch(md, /\[\[INDEX\]\]/);
});

test('defaultHomePage: renders sections when docs present', () => {
  const md = defaultHomePage({ axisPages: { component: [{ id: 'lib' }], docs: [{ id: 'pitfalls' }, { id: 'changelog' }] } });
  assert.match(md, /## Debug a problem/);
  assert.match(md, /- \[\[pitfalls\]\]/);
  assert.match(md, /## Decisions and timeline/);
  assert.match(md, /- \[\[changelog\]\]/);
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/home.test.js` → FAIL（空段仍渲染 + INDEX fallback）。

- [ ] **Step 3: 写实现** — `lib/home.js` 把整个 `defaultHomePage` 替换为：
```js
export function defaultHomePage({ title = 'lore', axisPages = {} } = {}) {
  const ids = axis => (axisPages[axis] ?? []).map(p => p.id);
  const docs = ids('docs');
  const bullets = arr => arr.map(id => `- [[${id}]]`).join('\n');
  const section = (heading, items) => items.length ? `\n\n## ${heading}\n\n${bullets(items)}` : '';
  const understand = ids('component').slice(0, 3);
  const debug = ['pitfalls', 'ROADMAP', 'troubleshooting'].filter(id => docs.includes(id));
  const decisions = docs.includes('changelog') ? ['changelog'] : [];
  const head = `---\ntitle: Home\nsummary: human-readable orientation map for this repository\n---\n# ${title}\n\nThis repository is documented as a living wiki: code, docs, decisions, and flows are folded into pages humans and agents can both use.\n\n${HOME_STATUS_TOKEN}\n\n## Knowledge flow\n\n\`\`\`mermaid\nflowchart LR\n  repo["Repo code/docs"] --> capture["Capture"]\n  capture --> journal[".lore/journal"]\n  journal --> sync["Sync"]\n  sync --> wiki[".lore/wiki"]\n  wiki --> human["Human reading"]\n  wiki --> agent["Agent retrieval"]\n\`\`\``;
  return head + section('Understand the project', understand) + section('Debug a problem', debug) + section('Decisions and timeline', decisions) + '\n';
}
```

- [ ] **Step 4: 跑测试确认通过** — Run: `node --test test/home.test.js` → PASS。

- [ ] **Step 5: Commit**
```bash
git add lib/home.js test/home.test.js
git commit -m "fix(home): omit empty HOME sections instead of INDEX fallback

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: docs 页 chips（#6 · `manifest.js` + `shell.mjs`）

**Files:** Modify `lib/manifest.js`, `site/shell.mjs`, `test/manifest.test.js`, `test/shell.test.js`

- [ ] **Step 1: 写失败测试**

5a. 追加到 `test/shell.test.js` 末尾（文件已 import `buildMeta`；若无则顶部加 `import { buildMeta } from '../site/shell.mjs';`）:
```js
test('buildMeta: docs page → only last-updated chip (no atoms/code_sha)', () => {
  const chips = buildMeta({ axis: 'docs', last_updated: '2026-06-07', path: 'docs/x.md' }).chips;
  const text = chips.map(c => c.text).join(' | ');
  assert.match(text, /last-updated 2026-06-07/);
  assert.doesNotMatch(text, /atoms/);
  assert.doesNotMatch(text, /code_sha/);
});

test('buildMeta: component page keeps atoms + code_sha', () => {
  const chips = buildMeta({ axis: 'component', last_updated: '2026-06-07', code_sha: 'abc', synthesized_from: { atoms: 3, commits: 2 } }).chips;
  const text = chips.map(c => c.text).join(' | ');
  assert.match(text, /3 atoms · 2 commits/);
  assert.match(text, /code_sha abc/);
});
```

5b. 追加到 `test/manifest.test.js` 末尾:
```js
test('pageEntry: manifest pages carry their axis', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-axis-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki', 'component'), { recursive: true });
    writeFileSync(join(lore, 'wiki', 'component', 'lib.md'), '---\ntitle: Lib\nsummary: s\ncode_sha: abc\n---\n# component: lib\n');
    const { manifest } = runManifestCli(lore, 'now');
    const comp = manifest.axes.find(a => a.id === 'component');
    assert.equal(comp.pages[0].axis, 'component');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test test/shell.test.js test/manifest.test.js` → FAIL（buildMeta 不分 docs；page 无 axis）。

- [ ] **Step 3: 写实现**

5c. `lib/manifest.js` `pageEntry` 的 `return {` 对象里加 `axis: axisId,`（放在 `id,` 之后）:
```js
  return {
    id,
    axis: axisId,
    title: data.title ?? id,
```
（`axisId` 是 `pageEntry(wikiDir, axisId, id, ...)` 已有的参数；root 轴 HOME/INDEX 传入的是 `''`，无碍。）

5d. `site/shell.mjs` `buildMeta` 开头加 docs 分支:
```js
export function buildMeta(page) {
  if (page.axis === 'docs') {
    return { chips: [{ icon: '📄', text: `last-updated ${page.last_updated ?? '—'}`, kind: 'plain' }] };
  }
  const f = page.synthesized_from ?? { atoms: 0, commits: 0 };
```
（其余保持不变。）

- [ ] **Step 4: 跑测试确认通过** — Run: `node --test test/shell.test.js test/manifest.test.js` → PASS。

- [ ] **Step 5: Commit**
```bash
git add lib/manifest.js site/shell.mjs test/shell.test.js test/manifest.test.js
git commit -m "fix(meta): docs pages show last-updated only (no atoms/code_sha chips)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: 全量回归 + dogfood（收尾）

- [ ] **Step 1: 全量绿** — Run: `node --test` → 全量 PASS、0 fail。
- [ ] **Step 2: dogfood resync**
```bash
node lib/sync.js finalize .lore
git add .lore
git commit -m "chore(lore): dogfood resync — roadmap cleanup

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Expected: sync 无报错；HOME 空段不再出现冗余 `[[INDEX]]`、docs 页 chips 干净。

---

## Spec 覆盖核对（self-review 映射）

| spec 决策 | 落地 |
|---|---|
| #3 stablePort | Task 2 (3b) + 测试 |
| #3 registry CRUD | Task 1 |
| #3 list/stop-all（含清死条目） | Task 2 `listRunning`/`stopAllRunning` + CLI |
| #3 start/stop 纯（registry 在 CLI） | Task 2 (3c/3d) |
| #4 hash 剔哨兵 | Task 3 |
| #5 空段省略 | Task 4 |
| #6 pageEntry axis + buildMeta docs | Task 5 |
| 测试不污染 ~/.lore | Task 1/2 全部注入临时 path |
