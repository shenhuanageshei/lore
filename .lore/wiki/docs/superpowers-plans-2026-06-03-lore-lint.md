---
title: /lore:lint Implementation Plan
summary: > **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.
source_path: docs/superpowers/plans/2026-06-03-lore-lint.md
last_updated: 2026-06-03
group: 设计与计划
---
> 源文档：`docs/superpowers/plans/2026-06-03-lore-lint.md`

# /lore:lint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** `/lore:lint` prints a read-only drift report — stale component pages (code_sha behind HEAD), orphans (page with no matching code_root), missing (code_root with no page) — reusing manifest's stale logic. Never writes anything.

**Architecture:** `lib/lint.js` = pure checks (`lintOrphans`/`lintMissing`/`lintStale`) + a `lint({loreDir})` orchestrator that reads config/wiki/git + a CLI. `lib/manifest.js` exposes its existing `gitCurrentSha` + `makeCountCommitsSince` so lint's "stale" is the same computation serve's manifest uses.

**Tech Stack:** Node ESM, `node:test`, zero deps. Reuses `lib/manifest.js` (`parseFrontmatter` + git helpers), `lib/config.js`.

**Spec:** `docs/superpowers/specs/2026-06-03-lore-lint-design.md`. **Branch:** `lore-lint` (off main).

---

## Task 1: manifest.js — export git helpers

**Files:** Modify `lib/manifest.js`; Test `test/manifest.test.js`

- [ ] **Step 1: Failing test** — append to `test/manifest.test.js` (read the file first; reuse any existing temp-git helper, else use this self-contained one):

