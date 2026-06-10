---
title: Journal 折叠层 Implementation Plan
summary: > **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [...
source_path: docs/superpowers/plans/2026-06-06-lore-journal-fold.md
last_updated: 2026-06-06
group: 设计与计划
---
> 源文档：`docs/superpowers/plans/2026-06-06-lore-journal-fold.md`

# Journal 折叠层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除决策史里 amend/rebase 孤儿造成的重复条目，并为未来 note enrich 打底——一个纯函数折叠层。

**Architecture:** 新增纯函数 `lib/fold.js`，两阶段管线：① 按 git 可达性丢弃孤儿 commit 原子（可达 sha 集合由调用方注入，本函数不跑 git）；② 同 `atom.id` 多条合并成一条（why 追加、refs 并集、enriched OR、ts 取最早）。仅在 `lib/sync.js` `finalizeSync` 接入一处：把 `readAllAtoms` 的结果先过 `foldAtoms` 再喂下游，决策史与 HOME/INDEX 计数一并受益。`journal.js` 不动（append-only 神圣，孤儿留 ndjson 供审计）。

**Tech Stack:** Node.js (ESM) · `node:test` + `node:assert/strict` · git CLI（`git rev-list --all`）· 零运行时依赖。

**前置 spec:** `docs/superpowers/specs/2026-06-06-lore-journal-fold-design.md`

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `lib/fold.js` | 纯函数折叠层：`foldAtoms(atoms, { reachableShas })` | 新建 |
| `test/fold.test.js` | fold 纯函数单测（无 git） | 新建 |
| `lib/sync.js` | `finalizeSync` 接入 + `reachableShaSet` helper | 改（import + 1 helper + 1 处替换） |
| `test/sync.test.js` | amend 孤儿端到端集成测试（真 git repo） | 改（追加 1 个 test） |
| `lib/journal.js` | — | **不动** |

**真实 atom schema（来自 `lib/mine.js:46-59` / `lib/note.js:6-21`，测试构造须照此）：**

```js
{
  id: 'commit:<sha>' | 'note:<x>' | 'decision:<x>',
  ts: '2026-06-06T01:31:17-07:00',     // ISO8601，git author date(%aI)；amend 默认保留 → 孤儿与重生 ts 可能同秒
  kind: 'commit' | 'decision',
  commit: '<40-char sha>' | null,       // decision 原子恒为 null
  title: '<subject>',
  why: '<body>',
  what_changed: '',
  facets: { component: [], flow: [], theme: [] },
  refs: { files: [], pitfall: null, related: [] },
  source: 'hook' | 'miner:commits' | 'agent',
  enriched: false | true,
  confidence: 'EXTRACTED',
}
```

---

## Task 1: `foldAtoms` 骨架 + 同 id 合并（mergeById）

纯函数核心，先做不依赖 git 的合并部分。`reachableShas` 参数此 Task 先接受不使用（占位 `const kept = atoms;`，Task 2 再启用）。

**Files:**
- Create: `lib/fold.js`
- Test: `test/fold.test.js`

- [ ] **Step 1: 写失败测试**

Create `test/fold.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldAtoms } from '../lib/fold.js';

// 真实 atom 形状的最小工厂；over 覆盖单个字段
const atom = (over = {}) => ({
  id: 'commit:aaa', ts: '2026-06-06T01:00:00-07:00', kind: 'commit', commit: 'aaa',
  title: 't', why: '', what_changed: '',
  facets: { component: ['lib'], flow: [], theme: [] },
  refs: { files: [], pitfall: null, related: [] },
  source: 'hook', enriched: false, confidence: 'EXTRACTED',
  ...over,
});

test('foldAtoms: empty → empty', () => {
  assert.deepEqual(foldAtoms([]), []);
});

test('foldAtoms: single atom passes through unchanged', () => {
  const a = atom();
  assert.deepEqual(foldAtoms([a]), [a]);
});

test('foldAtoms: distinct ids kept in first-seen order', () => {
  const a = atom({ id: 'commit:a', commit: 'a' });
  const b = atom({ id: 'commit:b', commit: 'b' });
  assert.deepEqual(foldAtoms([a, b]).map(x => x.id), ['commit:a', 'commit:b']);
});

test('foldAtoms: same id merges — ts earliest, why appended, files union, pitfall last-non-null, enriched OR', () => {
  const skeleton = atom({
    id: 'commit:x', commit: 'x', ts: '2026-06-06T01:00:00-07:00',
    why: 'commit body', enriched: false,
    refs: { files: ['a.js'], pitfall: null, related: [] },
  });
  const enrichedAtom = atom({
    id: 'commit:x', commit: 'x', ts: '2026-06-06T05:00:00-07:00',
    why: 'agent rationale', enriched: true,
    refs: { files: ['b.js'], pitfall: 'watch the lock', related: ['commit:y'] },
  });
  const out = foldAtoms([skeleton, enrichedAtom]);
  assert.equal(out.length, 1);
  const m = out[0];
  assert.equal(m.ts, '2026-06-06T01:00:00-07:00');        // 基底 = 最早
  assert.equal(m.why, 'commit body\n\nagent rationale');   // 追加，不覆盖
  assert.deepEqual(m.refs.files, ['a.js', 'b.js']);        // 并集
  assert.deepEqual(m.refs.related, ['commit:y']);
  assert.equal(m.refs.pitfall, 'watch the lock');          // 最后非 null
  assert.equal(m.enriched, true);                          // OR
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/fold.test.js`
Expected: FAIL —— `Cannot find module '../lib/fold.js'`（文件未建）。

- [ ] **Step 3: 写最小实现**

Create `lib/fold.js`:

```js
// 决策史折叠层（纯函数，不改 ndjson）。
// 两阶段：① 按 git 可达性丢 amend/rebase 孤儿 commit 原子（Task 2）；② 同 id 多条合并成一条。
// git I/O（可达 sha 集合）由调用方注入，保持本函数纯、可测。

// 并集去重，保持首次出现顺序。
function union(arrays) {
  const out = [], seen = new Set();
  for (const arr of arrays) for (const x of (arr ?? [])) {
    if (!seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}

// 合并同 id 的一组原子（≥1 条）成一条。基底 = ts 最早那条
// （决策史时间线位置不随后续 enrich 改变）。
function mergeGroup(group) {
  if (group.length === 1) return group[0];
  const sorted = [...group].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const base = sorted[0];

  // why：基底起头，追加后续 enriched 原子里不同的非空 why（留 skeleton→enriched 演化痕迹）
  const whys = [];
  const pushWhy = (w) => { const t = (w ?? '').trim(); if (t && !whys.includes(t)) whys.push(t); };
  pushWhy(base.why);
  for (const a of sorted.slice(1)) if (a.enriched) pushWhy(a.why);

  // 基底优先、空则后续首个非空
  const firstNonEmpty = (key) => {
    for (const a of sorted) { const v = a[key]; if (v != null && v !== '') return v; }
    return base[key];
  };

  let pitfall = base.refs?.pitfall ?? null;
  for (const a of sorted) if (a.refs?.pitfall != null) pitfall = a.refs.pitfall;

  return {
    ...base,
    title: firstNonEmpty('title'),
    why: whys.join('\n\n'),
    what_changed: firstNonEmpty('what_changed'),
    refs: {
      ...base.refs,
      files: union(sorted.map(a => a.refs?.files)),
      related: union(sorted.map(a => a.refs?.related)),
      pitfall,
    },
    enriched: sorted.some(a => a.enriched),
  };
}

export function foldAtoms(atoms, { reachableShas } = {}) {
  // ① dropOrphans —— Task 2 启用
  const kept = atoms;

  // ② mergeById —— 按 id 分组，保持首次出现顺序
  const order = [];
  const groups = new Map();
  for (const a of kept) {
    if (!groups.has(a.id)) { groups.set(a.id, []); order.push(a.id); }
    groups.get(a.id).push(a);
  }
  return order.map(id => mergeGroup(groups.get(id)));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/fold.test.js`
Expected: PASS（4 tests）。

- [ ] **Step 5: Commit**

```bash
git add lib/fold.js test/fold.test.js
git commit -m "feat(fold): foldAtoms merge-by-id (why append, refs union, ts earliest)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: 可达性丢孤儿（dropOrphans）

启用 `reachableShas`：第一阶段过滤掉 `kind:commit` 且 sha 不可达的孤儿。`reachableShas` 缺省/null → 不过滤（优雅退化）。

**Files:**
- Modify: `lib/fold.js`（`foldAtoms` 里 `const kept = atoms;` 一行）
- Test: `test/fold.test.js`（追加）

- [ ] **Step 1: 追加失败测试**

把以下 test 追加到 `test/fold.test.js` 末尾：

```js
test('foldAtoms: drops orphan commit atoms (sha not in reachable set)', () => {
  const live = atom({ id: 'commit:live', commit: 'live' });
  const orphan = atom({ id: 'commit:orphan', commit: 'orphan' });
  const out = foldAtoms([live, orphan], { reachableShas: new Set(['live']) });
  assert.deepEqual(out.map(x => x.id), ['commit:live']);
});

test('foldAtoms: no reachableShas (omitted / {} / null) → nothing dropped', () => {
  const orphan = atom({ id: 'commit:orphan', commit: 'orphan' });
  assert.equal(foldAtoms([orphan]).length, 1);
  assert.equal(foldAtoms([orphan], {}).length, 1);
  assert.equal(foldAtoms([orphan], { reachableShas: null }).length, 1);
});

test('foldAtoms: decision atoms (kind!=commit, commit=null) never dropped by reachability', () => {
  const decision = atom({ id: 'note:1', kind: 'decision', commit: null, enriched: true });
  const out = foldAtoms([decision], { reachableShas: new Set() });   // 空集 = 啥都不可达
  assert.deepEqual(out.map(x => x.id), ['note:1']);
});

test('foldAtoms: amend biting — orphan(old) + reborn(new), same title diff id → only reborn survives', () => {
  const oldA = atom({ id: 'commit:old', commit: 'old', title: 'feat: widget', ts: '2026-06-06T01:00:00-07:00' });
  const reborn = atom({ id: 'commit:new', commit: 'new', title: 'feat: widget', ts: '2026-06-06T01:00:01-07:00' });
  const out = foldAtoms([oldA, reborn], { reachableShas: new Set(['new']) });
  assert.deepEqual(out.map(x => x.id), ['commit:new']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/fold.test.js`
Expected: FAIL —— 带**非空** reachable Set 的两个测试（`drops orphan…`、`amend biting…`）失败：Task 1 占位实现 `kept = atoms` 不丢孤儿，`commit:orphan`/`commit:old` 仍在。另两个新测试（`no reachableShas…`、`decision…never dropped`）测的是退化路径，占位实现恰好已满足 → PASS；前 4 个旧 test 也仍 PASS。

- [ ] **Step 3: 启用 dropOrphans**

在 `lib/fold.js` 的 `foldAtoms` 里，把：

```js
  // ① dropOrphans —— Task 2 启用
  const kept = atoms;
```

替换为：

```js
  // ① dropOrphans —— 仅当传入 reachableShas(Set) 时过滤孤儿 commit 原子。
  // null/undefined → 不过滤；decision 原子(kind!=commit 或 commit=null) 恒保留。
  const kept = reachableShas instanceof Set
    ? atoms.filter(a => !(a.kind === 'commit' && a.commit && !reachableShas.has(a.commit)))
    : atoms;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/fold.test.js`
Expected: PASS（8 tests）。

- [ ] **Step 5: Commit**

```bash
git add lib/fold.js test/fold.test.js
git commit -m "feat(fold): drop unreachable (amend/rebase orphan) commit atoms

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `sync.js` 接入 + 端到端集成测试

把 `finalizeSync` 读到的原子先过 `foldAtoms` 再喂下游；可达 sha 集合由新 helper `reachableShaSet` 提供（best-effort，失败返回 null 退化为仅合并）。

**Files:**
- Modify: `lib/sync.js`（import 第 8 行后 / helper 第 66 行后 / `finalizeSync` 第 137 行）
- Test: `test/sync.test.js`（追加 1 个 test）

- [ ] **Step 1: 追加失败集成测试**

把以下 test 追加到 `test/sync.test.js` 末尾（复用文件已有的 `gitRepo` / `appendAtom` / `tmpDir`）：

```js
test('finalizeSync folds amend orphans out of a component decision history', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');

    // 提交一个 lib 改动，再 amend 改 message → 旧 sha 变不可达孤儿
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'feature.js'), 'export const x = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'feat: widget alpha'], { cwd: root });
    const oldSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
    execFileSync('git', ['commit', '--amend', '-qm', 'feat: widget bravo'], { cwd: root });
    const newSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();

    // journal append-only 同时带着孤儿与重生两条原子
    const journalDir = join(lore, 'journal');
    const mkAtom = (sha, title) => ({
      id: `commit:${sha}`, ts: '2026-06-06T01:00:00-07:00', kind: 'commit', commit: sha,
      title, why: 'body', what_changed: '',
      facets: { component: ['lib'], flow: [], theme: [] },
      refs: { files: ['lib/feature.js'], pitfall: null, related: [] },
      source: 'hook', enriched: false, confidence: 'EXTRACTED',
    });
    appendAtom(journalDir, mkAtom(oldSha, 'feat: widget alpha'));
    appendAtom(journalDir, mkAtom(newSha, 'feat: widget bravo'));

    // 带 {{LORE_JOURNAL}} token 的 component 页，决策史才会被注入
    const compDir = join(lore, 'wiki', 'component');
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, 'lib.md'),
      '---\ntitle: Lib\nsummary: s\n---\n# component: lib\n\n## Decision history\n\n{{LORE_JOURNAL}}\n');

    finalizeSync(lore, '2026-06-06T08:00:00Z');

    const page = readFileSync(join(compDir, 'lib.md'), 'utf8');
    assert.match(page, /feat: widget bravo/);        // 重生在
    assert.doesNotMatch(page, /feat: widget alpha/);  // 孤儿被折掉
    assert.match(page, /\ncommits: 1\n/);            // 计数反映折叠后(1)，不是 2
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/sync.test.js`
Expected: FAIL —— 此时 sync 未接入 fold，决策史含孤儿，页面同时出现 `widget alpha` 与 `widget bravo`、`commits: 2`，故 `doesNotMatch(alpha)` 与 `commits: 1` 断言失败。

- [ ] **Step 3: 接入 fold（三处编辑）**

3a. `lib/sync.js` 第 8 行 `import { readAllAtoms } from './journal.js';` 之后新增一行：

```js
import { foldAtoms } from './fold.js';
```

3b. `lib/sync.js` 在 `headShortSha`（第 64-66 行）之后新增 helper：

```js
// 当前 repo 所有 ref 可达的完整 sha 集合（喂 foldAtoms 丢孤儿）。
// best-effort：非 git / git 不可用 → null，foldAtoms 退化为仅合并、不丢孤儿。
function reachableShaSet(repoRoot) {
  try {
    const out = execFileSync('git', ['rev-list', '--all'],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }).toString();
    return new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
  } catch { return null; }
}
```

3c. `lib/sync.js` `finalizeSync` 第 137 行，把：

```js
  const allAtoms = readAllAtoms(join(loreDir, 'journal'));
```

替换为：

```js
  const rawAtoms = readAllAtoms(join(loreDir, 'journal'));
  // 折叠：丢 amend/rebase 孤儿 + 同 id 合并。下游决策史(153)与 HOME/INDEX 计数(196/197/203/204) 一并基于折叠后视图。
  const allAtoms = foldAtoms(rawAtoms, { reachableShas: reachableShaSet(repoRoot) });
```

（下游所有 `allAtoms` 引用无需改动——它们现在自动消费折叠后的原子。）

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `node --test test/sync.test.js`
Expected: PASS（含新集成测试）。

Run: `node --test`
Expected: PASS，全量 0 fail（确认 fold 接入未回归既有页面渲染/计数）。

- [ ] **Step 5: Commit**

```bash
git add lib/sync.js test/sync.test.js
git commit -m "feat(sync): fold journal atoms in finalizeSync (orphan-free decision history)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: dogfood 验证 + `.lore` 同步提交（收尾，非 TDD）

用 lore 自身真实 journal 验证：现存活孤儿 `commit:d6f13ea…`（被 amend 成 `9e6eb0c…`，见 `.lore/journal/2026/06/2026-06-06.ndjson`）应在 sync 后从决策史消失。

**Files:**
- Modify: `.lore/**`（sync 产物 + hook 追加的 journal 原子）

- [ ] **Step 1: 对本仓库跑真实 sync**

```bash
node lib/mine.js .            # 收最新 commit 原子（幂等）
node lib/sync.js finalize .lore
```
Expected: `✓ sync finalized: …`，无报错。

- [ ] **Step 2: 验证孤儿已被折掉**

Run: `node --test`
Expected: 全量 PASS。

人工核对 `.lore/wiki/component/*.md` 决策史：先前重复的 8 组标题各只剩一条——尤其 `docs(spec): journal fold layer …` 只出现一次（对应可达的 `9e6eb0c`，孤儿 `d6f13ea` 已消失）。量化对比：sync 前该标题在 `lib` 页出现 2 次、sync 后 1 次。

- [ ] **Step 3: 统一提交 dogfood 产物**

```bash
git add .lore
git commit -m "chore(lore): dogfood resync — fold drops amend orphans from decision history

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

（说明：每次 commit 都会触发 lore post-commit hook 再写一条本 commit 的 journal 原子，留一条未提交尾巴属预期；这一步把先前累积的 `.lore` 改动统一收口。）

---

## Spec 覆盖核对（self-review 映射）

| spec 决策 | 落地于 |
|---|---|
| B 通用折叠层（丢孤儿 + fold-by-id） | Task 1 + Task 2（`foldAtoms` 两阶段） |
| 孤儿识别 = git 可达性 `rev-list --all` | Task 3 `reachableShaSet` + Task 2 dropOrphans |
| 合并基底 = ts 最早 | Task 1 `mergeGroup` sort + base |
| why 追加不覆盖 | Task 1 `pushWhy` / Task 1 Step1 测试 |
| files/related 并集、pitfall 最后非空、enriched OR | Task 1 `mergeGroup` / Task 1 Step1 测试 |
| 纯函数边界，git 注入，缺省退化 | Task 1 签名 + Task 2 `instanceof Set` 分支 + Task 2 Step1 测试 |
| 接入点仅 finalizeSync，journal 不动 | Task 3（137 处替换）；`journal.js` 无改动 |
| 测试矩阵 1-9 | Task 1 Step1（1,2,3,5,7）+ Task 2 Step1（4,6,8 及空集 9 变体）+ Task 3 Step1（集成 9） |

