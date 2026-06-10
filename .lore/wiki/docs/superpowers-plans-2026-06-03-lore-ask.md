---
title: /lore:ask Implementation Plan
summary: > **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.
source_path: docs/superpowers/plans/2026-06-03-lore-ask.md
last_updated: 2026-06-03
group: 设计与计划
---
> 源文档：`docs/superpowers/plans/2026-06-03-lore-ask.md`

# /lore:ask Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** `/lore:ask "<q>"` retrieves the most relevant wiki pages (manifest keyword search) so the agent answers from the wiki instead of re-reading code.

**Architecture:** `lib/ask.js` = pure `searchPages(manifest, query)` (rank pages by query-term hits in title+summary) + a CLI that reads `.lore/wiki/.manifest.json` and prints ranked candidates. `commands/lore-ask.md` orchestrates: run ask.js → agent reads top pages → answers from wiki.

**Tech Stack:** Node ESM, `node:test`, zero deps. Reuses the sync-emitted `.manifest.json`.

**Spec:** `docs/superpowers/specs/2026-06-03-lore-ask-design.md`. **Branch:** `lore-ask` (off main).

---

## Task 1: lib/ask.js — searchPages + CLI

**Files:** Create `lib/ask.js`, `test/ask.test.js`

- [ ] **Step 1: Failing test** — `test/ask.test.js`:

```js
// test/ask.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { searchPages } from '../lib/ask.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-ask-')); }

const MANIFEST = {
  axes: [
    { id: 'INDEX', pages: [{ id: 'INDEX', title: 'Index', summary: 'toc', path: 'INDEX.md' }] },
    { id: 'component', pages: [
      { id: 'm3_nlp', title: 'M3 NLP', summary: 'entity extraction accuracy', path: 'component/m3_nlp.md' },
      { id: 'm1', title: 'M1 Crawler', summary: 'fetch articles', path: 'component/m1.md' },
    ] },
    { id: 'theme', pages: [{ id: 'quality', title: 'Quality', summary: 'accuracy and false positives', path: 'theme/quality.md' }] },
  ],
};

test('searchPages: ranks by title+summary keyword hits, skips INDEX axis', () => {
  const hits = searchPages(MANIFEST, 'accuracy');
  assert.deepEqual(hits.map(h => h.path), ['component/m3_nlp.md', 'theme/quality.md']);  // both hit, sorted by path
  assert.ok(hits.every(h => h.score === 1));
});

test('searchPages: multi-term scores higher; case-insensitive', () => {
  const hits = searchPages(MANIFEST, 'NLP Accuracy');
  assert.equal(hits[0].path, 'component/m3_nlp.md');   // title 'M3 NLP' + summary 'accuracy' = 2 hits
  assert.equal(hits[0].score, 2);
});

test('searchPages: no match → []; does not mutate manifest', () => {
  assert.deepEqual(searchPages(MANIFEST, 'zzz'), []);
  const before = JSON.stringify(MANIFEST);
  searchPages(MANIFEST, 'accuracy');
  assert.equal(JSON.stringify(MANIFEST), before);
});

test('CLI: prints candidates; no-manifest → exit non-zero', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    writeFileSync(join(lore, 'wiki', '.manifest.json'), JSON.stringify(MANIFEST));
    const out = execFileSync('node', ['lib/ask.js', lore, 'accuracy'], { cwd: process.cwd() }).toString();
    assert.match(out, /component\/m3_nlp\.md/);

    const root2 = tmpDir();
    mkdirSync(join(root2, '.lore', 'wiki'), { recursive: true });   // no .manifest.json
    assert.throws(() => execFileSync('node', ['lib/ask.js', join(root2, '.lore'), 'x'], { cwd: process.cwd(), stdio: 'pipe' }));
    rmSync(root2, { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** `node --test test/ask.test.js` → FAIL (`searchPages` not exported).

- [ ] **Step 3: Implement** `lib/ask.js`:

```js
// lib/ask.js
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function searchPages(manifest, query) {
  const terms = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const axis of manifest.axes ?? []) {
    if (axis.id === 'INDEX') continue;
    for (const p of axis.pages ?? []) {
      const hay = `${p.title ?? ''} ${p.summary ?? ''}`.toLowerCase();
      const score = terms.filter(t => hay.includes(t)).length;
      if (score > 0) out.push({ axis: axis.id, id: p.id, title: p.title, summary: p.summary, path: p.path, score });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const loreDir = process.argv[2] ?? join(process.cwd(), '.lore');
  const query = process.argv.slice(3).join(' ');
  const manifestPath = join(loreDir, 'wiki', '.manifest.json');
  if (!existsSync(manifestPath)) {
    console.error('lore: no .manifest.json — run /lore:sync first');
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const hits = searchPages(manifest, query);
  if (hits.length === 0) {
    console.log('no matching pages');
  } else {
    for (const h of hits) console.log(`${h.path}  [${h.axis}] ${h.title} (score ${h.score})`);
  }
  process.exit(0);
}
```

- [ ] **Step 4: Run** `node --test test/ask.test.js` → PASS (4 tests).

- [ ] **Step 5: Commit**
```bash
git add lib/ask.js test/ask.test.js
git commit -m "feat(ask): searchPages (manifest keyword retrieval) + CLI"
```

---

## Task 2: command + README

**Files:** Create `commands/lore-ask.md`; Modify `README.md`

- [ ] **Step 1: Create `commands/lore-ask.md`** (real ```bash fence; frontmatter first; UTF-8):

````markdown
---
description: 从 wiki 答问 —— 检索相关合成页，先读 wiki 别重 grep 代码（resident-mode payoff）
---

# /lore:ask

带着问题查 lore wiki：检索相关 component/theme/flow 页 → 从合成页（当前架构 + 决策历史）答，而非重头读代码。

## 用法

- `/lore:ask "<问题>"` —— 例：`/lore:ask "M3 的准确率为什么这么调"`

## 行为

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/ask.js" "$(pwd)/.lore" "<问题>"
```

打印按关键词命中排序的候选页（`path [axis] title (score N)`）。然后你读 top 几页（`.lore/wiki/<path>`）从 wiki 答。

## 给 agent 的提示

- **先读 wiki 别直接 grep/读源码** —— 合成页 token 远低于重读代码（resident-mode payoff）。
- 读检索出的 top 页：当前架构段答「是什么/怎么连」，决策历史段答「为什么这么定」。
- wiki 不足才兜底：页里 `[[链接]]` 跳相关页、或指向代码路径再看源码。
- 无候选 / `.manifest.json` 缺 → 先跑 `/lore:sync` 合成 wiki。
- 只读：不改任何东西。
````

> Note: real triple-backtick fence in the actual file.

- [ ] **Step 2: Sanity** `node -e "const s=require('fs').readFileSync('commands/lore-ask.md','utf8'); if(!s.includes('lib/ask.js')||!s.startsWith('---')) process.exit(1); console.log('ok')"` → `ok`.

- [ ] **Step 3: README** — add a `## /lore:ask（已实现）` section (after `/lore:serve`, or wherever consumer commands fit):

```markdown
## `/lore:ask`（已实现）

从 wiki 答问：`node lib/ask.js <.lore目录> "<问题>"` → 按关键词命中 title+summary 排序的候选页 → agent 读 top 页从合成页（当前架构+决策历史）答，不重 grep 代码（resident-mode payoff，省 token）。只读，复用 sync 产的 `.manifest.json`。
```

- [ ] **Step 4: Commit**
```bash
git add commands/lore-ask.md README.md
git commit -m "docs: /lore:ask command + README"
```

---

## Task 3: integration

**Files:** Modify `test/ask.test.js` (append)

- [ ] **Step 1: Write the test** — append to `test/ask.test.js`:

```js
import { init } from '../lib/init.js';

function gitRepo() {
  const root = tmpDir();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  writeFileSync(join(root, 'f.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  return root;
}

test('integration: init → write page → sync → ask finds it', () => {
  const root = gitRepo();
  try {
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'a.js'), 'export const x = 1;');
    init({ repoRoot: root, srcSiteDir: join(process.cwd(), 'site') });
    const lore = join(root, '.lore');
    const compDir = join(lore, 'wiki', 'component');
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, 'lib.md'), `---\ntitle: Lib Core\nsummary: dedup ZSET accuracy\n---\n# component: lib\n\n## Current architecture\n\nx\n\n## Decision history\n\n{{LORE_JOURNAL}}\n\n## Cross-links\n\n- [[x]]\n`);
    execFileSync('node', ['lib/sync.js', 'finalize', lore], { cwd: process.cwd() });   // emits manifest with the page

    const out = execFileSync('node', ['lib/ask.js', lore, 'dedup accuracy'], { cwd: process.cwd() }).toString();
    assert.match(out, /component\/lib\.md/);   // ask finds the page by its summary keywords
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** `node --test test/ask.test.js` → PASS — `sync finalize` stamps the page + emits `.manifest.json` (with `title: Lib Core`, `summary: dedup ZSET accuracy`); `ask "dedup accuracy"` matches both keywords in the summary → prints `component/lib.md`. If it fails, investigate the real wiring (don't weaken assertions).

- [ ] **Step 3: Full suite** `node --test` → all green.

- [ ] **Step 4: Commit**
```bash
git add test/ask.test.js
git commit -m "test(ask): integration init → sync → ask finds the page"
```

---

## Self-Review

**Spec coverage:** §2 searchPages → T1; §3 CLI → T1; §4 command → T2; §5 tests → T1/T3; §6 acceptance → all; §7 out-of-scope (full-text/semantic/MCP) → not built.

**Placeholder scan:** none. T2 (command/README) full content + backtick note.

**Type consistency:** `searchPages(manifest, query) -> [{axis,id,title,summary,path,score}]` (T1) consumes the manifest shape emitted by `lib/manifest.js` (`{axes:[{id,label,pages:[{id,title,summary,path,...}]}]}`) — verified against the integration test which runs real `sync finalize` → manifest → `ask`. CLI reads `<loreDir>/wiki/.manifest.json`. `init`/`sync finalize` are existing surfaces (T3).