```js
import { gitCurrentSha, makeCountCommitsSince } from '../lib/manifest.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('gitCurrentSha + makeCountCommitsSince are exported and work', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mf-git-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), '1');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'c1'], { cwd: root });
    const sha1 = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
    writeFileSync(join(root, 'b.txt'), '2');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'c2'], { cwd: root });

    assert.match(gitCurrentSha(root), /^[0-9a-f]{7,}$/);
    assert.equal(makeCountCommitsSince(root)(sha1), 1);   // 1 commit (c2) since c1
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

(If `test/manifest.test.js` already imports `mkdtempSync`/`execFileSync`/etc., merge — don't duplicate imports.)

- [ ] **Step 2: Run** `node --test test/manifest.test.js` → FAIL (`gitCurrentSha`/`makeCountCommitsSince` not exported).

- [ ] **Step 3: Implement.** In `lib/manifest.js`, add `export` to the two existing function declarations. Find `function gitCurrentSha(repoRoot) {` → `export function gitCurrentSha(repoRoot) {`. Find `function makeCountCommitsSince(repoRoot) {` → `export function makeCountCommitsSince(repoRoot) {`. Change NOTHING else (the functions' bodies + their internal use by `runManifestCli` are unchanged).

- [ ] **Step 4: Run** `node --test test/manifest.test.js` → PASS (new + existing manifest tests).

- [ ] **Step 5: Commit**
```bash
git add lib/manifest.js test/manifest.test.js
git commit -m "refactor(manifest): export gitCurrentSha + makeCountCommitsSince (for lint reuse)"
```

---

## Task 2: lint.js — pure orphan/missing checks

**Files:** Create `lib/lint.js`, `test/lint.test.js`

- [ ] **Step 1: Failing test** — `test/lint.test.js`:

```js
// test/lint.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { lintOrphans, lintMissing } from '../lib/lint.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-lint-')); }

test('lintOrphans: page ids not matching any code_root last-segment', () => {
  assert.deepEqual(lintOrphans(['lib', 'gone'], ['lib', 'src/pkg']), ['gone']);
  assert.deepEqual(lintOrphans(['lib', 'pkg'], ['lib', 'src/pkg']), []);   // pkg ← src/pkg
});

test('lintMissing: code_root last-segments with no page', () => {
  assert.deepEqual(lintMissing(['lib'], ['lib', 'src/pkg']), ['pkg']);     // pkg page missing
  assert.deepEqual(lintMissing(['lib', 'pkg'], ['lib', 'src/pkg']), []);
});
```

- [ ] **Step 2: Run** `node --test test/lint.test.js` → FAIL (not exported).

- [ ] **Step 3: Implement** `lib/lint.js`:

```js
// lib/lint.js
function rootName(codeRoot) {
  return codeRoot.split('/').pop();
}

export function lintOrphans(pageIds, codeRoots) {
  const names = new Set(codeRoots.map(rootName));
  return pageIds.filter(id => !names.has(id));
}

export function lintMissing(pageIds, codeRoots) {
  const pages = new Set(pageIds);
  return [...new Set(codeRoots.map(rootName))].filter(c => !pages.has(c));
}
```

- [ ] **Step 4: Run** `node --test test/lint.test.js` → PASS (2 tests).

- [ ] **Step 5: Commit**
```bash
git add lib/lint.js test/lint.test.js
git commit -m "feat(lint): lintOrphans + lintMissing (page↔code_root diff)"
```

---

## Task 3: lint.js — lintStale + componentPages + lint orchestrator

**Files:** Modify `lib/lint.js`; Test `test/lint.test.js`

- [ ] **Step 1: Failing test** — append to `test/lint.test.js`:

```js
import { lintStale, lint } from '../lib/lint.js';

test('lintStale: pages whose code_sha != current → behind via countSince', () => {
  const pages = [
    { id: 'a', code_sha: 'old1234' },
    { id: 'b', code_sha: 'cur5678' },   // == current → not stale
    { id: 'c', code_sha: '' },           // no sha → skipped
  ];
  const countSince = sha => (sha === 'old1234' ? 3 : 0);
  assert.deepEqual(lintStale(pages, 'cur5678', countSince), [
    { page: 'a', code_sha: 'old1234', behind: 3 },
  ]);
});

function gitRepo() {
  const root = tmpDir();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  writeFileSync(join(root, 'f.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'c1'], { cwd: root });
  return root;
}
function page(loreDir, id, codeSha) {
  const dir = join(loreDir, 'wiki', 'component');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), `---\ntitle: ${id}\ncode_sha: ${codeSha}\n---\n# ${id}\n`);
}

test('lint orchestrator reports stale + orphan + missing', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    const cur = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib, site]\n');
    page(lore, 'lib', 'deadbee');   // stale (old sha) + valid root
    page(lore, 'gone', cur);        // orphan (no code_root 'gone'), not stale
    // 'site' code_root has no page → missing

    const r = lint({ loreDir: lore });
    assert.deepEqual(r.stale.map(s => s.page), ['lib']);
    assert.ok(r.stale[0].behind >= 1);
    assert.deepEqual(r.orphans, ['gone']);
    assert.deepEqual(r.missing, ['site']);
    assert.equal(r.clean, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lint: clean repo → clean:true', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    const cur = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib]\n');
    page(lore, 'lib', cur);   // current sha, matches root → no drift
    const r = lint({ loreDir: lore });
    assert.deepEqual(r, { stale: [], orphans: [], missing: [], clean: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** `node --test test/lint.test.js` → FAIL (`lintStale`/`lint` not exported).

- [ ] **Step 3: Implement** — append to `lib/lint.js`:

```js
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, gitCurrentSha, makeCountCommitsSince } from './manifest.js';
import { parseConfigCodeRoots } from './config.js';

function componentPages(wikiDir) {
  const dir = join(wikiDir, 'component');
  let files = [];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => e.name).sort();
  } catch { return []; }
  return files.map(f => {
    const { data } = parseFrontmatter(readFileSync(join(dir, f), 'utf8'));
    return { id: basename(f, '.md'), code_sha: data.code_sha ?? '' };
  });
}

export function lintStale(pages, currentSha, countSince) {
  return pages
    .filter(p => p.code_sha && p.code_sha !== currentSha)
    .map(p => ({ page: p.id, code_sha: p.code_sha, behind: countSince(p.code_sha) }));
}

export function lint({ loreDir }) {
  const wikiDir = join(loreDir, 'wiki');
  const configPath = join(loreDir, 'config.yml');
  const codeRoots = existsSync(configPath)
    ? parseConfigCodeRoots(readFileSync(configPath, 'utf8'))
    : [];
  const pages = componentPages(wikiDir);
  const ids = pages.map(p => p.id);

  let currentSha = '';
  let countSince = () => 0;
  try {
    const repoRoot = join(resolve(loreDir), '..');
    currentSha = gitCurrentSha(repoRoot);
    countSince = makeCountCommitsSince(repoRoot);
  } catch { /* non-git → skip stale */ }

  const stale = currentSha ? lintStale(pages, currentSha, countSince) : [];
  const orphans = lintOrphans(ids, codeRoots);
  const missing = lintMissing(ids, codeRoots);
  return { stale, orphans, missing, clean: stale.length === 0 && orphans.length === 0 && missing.length === 0 };
}
```

(Merge the new imports cleanly; `lintOrphans`/`lintMissing`/`rootName` from Task 2 already exist in the file.)

- [ ] **Step 4: Run** `node --test test/lint.test.js` → PASS (5 tests).

- [ ] **Step 5: Commit**
```bash
git add lib/lint.js test/lint.test.js
git commit -m "feat(lint): lintStale + lint orchestrator (config/wiki/git, read-only)"
```

---

## Task 4: lint CLI

**Files:** Modify `lib/lint.js`; Test `test/lint.test.js`

- [ ] **Step 1: Failing test** — append to `test/lint.test.js`:

```js
test('CLI: prints report and exits 0 (drift)', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib, site]\n');
    page(lore, 'gone', '');   // orphan
    const out = execFileSync('node', ['lib/lint.js', lore], { cwd: process.cwd() }).toString();
    assert.match(out, /orphans/);
    assert.match(out, /gone/);
    assert.match(out, /missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: clean repo prints clean and exits 0', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    const cur = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib]\n');
    page(lore, 'lib', cur);
    const out = execFileSync('node', ['lib/lint.js', lore], { cwd: process.cwd() }).toString();
    assert.match(out, /clean/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** `node --test test/lint.test.js` → FAIL (CLI prints nothing → `JSON`/match fails; actually `execFileSync` returns empty → assertions fail).

- [ ] **Step 3: Implement** — append the CLI guard to `lib/lint.js`:

```js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const loreDir = process.argv[2] ?? join(process.cwd(), '.lore');
  const r = lint({ loreDir });
  if (r.clean) {
    console.log('✓ lore lint: clean (no drift)');
  } else {
    if (r.stale.length) console.log(`stale (${r.stale.length}): ` + r.stale.map(s => `${s.page} (behind ${s.behind})`).join(', '));
    if (r.orphans.length) console.log(`orphans (${r.orphans.length}): ${r.orphans.join(', ')}`);
    if (r.missing.length) console.log(`missing (${r.missing.length}): ${r.missing.join(', ')} → run /lore:sync`);
  }
  process.exit(0);
}
```

- [ ] **Step 4: Run** `node --test test/lint.test.js` → PASS (7 tests).

- [ ] **Step 5: Commit**
```bash
git add lib/lint.js test/lint.test.js
git commit -m "feat(lint): CLI prints drift report (exit 0, advisory)"
```

---

## Task 5: command + README + integration

**Files:** Create `commands/lore-lint.md`; Modify `README.md`; Modify `test/lint.test.js`

- [ ] **Step 1: Create `commands/lore-lint.md`** (real ```bash fence; frontmatter first; UTF-8):

````markdown
---
description: 只读漂移报告 —— 报陈旧页（落后 N commits）/ orphan / missing，不自动改
---

# /lore:lint

只读检查 wiki 与代码/config 的漂移：陈旧页（`code_sha` 落后当前 HEAD）、orphan（页无对应 `code_root`）、missing（`code_root` 无页）。**只报不改**（修复跑 `/lore:sync`）。

## 用法

- `/lore:lint` —— 报告当前 repo 的 wiki 漂移

## 行为

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/lint.js" "$(pwd)/.lore"
```

打印分组报告（stale / orphans / missing）或 `✓ clean`。exit 0（咨询，不阻断）。

## 给 agent 的提示

- 漂移 = wiki 落后代码。**stale 多 → 跑 `/lore:sync` 重合成**；**missing → 该 `code_root` 还没 sync**；**orphan → `code_root` 改名/删了，删页或改 config**。
- 只读：不改 wiki / 源码 / .lore。
- 本版三检（stale/orphan/missing）；未打标/矛盾检查随 flow/theme 落地。
````

> Note: real triple-backtick fence in the actual file.

- [ ] **Step 2: Sanity** `node -e "const s=require('fs').readFileSync('commands/lore-lint.md','utf8'); if(!s.includes('lib/lint.js')||!s.startsWith('---')) process.exit(1); console.log('ok')"` → `ok`.

- [ ] **Step 3: README** — add a `## /lore:lint（已实现）` section (after `/lore:sync`, before `/lore:serve` — lint is a consumer-side check):

```markdown
## `/lore:lint`（已实现）

只读漂移报告：`node lib/lint.js <.lore目录>` → 报陈旧页（`code_sha` 落后 HEAD N commits）/ orphan（页无对应 code_root）/ missing（code_root 无页 → 提示 sync）。只报不改，exit 0（检测与修复分离：lint 报、sync 修）。stale 逻辑与 serve manifest 同源。
```

- [ ] **Step 4: Integration test** — append to `test/lint.test.js`:

```js
import { init } from '../lib/init.js';

test('integration: sync then a new commit makes the page stale → lint reports it', () => {
  const root = gitRepo();
  try {
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'a.js'), 'export const x = 1;');
    init({ repoRoot: root, srcSiteDir: join(process.cwd(), 'site') });
    const lore = join(root, '.lore');
    const compDir = join(lore, 'wiki', 'component');
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, 'lib.md'), `---\ntitle: Lib\nsummary: c\n---\n# component: Lib\n\n## Current architecture\n\nx\n\n## Decision history\n\n{{LORE_JOURNAL}}\n\n## Cross-links\n\n- [[x]]\n`);
    execFileSync('node', ['lib/sync.js', 'finalize', lore], { cwd: process.cwd() });   // stamps page code_sha = current HEAD
    // lint now: clean (page sha == HEAD)
    assert.equal(lint({ loreDir: lore }).stale.length, 0);
    // a new commit moves HEAD forward → page is now behind
    writeFileSync(join(root, 'lib', 'b.js'), 'export const y = 2;');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'add b'], { cwd: root });
    const r = lint({ loreDir: lore });
    assert.deepEqual(r.stale.map(s => s.page), ['lib']);
    assert.ok(r.stale[0].behind >= 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

> NOTE: `init` installs a post-commit hook; the `add b` commit fires it (writes a journal atom) — harmless to this lint test (lint reads page code_sha, not journal). The page's code_sha was stamped by `sync finalize` at the pre-`add b` HEAD, so after `add b` it is 1 behind.

- [ ] **Step 5: Run** `node --test test/lint.test.js` (8 tests) + full `node --test` → all green.

- [ ] **Step 6: Commit**
```bash
git add commands/lore-lint.md README.md test/lint.test.js
git commit -m "docs+test(lint): command, README, sync→stale→lint integration"
```

---

## Self-Review

**Spec coverage:** §1 (stale/orphan/missing, manifest export, read-only) → Tasks 1-5; §2 API → Tasks 1-3; §3 CLI → Task 4; §4 tests → all; §5 acceptance → all; §6 out-of-scope (untagged/AMBIGUOUS/contradiction/auto-fix/exit-nonzero) → not built.

**Placeholder scan:** none. Task 5 docs full content + backtick note + a NOTE about the hook firing during integration.

**Type consistency:** `gitCurrentSha(repoRoot)->string` + `makeCountCommitsSince(repoRoot)->(sha)=>number` (Task 1) reused in `lint` (Task 3). `lintOrphans(pageIds, codeRoots)`/`lintMissing(...)` (Task 2) + `lintStale(pages, currentSha, countSince)` with `pages=[{id, code_sha}]` (Task 3) → all consumed by `lint({loreDir}) -> {stale, orphans, missing, clean}` (Task 3), surfaced by the CLI (Task 4) + integration (Task 5). `parseFrontmatter`/`parseConfigCodeRoots` existing signatures. `rootName` (last path segment) consistent with how sync/mine derive component names (`split('/').pop()`).

