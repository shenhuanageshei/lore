---
title: post-commit hook Implementation Plan
summary: > **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.
source_path: docs/superpowers/plans/2026-06-02-lore-hook.md
last_updated: 2026-06-02
---
> 源文档：`docs/superpowers/plans/2026-06-02-lore-hook.md`

# post-commit hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Auto-write a journal skeleton atom on every commit via a `.git/hooks/post-commit` hook — `lib/hook.js` (single-commit capture, deterministic, <50ms, best-effort) installed by an extended `/lore:init`.

**Architecture:** `lib/hook.js` reuses mine's `parseGitLog`/`commitAtom` + journal's `existingIds`/`appendAtom` to capture HEAD's commit as an atom (`source:'hook'`), dedup-append. `installHook` in `lib/init.js` writes a sh stub (install-if-absent, warn-if-exists/hooksPath/no-git) + flips config `hook:true`. Fully deterministic, no LLM.

**Tech Stack:** Node ESM, `node:test`, zero deps. Reuses `lib/mine.js`, `lib/journal.js`, `lib/config.js`.

**Spec:** `docs/superpowers/specs/2026-06-02-lore-hook-design.md`. **Parent:** `2026-05-31-lore-repo-wiki-design.md` §4①/§6/§7.

**Branch:** `lore-hook` (off main).

---

## Task 1: mine.js — export GIT_FORMAT + commitAtom source param

**Files:** Modify `lib/mine.js`; Test `test/mine.test.js`

- [ ] **Step 1: Failing test** — append to `test/mine.test.js`:

```js
test('commitAtom: source param overrides default', () => {
  const raw = { sha: 'abc', ts: '2026-06-01T08:00:00Z', subject: 's', body: '', files: [] };
  assert.equal(commitAtom(raw, []).source, 'miner:commits');         // default unchanged
  assert.equal(commitAtom(raw, [], 'hook').source, 'hook');          // override
});
```

- [ ] **Step 2: Run** `node --test test/mine.test.js` → FAIL (3rd-arg ignored → `source` stays `miner:commits`).

- [ ] **Step 3: Implement.** In `lib/mine.js`: (a) add `export` to the `GIT_FORMAT` const line (`const GIT_FORMAT = ...` → `export const GIT_FORMAT = ...`). (b) change `commitAtom` signature + the `source` field:

```js
export function commitAtom(raw, codeRoots, source = 'miner:commits') {
  const component = [...new Set(
    raw.files.map(f => pathComponent(f, codeRoots)).filter(Boolean),
  )].sort();
  return {
    id: `commit:${raw.sha}`,
    ts: raw.ts,
    kind: 'commit',
    commit: raw.sha,
    title: raw.subject,
    why: raw.body,
    what_changed: '',
    facets: { component, flow: [], theme: [] },
    refs: { files: raw.files, pitfall: null, related: [] },
    source,
    enriched: false,
    confidence: 'EXTRACTED',
  };
}
```

- [ ] **Step 4: Run** `node --test test/mine.test.js` → PASS (existing commitAtom tests still pass — default is `miner:commits`).

- [ ] **Step 5: Commit**
```bash
git add lib/mine.js test/mine.test.js
git commit -m "refactor(mine): export GIT_FORMAT + commitAtom source param (for hook reuse)"
```

---

## Task 2: lib/hook.js — captureHead + CLI

**Files:** Create `lib/hook.js`, `test/hook.test.js`

- [ ] **Step 1: Failing test** — `test/hook.test.js`:

```js
// test/hook.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureHead } from '../lib/hook.js';
import { readAllAtoms } from '../lib/journal.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-hook-')); }
function gitRepo() {
  const root = tmpDir();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  return root;
}
function commitFile(root, rel, content, msg) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', msg], { cwd: root });
}

test('captureHead writes HEAD commit atom (source=hook), idempotent', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'x', 'add lib');
    const journalDir = join(root, '.lore', 'journal');
    const r1 = captureHead({ repoRoot: root, journalDir, codeRoots: ['lib'] });
    assert.equal(r1.added, 1);
    const atoms = readAllAtoms(journalDir);
    assert.equal(atoms.length, 1);
    assert.equal(atoms[0].title, 'add lib');
    assert.equal(atoms[0].source, 'hook');
    assert.deepEqual(atoms[0].facets.component, ['lib']);
    // idempotent: same HEAD → no new atom
    assert.equal(captureHead({ repoRoot: root, journalDir, codeRoots: ['lib'] }).added, 0);
    assert.equal(readAllAtoms(journalDir).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('captureHead on a merge HEAD adds nothing new', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'a.txt', '1', 'base');
    execFileSync('git', ['checkout', '-q', '-b', 'feat'], { cwd: root });
    commitFile(root, 'b.txt', '2', 'feat commit');
    execFileSync('git', ['checkout', '-q', 'master'], { cwd: root });
    // ensure a divergent commit on master so the merge is a real merge commit
    commitFile(root, 'c.txt', '3', 'master commit');
    execFileSync('git', ['merge', '-q', '--no-ff', '-m', 'merge feat', 'feat'], { cwd: root });
    const journalDir = join(root, '.lore', 'journal');
    // HEAD is a merge commit → --no-merges falls back to an ancestor (already capturable);
    // capturing it once then again must not double-add.
    const first = captureHead({ repoRoot: root, journalDir, codeRoots: [] });
    const second = captureHead({ repoRoot: root, journalDir, codeRoots: [] });
    assert.equal(second.added, 0);   // idempotent regardless
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI never throws / exits 0 even on a non-git dir', () => {
  const root = tmpDir();   // not a git repo
  try {
    // should exit 0 (best-effort), not throw
    execFileSync('node', ['lib/hook.js', root], { cwd: process.cwd() });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** `node --test test/hook.test.js` → FAIL (`captureHead` not exported).

- [ ] **Step 3: Implement** `lib/hook.js`:

```js
// lib/hook.js
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGitLog, commitAtom, GIT_FORMAT } from './mine.js';
import { existingIds, appendAtom } from './journal.js';
import { parseConfigCodeRoots } from './config.js';

export function captureHead({ repoRoot, journalDir, codeRoots }) {
  const stdout = execFileSync(
    'git',
    ['log', '-1', '--no-merges', `--pretty=format:${GIT_FORMAT}`, '--name-only', 'HEAD'],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
  ).toString();
  const raws = parseGitLog(stdout);
  if (raws.length === 0) return { added: 0 };
  const atom = commitAtom(raws[0], codeRoots, 'hook');
  if (existingIds(journalDir).has(atom.id)) return { added: 0 };
  appendAtom(journalDir, atom);
  return { added: 1 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const repoRoot = process.argv[2] ?? process.cwd();
    const loreDir = join(repoRoot, '.lore');
    const configPath = join(loreDir, 'config.yml');
    const codeRoots = existsSync(configPath)
      ? parseConfigCodeRoots(readFileSync(configPath, 'utf8'))
      : [];
    captureHead({ repoRoot, journalDir: join(loreDir, 'journal'), codeRoots });
  } catch {
    // best-effort: a hook must never block a commit
  }
  process.exit(0);
}
```

- [ ] **Step 4: Run** `node --test test/hook.test.js` → PASS (3 tests).

- [ ] **Step 5: Commit**
```bash
git add lib/hook.js test/hook.test.js
git commit -m "feat(hook): captureHead writes HEAD commit atom (best-effort, source=hook)"
```

---

## Task 3: installHook in lib/init.js

**Files:** Modify `lib/init.js`; Test `test/init.test.js`

- [ ] **Step 1: Failing test** — append to `test/init.test.js`:

```js
import { installHook } from '../lib/init.js';

function bareGitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'lore-hook-init-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

