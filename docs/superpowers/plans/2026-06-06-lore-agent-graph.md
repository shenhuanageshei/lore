# Agent Graph 数据层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 journal 原子 + wiki 页表达成节点+边的图，`sync` 落盘 `wiki/.graph.json`，给 agent 端打数据基础。

**Architecture:** 纯函数 `buildGraph(atoms, manifest, now) → {nodes, edges}`（节点=原子+页，边=facet+refs_related，悬挂边丢弃）。`runManifestCli` 改返回 `{manifestPath, manifest}` 以复用 manifest 对象；`finalizeSync` 用 folded atoms + manifest 落盘 `.graph.json`。MCP 接口为后续独立子项。

**Tech Stack:** Node.js (ESM) · `node:test` + `node:assert/strict` · 零依赖。

**前置 spec:** `docs/superpowers/specs/2026-06-06-lore-agent-graph-design.md`

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `lib/graph.js` | 纯函数 `buildGraph(atoms, manifest, now)` | 新建 |
| `test/graph.test.js` | buildGraph 单测（无 git） | 新建 |
| `lib/manifest.js` | `runManifestCli` 返回 `{manifestPath, manifest}` + CLI 用法 | 改 |
| `lib/sync.js` | import buildGraph + `finalizeSync` 落盘 `.graph.json` + 解构 manifestPath | 改 |
| `test/manifest.test.js` | 加 `runManifestCli` 返回对象断言 | 改 |
| `test/integration.test.js` | `line 29` 解构 manifestPath | 改 |
| `test/sync.test.js` | 加 `.graph.json` 集成用例 | 改 |

**真实 atom schema**（`lib/mine.js` / `lib/note.js`）：`{ id, ts, kind:'commit'|'decision', commit, title, why, what_changed, facets:{component,flow,theme}, refs:{files,pitfall,related}, source, enriched, confidence }`

**manifest 结构**（`lib/manifest.js emitManifest`）：`{ generated, current_code_sha, language, user_preferences, axes:[{id,label,pages:[{id,title,summary,last_updated,path,lang,translations,stale,code_sha,synthesized_from}]}] }`

---

## Task 1: `buildGraph` 纯函数

**Files:**
- Create: `lib/graph.js`
- Test: `test/graph.test.js`

- [ ] **Step 1: 写失败测试**

