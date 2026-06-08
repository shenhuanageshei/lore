# lore 低摩擦合成（增量 sync + 提交即机械刷新）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 lore 的「prose 新鲜度」与「机械 finalize」用内容指纹解耦，让 `stale` 诚实、`plan` 增量、commit 后台自动机械刷新——大幅降低运维负担。

**Architecture:** 新增 `lib/fingerprint.js` 存每页 `{prose_hash, prose_sha}`（`prose_hash` 复用 `i18n.translationSourceHash`，已剥 frontmatter + 哨兵区）。`finalizeSync` 只在正文 hash 变了才推进 `prose_sha`，并把 frontmatter `code_sha` 盖成 `prose_sha`；`manifest.js` 按 code_root 精确算 `stale`；`planSync` 据指纹只挑动过代码的 component 页；`hook.js` 在 `captureHead` 后 detached spawn `finalize`。

**Tech Stack:** Node.js（零依赖、ESM）、`node:crypto`/`node:child_process`/`node:fs`、`git rev-list`、`node --test`。

**Spec:** `docs/superpowers/specs/2026-06-08-lore-low-friction-sync-design.md`（设计已批，方案 1 内容指纹）。

---

## File Structure

新增：
- `lib/fingerprint.js` —— 指纹层。职责：`fingerprintsPath` / `readFingerprints` / `writeFingerprints` / `proseHash`。纯函数 + 路径注入。
- `test/fingerprint.test.js` —— 指纹层测试。

修改：
- `lib/manifest.js` —— `makeCountCommitsSince` 加可选 pathspec；`pageEntry` / `emitManifest` / `runManifestCli` 接收并使用 `staleScopes`（page rel → pathspec[]）。
- `lib/sync.js` —— `finalizeSync` 指纹化（盖 `prose_sha` + GC 孤儿 + 构造并传 `staleScopes`）；`planSync` 增量 + `--all`。
- `lib/hook.js` —— 新增 `maybeRefresh`（有 manifest 才 detached spawn finalize）；CLI 块调用它。
- `commands/sync.md` —— 说明增量 + `--all`。
- `docs/ROADMAP.md` —— 增量 sync 标完成。

扩展测试：`test/sync.test.js`、`test/manifest.test.js`、`test/hook.test.js`。

不动：`i18n.js`（复用其 `translationSourceHash`）、`journal.js`、`fold.js`、`graph.js`、`docs.js`、`home.js`、`config.js`。

---

## Task 1: `lib/fingerprint.js` —— 指纹层

**Files:**
- Create: `lib/fingerprint.js`
- Test: `test/fingerprint.test.js`

- [ ] **Step 1: 写失败测试**

Create `test/fingerprint.test.js`:

```js
// test/fingerprint.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFingerprints, writeFingerprints, proseHash, fingerprintsPath } from '../lib/fingerprint.js';

function tmpState() { return mkdtempSync(join(tmpdir(), 'lore-fp-')); }

test('writeFingerprints → readFingerprints round-trips', () => {
  const s = tmpState();
  try {
    const map = { 'component/lib.md': { prose_hash: 'sha256:abc', prose_sha: 'c8f0721' } };
    writeFingerprints(s, map);
    assert.deepEqual(readFingerprints(s), map);
  } finally { rmSync(s, { recursive: true, force: true }); }
});

test('readFingerprints: missing file → {}', () => {
  const s = tmpState();
  try { assert.deepEqual(readFingerprints(s), {}); }
  finally { rmSync(s, { recursive: true, force: true }); }
});

test('readFingerprints: corrupt JSON → {}', () => {
  const s = tmpState();
  try {
    writeFileSync(fingerprintsPath(s), '{bad json');
    assert.deepEqual(readFingerprints(s), {});
  } finally { rmSync(s, { recursive: true, force: true }); }
});

test('proseHash ignores frontmatter + sentinel regions, tracks prose body', () => {
  const withFm = `---\ntitle: X\nlast_updated: 2026-06-01\ncode_sha: aaa\n---\n# h\n架构正文\n## Decision history\n<!-- LORE_JOURNAL:START -->\n- old atom\n<!-- LORE_JOURNAL:END -->\n`;
  // 只改 frontmatter（日期/sha）+ 决策史哨兵区内容 → hash 不变
  const fmChanged = `---\ntitle: X\nlast_updated: 2026-06-08\ncode_sha: zzz\n---\n# h\n架构正文\n## Decision history\n<!-- LORE_JOURNAL:START -->\n- NEW atom different\n<!-- LORE_JOURNAL:END -->\n`;
  assert.equal(proseHash(withFm), proseHash(fmChanged));
  // 改架构正文 → hash 变
  const proseChanged = withFm.replace('架构正文', '架构正文（重写）');
  assert.notEqual(proseHash(withFm), proseHash(proseChanged));
  assert.match(proseHash(withFm), /^sha256:[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/fingerprint.test.js`
Expected: FAIL —— `Cannot find module '../lib/fingerprint.js'`。

- [ ] **Step 3: 写实现**

Create `lib/fingerprint.js`:

```js
// lib/fingerprint.js — 每页 prose 指纹（解耦 prose 新鲜度 与 机械 finalize）。
// 存 <loreDir>/.state/fingerprints.json（gitignored、本地缓存、可重建）。纯函数 + 路径注入。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { translationSourceHash } from './i18n.js';

export function fingerprintsPath(stateDir) {
  return join(stateDir, 'fingerprints.json');
}

// prose 指纹 = 排除 frontmatter + LORE_*:START/END 哨兵区后的正文 hash（复用 i18n）。
// 改日期/sha/决策史/状态块都不变；只有 agent 重写架构正文才变。
export function proseHash(pageText) {
  return translationSourceHash(pageText);
}

export function readFingerprints(stateDir) {
  const p = fingerprintsPath(stateDir);
  if (!existsSync(p)) return {};
  try {
    const v = JSON.parse(readFileSync(p, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

export function writeFingerprints(stateDir, map) {
  const p = fingerprintsPath(stateDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(map, null, 2) + '\n');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/fingerprint.test.js`
Expected: PASS（4 tests）。

- [ ] **Step 5: Commit**

```bash
git add lib/fingerprint.js test/fingerprint.test.js
git commit -m "feat(fingerprint): per-page prose fingerprint store (.state/fingerprints.json)"
```

---

## Task 2: `manifest.js` —— `countCommitsSince` 支持 pathspec

**Files:**
- Modify: `lib/manifest.js`（`makeCountCommitsSince`）
- Test: `test/manifest.test.js`（新增 pathspec 用例）

- [ ] **Step 1: 写失败测试**

在 `test/manifest.test.js` 末尾追加（文件顶部已 import `test`/`assert`；新增需要的 fs/git helper 在用例内 import）：

```js
import { makeCountCommitsSince } from '../lib/manifest.js';
import { mkdtempSync as mkdtemp2, rmSync as rm2 } from 'node:fs';
import { tmpdir as tmp2 } from 'node:os';
import { join as join2 } from 'node:path';
import { execFileSync as exec2 } from 'node:child_process';

test('countCommitsSince scopes to a pathspec', () => {
  const root = mkdtemp2(join2(tmp2(), 'lore-ccs-'));
  try {
    const git = (...a) => exec2('git', a, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    exec2('git', ['commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root, stdio: 'pipe' });
    const base = git('rev-parse', '--short', 'HEAD').toString().trim();
    // 一个 commit 动 a/，一个动 b/
    mkdtemp2;  // noop keep import
    exec2('bash', ['-c', 'mkdir -p a b && echo x > a/f && git add a/f && git commit -q -m a'], { cwd: root, stdio: 'pipe' });
    exec2('bash', ['-c', 'echo y > b/f && git add b/f && git commit -q -m b'], { cwd: root, stdio: 'pipe' });
    const count = makeCountCommitsSince(root);
    assert.equal(count(base), 2);              // 全仓：2 个 commit
    assert.equal(count(base, ['a']), 1);       // 只数动过 a/ 的：1
    assert.equal(count(base, ['b']), 1);       // 只数动过 b/ 的：1
    assert.equal(count(base, ['a', 'b']), 2);  // 并集：2
  } finally { rm2(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/manifest.test.js`
Expected: FAIL —— `count(base, ['a'])` 返回 2（当前忽略第二参，仍全仓），断言 `=== 1` 失败。

- [ ] **Step 3: 写实现**

在 `lib/manifest.js` 中把：

```js
export function makeCountCommitsSince(repoRoot) {
  return (sha) => {
    try {
      const out = execFileSync('git', ['rev-list', '--count', `${sha}..HEAD`],
        { cwd: repoRoot, stdio: 'pipe' }).toString().trim();
      return Number(out) || 0;
    } catch {
      return 0;   // unknown/unreachable sha → treat as not-stale
    }
  };
}
```

替换为：

```js
export function makeCountCommitsSince(repoRoot) {
  return (sha, pathspec) => {
    try {
      const args = ['rev-list', '--count', `${sha}..HEAD`];
      if (pathspec && pathspec.length) args.push('--', ...pathspec);
      const out = execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim();
      return Number(out) || 0;
    } catch {
      return 0;   // unknown/unreachable sha or empty diff → treat as not-stale
    }
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/manifest.test.js`
Expected: PASS（含新 pathspec 用例 + 原有用例全绿；无 pathspec 调用向后兼容）。

- [ ] **Step 5: Commit**

```bash
git add lib/manifest.js test/manifest.test.js
git commit -m "feat(manifest): countCommitsSince accepts optional pathspec (scoped staleness)"
```

---

## Task 3: `manifest.js` —— 把 `staleScopes` 串进 stale 计算

**Files:**
- Modify: `lib/manifest.js`（`pageEntry` / `emitManifest` / `runManifestCli`）
- Test: `test/manifest.test.js`（scoped stale 用例）

- [ ] **Step 1: 写失败测试**

在 `test/manifest.test.js` 末尾追加：

```js
import { emitManifest as emitM } from '../lib/manifest.js';
import { mkdirSync as mkd3, writeFileSync as wf3, mkdtempSync as mkdtemp3, rmSync as rm3 } from 'node:fs';
import { tmpdir as tmp3 } from 'node:os';
import { join as j3 } from 'node:path';

test('emitManifest uses staleScopes to scope per-page stale', () => {
  const wiki = mkdtemp3(j3(tmp3(), 'lore-ss-'));
  try {
    mkd3(j3(wiki, 'component'), { recursive: true });
    const page = (id, sha) => `---\ntitle: ${id}\ncode_sha: ${sha}\natoms: 0\ncommits: 0\n---\n# ${id}\n`;
    wf3(j3(wiki, 'component', 'a.md'), page('a', 'OLD'));
    wf3(j3(wiki, 'component', 'b.md'), page('b', 'OLD'));
    // 假 countCommitsSince：动过 'a' 算 5，动过 'b' 算 0
    const count = (sha, pathspec) => (pathspec && pathspec.includes('a')) ? 5 : 0;
    const m = emitM({
      wikiDir: wiki, currentSha: 'NEW', countCommitsSince: count, now: 't',
      staleScopes: { 'component/a.md': ['a'], 'component/b.md': ['b'] },
    });
    const comp = m.axes.find(x => x.id === 'component');
    assert.equal(comp.pages.find(p => p.id === 'a').stale, 5);
    assert.equal(comp.pages.find(p => p.id === 'b').stale, 0);
  } finally { rm3(wiki, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/manifest.test.js`
Expected: FAIL —— `emitManifest` 不接收 `staleScopes`，`countCommitsSince` 被调时无 pathspec → 'a' 也算 0，断言 `=== 5` 失败。

- [ ] **Step 3: 写实现**

在 `lib/manifest.js` 中，把 `emitManifest` 签名与 `pageEntry` 调用、`pageEntry` 定义、`runManifestCli` 三处改为透传 `staleScopes`。

把 `emitManifest` 的签名与函数体起始：

```js
export function emitManifest({
  wikiDir,
  currentSha,
  countCommitsSince,
  now,
  axes,
  language = { default: 'en', available: ['en'] },
  preferences = {},
}) {
```

替换为：

```js
export function emitManifest({
  wikiDir,
  currentSha,
  countCommitsSince,
  now,
  axes,
  language = { default: 'en', available: ['en'] },
  preferences = {},
  staleScopes = {},
}) {
```

把两处 `pageEntry(...)` 调用：

```js
        pages.push(pageEntry(wikiDir, '', ax.id, currentSha, countCommitsSince, language));
```
改为：
```js
        pages.push(pageEntry(wikiDir, '', ax.id, currentSha, countCommitsSince, language, staleScopes));
```

以及：
```js
        pages.push(pageEntry(wikiDir, ax.id, f.replace(/\.md$/, ''), currentSha, countCommitsSince, language));
```
改为：
```js
        pages.push(pageEntry(wikiDir, ax.id, f.replace(/\.md$/, ''), currentSha, countCommitsSince, language, staleScopes));
```

把 `pageEntry` 定义里：

```js
function pageEntry(wikiDir, axisId, id, currentSha, countCommitsSince, language) {
  const rel = axisId ? `${axisId}/${id}.md` : `${id}.md`;
  const text = readFileSync(join(wikiDir, rel), 'utf8');
  const { data } = parseFrontmatter(text);
  const sha = data.code_sha ?? '';
  const stale = sha && sha !== currentSha ? countCommitsSince(sha) : 0;
```

替换为：

```js
function pageEntry(wikiDir, axisId, id, currentSha, countCommitsSince, language, staleScopes = {}) {
  const rel = axisId ? `${axisId}/${id}.md` : `${id}.md`;
  const text = readFileSync(join(wikiDir, rel), 'utf8');
  const { data } = parseFrontmatter(text);
  const sha = data.code_sha ?? '';
  const stale = sha && sha !== currentSha ? countCommitsSince(sha, staleScopes[rel]) : 0;
```

把 `runManifestCli` 签名与 `emitManifest` 调用：

```js
export function runManifestCli(loreDir, nowIso) {
  const repoRoot = join(resolve(loreDir), '..');
  const wikiDir = join(loreDir, 'wiki');
  const configPath = join(loreDir, 'config.yml');
  const language = existsSync(configPath)
    ? parseConfigLanguage(readFileSync(configPath, 'utf8'))
    : { default: 'en', available: ['en'] };
  const preferences = readPreferences(join(loreDir, '.state'));
  const manifest = emitManifest({
    wikiDir,
    currentSha: gitCurrentSha(repoRoot),
    countCommitsSince: makeCountCommitsSince(repoRoot),
    now: nowIso,
    language,
    preferences,
  });
```

替换为：

```js
export function runManifestCli(loreDir, nowIso, staleScopes = {}) {
  const repoRoot = join(resolve(loreDir), '..');
  const wikiDir = join(loreDir, 'wiki');
  const configPath = join(loreDir, 'config.yml');
  const language = existsSync(configPath)
    ? parseConfigLanguage(readFileSync(configPath, 'utf8'))
    : { default: 'en', available: ['en'] };
  const preferences = readPreferences(join(loreDir, '.state'));
  const manifest = emitManifest({
    wikiDir,
    currentSha: gitCurrentSha(repoRoot),
    countCommitsSince: makeCountCommitsSince(repoRoot),
    now: nowIso,
    language,
    preferences,
    staleScopes,
  });
```

> 向后兼容：`runManifestCli` / `emitManifest` 不传 `staleScopes` 时为 `{}` → 每页无 scope → `countCommitsSince(sha, undefined)` 退化为全仓（同今天）。`manifest.js` CLI 与 `translate.js` 的 `runManifestCli(loreDir, nowIso)` 调用不受影响。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/manifest.test.js`
Expected: PASS（scoped stale 用例 + 原有全绿）。

- [ ] **Step 5: Commit**

```bash
git add lib/manifest.js test/manifest.test.js
git commit -m "feat(manifest): thread staleScopes into per-page stale (component=code_root)"
```

---

## Task 4: `sync.js` `finalizeSync` —— 指纹化 + 盖 prose_sha + GC + staleScopes

**Files:**
- Modify: `lib/sync.js`（imports + `finalizeSync`）
- Test: `test/sync.test.js`（指纹语义用例）

- [ ] **Step 1: 写失败测试**

先看 `test/sync.test.js` 现有 helper（它已有建临时 repo + init + finalize 的模式）。在文件末尾追加自给自足的用例：

```js
import { finalizeSync as fz } from '../lib/sync.js';
import { readFingerprints as rfp } from '../lib/fingerprint.js';
import { parseFrontmatter as pfm } from '../lib/manifest.js';
import { mkdtempSync as mkN, rmSync as rmN, mkdirSync as mdN, writeFileSync as wfN, readFileSync as rdN, existsSync as exN } from 'node:fs';
import { tmpdir as tmpN } from 'node:os';
import { join as jN } from 'node:path';
import { execFileSync as exN2 } from 'node:child_process';

// 建一个真 git repo + 最小 .lore（1 component 页 lib），返回 {root, loreDir, git, sha}
function fzRepo() {
  const root = mkN(jN(tmpN(), 'lore-fz-'));
  const git = (...a) => exN2('git', a, { cwd: root, stdio: 'pipe' }).toString().trim();
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  mdN(jN(root, 'lib'), { recursive: true });
  wfN(jN(root, 'lib', 'a.js'), 'export const x = 1;\n');
  wfN(jN(root, 'config.yml'), 'axes:\n  component:\n    code_roots: [lib]\n');
  const lore = jN(root, '.lore');
  mdN(jN(lore, 'wiki', 'component'), { recursive: true });
  mdN(jN(lore, 'journal'), { recursive: true });
  mdN(jN(lore, '.state'), { recursive: true });
  // config 进 .lore（finalize 读 .lore/config.yml）
  wfN(jN(lore, 'config.yml'), 'axes:\n  component:\n    code_roots: [lib]\n');
  wfN(jN(lore, 'wiki', 'component', 'lib.md'),
    '---\ntitle: lib\nsummary: s\n---\n# component: lib\n\n## Current architecture\n\n架构 v1\n\n## Decision history\n\n{{LORE_JOURNAL}}\n');
  exN2('git', ['add', '-A'], { cwd: root, stdio: 'pipe' });
  exN2('git', ['commit', '-q', '-m', 'init'], { cwd: root, stdio: 'pipe' });
  return { root, loreDir: lore, git, sha: () => git('rev-parse', '--short', 'HEAD') };
}

test('finalize: 正文不变 + 新 commit → prose_sha 保持、code_sha 不前移', () => {
  const r = fzRepo();
  try {
    fz(r.loreDir, '2026-06-08T00:00:00Z');
    const fp1 = rfp(jN(r.loreDir, '.state'))['component/lib.md'];
    const sha1 = r.sha();
    assert.equal(fp1.prose_sha, sha1);                       // seed = 当前
    // 动代码、提交（正文不动）
    wfN(jN(r.root, 'lib', 'a.js'), 'export const x = 2;\n');
    exN2('git', ['commit', '-aqm', 'change code'], { cwd: r.root, stdio: 'pipe' });
    fz(r.loreDir, '2026-06-08T00:00:00Z');
    const fp2 = rfp(jN(r.loreDir, '.state'))['component/lib.md'];
    assert.equal(fp2.prose_sha, sha1);                       // 保持旧 sha（正文 hash 未变）
    const { data } = pfm(rdN(jN(r.loreDir, 'wiki', 'component', 'lib.md'), 'utf8'));
    assert.equal(data.code_sha, sha1);                       // frontmatter 盖 prose_sha，不是当前
  } finally { rmN(r.root, { recursive: true, force: true }); }
});

test('finalize: 正文改了 → prose_sha 前移到当前', () => {
  const r = fzRepo();
  try {
    fz(r.loreDir, '2026-06-08T00:00:00Z');
    wfN(jN(r.root, 'lib', 'a.js'), 'export const x = 3;\n');
    exN2('git', ['commit', '-aqm', 'change'], { cwd: r.root, stdio: 'pipe' });
    // 重写架构正文（模拟 agent）
    const pPath = jN(r.loreDir, 'wiki', 'component', 'lib.md');
    wfN(pPath, rdN(pPath, 'utf8').replace('架构 v1', '架构 v2 重写'));
    fz(r.loreDir, '2026-06-08T00:00:00Z');
    const fp = rfp(jN(r.loreDir, '.state'))['component/lib.md'];
    assert.equal(fp.prose_sha, r.sha());                     // 前移到当前
  } finally { rmN(r.root, { recursive: true, force: true }); }
});

test('finalize: 删页后 GC 掉孤儿指纹', () => {
  const r = fzRepo();
  try {
    fz(r.loreDir, '2026-06-08T00:00:00Z');
    assert.ok(rfp(jN(r.loreDir, '.state'))['component/lib.md']);
    rmN(jN(r.loreDir, 'wiki', 'component', 'lib.md'), { force: true });
    fz(r.loreDir, '2026-06-08T00:00:00Z');
    assert.equal(rfp(jN(r.loreDir, '.state'))['component/lib.md'], undefined);  // 已 GC
  } finally { rmN(r.root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/sync.test.js`
Expected: FAIL —— 当前 finalize 给每页盖 current sha、不写 fingerprints；`fp1` 为 undefined / `code_sha` = 当前而非旧 sha，断言失败。

- [ ] **Step 3: 写实现**

在 `lib/sync.js` 顶部 import 区加：

```js
import { readFingerprints, writeFingerprints, proseHash } from './fingerprint.js';
```

把 `finalizeSync` 整个函数（第 154–236 行）替换为下面版本（改动：读指纹 → 每页据 hash 决定 prose_sha → stamp prose_sha → HOME 同理 → 构造 staleScopes 传给 manifest → 写回并 GC 指纹）：

```js
export function finalizeSync(loreDir, now, { warn = (m) => console.error(m) } = {}) {
  const repoRoot = join(resolve(loreDir), '..');
  const wikiDir = join(loreDir, 'wiki');
  const stateDir = join(loreDir, '.state');
  const codeSha = headShortSha(repoRoot);
  const lastUpdated = now.slice(0, 10);
  const rawAtoms = readAllAtoms(join(loreDir, 'journal'));
  const allAtoms = foldAtoms(rawAtoms, { reachableShas: reachableShaSet(repoRoot) });

  const fingerprints = readFingerprints(stateDir);
  const nextFingerprints = {};
  // 据 prose hash 决定该页盖哪个 sha：正文变了/新页 → 当前；没变 → 保持旧 prose_sha。
  const resolveProseSha = (rel, text) => {
    const h = proseHash(text);
    const prev = fingerprints[rel];
    const prose_sha = (prev && prev.prose_hash === h) ? prev.prose_sha : codeSha;
    nextFingerprints[rel] = { prose_hash: h, prose_sha };
    return prose_sha;
  };

  const stamped = [];
  const axisPages = {};
  for (const axis of SYNC_AXES) {
    const axisDir = join(wikiDir, axis);
    let files = [];
    try {
      files = readdirSync(axisDir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.md'))
        .map(e => e.name).sort();
    } catch { continue; }
    axisPages[axis] = [];
    for (const f of files) {
      const p = join(axisDir, f);
      const id = basename(f, '.md');
      const rel = `${axis}/${f}`;
      const original = readFileSync(p, 'utf8');
      const proseSha = resolveProseSha(rel, original);
      const atomsFor = allAtoms.filter(a => a.facets?.[axis]?.includes(id));
      const md = renderDecisionHistory(atomsFor);
      let text = foldJournal(original, md, { page: rel, warn });
      text = stampFrontmatter(text, {
        codeSha: proseSha,
        lastUpdated,
        atoms: atomsFor.length,
        commits: atomsFor.filter(a => a.kind === 'commit').length,
      });
      writeFileSync(p, text);
      const { data } = parseFrontmatter(text);
      stamped.push(rel);
      axisPages[axis].push({ id, title: data.title ?? id });
    }
  }

  // docs axis — 机械物化视图（无 journal、无 LLM、不进指纹）
  const configPath = join(loreDir, 'config.yml');
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const docsConfig = parseConfigDocsAxis(configText);
  const language = parseConfigLanguage(configText);
  if (docsConfig) {
    const docsPages = buildDocsAxis(loreDir, repoRoot, docsConfig);
    if (docsPages.length) axisPages.docs = docsPages;
  }

  if (!existsSync(wikiDir)) mkdirSync(wikiDir, { recursive: true });

  // HOME — 半稳定人读页，走同一指纹逻辑（stale 全仓）
  const pkgPath = join(repoRoot, 'package.json');
  let version = 'unknown';
  try { version = JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? 'unknown'; } catch {}
  const homePath = join(wikiDir, 'HOME.md');
  const existingHome = existsSync(homePath) ? readFileSync(homePath, 'utf8') : defaultHomePage({ title: 'lore', axisPages });
  const homeProseSha = resolveProseSha('HOME.md', existingHome);
  const homeStatus = buildHomeStatus({
    version, codeSha, lastUpdated, axisPages, language,
    translationStats: translationStats({ wikiDir, axisPages, language }),
  });
  writeFileSync(homePath, stampFrontmatter(finalizeHomeText(existingHome, homeStatus), {
    codeSha: homeProseSha,
    lastUpdated,
    atoms: allAtoms.length,
    commits: allAtoms.filter(a => a.kind === 'commit').length,
  }));

  // INDEX — 纯机械 TOC，永远当前（不进指纹）
  const indexFields = {
    codeSha,
    lastUpdated,
    atoms: allAtoms.length,
    commits: allAtoms.filter(a => a.kind === 'commit').length,
  };
  writeFileSync(join(wikiDir, 'INDEX.md'), stampFrontmatter(buildIndex(axisPages), indexFields));

  // 写回指纹 + GC（只留本轮处理过的页 = 仍存在的页）
  writeFingerprints(stateDir, nextFingerprints);

  // staleScopes：component → [code_root]；flow → spans 各 code_root；theme/HOME → 无（全仓）
  const codeRoots = parseConfigCodeRoots(configText);
  const flows = parseConfigFlows(configText);
  const staleScopes = {};
  for (const cr of codeRoots) staleScopes[`component/${cr.split('/').pop()}.md`] = [cr];
  for (const fl of flows) {
    const roots = (fl.spans ?? []).map(s => codeRoots.find(cr => cr.split('/').pop() === s) ?? s);
    if (roots.length) staleScopes[`flow/${fl.id}.md`] = roots;
  }

  const { manifestPath, manifest } = runManifestCli(loreDir, now, staleScopes);
  writeFileSync(join(wikiDir, '.graph.json'),
    JSON.stringify(buildGraph(allAtoms, manifest, now), null, 2) + '\n');
  return { stamped, indexWritten: true, manifestPath };
}
```

> `nextFingerprints` 只装本轮处理过的页 → 写回时天然把"页文件已不存在"的孤儿丢掉（GC）。`parseConfigCodeRoots` / `parseConfigFlows` 已在 `sync.js` 顶部 import（第 7 行），无需新增。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/sync.test.js`
Expected: PASS（3 个新指纹用例 + 原有用例；若原有用例断言"finalize 后 code_sha === 当前 sha"，在同一 commit 内 seed 后 prose_sha 仍 = 当前，故多数不回归——见 Step 5）。

- [ ] **Step 5: 修可能回归的原有断言**

Run: `node --test test/sync.test.js 2>&1 | grep -A3 "fail"`
若有原 finalize 用例失败（因语义从"盖 current"变为"盖 prose_sha"）：仅当用例「先 finalize、再不改正文地推进 HEAD、再 finalize、然后断言 code_sha === 新 HEAD」才会失败——把该断言改为「code_sha === 首次 finalize 时的 sha」（反映 prose 未重写）。改断言意图（验证机械字段）不变。若无失败，跳过本步。

- [ ] **Step 6: Commit**

```bash
git add lib/sync.js test/sync.test.js
git commit -m "feat(sync): finalize stamps prose_sha via fingerprint (honest stale, GC orphans)"
```

---

## Task 5: `sync.js` `planSync` —— 增量 + `--all`

**Files:**
- Modify: `lib/sync.js`（`planSync` + CLI 块解析 `--all`）
- Test: `test/sync.test.js`（增量用例）

- [ ] **Step 1: 写失败测试**

在 `test/sync.test.js` 末尾追加（复用 Task 4 的 `fzRepo` helper —— 确保它定义在本用例之前；若按本计划顺序追加，`fzRepo` 已在文件中）：

```js
import { planSync as pl } from '../lib/sync.js';

test('planSync 增量：未动 code_root 的 component 页跳过，动了的入 worklist', () => {
  const r = fzRepo();
  try {
    fz(r.loreDir, '2026-06-08T00:00:00Z');                  // seed 指纹（lib 此刻 fresh）
    let wl = pl(r.loreDir).worklist.filter(w => w.axis === 'component');
    assert.equal(wl.length, 0);                             // lib fresh → 不入
    // 动 lib 代码 + 提交
    wfN(jN(r.root, 'lib', 'a.js'), 'export const x = 9;\n');
    exN2('git', ['commit', '-aqm', 'touch lib'], { cwd: r.root, stdio: 'pipe' });
    wl = pl(r.loreDir).worklist.filter(w => w.axis === 'component');
    assert.equal(wl.length, 1);                             // lib 代码动了 → 入
    assert.equal(wl[0].id, 'lib');
    assert.equal(wl[0].reason, 'code-changed');
  } finally { rmN(r.root, { recursive: true, force: true }); }
});

test('planSync --all 强制全量', () => {
  const r = fzRepo();
  try {
    fz(r.loreDir, '2026-06-08T00:00:00Z');                  // lib fresh
    const wl = pl(r.loreDir, { all: true }).worklist.filter(w => w.axis === 'component');
    assert.equal(wl.length, 1);                             // --all 忽略指纹
    assert.equal(wl[0].reason, 'all');
  } finally { rmN(r.root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/sync.test.js`
Expected: FAIL —— 当前 `planSync` 无增量、无 `reason`，且签名不收 `{all}`；component 页总在 worklist，断言 `length === 0` 失败。

- [ ] **Step 3: 写实现**

在 `lib/sync.js` 顶部 import 区加（`makeCountCommitsSince` 来自 manifest）：

```js
import { makeCountCommitsSince } from './manifest.js';
```

把 `planSync` 整个函数（第 14–35 行）替换为：

```js
export function planSync(loreDir, { all = false } = {}) {
  const configPath = join(loreDir, 'config.yml');
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const codeRoots = parseConfigCodeRoots(configText);
  const themes = parseConfigThemes(configText);
  const flows = parseConfigFlows(configText);
  const wikiDir = join(loreDir, 'wiki');
  const exists = (axis, id) => existsSync(join(wikiDir, axis, `${id}.md`));

  const fingerprints = readFingerprints(join(loreDir, '.state'));
  const repoRoot = join(resolve(loreDir), '..');
  const countSince = makeCountCommitsSince(repoRoot);

  const worklist = [];
  worklist.push({ axis: 'HOME', id: 'HOME', path: 'HOME.md', priorExists: existsSync(join(wikiDir, 'HOME.md')) });

  for (const codeRoot of codeRoots) {
    const id = codeRoot.split('/').pop();
    const rel = `component/${id}.md`;
    const fp = fingerprints[rel];
    let stale = null, reason;
    if (all) { reason = 'all'; }
    else if (!fp) { reason = 'new'; }
    else { stale = countSince(fp.prose_sha, [codeRoot]); reason = stale > 0 ? 'code-changed' : 'fresh'; }
    const include = all || !fp || (stale ?? 0) > 0;
    if (include) {
      worklist.push({ axis: 'component', id, component: id, codeRoot, path: rel, priorExists: exists('component', id), stale, reason });
    }
  }
  // HOME/theme/flow：cross-cutting，默认仍入（spec 决策）
  for (const th of themes) {
    worklist.push({ axis: 'theme', id: th.id, path: `theme/${th.id}.md`, priorExists: exists('theme', th.id) });
  }
  for (const fl of flows) {
    worklist.push({ axis: 'flow', id: fl.id, path: `flow/${fl.id}.md`, priorExists: exists('flow', fl.id) });
  }
  return { codeRoots, themes, flows, worklist };
}
```

把 CLI 块里 plan 分支：

```js
  if (sub === 'plan') {
    console.log(JSON.stringify(planSync(loreDir), null, 2));
  } else if (sub === 'finalize') {
```

替换为（支持 `--all`）：

```js
  if (sub === 'plan') {
    const all = process.argv.includes('--all');
    console.log(JSON.stringify(planSync(loreDir, { all }), null, 2));
  } else if (sub === 'finalize') {
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/sync.test.js`
Expected: PASS（增量 + `--all` 用例 + 之前用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add lib/sync.js test/sync.test.js
git commit -m "feat(sync): incremental planSync — skip fresh component pages, --all override"
```

---

## Task 6: `hook.js` —— 提交即 detached 机械刷新

**Files:**
- Modify: `lib/hook.js`（新增 `maybeRefresh` + CLI 调用）
- Test: `test/hook.test.js`（`maybeRefresh` 用例）

- [ ] **Step 1: 写失败测试**

在 `test/hook.test.js` 末尾追加：

```js
import { maybeRefresh } from '../lib/hook.js';
import { mkdtempSync as mkH, rmSync as rmH, mkdirSync as mdH, writeFileSync as wfH } from 'node:fs';
import { tmpdir as tmpH } from 'node:os';
import { join as jH } from 'node:path';

test('maybeRefresh: 有 manifest → spawn finalize（detached）', () => {
  const root = mkH(jH(tmpH(), 'lore-mr-'));
  try {
    const lore = jH(root, '.lore');
    mdH(jH(lore, 'wiki'), { recursive: true });
    wfH(jH(lore, 'wiki', '.manifest.json'), '{"axes":[]}');
    const calls = [];
    const r = maybeRefresh({ loreDir: lore, spawnFn: (cmd, args) => { calls.push({ cmd, args }); return { unref() {} }; } });
    assert.equal(r.spawned, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[1], 'finalize');            // node sync.js finalize <lore>
    assert.equal(calls[0].args[2], lore);
  } finally { rmH(root, { recursive: true, force: true }); }
});

test('maybeRefresh: 无 manifest → 不 spawn', () => {
  const root = mkH(jH(tmpH(), 'lore-mr-'));
  try {
    const lore = jH(root, '.lore');
    mdH(jH(lore, 'wiki'), { recursive: true });
    let spawned = false;
    const r = maybeRefresh({ loreDir: lore, spawnFn: () => { spawned = true; return { unref() {} }; } });
    assert.equal(r.spawned, false);
    assert.equal(spawned, false);
  } finally { rmH(root, { recursive: true, force: true }); }
});

test('maybeRefresh: spawn 抛错也不抛出（best-effort）', () => {
  const root = mkH(jH(tmpH(), 'lore-mr-'));
  try {
    const lore = jH(root, '.lore');
    mdH(jH(lore, 'wiki'), { recursive: true });
    wfH(jH(lore, 'wiki', '.manifest.json'), '{"axes":[]}');
    const r = maybeRefresh({ loreDir: lore, spawnFn: () => { throw new Error('boom'); } });
    assert.equal(r.spawned, false);                        // 吞掉异常、返回未 spawn
  } finally { rmH(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/hook.test.js`
Expected: FAIL —— `maybeRefresh` 未导出。

- [ ] **Step 3: 写实现**

把 `lib/hook.js` 顶部 import：

```js
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
```

替换为（加 `spawn` + `dirname`）：

```js
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
```

在 `captureHead` 函数之后、CLI 块之前，新增：

```js
// 提交后台机械刷新：已 sync 过（有 manifest）的 repo，detached spawn finalize，
// commit 立刻返回、后台刷决策史/docs/状态/manifest/stale（零 LLM）。永不抛出。
export function maybeRefresh({ loreDir, spawnFn = spawn }) {
  try {
    if (!existsSync(join(loreDir, 'wiki', '.manifest.json'))) return { spawned: false };
    const syncJs = join(dirname(fileURLToPath(import.meta.url)), 'sync.js');
    const child = spawnFn(process.execPath, [syncJs, 'finalize', loreDir], { detached: true, stdio: 'ignore' });
    child.unref();
    return { spawned: true };
  } catch {
    return { spawned: false };   // best-effort：绝不挡 commit
  }
}
```

把 CLI 块里 `captureHead(...)` 这行：

```js
    captureHead({ repoRoot, journalDir: join(loreDir, 'journal'), codeRoots, themes, flows });
```

替换为（捕获后触发后台刷新）：

```js
    captureHead({ repoRoot, journalDir: join(loreDir, 'journal'), codeRoots, themes, flows });
    maybeRefresh({ loreDir });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/hook.test.js`
Expected: PASS（3 个 `maybeRefresh` 用例 + 原有 captureHead 用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add lib/hook.js test/hook.test.js
git commit -m "feat(hook): detached mechanical finalize on commit (non-blocking, manifest-gated)"
```

---

## Task 7: 文档同步 + 全量验证

**Files:**
- Modify: `commands/sync.md`、`docs/ROADMAP.md`
- 验证：全测试

- [ ] **Step 1: `commands/sync.md` 说明增量**

在 `commands/sync.md` 的 plan 步骤说明附近，加一句（找到描述 `node ... sync.js plan` 的段落，在其后插入）：

```md
> 增量：`plan` 默认只列「代码动过」的 component 页（据 `.state/fingerprints.json` 指纹）；HOME/theme/flow 仍全列。要强制全量（首跑/大改后）：`node "${CLAUDE_PLUGIN_ROOT}/lib/sync.js" plan "$(pwd)/.lore" --all`。
> 提交即刷新：装了 post-commit hook 的 repo，每次 commit 会后台自动跑机械 `finalize`（决策史/docs/状态/stale 准实时、零 LLM）；架构 prose 仍按 `plan` 增量、由 agent 重写。
```

- [ ] **Step 2: `docs/ROADMAP.md` 标记完成**

在 `docs/ROADMAP.md` 找到「增量 sync（母 §5「增量合成」）」小节，把其标题与首行：

```md
### 增量 sync（母 §5「增量合成」）
- 现全量重建（每 sync 重渲所有页）。加 `.state/` 每页指纹 `{code_sha, journal_offset}`；只重建被碰的页 → 只有变动页重新 LLM。控成本。
```

替换为：

```md
### 增量 sync（母 §5「增量合成」）✅ 已实现（低摩擦合成 A）
- 已实现：`.state/fingerprints.json` 每页 `{prose_hash, prose_sha}`（`prose_hash` 复用 `translationSourceHash`）；finalize 只在正文变了才推进 `prose_sha`、frontmatter `code_sha` 盖 `prose_sha` → `stale` 诚实（按 code_root 精确）；`planSync` 只挑动过 code_root 的 component 页（`--all` 兜底）；post-commit hook detached 跑机械 `finalize`。设计见 `docs/superpowers/specs/2026-06-08-lore-low-friction-sync-design.md`。余项（B 前端控制台/档位、C 质量打磨）另立 spec。
```

- [ ] **Step 3: 全量测试全绿**

Run: `node --test`
Expected: PASS —— 0 failures。记录实际 `# tests` / `# pass` / `# fail`。

- [ ] **Step 4: 端到端手动冒烟（增量 + 提交刷新）**

在 bash 跑（临时 git repo，验证真链路）：

```bash
T=$(mktemp -d); cd "$T"
git init -q && git config user.email t@t && git config user.name t
mkdir -p lib && echo 'export const x=1' > lib/a.js
node D:/workspace/lore/lib/init.js "$T" >/dev/null
git add -A && git commit -q -m init
# 首次 plan：lib 应「new」入列
node D:/workspace/lore/lib/sync.js plan "$T/.lore" | grep -o '"reason": "[a-z-]*"' | head
# 写个最小 component 页 + finalize（seed 指纹）
mkdir -p "$T/.lore/wiki/component"
printf -- '---\ntitle: lib\nsummary: s\n---\n# component: lib\n\n## Current architecture\n\nv1\n\n## Decision history\n\n{{LORE_JOURNAL}}\n' > "$T/.lore/wiki/component/lib.md"
node D:/workspace/lore/lib/sync.js finalize "$T/.lore" >/dev/null
echo "--- seed 后 plan（lib 应不在 component worklist）---"
node D:/workspace/lore/lib/sync.js plan "$T/.lore" | grep -c '"axis": "component"'
echo "--- 动 lib 代码 + commit（hook 后台 finalize）---"
echo 'export const x=2' > lib/a.js && git commit -aqm 'touch lib' && sleep 1
echo "--- 动后 plan（lib 应回到 component worklist，reason code-changed）---"
node D:/workspace/lore/lib/sync.js plan "$T/.lore" | grep -o '"reason": "code-changed"'
echo "--- 指纹文件 ---"; cat "$T/.lore/.state/fingerprints.json"
cd / && rm -rf "$T"
```

Expected:
- 首次 plan：`"reason": "new"`（lib 入列）
- seed 后：component worklist 计数 `0`（lib fresh、跳过）
- 动后：`"reason": "code-changed"`（lib 回列）
- `fingerprints.json` 含 `component/lib.md` 的 `{prose_hash, prose_sha}`

- [ ] **Step 5: Commit**

```bash
git add commands/sync.md docs/ROADMAP.md
git commit -m "docs(sync): incremental + commit-time refresh; ROADMAP marks incremental sync done"
```

---

## Self-Review（计划自查，已执行）

**1. Spec 覆盖：** 指纹层（决策「方案1/.state/translationSourceHash」）→ Task 1；stale 精确化（决策「stale 范围 component=code_root」）→ Task 2+3；finalize 解耦 + 盖 prose_sha + GC + seed（决策「prose_sha 推进 / code_sha / 指纹 GC / seed」）→ Task 4；增量 plan + `--all`（决策「增量 plan」）→ Task 5；提交即机械刷新（决策「提交即刷新」）→ Task 6；与 B 的接缝（诚实 manifest stale + 增量 plan JSON + 可 spawn finalize）→ Task 3/5/6 自然满足；docs → Task 7。spec 测试 1–11 全部对应到各任务的测试步骤。

**2. Placeholder 扫描：** 每个代码步骤含完整代码或完整 old→new 替换；命令带期望输出。无 TBD / 泛词。

**3. 类型/签名一致性：** `proseHash(text)`、`readFingerprints(stateDir)`/`writeFingerprints(stateDir,map)`/`fingerprintsPath(stateDir)`、`makeCountCommitsSince(repoRoot)→(sha,pathspec?)`、`emitManifest({...,staleScopes})`、`pageEntry(...,staleScopes)`、`runManifestCli(loreDir,now,staleScopes?)`、`planSync(loreDir,{all}?)`、`finalizeSync(loreDir,now,{warn}?)`、`maybeRefresh({loreDir,spawnFn?})` —— 各任务定义与调用处一致。finalize 内 `resolveProseSha(rel,text)` 统一处理 component/theme/flow/HOME；INDEX/docs 不进指纹。staleScopes key 用 `component/<id>.md` / `flow/<id>.md`，与 manifest `rel` 拼法一致。

**4. 风险点复核：** `proseHash=translationSourceHash` 已读源码确认剥 frontmatter + 哨兵区（i18n.js:17-20）→ finalize 改机械字段不误判正文变。hook detached + try/catch + exit 0 → 不挡 commit。finalize 不 commit → 无 hook 循环。`countCommitsSince` 无 pathspec 向后兼容。
