---
title: /lore:serve Implementation Plan
summary: > **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [...
source_path: docs/superpowers/plans/2026-05-31-lore-serve.md
last_updated: 2026-05-31
---
> 源文档：`docs/superpowers/plans/2026-05-31-lore-serve.md`

# /lore:serve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/lore:serve` — a local static server + no-build browser shell that renders the lore wiki (sidebar nav, markdown, wikilink routing, search, freshness metadata, multi-theme) without requiring Obsidian.

**Architecture:** A dumb static file server (runtime probe chain: `python3` → `python` → bundled Node fallback) serves `.lore/`; all rendering happens client-side in a single no-build shell that `fetch`es `.lore/wiki/.manifest.json` + page `.md` files. A separate `emit_manifest` module (pure, git/clock injected) produces the manifest from wiki front-matter — it is the data contract the shell consumes and the finalizer `/lore:sync` will later call.

**Tech Stack:** Node.js (ESM, `type: module`), `node:test` built-in test runner (zero external deps), `node:http`/`node:fs`/`node:child_process`, vanilla browser JS + hand-rolled mini markdown renderer.

**Spec:** `docs/superpowers/specs/2026-05-31-lore-repo-wiki-design.md` §5.5. **Mockup (committed, layout/theme approved):** `docs/superpowers/specs/2026-05-31-lore-serve-mockup.html`.

**Deliberate refinements vs spec wording** (all preserve spec intent):
- Renderer: hand-rolled mini-renderer (not marked.js) — zero-dep, controlled input. Mockup already uses it; user approved.
- `site/` holds 2 no-build static files (`index.html` + `shell.mjs`) not 1 — isolates pure logic for headless tests. No bundler.
- `emit_manifest` injects git + clock → deterministic, unit-testable without a real repo (spec §11 byte-identical invariant holds as "deterministic function of inputs").
- Page front-matter is **flat `key: value`** (no nested YAML) — trivial zero-dep parse; serve-first defines this contract, future sync emits it.

---

## File Structure

```
D:\workspace\lore\                 (greenfield — this IS the plugin repo)
├── package.json                   # type:module, test script, zero deps
├── .gitignore                     # node_modules, .lore/.state
├── server.js                      # Node fallback static server (createServer + CLI)
├── lib/
│   ├── manifest.js                # parseFrontmatter, deriveAxes, emitManifest (+ CLI)
│   └── serve.js                   # probeRuntime, pid mgmt, start/stop (+ CLI)
├── site/
│   ├── index.html                 # DOM skeleton + CSS + themes + event glue
│   └── shell.mjs                  # pure render logic (browser-loaded + node-tested)
├── commands/
│   └── lore-serve.md              # /lore:serve slash command definition
└── test/
    ├── manifest.test.js
    ├── server.test.js
    ├── serve.test.js
    ├── shell.test.js
    ├── integration.test.js
    └── fixtures/
        └── wiki/                  # hand-made fixture wiki (serve-first test data)
            ├── INDEX.md
            ├── component/m3_nlp.md
            └── theme/quality.md
```

**Module API contract (locked — later tasks must match exactly):**

`lib/manifest.js` (ESM exports):
- `parseFrontmatter(text) -> { data, body }` — `data` = flat object (numbers parsed for `atoms`/`commits`/`stale`), `body` = markdown after the front-matter block.
- `deriveAxes(subdirNames) -> [{ id, label }]` — order `[INDEX, component, flow, theme, ...rest]`, label = capitalized id.
- `emitManifest({ wikiDir, currentSha, countCommitsSince, now, axes }) -> manifestObject` — `countCommitsSince(pageSha) -> number`, `now` = ISO string, `axes` optional (auto-derived from subdirs if omitted). Uses real `fs`.

`server.js` (ESM exports):
- `createServer(rootDir) -> http.Server` — not listening; path-traversal guarded.

`lib/serve.js` (ESM exports):
- `probeRuntime(canRun) -> { kind, cmd, buildArgs }` — `canRun(cmd) -> bool`; `buildArgs(port, dir) -> string[]`.
- `readPid(stateDir) -> info|null`, `writePid(stateDir, info)`, `isAlive(pid) -> bool`, `killPid(pid, platform) -> void`.
- `start({ loreDir, port, canRun, spawnFn, now }) -> info`, `stop({ loreDir }) -> {stopped}`.

`site/shell.mjs` (ESM exports, all pure):
- `stripFrontmatter(md) -> string`
- `renderMarkdown(md) -> html`
- `buildPageIndex(manifest) -> { shortId: "axis/id" }`
- `preprocessWikilinks(html, pageIndex) -> html`
- `buildNavModel(manifest) -> [{ id, label, pages }]`
- `matchesSearch(page, term) -> bool`
- `buildMeta(pageEntry) -> { chips: [{ icon, text, kind }] }`

---

## Task 0: Project scaffold

**Files:**
- Create: `package.json`
- Create: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "lore",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Repo living-docs / decision-history framework — /lore:serve",
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```gitignore
node_modules/
.lore/.state/
test/.tmp/
*.log
```

- [ ] **Step 3: Verify test runner works (empty pass)**

Run: `node --test`
Expected: exits 0 with "tests 0" (no test files yet) — confirms Node test runner is wired.

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: scaffold lore plugin repo (ESM, node:test, zero deps)"
```

---

## Task 1: Front-matter parser

**Files:**
- Create: `lib/manifest.js`
- Test: `test/manifest.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/manifest.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../lib/manifest.js';

test('parseFrontmatter extracts flat keys and body', () => {
  const md = [
    '---',
    'title: M3 NLP',
    'summary: entity extraction',
    'last_updated: 2026-05-28',
    'code_sha: def5678',
    'atoms: 8',
    'commits: 5',
    'stale: 3',
    '---',
    '',
    '# M3 NLP',
    'body line',
  ].join('\n');
  const { data, body } = parseFrontmatter(md);
  assert.equal(data.title, 'M3 NLP');
  assert.equal(data.summary, 'entity extraction');
  assert.equal(data.code_sha, 'def5678');
  assert.equal(data.atoms, 8);          // numeric coercion
  assert.equal(data.commits, 5);
  assert.equal(data.stale, 3);
  assert.equal(body.trim().startsWith('# M3 NLP'), true);
});

test('parseFrontmatter returns empty data when no front-matter', () => {
  const { data, body } = parseFrontmatter('# Just a title\ntext');
  assert.deepEqual(data, {});
  assert.equal(body.startsWith('# Just a title'), true);
});

test('parseFrontmatter ignores malformed lines without throwing', () => {
  const md = '---\ntitle: ok\ngarbage-no-colon\n---\nbody';
  const { data } = parseFrontmatter(md);
  assert.equal(data.title, 'ok');
  assert.equal('garbage-no-colon' in data, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/manifest.test.js`
Expected: FAIL — `parseFrontmatter` is not exported (import error / undefined).

- [ ] **Step 3: Write minimal implementation**

```js
// lib/manifest.js
const NUMERIC_KEYS = new Set(['atoms', 'commits', 'stale']);

export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text };
  const block = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  const data = {};
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;                       // skip malformed
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (!key) continue;
    data[key] = NUMERIC_KEYS.has(key) ? Number(val) : val;
  }
  return { data, body };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/manifest.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/manifest.js test/manifest.test.js
git commit -m "feat(manifest): flat front-matter parser"
```

---

## Task 2: Axis derivation

**Files:**
- Modify: `lib/manifest.js` (add `deriveAxes`)
- Test: `test/manifest.test.js` (append)

- [ ] **Step 1: Write the failing test**

```js
// append to test/manifest.test.js
import { deriveAxes } from '../lib/manifest.js';

test('deriveAxes orders known axes and capitalizes labels', () => {
  const axes = deriveAxes(['theme', 'component', 'flow']);
  assert.deepEqual(axes, [
    { id: 'component', label: 'Component' },
    { id: 'flow', label: 'Flow' },
    { id: 'theme', label: 'Theme' },
  ]);
});

test('deriveAxes puts INDEX first and unknown axes last in given order', () => {
  const axes = deriveAxes(['custom', 'theme', 'INDEX']);
  assert.deepEqual(axes.map(a => a.id), ['INDEX', 'theme', 'custom']);
  assert.equal(axes[0].label, 'INDEX');
  assert.equal(axes[2].label, 'Custom');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/manifest.test.js`
Expected: FAIL — `deriveAxes` undefined.

- [ ] **Step 3: Write minimal implementation**

```js
// append to lib/manifest.js
const AXIS_ORDER = ['INDEX', 'component', 'flow', 'theme'];

export function deriveAxes(subdirNames) {
  const known = AXIS_ORDER.filter(id => subdirNames.includes(id));
  const rest = subdirNames.filter(id => !AXIS_ORDER.includes(id));
  return [...known, ...rest].map(id => ({
    id,
    label: id === 'INDEX' ? 'INDEX' : id.charAt(0).toUpperCase() + id.slice(1),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/manifest.test.js`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add lib/manifest.js test/manifest.test.js
git commit -m "feat(manifest): derive ordered axes from wiki subdirs"
```

---

## Task 3: emitManifest core (git + clock injected)

**Files:**
- Modify: `lib/manifest.js` (add `emitManifest`)
- Test: `test/manifest.test.js` (append)

- [ ] **Step 1: Write the failing test**

```js
// append to test/manifest.test.js
import { emitManifest } from '../lib/manifest.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeWiki() {
  const dir = mkdtempSync(join(tmpdir(), 'lore-wiki-'));
  mkdirSync(join(dir, 'component'), { recursive: true });
  mkdirSync(join(dir, 'theme'), { recursive: true });
  writeFileSync(join(dir, 'INDEX.md'),
    '---\ntitle: Index\nsummary: toc\nlast_updated: 2026-05-31\ncode_sha: abc1234\natoms: 33\ncommits: 21\n---\n# Index');
  writeFileSync(join(dir, 'component', 'm3_nlp.md'),
    '---\ntitle: M3 NLP\nsummary: extraction\nlast_updated: 2026-05-28\ncode_sha: def5678\natoms: 8\ncommits: 5\n---\n# M3 NLP');
  writeFileSync(join(dir, 'theme', 'quality.md'),
    '---\ntitle: Quality\nsummary: qa evolution\nlast_updated: 2026-05-31\ncode_sha: abc1234\natoms: 14\ncommits: 9\n---\n# Quality');
  return dir;
}

test('emitManifest builds axes->pages with stale + provenance', () => {
  const dir = makeWiki();
  try {
    const m = emitManifest({
      wikiDir: dir,
      currentSha: 'abc1234',
      countCommitsSince: (sha) => (sha === 'abc1234' ? 0 : 3),
      now: '2026-05-31T08:14:00Z',
    });
    assert.equal(m.generated, '2026-05-31T08:14:00Z');
    assert.equal(m.current_code_sha, 'abc1234');
    const comp = m.axes.find(a => a.id === 'component');
    const page = comp.pages.find(p => p.id === 'm3_nlp');
    assert.equal(page.title, 'M3 NLP');
    assert.equal(page.summary, 'extraction');
    assert.equal(page.path, 'component/m3_nlp.md');
    assert.equal(page.stale, 3);                  // def5678 != HEAD
    assert.equal(page.code_sha, 'def5678');
    assert.deepEqual(page.synthesized_from, { atoms: 8, commits: 5 });
    const theme = m.axes.find(a => a.id === 'theme');
    assert.equal(theme.pages[0].stale, 0);        // abc1234 == HEAD
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('emitManifest is deterministic for identical inputs (byte-identical)', () => {
  const dir = makeWiki();
  try {
    const args = {
      wikiDir: dir, currentSha: 'abc1234',
      countCommitsSince: () => 0, now: '2026-05-31T08:14:00Z',
    };
    const a = JSON.stringify(emitManifest(args));
    const b = JSON.stringify(emitManifest(args));
    assert.equal(a, b);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('emitManifest tolerates a page missing summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lore-wiki-'));
  try {
    mkdirSync(join(dir, 'component'), { recursive: true });
    writeFileSync(join(dir, 'component', 'bare.md'),
      '---\ntitle: Bare\ncode_sha: aaa\n---\n# Bare');
    const m = emitManifest({
      wikiDir: dir, currentSha: 'aaa',
      countCommitsSince: () => 0, now: 't',
    });
    const page = m.axes.find(a => a.id === 'component').pages[0];
    assert.equal(page.summary, '');               // graceful default
    assert.equal(page.title, 'Bare');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/manifest.test.js`
Expected: FAIL — `emitManifest` undefined.

- [ ] **Step 3: Write minimal implementation**

```js
// append to lib/manifest.js
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function emitManifest({ wikiDir, currentSha, countCommitsSince, now, axes }) {
  const entries = readdirSync(wikiDir, { withFileTypes: true });
  const subdirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  const hasIndex = entries.some(e => e.isFile() && e.name === 'INDEX.md');
  const axisDefs = axes ?? deriveAxes([...(hasIndex ? ['INDEX'] : []), ...subdirs]);

  const builtAxes = [];
  for (const ax of axisDefs) {
    const pages = [];
    if (ax.id === 'INDEX') {
      if (hasIndex) pages.push(pageEntry(wikiDir, '', 'INDEX', currentSha, countCommitsSince));
    } else {
      const axisDir = join(wikiDir, ax.id);
      let files = [];
      try { files = readdirSync(axisDir).filter(f => f.endsWith('.md')); } catch { files = []; }
      files.sort();
      for (const f of files) {
        pages.push(pageEntry(wikiDir, ax.id, f.replace(/\.md$/, ''), currentSha, countCommitsSince));
      }
    }
    builtAxes.push({ id: ax.id, label: ax.label, pages });
  }
  return { generated: now, current_code_sha: currentSha, axes: builtAxes };
}

function pageEntry(wikiDir, axisId, id, currentSha, countCommitsSince) {
  const rel = axisId ? `${axisId}/${id}.md` : `${id}.md`;
  const text = readFileSync(join(wikiDir, rel), 'utf8');
  const { data } = parseFrontmatter(text);
  const sha = data.code_sha ?? '';
  const stale = sha && sha !== currentSha ? countCommitsSince(sha) : 0;
  return {
    id,
    title: data.title ?? id,
    summary: data.summary ?? '',
    path: rel,
    stale,
    code_sha: sha,
    synthesized_from: { atoms: data.atoms ?? 0, commits: data.commits ?? 0 },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/manifest.test.js`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add lib/manifest.js test/manifest.test.js
git commit -m "feat(manifest): emitManifest with injected git/clock (deterministic)"
```

---

## Task 4: manifest CLI wiring (real git)

**Files:**
- Modify: `lib/manifest.js` (add CLI entry + git helpers)
- Test: `test/manifest.test.js` (append integration test gated on git)

- [ ] **Step 1: Write the failing test**

```js
// append to test/manifest.test.js
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

test('manifest CLI writes .manifest.json into wiki dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-cli-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    const wiki = join(root, '.lore', 'wiki', 'component');
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(root, '.lore', 'wiki', 'component', 'x.md'),
      '---\ntitle: X\nsummary: s\ncode_sha: deadbee\n---\n# X');
    writeFileSync(join(root, 'f.txt'), 'hi');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });

    execFileSync('node', ['lib/manifest.js', join(root, '.lore')],
      { cwd: process.cwd() });

    const out = join(root, '.lore', 'wiki', '.manifest.json');
    assert.equal(existsSync(out), true);
    const m = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(m.axes.find(a => a.id === 'component').pages[0].title, 'X');
    assert.equal(typeof m.current_code_sha, 'string');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/manifest.test.js`
Expected: FAIL — running `node lib/manifest.js` does nothing / no output file (no CLI block yet).

- [ ] **Step 3: Write minimal implementation**

```js
// append to lib/manifest.js
import { writeFileSync as _writeFileSync } from 'node:fs';
import { execFileSync as _execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function gitCurrentSha(repoRoot) {
  return _execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot })
    .toString().trim();
}

function makeCountCommitsSince(repoRoot) {
  return (sha) => {
    try {
      const out = _execFileSync('git', ['rev-list', '--count', `${sha}..HEAD`],
        { cwd: repoRoot }).toString().trim();
      return Number(out) || 0;
    } catch {
      return 0;   // unknown/unreachable sha → treat as not-stale
    }
  };
}

export function runManifestCli(loreDir, nowIso) {
  const repoRoot = join(loreDir, '..');
  const wikiDir = join(loreDir, 'wiki');
  const manifest = emitManifest({
    wikiDir,
    currentSha: gitCurrentSha(repoRoot),
    countCommitsSince: makeCountCommitsSince(repoRoot),
    now: nowIso,
  });
  const out = join(wikiDir, '.manifest.json');
  _writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const loreDir = process.argv[2];
  if (!loreDir) { console.error('usage: node lib/manifest.js <loreDir>'); process.exit(1); }
  const out = runManifestCli(loreDir, new Date().toISOString());
  console.log(`wrote ${out}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/manifest.test.js`
Expected: PASS (9 tests total). If git is unavailable in the environment the test will error — git is required for this task.

- [ ] **Step 5: Commit**

```bash
git add lib/manifest.js test/manifest.test.js
git commit -m "feat(manifest): CLI entry wiring real git (rev-parse/rev-list)"
```

---

## Task 5: Static file server + path-traversal guard

**Files:**
- Create: `server.js`
- Test: `test/server.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/server.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server.test.js`
Expected: FAIL — `createServer` not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// server.js
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function createServer(rootDir) {
  const root = normalize(rootDir);
  return http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch { res.writeHead(400); return res.end('bad request'); }

    let rel = pathname.replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'site/index.html';
    const full = normalize(join(root, rel));

    // traversal guard: resolved path must stay within root
    if (full !== root && !full.startsWith(root + sep)) {
      res.writeHead(403); return res.end('forbidden');
    }
    let st;
    try { st = statSync(full); } catch { res.writeHead(404); return res.end('not found'); }
    if (st.isDirectory()) { res.writeHead(404); return res.end('not found'); }

    res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream' });
    createReadStream(full).pipe(res);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , rootDir, portStr] = process.argv;
  if (!rootDir || !portStr) { console.error('usage: node server.js <rootDir> <port>'); process.exit(1); }
  createServer(rootDir).listen(Number(portStr), '127.0.0.1',
    () => console.log(`lore static server on 127.0.0.1:${portStr} root=${rootDir}`));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat(server): zero-dep static file server with traversal guard"
```

---

## Task 6: Runtime probe chain

**Files:**
- Create: `lib/serve.js`
- Test: `test/serve.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/serve.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeRuntime } from '../lib/serve.js';

test('probeRuntime prefers python3 when available', () => {
  const r = probeRuntime(cmd => cmd === 'python3');
  assert.equal(r.kind, 'python');
  assert.equal(r.cmd, 'python3');
  assert.deepEqual(r.buildArgs(7842, '/x'),
    ['-m', 'http.server', '7842', '--bind', '127.0.0.1', '--directory', '/x']);
});

test('probeRuntime falls back to python (Windows) when no python3', () => {
  const r = probeRuntime(cmd => cmd === 'python');
  assert.equal(r.kind, 'python');
  assert.equal(r.cmd, 'python');
});

test('probeRuntime falls back to bundled node server when no python', () => {
  const r = probeRuntime(() => false);
  assert.equal(r.kind, 'node');
  assert.equal(r.cmd, process.execPath);     // current node binary
  const args = r.buildArgs(7842, '/x');
  assert.equal(args[0].endsWith('server.js'), true);
  assert.deepEqual(args.slice(1), ['/x', '7842']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/serve.test.js`
Expected: FAIL — `probeRuntime` not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/serve.js
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = join(HERE, '..', 'server.js');

export function probeRuntime(canRun) {
  for (const cmd of ['python3', 'python']) {
    if (canRun(cmd)) {
      return {
        kind: 'python', cmd,
        buildArgs: (port, dir) =>
          ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', dir],
      };
    }
  }
  return {
    kind: 'node', cmd: process.execPath,
    buildArgs: (port, dir) => [SERVER_JS, dir, String(port)],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/serve.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/serve.js test/serve.test.js
git commit -m "feat(serve): runtime probe chain python3->python->node fallback"
```

---

## Task 7: PID file management

**Files:**
- Modify: `lib/serve.js` (add pid helpers)
- Test: `test/serve.test.js` (append)

- [ ] **Step 1: Write the failing test**

```js
// append to test/serve.test.js
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';
import { readPid, writePid, isAlive } from '../lib/serve.js';

test('writePid then readPid round-trips', () => {
  const state = mkdtempSync(pjoin(tmpdir(), 'lore-state-'));
  try {
    writePid(state, { pid: 4242, port: 7842, runtime: 'python', started: 't' });
    const info = readPid(state);
    assert.equal(info.pid, 4242);
    assert.equal(info.port, 7842);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('readPid returns null when absent', () => {
  const state = mkdtempSync(pjoin(tmpdir(), 'lore-state-'));
  try { assert.equal(readPid(state), null); }
  finally { rmSync(state, { recursive: true, force: true }); }
});

test('isAlive is true for current process, false for unused pid', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(2 ** 31 - 1), false);   // implausible pid
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/serve.test.js`
Expected: FAIL — `readPid`/`writePid`/`isAlive` undefined.

- [ ] **Step 3: Write minimal implementation**

```js
// append to lib/serve.js
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';

const PID_NAME = 'serve.pid';

export function writePid(stateDir, info) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, PID_NAME), JSON.stringify(info, null, 2));
}

export function readPid(stateDir) {
  const p = join(stateDir, PID_NAME);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function clearPid(stateDir) {
  rmSync(join(stateDir, PID_NAME), { force: true });
}

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // EPERM = exists but not ours
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/serve.test.js`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add lib/serve.js test/serve.test.js
git commit -m "feat(serve): pid file read/write + liveness check"
```

---

## Task 8: Cross-platform kill

**Files:**
- Modify: `lib/serve.js` (add `killPid`)
- Test: `test/serve.test.js` (append)

- [ ] **Step 1: Write the failing test**

```js
// append to test/serve.test.js
import { spawn } from 'node:child_process';
import { killPid } from '../lib/serve.js';

test('killPid terminates a real child process', async () => {
  // long-lived child: node that sleeps
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e9)'],
    { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(isAlive(child.pid), true);
  killPid(child.pid, process.platform);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(isAlive(child.pid), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/serve.test.js`
Expected: FAIL — `killPid` undefined.

- [ ] **Step 3: Write minimal implementation**

```js
// append to lib/serve.js
import { execFileSync } from 'node:child_process';

export function killPid(pid, platform) {
  if (platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); }
    catch { /* already gone */ }
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/serve.test.js`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add lib/serve.js test/serve.test.js
git commit -m "feat(serve): cross-platform process kill (taskkill/SIGTERM)"
```

---

## Task 9: Port selection + start/stop orchestration

**Files:**
- Modify: `lib/serve.js` (add `findPort`, `start`, `stop`)
- Test: `test/serve.test.js` (append)

- [ ] **Step 1: Write the failing test**

```js
// append to test/serve.test.js
import { findPort, start, stop } from '../lib/serve.js';
import { mkdirSync as mkd, writeFileSync as wf } from 'node:fs';

test('findPort returns the requested port when free', async () => {
  const p = await findPort(0);          // 0 => OS picks a free port, returned as-is rule
  assert.equal(typeof p, 'number');
});

test('start writes pid + returns url, stop kills and clears', async () => {
  const root = mkdtempSync(pjoin(tmpdir(), 'lore-run-'));
  try {
    // minimal .lore with manifest so start does not early-exit
    const wiki = pjoin(root, '.lore', 'wiki');
    mkd(wiki, { recursive: true });
    wf(pjoin(wiki, '.manifest.json'), '{"axes":[]}');
    mkd(pjoin(root, '.lore', 'site'), { recursive: true });
    wf(pjoin(root, '.lore', 'site', 'index.html'), '<!doctype html>ok');

    const info = await start({
      loreDir: pjoin(root, '.lore'),
      port: 0,
      canRun: () => false,              // force node fallback (deterministic)
      now: 't',
    });
    assert.equal(typeof info.port, 'number');
    assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/site\/$/);
    assert.equal(isAlive(info.pid), true);

    // server actually responds
    const r = await fetch(info.url + 'index.html');
    assert.equal(r.status, 200);

    const res = await stop({ loreDir: pjoin(root, '.lore') });
    assert.equal(res.stopped, true);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(isAlive(info.pid), false);
    assert.equal(readPid(pjoin(root, '.lore', '.state')), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('start is idempotent: second call reuses running server', async () => {
  const root = mkdtempSync(pjoin(tmpdir(), 'lore-run-'));
  try {
    const wiki = pjoin(root, '.lore', 'wiki');
    mkd(wiki, { recursive: true });
    wf(pjoin(wiki, '.manifest.json'), '{"axes":[]}');
    mkd(pjoin(root, '.lore', 'site'), { recursive: true });
    wf(pjoin(root, '.lore', 'site', 'index.html'), 'ok');
    const a = await start({ loreDir: pjoin(root, '.lore'), port: 0, canRun: () => false, now: 't' });
    const b = await start({ loreDir: pjoin(root, '.lore'), port: 0, canRun: () => false, now: 't' });
    assert.equal(a.pid, b.pid);         // same process, not restarted
    assert.equal(b.reused, true);
    await stop({ loreDir: pjoin(root, '.lore') });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stop on nothing-running is a no-op', async () => {
  const root = mkdtempSync(pjoin(tmpdir(), 'lore-run-'));
  try {
    const res = await stop({ loreDir: pjoin(root, '.lore') });
    assert.equal(res.stopped, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/serve.test.js`
Expected: FAIL — `findPort`/`start`/`stop` undefined.

- [ ] **Step 3: Write minimal implementation**

```js
// append to lib/serve.js
import net from 'node:net';
import { spawn } from 'node:child_process';

export function findPort(preferred) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', () => {
      // preferred busy → ask OS for any free port
      const s2 = net.createServer();
      s2.once('error', reject);
      s2.listen(0, '127.0.0.1', () => {
        const p = s2.address().port; s2.close(() => resolve(p));
      });
    });
    srv.listen(preferred, '127.0.0.1', () => {
      const p = srv.address().port; srv.close(() => resolve(p));
    });
  });
}

export async function start({ loreDir, port = 7842, canRun, spawnFn = spawn, now }) {
  const stateDir = join(loreDir, '.state');
  const existing = readPid(stateDir);
  if (existing && isAlive(existing.pid)) {
    return { ...existing, url: `http://127.0.0.1:${existing.port}/site/`, reused: true };
  }
  const can = canRun ?? defaultCanRun;
  const runtime = probeRuntime(can);
  const chosen = await findPort(port);
  const child = spawnFn(runtime.cmd, runtime.buildArgs(chosen, loreDir),
    { detached: true, stdio: 'ignore' });
  child.unref();
  const info = { pid: child.pid, port: chosen, runtime: runtime.kind, started: now };
  writePid(stateDir, info);
  await waitForPort(chosen);
  return { ...info, url: `http://127.0.0.1:${chosen}/site/`, reused: false };
}

export async function stop({ loreDir }) {
  const stateDir = join(loreDir, '.state');
  const info = readPid(stateDir);
  if (!info) return { stopped: false };
  if (isAlive(info.pid)) killPid(info.pid, process.platform);
  clearPid(stateDir);
  return { stopped: true, pid: info.pid };
}

function defaultCanRun(cmd) {
  try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/serve.test.js`
Expected: PASS (11 tests total).

- [ ] **Step 5: Commit**

```bash
git add lib/serve.js test/serve.test.js
git commit -m "feat(serve): port selection + idempotent start/stop orchestration"
```

---

## Task 10: serve CLI entry

**Files:**
- Modify: `lib/serve.js` (add CLI block)
- Test: `test/serve.test.js` (append CLI smoke)

- [ ] **Step 1: Write the failing test**

```js
// append to test/serve.test.js
import { execFileSync as exec } from 'node:child_process';

test('CLI: serve start prints URL, serve stop tears down', async () => {
  const root = mkdtempSync(pjoin(tmpdir(), 'lore-cli2-'));
  try {
    const wiki = pjoin(root, '.lore', 'wiki');
    mkd(wiki, { recursive: true });
    wf(pjoin(wiki, '.manifest.json'), '{"axes":[]}');
    mkd(pjoin(root, '.lore', 'site'), { recursive: true });
    wf(pjoin(root, '.lore', 'site', 'index.html'), 'ok');

    const out = exec('node',
      ['lib/serve.js', 'start', '--lore', pjoin(root, '.lore'), '--port', '0'],
      { cwd: process.cwd() }).toString();
    assert.match(out, /http:\/\/127\.0\.0\.1:\d+\/site\//);

    const stopOut = exec('node',
      ['lib/serve.js', 'stop', '--lore', pjoin(root, '.lore')],
      { cwd: process.cwd() }).toString();
    assert.match(stopOut, /stopped|no running/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: serve start without manifest exits non-zero with hint', () => {
  const root = mkdtempSync(pjoin(tmpdir(), 'lore-cli3-'));
  try {
    mkd(pjoin(root, '.lore'), { recursive: true });
    assert.throws(() => exec('node',
      ['lib/serve.js', 'start', '--lore', pjoin(root, '.lore')],
      { cwd: process.cwd(), stdio: 'pipe' }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/serve.test.js`
Expected: FAIL — CLI prints nothing / does not exit non-zero (no CLI block).

- [ ] **Step 3: Write minimal implementation**

```js
// append to lib/serve.js
import { existsSync as _exists } from 'node:fs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lore') out.lore = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else out._.push(a);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const sub = args._[0];
  const loreDir = args.lore ?? join(process.cwd(), '.lore');
  (async () => {
    if (sub === 'start') {
      if (!_exists(join(loreDir, 'wiki', '.manifest.json'))) {
        console.error('No .lore/wiki/.manifest.json — run /lore:sync first.');
        process.exit(1);
      }
      const info = await start({ loreDir, port: args.port ?? 7842, now: new Date().toISOString() });
      const tag = info.reused ? '(already running)' : '';
      console.log(`▶ lore wiki ${tag} ${info.url}   stop: /lore:serve --stop`);
    } else if (sub === 'stop') {
      const res = await stop({ loreDir });
      console.log(res.stopped ? '■ stopped' : 'no running lore server');
    } else {
      console.error('usage: node lib/serve.js start|stop [--lore <dir>] [--port N]');
      process.exit(1);
    }
  })();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/serve.test.js`
Expected: PASS (13 tests total).

- [ ] **Step 5: Commit**

```bash
git add lib/serve.js test/serve.test.js
git commit -m "feat(serve): start/stop CLI entry with manifest precheck"
```

---

## Task 11: Shell pure logic — front-matter strip + markdown render

**Files:**
- Create: `site/shell.mjs`
- Test: `test/shell.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/shell.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripFrontmatter, renderMarkdown } from '../site/shell.mjs';

test('stripFrontmatter removes the leading --- block', () => {
  const md = '---\ntitle: X\ncode_sha: a\n---\n# Heading\nbody';
  assert.equal(stripFrontmatter(md).trim().startsWith('# Heading'), true);
});

test('stripFrontmatter leaves body untouched when no front-matter', () => {
  assert.equal(stripFrontmatter('# Heading\nb').startsWith('# Heading'), true);
});

test('renderMarkdown handles headings, lists, code, inline code', () => {
  const html = renderMarkdown('# T\n\n- a\n- b\n\n`x`\n\n```\ncode\n```');
  assert.match(html, /<h1>T<\/h1>/);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(html, /<code>x<\/code>/);
  assert.match(html, /<pre><code>code/);
});

test('renderMarkdown renders tables and links', () => {
  const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |\n\n[t](u)');
  assert.match(html, /<table>/);
  assert.match(html, /<th>A<\/th>/);
  assert.match(html, /<a href="u">t<\/a>/);
});

test('renderMarkdown escapes html in code blocks', () => {
  const html = renderMarkdown('```\n<script>\n```');
  assert.match(html, /&lt;script&gt;/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/shell.test.js`
Expected: FAIL — `site/shell.mjs` does not export these.

- [ ] **Step 3: Write minimal implementation**

```js
// site/shell.mjs
export function stripFrontmatter(md) {
  if (!md.startsWith('---')) return md;
  const end = md.indexOf('\n---', 3);
  if (end === -1) return md;
  return md.slice(end + 4).replace(/^\r?\n/, '');
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(t) {
  return t
    .replace(/`([^`]+)`/g, (_, c) => `<code>${esc(c)}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

export function renderMarkdown(src) {
  const lines = src.split('\n');
  let html = '', i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    // passthrough raw <div ...> blocks (timeline markup) until matching depth 0
    if (/^<div/.test(ln)) {
      let buf = '', depth = 0;
      do {
        const l = lines[i];
        depth += (l.match(/<div/g) || []).length - (l.match(/<\/div>/g) || []).length;
        buf += l + '\n'; i++;
      } while (i < lines.length && depth > 0);
      html += buf; continue;
    }
    if (/^```/.test(ln)) {
      let buf = ''; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf += lines[i] + '\n'; i++; }
      i++; html += `<pre><code>${esc(buf)}</code></pre>`; continue;
    }
    if (/^### /.test(ln)) { html += `<h3>${inline(ln.slice(4))}</h3>`; i++; continue; }
    if (/^## /.test(ln))  { html += `<h2>${inline(ln.slice(3))}</h2>`; i++; continue; }
    if (/^# /.test(ln))   { html += `<h1>${inline(ln.slice(2))}</h1>`; i++; continue; }
    if (/^> /.test(ln))   { html += `<blockquote>${inline(ln.slice(2))}</blockquote>`; i++; continue; }
    if (/^---\s*$/.test(ln)) { html += '<hr>'; i++; continue; }
    if (/^[-*] /.test(ln)) {
      let buf = '<ul>';
      while (i < lines.length && /^[-*] /.test(lines[i])) { buf += `<li>${inline(lines[i].slice(2))}</li>`; i++; }
      html += buf + '</ul>'; continue;
    }
    if (/^\|/.test(ln)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const body = rows
        .filter(r => !/^\|[\s\-:|]+\|?\s*$/.test(r))
        .map((r, ri) => {
          const cells = r.split('|').slice(1, -1).map(c => c.trim());
          const tag = ri === 0 ? 'th' : 'td';
          return '<tr>' + cells.map(c => `<${tag}>${inline(c)}</${tag}>`).join('') + '</tr>';
        }).join('');
      html += `<table>${body}</table>`; continue;
    }
    if (ln.trim() === '') { i++; continue; }
    html += `<p>${inline(ln)}</p>`; i++;
  }
  return html;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/shell.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add site/shell.mjs test/shell.test.js
git commit -m "feat(shell): front-matter strip + mini markdown renderer"
```

---

## Task 12: Shell pure logic — nav model, wikilinks, search, meta

**Files:**
- Modify: `site/shell.mjs` (add 5 functions)
- Test: `test/shell.test.js` (append)

- [ ] **Step 1: Write the failing test**

```js
// append to test/shell.test.js
import {
  buildPageIndex, preprocessWikilinks, buildNavModel, matchesSearch, buildMeta,
} from '../site/shell.mjs';

const MANIFEST = {
  current_code_sha: 'abc1234',
  axes: [
    { id: 'component', label: 'Component', pages: [
      { id: 'm3_nlp', title: 'M3 NLP', summary: 'extraction', path: 'component/m3_nlp.md', stale: 3,
        code_sha: 'def5678', synthesized_from: { atoms: 8, commits: 5 } }] },
    { id: 'theme', label: 'Theme', pages: [
      { id: 'quality', title: 'Quality', summary: 'qa', path: 'theme/quality.md', stale: 0,
        code_sha: 'abc1234', synthesized_from: { atoms: 14, commits: 9 } }] },
  ],
};

test('buildPageIndex maps short id to axis/id', () => {
  const idx = buildPageIndex(MANIFEST);
  assert.equal(idx.m3_nlp, 'component/m3_nlp');
  assert.equal(idx.quality, 'theme/quality');
});

test('preprocessWikilinks rewrites [[id]] to hash anchors', () => {
  const idx = buildPageIndex(MANIFEST);
  const out = preprocessWikilinks('see [[m3_nlp]] now', idx);
  assert.match(out, /<a class="wikilink" href="#component\/m3_nlp">m3_nlp<\/a>/);
});

test('preprocessWikilinks falls back for unknown id', () => {
  const out = preprocessWikilinks('[[ghost]]', {});
  assert.match(out, /href="#component\/ghost"/);   // best-effort fallback
});

test('buildNavModel passes axes through with pages', () => {
  const nav = buildNavModel(MANIFEST);
  assert.equal(nav.length, 2);
  assert.equal(nav[0].id, 'component');
  assert.equal(nav[0].pages[0].id, 'm3_nlp');
});

test('matchesSearch matches title and summary case-insensitively', () => {
  const page = MANIFEST.axes[0].pages[0];
  assert.equal(matchesSearch(page, 'nlp'), true);
  assert.equal(matchesSearch(page, 'EXTRACT'), true);
  assert.equal(matchesSearch(page, 'zzz'), false);
  assert.equal(matchesSearch(page, ''), true);     // empty term shows all
});

test('buildMeta produces freshness chips (stale and fresh)', () => {
  const stale = buildMeta(MANIFEST.axes[0].pages[0]);
  assert.equal(stale.chips.some(c => c.kind === 'stale' && /3/.test(c.text)), true);
  const fresh = buildMeta(MANIFEST.axes[1].pages[0]);
  assert.equal(fresh.chips.some(c => c.kind === 'fresh'), true);
  assert.equal(fresh.chips.some(c => /14 atoms/.test(c.text)), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/shell.test.js`
Expected: FAIL — the 5 new functions are undefined.

- [ ] **Step 3: Write minimal implementation**

```js
// append to site/shell.mjs
export function buildPageIndex(manifest) {
  const idx = {};
  for (const ax of manifest.axes) for (const p of ax.pages) idx[p.id] = `${ax.id}/${p.id}`;
  return idx;
}

export function preprocessWikilinks(html, pageIndex) {
  return html.replace(/\[\[([a-zA-Z0-9_\-]+)\]\]/g, (_, id) => {
    const target = pageIndex[id] ?? `component/${id}`;
    return `<a class="wikilink" href="#${target}">${id}</a>`;
  });
}

export function buildNavModel(manifest) {
  return manifest.axes.map(ax => ({ id: ax.id, label: ax.label, pages: ax.pages }));
}

export function matchesSearch(page, term) {
  if (!term) return true;
  const t = term.toLowerCase();
  return (page.title + ' ' + (page.summary ?? '')).toLowerCase().includes(t);
}

export function buildMeta(page) {
  const f = page.synthesized_from ?? { atoms: 0, commits: 0 };
  const chips = [
    { icon: '📅', text: `last-updated ${page.last_updated ?? '—'}`, kind: 'plain' },
    { icon: '🔗', text: `${f.atoms} atoms · ${f.commits} commits`, kind: 'plain' },
    { icon: '⎇', text: `code_sha ${page.code_sha ?? '—'}`, kind: 'plain' },
  ];
  chips.push(page.stale > 0
    ? { icon: '⚠', text: `落后 ${page.stale} commits · 跑 /lore:sync`, kind: 'stale' }
    : { icon: '✓', text: '最新', kind: 'fresh' });
  return { chips };
}
```

Note: `buildMeta` reads `page.last_updated` — add `last_updated` to the manifest page entry in `lib/manifest.js` `pageEntry()` so the shell has it. Apply this change now:

```js
// in lib/manifest.js pageEntry(), add to the returned object:
    last_updated: data.last_updated ?? '',
```

And extend the Task 3 manifest assertions are unaffected (additive field).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test`
Expected: PASS — all shell tests (11 total) AND manifest tests still green (additive field).

- [ ] **Step 5: Commit**

```bash
git add site/shell.mjs lib/manifest.js test/shell.test.js
git commit -m "feat(shell): nav model, wikilink rewrite, search, meta chips"
```

---

## Task 13: Browser shell DOM + CSS + themes

**Files:**
- Create: `site/index.html`
- Reference: `docs/superpowers/specs/2026-05-31-lore-serve-mockup.html` (committed; copy its `<style>` block + DOM layout)

This task is DOM glue + styling — verified manually in a browser (pure logic already covered by Task 11–12 tests).

- [ ] **Step 1: Create `site/index.html` from the mockup, wired to `shell.mjs`**

Build `site/index.html` with these exact parts:

1. **`<style>`**: copy the entire `<style>` block from the committed mockup (`2026-05-31-lore-serve-mockup.html`) verbatim — it already implements the 3-region grid layout, sidebar, meta chips, timeline, and code/table styling using CSS variables under `:root`.

2. **Add 2 more themes** after the existing `:root` (dark) block — light + sepia overrides:

```html
<style>
/* ... mockup :root (dark) stays as the default ... */
:root[data-theme="light"] {
  --bg:#ffffff; --sidebar:#f4f5f8; --panel:#eef0f4; --fg:#24283b; --fg-dim:#787c99;
  --fg-bright:#1a1b26; --accent:#3760bf; --accent-dim:#a4b3e0; --border:#dcdfe6;
  --code-bg:#eef0f4; --green:#587539; --yellow:#8c6c20; --red:#c64343;
  --comp:#2e7de9; --flow:#7847bd; --theme:#b15c00;
}
:root[data-theme="sepia"] {
  --bg:#f4ecd8; --sidebar:#ece2c8; --panel:#e7dcc0; --fg:#5b4636; --fg-dim:#9c8b73;
  --fg-bright:#3b2f25; --accent:#9a6a3a; --accent-dim:#cdb892; --border:#d9c9a3;
  --code-bg:#e7dcc0; --green:#6b7536; --yellow:#9a6a20; --red:#a8443a;
  --comp:#7a6a3a; --flow:#8a5a6a; --theme:#9a6a3a;
}
</style>
```

3. **DOM skeleton** (same as mockup body, plus a theme switcher in the top bar):

```html
<div id="app">
  <div id="topbar">
    <div id="brand">lore <span class="dim">// .lore/wiki</span></div>
    <div id="search"><input id="q" placeholder="🔍 搜索页面 (title + 摘要)..." autocomplete="off"></div>
    <select id="theme" title="主题">
      <option value="dark">🌙 暗</option>
      <option value="light">☀ 亮</option>
      <option value="sepia">🌿 护眼</option>
    </select>
    <div id="serve-badge">● serving</div>
  </div>
  <nav id="sidebar"></nav>
  <main id="main">
    <div id="meta"></div>
    <article id="content"></article>
  </main>
</div>
```

4. **Module script** — wire `shell.mjs` to live data via `fetch`:

```html
<script type="module">
import {
  stripFrontmatter, renderMarkdown, buildPageIndex, preprocessWikilinks,
  buildNavModel, matchesSearch, buildMeta,
} from './shell.mjs';

let MANIFEST = { axes: [] }, PAGE_INDEX = {}, FLAT = {};

async function boot() {
  MANIFEST = await (await fetch('../wiki/.manifest.json')).json();
  PAGE_INDEX = buildPageIndex(MANIFEST);
  FLAT = {};
  for (const ax of MANIFEST.axes) for (const p of ax.pages) FLAT[`${ax.id}/${p.id}`] = p;
  buildSidebar();
  wireSearch();
  wireTheme();
  window.addEventListener('hashchange', route);
  route();
}

function buildSidebar() {
  const nav = document.getElementById('sidebar');
  nav.innerHTML = buildNavModel(MANIFEST).map(ax => `
    <div class="axis" data-axis="${ax.id}">
      <div class="axis-h"><span class="dot ${ax.id}"></span>${ax.label}<span class="caret">▼</span></div>
      <div class="links">
        ${ax.pages.map(p => `<a href="#${ax.id}/${p.id}" data-key="${ax.id}/${p.id}"
           data-search="${(p.title + ' ' + (p.summary||'')).toLowerCase()}">
          ${p.title}${p.stale ? `<span class="stale">⚠${p.stale}</span>` : ''}</a>`).join('')}
      </div>
    </div>`).join('');
  nav.querySelectorAll('.axis-h').forEach(h =>
    h.onclick = () => h.parentElement.classList.toggle('collapsed'));
}

function renderMeta(page) {
  const cls = { plain: 'chip', stale: 'chip stale', fresh: 'chip fresh' };
  return buildMeta(page).chips.map(c =>
    `<span class="${cls[c.kind]}">${c.icon} ${c.text}</span>`).join('');
}

async function route() {
  const hash = location.hash.slice(1) || firstPageKey();
  const page = FLAT[hash];
  document.querySelectorAll('#sidebar a').forEach(a =>
    a.classList.toggle('active', a.dataset.key === hash));
  if (!page) {
    document.getElementById('meta').innerHTML = '';
    document.getElementById('content').innerHTML = `<h1>404</h1><p>无此页：<code>${hash}</code></p>`;
    return;
  }
  const raw = await (await fetch('../wiki/' + page.path)).text();
  const html = preprocessWikilinks(renderMarkdown(stripFrontmatter(raw)), PAGE_INDEX);
  document.getElementById('meta').innerHTML = renderMeta(page);
  document.getElementById('content').innerHTML = html;
  document.getElementById('main').scrollTop = 0;
}

function firstPageKey() {
  for (const ax of MANIFEST.axes) if (ax.pages[0]) return `${ax.id}/${ax.pages[0].id}`;
  return '';
}

function wireSearch() {
  document.getElementById('q').addEventListener('input', e => {
    const term = e.target.value.toLowerCase().trim();
    document.querySelectorAll('#sidebar .links a').forEach(a =>
      a.classList.toggle('hidden', term && !a.dataset.search.includes(term)));
    document.querySelectorAll('.axis').forEach(ax => {
      const any = [...ax.querySelectorAll('a')].some(a => !a.classList.contains('hidden'));
      ax.style.display = any ? '' : 'none';
    });
  });
}

function wireTheme() {
  const sel = document.getElementById('theme');
  const saved = localStorage.getItem('lore-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  sel.value = saved;
  sel.addEventListener('change', () => {
    document.documentElement.setAttribute('data-theme', sel.value);
    localStorage.setItem('lore-theme', sel.value);
  });
}

boot();
</script>
```

Add CSS for `.hidden { display:none }`, `#theme` select styling, and `.axis.collapsed .links { display:none }` / `.axis.collapsed .caret { transform:rotate(-90deg) }` if not already inherited from the mockup (the mockup already has the collapse + hidden rules — verify and add only what's missing).

- [ ] **Step 2: Manual verification with the fixture wiki**

Run (creates a throwaway `.lore` from fixtures and serves it):

```bash
# from repo root
mkdir -p .lore/wiki .lore/site
cp -r test/fixtures/wiki/* .lore/wiki/
cp site/index.html site/shell.mjs .lore/site/
node lib/manifest.js .lore        # writes .lore/wiki/.manifest.json (needs git repo)
node lib/serve.js start --lore .lore --port 7842
```

Open the printed URL. Verify ALL of:
- Sidebar lists axes (Component / Theme / INDEX) with pages; `⚠N` on stale pages
- Clicking a page renders its markdown in the main area
- `[[wikilink]]` pills are clickable and navigate within the shell (no full reload)
- Meta bar shows 📅 / 🔗 atoms·commits / ⎇ code_sha / freshness flag (green ✓ or yellow ⚠)
- Search box filters the sidebar live
- Theme switcher cycles dark / light / sepia and survives a reload (localStorage)

Then tear down:

```bash
node lib/serve.js stop --lore .lore
rm -rf .lore
```

Expected: every checklist item works; `stop` prints `■ stopped`; no leftover process (`node lib/serve.js stop` a second time prints `no running lore server`).

- [ ] **Step 3: Commit**

```bash
git add site/index.html
git commit -m "feat(shell): browser DOM + 3 themes (dark/light/sepia) wired to shell.mjs"
```

---

## Task 14: Test fixtures (committed wiki for integration)

**Files:**
- Create: `test/fixtures/wiki/INDEX.md`
- Create: `test/fixtures/wiki/component/m3_nlp.md`
- Create: `test/fixtures/wiki/theme/quality.md`

- [ ] **Step 1: Create the fixture pages**

`test/fixtures/wiki/INDEX.md`:

```markdown
---
title: Index
summary: table of contents
last_updated: 2026-05-31
code_sha: abc1234
atoms: 33
commits: 21
---
# lore wiki — index

## Component
- [[m3_nlp]]

## Theme
- [[quality]]
```

`test/fixtures/wiki/component/m3_nlp.md`:

```markdown
---
title: M3 NLP
summary: entity / IOC / theme extraction — in-batch concurrency
last_updated: 2026-05-28
code_sha: def5678
atoms: 8
commits: 5
---
# component: M3 NLP

## Current architecture

In-batch `asyncio.gather` + `Semaphore`.

## Cross-links

- Theme: [[quality]]
```

`test/fixtures/wiki/theme/quality.md`:

```markdown
---
title: Quality
summary: extraction accuracy + report quality evolution
last_updated: 2026-05-31
code_sha: abc1234
atoms: 14
commits: 9
---
# theme: quality

## Current architecture

Three gates: extraction, dedup, report threshold.

## Cross-links

- Component: [[m3_nlp]]
```

- [ ] **Step 2: Commit**

```bash
git add test/fixtures/wiki
git commit -m "test: committed fixture wiki for serve integration"
```

---

## Task 15: End-to-end integration test

**Files:**
- Create: `test/integration.test.js`

- [ ] **Step 1: Write the integration test**

```js
// test/integration.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runManifestCli } from '../lib/manifest.js';
import { start, stop } from '../lib/serve.js';

test('e2e: fixtures -> manifest -> serve -> fetch page -> stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-e2e-'));
  try {
    // build a git repo containing .lore with fixture wiki + shell
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'site'), { recursive: true });
    cpSync(join(process.cwd(), 'test', 'fixtures', 'wiki'), join(lore, 'wiki'), { recursive: true });
    cpSync(join(process.cwd(), 'site', 'index.html'), join(lore, 'site', 'index.html'));
    cpSync(join(process.cwd(), 'site', 'shell.mjs'), join(lore, 'site', 'shell.mjs'));
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });

    // 1. manifest
    const manifestPath = runManifestCli(lore, '2026-05-31T00:00:00Z');
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(m.axes.find(a => a.id === 'component').pages[0].id, 'm3_nlp');

    // 2. determinism: nuke + rebuild → byte-identical (same clock)
    const first = readFileSync(manifestPath, 'utf8');
    rmSync(manifestPath);
    runManifestCli(lore, '2026-05-31T00:00:00Z');
    assert.equal(readFileSync(manifestPath, 'utf8'), first);

    // 3. serve (force node fallback for determinism)
    const info = await start({ loreDir: lore, port: 0, canRun: () => false, now: 't' });

    // 4. fetch shell, manifest, a page
    assert.equal((await fetch(info.url + 'index.html')).status, 200);
    assert.equal((await fetch(info.url + '../wiki/.manifest.json')).status, 200);
    const page = await fetch(info.url + '../wiki/component/m3_nlp.md');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /component: M3 NLP/);

    // 5. stop
    const res = await stop({ loreDir: lore });
    assert.equal(res.stopped, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run the full suite**

Run: `node --test`
Expected: PASS — every test file green (manifest 9, server 3, serve 13, shell 11, integration 1).

- [ ] **Step 3: Commit**

```bash
git add test/integration.test.js
git commit -m "test: end-to-end fixtures->manifest->serve->fetch->stop"
```

---

## Task 16: Slash command definition

**Files:**
- Create: `commands/lore-serve.md`

- [ ] **Step 1: Create the slash command**

```markdown
---
description: Start/stop a local web server to browse the lore wiki in a browser
---

# /lore:serve

Start a local static server and browser shell for `.lore/wiki/`, or stop a running one.

## Usage

- `/lore:serve` — start (default port 7842, auto-increments if busy)
- `/lore:serve --port 9000` — start on a specific port
- `/lore:serve --stop` — stop the running server

## Behavior

This command is a thin wrapper over `lib/serve.js`. Run from the target repo root
(the directory containing `.lore/`).

**To start**, run:

​```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/serve.js" start --lore "$(pwd)/.lore"
​```

(append `--port N` if the user gave one)

**To stop**, run:

​```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/serve.js" stop --lore "$(pwd)/.lore"
​```

## Notes for the agent

- Precondition: `.lore/wiki/.manifest.json` must exist. If the command prints
  "run /lore:sync first", tell the user to run `/lore:sync` before serving.
- The server binds `127.0.0.1` only (local browsing; never exposed to the LAN).
- Report the printed URL to the user; the process runs in the background and does
  not block the session. Remind them they can stop it with `/lore:serve --stop`.
- Do not modify any target-repo source; serve only reads `.lore/`.
```

- [ ] **Step 2: Verify the command file is valid markdown with front-matter**

Run: `node -e "const s=require('fs').readFileSync('commands/lore-serve.md','utf8'); if(!s.startsWith('---')) process.exit(1); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add commands/lore-serve.md
git commit -m "feat(command): /lore:serve slash command definition"
```

---

## Task 17: Final full-suite gate + README note

**Files:**
- Create: `README.md`

- [ ] **Step 1: Run the entire suite one final time**

Run: `node --test`
Expected: ALL pass, exit 0. Note the total test count.

- [ ] **Step 2: Create a minimal `README.md`**

```markdown
# lore

Repo living-docs / decision-history framework. See the design spec in
`docs/superpowers/specs/`.

## `/lore:serve` (implemented)

Local browser view of the wiki — no Obsidian required.

​```bash
node lib/serve.js start --lore <path-to>/.lore    # start (prints URL)
node lib/serve.js stop  --lore <path-to>/.lore    # stop
​```

A dumb static server (probes `python3` → `python` → bundled Node) serves `.lore/`;
the no-build shell in `site/` renders the wiki client-side. The manifest the shell
consumes is produced by `node lib/manifest.js <path-to>/.lore` (later called as the
final step of `/lore:sync`).

## Development

​```bash
node --test        # run all tests (zero external deps)
​```
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with /lore:serve usage"
```

---

## Self-Review (completed during planning)

**1. Spec coverage (§5.5):**
- Dumb static server + probe chain → Tasks 5, 6 ✓
- Backgrounded/detached, returns 127.0.0.1 URL, `--stop` → Tasks 9, 10 ✓
- Idempotent start (reuse running) → Task 9 ✓
- Client-side shell, single-render, hash routing → Tasks 11–13 ✓
- Sidebar facet nav, md render, `[[wikilink]]` in-shell jump, search, meta bar → Tasks 11–13 ✓
- ≥3 themes (dark/light/sepia) + localStorage → Task 13 ✓
- `.manifest.json` emitted by sync finalizer (built standalone here) → Tasks 1–4 ✓
- Dual-renderer compat: `[[x]]` rewrite (Task 12), dotfile manifest (`.manifest.json` path used throughout), front-matter handled (strip in shell / parse in manifest) ✓
- Path-traversal guard → Task 5 ✓
- Determinism / byte-identical manifest invariant → Tasks 3, 15 ✓
- Target-repo source read-only: serve only reads `.lore/`; command file states it; no task writes target source ✓
- Cross-platform kill → Task 8 ✓

**2. Placeholder scan:** No TBD/TODO; every code step contains complete code; manual-verify task (13) lists exact checklist + commands. ✓

**3. Type consistency:** `emitManifest` page shape (`id/title/summary/path/stale/code_sha/synthesized_from/last_updated`) is produced in Tasks 3+12 and consumed identically by `buildMeta`/`buildNavModel`/sidebar in Tasks 12–13. `start`/`stop` signatures in Task 9 match CLI calls in Task 10 and integration in Task 15. `createServer(rootDir)` consistent across Tasks 5, 9, 15. ✓

**Deferred to future plans (out of serve scope, correctly excluded):** journal/hook/mine/synthesis/lint/ask, real `/lore:sync` (only its `emit_manifest` finalizer is built here), `/lore:init` shell-copy step, relationship-graph visualization (v2).