Create `test/graph.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../lib/graph.js';

const atom = (over = {}) => ({
  id: 'commit:a', ts: '2026-06-06T01:00:00-07:00', kind: 'commit', commit: 'a',
  title: 't', why: '', what_changed: '',
  facets: { component: [], flow: [], theme: [] },
  refs: { files: [], pitfall: null, related: [] },
  source: 'hook', enriched: false, confidence: 'EXTRACTED',
  ...over,
});
const mf = (axes = []) => ({ axes });

test('buildGraph: empty atoms + empty manifest → empty graph', () => {
  assert.deepEqual(buildGraph([], mf([]), 'NOW'), { generated: 'NOW', nodes: [], edges: [] });
});

test('buildGraph: page nodes from manifest, INDEX axis skipped', () => {
  const manifest = mf([
    { id: 'INDEX', pages: [{ id: 'INDEX', title: 'INDEX', path: 'INDEX.md' }] },
    { id: 'component', pages: [{ id: 'lib', title: 'Lib', path: 'component/lib.md' }] },
    { id: 'docs', pages: [{ id: 'x', title: 'X', path: 'docs/x.md' }] },
  ]);
  const pageNodes = buildGraph([], manifest, 'NOW').nodes.filter(n => n.type === 'page').map(n => n.id);
  assert.deepEqual(pageNodes.sort(), ['page:component/lib', 'page:docs/x']);
});

test('buildGraph: atom nodes carry type/kind/title/ts', () => {
  const a = atom({ id: 'commit:x', kind: 'commit', title: 'feat: x', ts: '2026-06-06T02:00:00-07:00' });
  const d = atom({ id: 'decision:y', kind: 'decision', commit: null, title: 'chose X' });
  const nodes = buildGraph([a, d], mf([]), 'NOW').nodes;
  assert.deepEqual(nodes.find(n => n.id === 'commit:x'),
    { id: 'commit:x', type: 'atom', kind: 'commit', title: 'feat: x', ts: '2026-06-06T02:00:00-07:00' });
  assert.equal(nodes.find(n => n.id === 'decision:y').kind, 'decision');
});

test('buildGraph: facet edge only when target page exists (dangling dropped)', () => {
  const manifest = mf([{ id: 'component', pages: [{ id: 'lib', title: 'Lib', path: 'component/lib.md' }] }]);
  const a = atom({ id: 'commit:x', facets: { component: ['lib', 'ghost'], flow: [], theme: [] } });
  const facet = buildGraph([a], manifest, 'NOW').edges.filter(e => e.type === 'facet');
  assert.deepEqual(facet, [{ from: 'commit:x', to: 'page:component/lib', type: 'facet' }]);
});

test('buildGraph: refs_related edge only when target atom exists (dangling dropped)', () => {
  const x = atom({ id: 'commit:x', refs: { files: [], pitfall: null, related: ['commit:y', 'commit:gone'] } });
  const y = atom({ id: 'commit:y' });
  const rel = buildGraph([x, y], mf([]), 'NOW').edges.filter(e => e.type === 'refs_related');
  assert.deepEqual(rel, [{ from: 'commit:x', to: 'commit:y', type: 'refs_related' }]);
});

test('buildGraph: facet edges across flow/theme axes', () => {
  const manifest = mf([
    { id: 'flow', pages: [{ id: 'pipe', title: 'Pipe', path: 'flow/pipe.md' }] },
    { id: 'theme', pages: [{ id: 'quality', title: 'Quality', path: 'theme/quality.md' }] },
  ]);
  const a = atom({ id: 'commit:x', facets: { component: [], flow: ['pipe'], theme: ['quality'] } });
  const facet = buildGraph([a], manifest, 'NOW').edges.filter(e => e.type === 'facet').map(e => e.to).sort();
  assert.deepEqual(facet, ['page:flow/pipe', 'page:theme/quality']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/graph.test.js`
Expected: FAIL — `Cannot find module '../lib/graph.js'`。

- [ ] **Step 3: 写实现**

Create `lib/graph.js`:

```js
// agent 图数据层（纯函数）：journal 原子 + wiki 页 → { nodes, edges }。
// 节点：原子（commit/decision）+ 页（跳过 INDEX 轴）。
// 边：facet（原子→component/flow/theme 页）、refs_related（原子→原子）。悬挂边丢弃。
// 无 IO；now 由调用方注入（确定性，不在纯函数里取时钟）。

const FACET_AXES = ['component', 'flow', 'theme'];

export function buildGraph(atoms, manifest, now) {
  const nodes = [];
  const edges = [];
  const pageIds = new Set();
  const atomIds = new Set();

  // 页节点（跳过 INDEX 轴）
  for (const ax of manifest.axes ?? []) {
    if (ax.id === 'INDEX') continue;
    for (const p of ax.pages ?? []) {
      const id = `page:${ax.id}/${p.id}`;
      pageIds.add(id);
      nodes.push({ id, type: 'page', axis: ax.id, title: p.title ?? p.id, path: p.path });
    }
  }

  // 原子节点
  for (const a of atoms) {
    atomIds.add(a.id);
    nodes.push({ id: a.id, type: 'atom', kind: a.kind, title: a.title ?? '', ts: a.ts ?? '' });
  }

  // 边（悬挂目标丢弃）
  for (const a of atoms) {
    for (const axis of FACET_AXES) {
      for (const v of (a.facets?.[axis] ?? [])) {
        const to = `page:${axis}/${v}`;
        if (pageIds.has(to)) edges.push({ from: a.id, to, type: 'facet' });
      }
    }
    for (const rid of (a.refs?.related ?? [])) {
      if (atomIds.has(rid)) edges.push({ from: a.id, to: rid, type: 'refs_related' });
    }
  }

  return { generated: now, nodes, edges };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/graph.test.js`
Expected: PASS（6 tests）。

- [ ] **Step 5: Commit**