test('installHook: installs lore post-commit when absent (idempotent)', () => {
  const root = bareGitRepo();
  try {
    assert.equal(installHook(root), 'installed');
    const hook = readFileSync(join(root, '.git', 'hooks', 'post-commit'), 'utf8');
    assert.match(hook, /# lore:post-commit/);
    assert.match(hook, /lib\/hook\.js/);          // forward-slash path
    assert.doesNotMatch(hook, /\\/);              // no backslashes (sh-safe)
    assert.equal(installHook(root), 'present');   // idempotent
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installHook: does not clobber a foreign hook', () => {
  const root = bareGitRepo();
  try {
    const hp = join(root, '.git', 'hooks', 'post-commit');
    writeFileSync(hp, '#!/bin/sh\necho custom\n');
    assert.equal(installHook(root), 'exists-foreign');
    assert.equal(readFileSync(hp, 'utf8'), '#!/bin/sh\necho custom\n');  // untouched
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installHook: warns when core.hooksPath set', () => {
  const root = bareGitRepo();
  try {
    execFileSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: root });
    assert.equal(installHook(root), 'hookspath-set');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installHook: no-git dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-nogit-'));
  try {
    assert.equal(installHook(root), 'no-git');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** `node --test test/init.test.js` → FAIL (`installHook` not exported).

- [ ] **Step 3: Implement.** In `lib/init.js`: ensure imports include `execFileSync` (from `node:child_process`) and `chmodSync` (merge into the existing `node:fs` import). `dirname`/`fileURLToPath`/`existsSync`/`readFileSync`/`writeFileSync`/`mkdirSync`/`join` already imported (CLI + existing fns). Add:

```js
const HOOK_MARKER = '# lore:post-commit';

export function installHook(repoRoot) {
  const gitDir = join(repoRoot, '.git');
  if (!existsSync(gitDir)) return 'no-git';
  let hooksPath = '';
  try {
    hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: repoRoot })
      .toString().trim();
  } catch { /* unset → empty */ }
  if (hooksPath) return 'hookspath-set';

  const hookPath = join(gitDir, 'hooks', 'post-commit');
  if (existsSync(hookPath)) {
    return readFileSync(hookPath, 'utf8').includes(HOOK_MARKER) ? 'present' : 'exists-foreign';
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const hookJs = join(here, 'hook.js').replace(/\\/g, '/');   // forward-slash: sh-safe on Windows
  const stub = `#!/bin/sh\n${HOOK_MARKER} (auto-generated by /lore:init)\nnode "${hookJs}" "$(git rev-parse --show-toplevel)" >/dev/null 2>&1 || true\n`;
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, stub);
  try { chmodSync(hookPath, 0o755); } catch { /* best-effort (Windows ignores) */ }
  return 'installed';
}
```

- [ ] **Step 4: Run** `node --test test/init.test.js` → PASS (4 new + existing).

- [ ] **Step 5: Commit**
```bash
git add lib/init.js test/init.test.js
git commit -m "feat(init): installHook writes post-commit stub (install-if-absent, strategy A)"
```

---

## Task 4: wire init() + config hook:true

**Files:** Modify `lib/init.js`; Test `test/init.test.js`

- [ ] **Step 1: Failing test** — append to `test/init.test.js`:

```js
test('init installs the hook and sets config hook: true', () => {
  const root = bareGitRepo();
  const src = fakeSrcSite(root);   // existing helper that builds a srcSiteDir with index.html+shell.mjs
  try {
    const r = init({ repoRoot: root, srcSiteDir: src });
    assert.equal(r.hook, 'installed');
    assert.equal(existsSync(join(root, '.git', 'hooks', 'post-commit')), true);
    assert.match(readFileSync(join(root, '.lore', 'config.yml'), 'utf8'), /hook: true/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

> NOTE: `fakeSrcSite` is an existing helper in `test/init.test.js`. If its signature differs, build the srcSiteDir inline the same way the existing init tests do (a temp dir with `index.html` + `shell.mjs`). Read the file to match.

- [ ] **Step 2: Run** `node --test test/init.test.js` → FAIL (`r.hook` undefined; config still `hook: false`). Also expect any EXISTING init test that asserted `hook: false` to now fail — those will be updated in Step 3.

- [ ] **Step 3: Implement.** Two edits in `lib/init.js`:

(a) In `init()`, call `installHook` and include it in the report. Change the end of `init` from:
```js
  const gitignore = ensureGitignore(repoRoot);
  return { loreDir, copied, codeRoots, configWritten, gitignore };
```
to:
```js
  const gitignore = ensureGitignore(repoRoot);
  const hook = installHook(repoRoot);
  return { loreDir, copied, codeRoots, configWritten, gitignore, hook };
```

(b) In `renderConfigYaml`, flip the journal hook line. Change:
```js
  hook: false                # post-commit hook 由后续版本安装（本版未装）
```
to:
```js
  hook: true                 # post-commit hook 已装（每 commit 写 journal 骨架原子）
```

Then update any EXISTING test in `test/init.test.js` that asserts `hook: false` in the rendered config → assert `hook: true` (read the file; there is a `renderConfigYaml` test asserting `/hook: false/`).

- [ ] **Step 4: Run** `node --test test/init.test.js` → PASS. Then `node --test` (full suite) → PASS (update any integration test that asserted no `.git/hooks` if present; the existing serve/sync integration tests use `init` on a git repo and will now also install a hook — that is harmless to those assertions, but verify).

- [ ] **Step 5: Commit**
```bash
git add lib/init.js test/init.test.js
git commit -m "feat(init): init installs post-commit hook + config hook: true"
```

---

## Task 5: docs — command + README

**Files:** Modify `commands/lore-init.md`, `README.md`

- [ ] **Step 1: Update `commands/lore-init.md`.** Find the agent-tip line stating the hook is NOT installed (text like `本版**不安装 post-commit hook**`). Replace that clause with:
```
- 现装 **post-commit hook**：每 commit 自动写一条 journal 骨架原子（机械、零 LLM、不阻断 commit）。已有 hook / 设了 `core.hooksPath` / 非 git repo → 跳过并提示（不覆盖你的 hook）。
```
Also, if step 1 of the 行为 list says hook is deferred, update it to note the hook is installed.

- [ ] **Step 2: Update `README.md`** `/lore:init` section: append a sentence:
```
init 现装 post-commit hook —— 每 commit 自动写 journal 骨架原子（已有 hook / `core.hooksPath` / 非 git 则跳过）。
```

- [ ] **Step 3: Sanity** `node -e "const s=require('fs').readFileSync('commands/lore-init.md','utf8'); if(s.includes('不安装 post-commit')) process.exit(1); console.log('ok')"` → `ok`.

- [ ] **Step 4: Commit**
```bash
git add commands/lore-init.md README.md
git commit -m "docs: /lore:init now installs the post-commit hook"
```

---

## Task 6: integration — init → real commit → hook fires

**Files:** Modify `test/hook.test.js` (append)

- [ ] **Step 1: Write the test** — append to `test/hook.test.js`:

```js
import { init } from '../lib/init.js';

test('integration: init installs hook → a real commit auto-writes a journal atom', () => {
  const root = gitRepo();
  try {
    // discoverable code dir so init writes code_roots: [lib]
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'a.js'), 'export const x = 1;');
    const r = init({ repoRoot: root, srcSiteDir: join(process.cwd(), 'site') });
    assert.equal(r.hook, 'installed');

    // a real commit AFTER init → the post-commit hook fires and writes an atom
    writeFileSync(join(root, 'lib', 'b.js'), 'export const y = 2;');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'add b'], { cwd: root });

    const atoms = readAllAtoms(join(root, '.lore', 'journal'));
    const added = atoms.find(a => a.title === 'add b');
    assert.ok(added, 'hook should have captured the "add b" commit');
    assert.equal(added.source, 'hook');
    assert.deepEqual(added.facets.component, ['lib']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** `node --test test/hook.test.js` → PASS — the installed hook fires on the real `git commit` and `captureHead` writes the `add b` atom. If it fails because the hook did not fire (e.g. node not on PATH in the test's git env, or hook not executable), investigate: confirm the stub path is correct + forward-slash, and that `git commit` actually runs `.git/hooks/post-commit`. (On Windows, git runs hooks via its bundled sh; `node` must be on PATH.)

- [ ] **Step 3: Full suite** `node --test` → all green.

- [ ] **Step 4: Commit**
```bash
git add test/hook.test.js
git commit -m "test(hook): integration init → real commit fires hook → journal atom"
```

---

## Self-Review

**Spec coverage:** §1 scope → all tasks; §2 captureHead (reuse parseGitLog/commitAtom/existingIds/appendAtom, source='hook', merge edge, best-effort CLI) → Tasks 1-2; §3 installHook (5 states, posix path, chmod, marker) → Task 3; init wiring + config hook:true → Task 4; §4 docs → Task 5; §5 tests → Tasks 2-3-4-6; §6 acceptance → all; §7 out-of-scope (flow/theme, chain, hooksPath-install, enrich) → not built.

**Placeholder scan:** none. Task 4 notes reading existing `fakeSrcSite`/`hook:false` test to match — concrete, not a placeholder.

**Type consistency:** `commitAtom(raw, codeRoots, source='miner:commits')` (Task 1) used by `captureHead` with `'hook'` (Task 2) and unchanged by mine (default). `GIT_FORMAT` exported (Task 1) imported by hook (Task 2). `captureHead({repoRoot, journalDir, codeRoots}) -> {added}` (Task 2) reused in integration (Task 6). `installHook(repoRoot) -> 'installed'|'present'|'exists-foreign'|'hookspath-set'|'no-git'` (Task 3) used in `init` report `hook` field (Task 4) + integration (Task 6). `readAllAtoms`/`existingIds`/`appendAtom` from journal.js, `parseGitLog`/`commitAtom` from mine.js, `parseConfigCodeRoots` from config.js — all existing signatures.