```bash
git add lib/graph.js test/graph.test.js
git commit -m "feat(graph): buildGraph — atom/page nodes + facet/refs_related edges

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `runManifestCli` 返回 `{ manifestPath, manifest }`

复用 manifest 对象供 graph，免重复读盘。这是重构——改返回值 + 同步所有消费返回值的调用者。

**Files:**
- Modify: `lib/manifest.js`（`runManifestCli` 第 134-153 行 + CLI 第 158 行）
- Modify: `lib/sync.js`（第 231 行解构）
- Modify: `test/integration.test.js`（第 29 行解构）
- Test: `test/manifest.test.js`（追加断言）

- [ ] **Step 1: 写失败测试**

把以下 test 追加到 `test/manifest.test.js` 末尾：

```js
test('runManifestCli returns { manifestPath, manifest }', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mani-ret-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki', 'component'), { recursive: true });
    writeFileSync(join(lore, 'wiki', 'component', 'lib.md'),
      '---\ntitle: Lib\nsummary: s\ncode_sha: abc\n---\n# component: lib\n');
    const r = runManifestCli(lore, '2026-06-06T00:00:00Z');
    assert.equal(typeof r.manifestPath, 'string');
    assert.ok(r.manifest && Array.isArray(r.manifest.axes), 'returns manifest object with axes');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

Verify `test/manifest.test.js` imports `mkdtempSync`, `mkdirSync`, `writeFileSync`, `rmSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`, `execFileSync` from `node:child_process`. （现有 fixture 已用，若缺则在顶部 import 补上。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/manifest.test.js`
Expected: FAIL — 现 `runManifestCli` 返回 string，`r.manifestPath` 为 undefined、`r.manifest` 为 undefined，断言失败。

- [ ] **Step 3: 改返回值 + 同步 3 个调用者**

3a. `lib/manifest.js` `runManifestCli`（第 150-152 行）：把

```js
  const out = join(wikiDir, '.manifest.json');
  writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  return out;
```

改为

```js
  const out = join(wikiDir, '.manifest.json');
  writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  return { manifestPath: out, manifest };
```

3b. `lib/manifest.js` CLI（第 158-159 行）：把

```js
  const out = runManifestCli(loreDir, new Date().toISOString());
  console.log(`wrote ${out}`);
```

改为

```js
  const { manifestPath } = runManifestCli(loreDir, new Date().toISOString());
  console.log(`wrote ${manifestPath}`);
```

3c. `lib/sync.js` 第 231 行：把 `const manifestPath = runManifestCli(loreDir, now);` 改为
```js
  const { manifestPath } = runManifestCli(loreDir, now);
```
（Task 3 会在此处再加 graph 落盘。）

3d. `test/integration.test.js` 第 29 行：把 `const manifestPath = runManifestCli(lore, '2026-05-31T00:00:00Z');` 改为
```js
    const { manifestPath } = runManifestCli(lore, '2026-05-31T00:00:00Z');
```
（`lib/translate.js:57` 与 `test/manifest.test.js:163,293` 忽略返回值，无需改。）

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `node --test test/manifest.test.js test/integration.test.js test/sync.test.js`
Expected: PASS（含新断言；integration/sync 不回归）。

- [ ] **Step 5: Commit**

```bash
git add lib/manifest.js lib/sync.js test/manifest.test.js test/integration.test.js
git commit -m "refactor(manifest): runManifestCli returns { manifestPath, manifest }

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `finalizeSync` 落盘 `.graph.json`

**Files:**
- Modify: `lib/sync.js`（import + 第 231 行后落盘）
- Test: `test/sync.test.js`（追加集成用例）

- [ ] **Step 1: 写失败集成测试**

把以下 test 追加到 `test/sync.test.js` 末尾（复用已有 `gitRepo`）：

```js
test('finalizeSync writes .graph.json with page/atom nodes and a facet edge', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    writeFileSync(join(lore, 'config.yml'), 'axes:\n  component:\n    code_roots: [lib]\n');
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'feature.js'), 'export const x = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'feat: graph thing'], { cwd: root });
    execFileSync('node', ['lib/mine.js', root], { cwd: process.cwd() });   // commit atom, facets.component=['lib']

    const compDir = join(lore, 'wiki', 'component');
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, 'lib.md'),
      '---\ntitle: Lib\nsummary: s\n---\n# component: lib\n\n## Decision history\n\n{{LORE_JOURNAL}}\n');

    finalizeSync(lore, '2026-06-06T08:00:00Z');

    const graph = JSON.parse(readFileSync(join(lore, 'wiki', '.graph.json'), 'utf8'));
    const pageNode = graph.nodes.find(n => n.id === 'page:component/lib');
    const atomNode = graph.nodes.find(n => n.type === 'atom' && n.kind === 'commit');
    const facetEdge = graph.edges.find(e => e.type === 'facet' && e.to === 'page:component/lib');
    assert.ok(pageNode, 'page node present');
    assert.ok(atomNode, 'commit atom node present');
    assert.ok(facetEdge, 'facet edge present');
    assert.equal(facetEdge.from, atomNode.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/sync.test.js`
Expected: FAIL — `.graph.json` 不存在，`readFileSync` 抛 ENOENT。

- [ ] **Step 3: 接入（两处编辑）**

3a. `lib/sync.js` 第 5 行 import 之后新增：
```js
import { buildGraph } from './graph.js';
```

3b. `lib/sync.js` `finalizeSync`，把第 231-232 行：
```js
  const { manifestPath } = runManifestCli(loreDir, now);
  return { stamped, indexWritten: true, manifestPath };
```
改为：
```js
  const { manifestPath, manifest } = runManifestCli(loreDir, now);
  writeFileSync(join(wikiDir, '.graph.json'),
    JSON.stringify(buildGraph(allAtoms, manifest, now), null, 2) + '\n');
  return { stamped, indexWritten: true, manifestPath };
```
（`allAtoms` 已是 folded；`manifest` 来自 Task 2 的返回对象。）

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `node --test test/sync.test.js`
Expected: PASS（含新集成用例）。

Run: `node --test`
Expected: 全量 PASS、0 fail。

- [ ] **Step 5: Commit**

```bash
git add lib/sync.js test/sync.test.js
git commit -m "feat(sync): emit wiki/.graph.json (agent graph) in finalizeSync

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: dogfood 验证 + `.lore` 同步提交（收尾，非 TDD）

**Files:** `.lore/**`（sync 产物）

- [ ] **Step 1: 对本仓库跑真实 sync**

```bash
node lib/mine.js .
node lib/sync.js finalize .lore
```
Expected: `✓ sync finalized: …`，无报错；`.lore/wiki/.graph.json` 生成。

- [ ] **Step 2: 验证真实图**

`.graph.json` 是 2-空格格式化 JSON（每字段独立行），用 `grep` 计数（避免 `node -e` 在 ESM 项目下的 require 歧义）：

Run: `grep -c '"type": "atom"' .lore/wiki/.graph.json` → 原子节点数（应 >0）
Run: `grep -c '"type": "facet"' .lore/wiki/.graph.json` → facet 边数（应 >0）
Run: `grep '"id": "page:component/lib"' .lore/wiki/.graph.json` → 确认该页节点存在（有输出）

Run: `node --test`
Expected: 全量 PASS。

- [ ] **Step 3: 提交 dogfood 产物**

```bash
git add .lore
git commit -m "chore(lore): dogfood resync — emit agent graph (.graph.json)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Spec 覆盖核对（self-review 映射）

| spec 决策 | 落地于 |
|---|---|
| `buildGraph` 纯函数 + 落盘 `.graph.json` | Task 1（函数）+ Task 3（落盘） |
| 节点 = 原子 + 页（跳过 INDEX） | Task 1 Step3 + 测试 2 |
| 边 = facet + refs_related，悬挂丢弃 | Task 1 Step3 + 测试 4/5 |
| 节点 id = `atom.id` / `page:<axis>/<id>` | Task 1 Step3 + 测试 |
| folded atoms 来源 | Task 3 用 `allAtoms`（已折叠） |
| `runManifestCli` 返回 `{manifestPath, manifest}` | Task 2 |
| now 注入纯函数 | Task 1 `buildGraph(…, now)` + Task 3 传 `now` |
| 不改 manifest schema | Task 2 只扩返回值，emitManifest 不变 |
