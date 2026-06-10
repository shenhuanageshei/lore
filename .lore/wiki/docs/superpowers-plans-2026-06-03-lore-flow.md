---
title: flow axis Implementation Plan
summary: > **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.
source_path: docs/superpowers/plans/2026-06-03-lore-flow.md
last_updated: 2026-06-03
group: 设计与计划
---
> 源文档：`docs/superpowers/plans/2026-06-03-lore-flow.md`

# flow axis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** The third wiki axis — `flow` — where commit atoms are tagged by component-membership (atom's component ∈ flow's `spans`), and sync produces `flow/<id>.md` pages, completing component+theme+flow.

**Architecture:** `parseConfigFlows` (config.js) reads flow id+spans. `tagFlows` (mine.js, pure) tags by component intersection. `commitAtom` gains a 5th `flows` param → `facets.flow`. mine/hook thread config flows. sync's `planSync` emits flow worklist + `SYNC_AXES += 'flow'` (finalize/buildIndex already generalized). Symmetric to theme.

**Tech Stack:** Node ESM, `node:test`, zero deps.

**Spec:** `docs/superpowers/specs/2026-06-03-lore-flow-design.md`. **Branch:** `lore-flow` (off main).

---

## Task 1: config.parseConfigFlows

**Files:** Modify `lib/config.js`; Test `test/config.test.js`

- [ ] **Step 1: Failing test** — append to `test/config.test.js`:

```js
import { parseConfigFlows } from '../lib/config.js';

test('parseConfigFlows: commented example → []', () => {
  assert.deepEqual(parseConfigFlows('  flow:\n    values: []\n    # - { id: article-pipeline, spans: [lib] }\n'), []);
});

test('parseConfigFlows: uncommented flows (field order independent)', () => {
  const cfg = '  flow:\n    values:\n    - { id: pipeline, spans: [m1, m3, shared] }\n    - { spans: [lib], id: dedup }\n';
  assert.deepEqual(parseConfigFlows(cfg), [
    { id: 'pipeline', spans: ['m1', 'm3', 'shared'] },
    { id: 'dedup', spans: ['lib'] },
  ]);
});

test('parseConfigFlows: ignores theme items (match, no spans)', () => {
  assert.deepEqual(parseConfigFlows('    - { id: quality, match: [a] }\n    - { id: f1, spans: [lib] }\n'), [{ id: 'f1', spans: ['lib'] }]);
});
```

- [ ] **Step 2: Run** `node --test test/config.test.js` → FAIL.

- [ ] **Step 3: Implement** — append to `lib/config.js`:

```js
export function parseConfigFlows(configText) {
  const flows = [];
  for (const line of configText.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('- {') || !/\bspans:/.test(t)) continue;
    const idM = t.match(/\bid:\s*([A-Za-z0-9_-]+)/);
    const spansM = t.match(/\bspans:\s*\[([^\]]*)\]/);
    if (!idM || !spansM) continue;
    const spans = spansM[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '').trim()).filter(Boolean);
    flows.push({ id: idM[1], spans });
  }
  return flows;
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `git add lib/config.js test/config.test.js && git commit -m "feat(config): parseConfigFlows (flow id + spans)"`

---

## Task 2: mine.tagFlows

**Files:** Modify `lib/mine.js`; Test `test/mine.test.js`

- [ ] **Step 1: Failing test** — append to `test/mine.test.js`:

```js
import { tagFlows } from '../lib/mine.js';

const FLOWS = [{ id: 'pipeline', spans: ['m1', 'm3'] }, { id: 'dedup', spans: ['shared'] }];

test('tagFlows: component∩spans non-empty → flow id, sorted', () => {
  assert.deepEqual(tagFlows(['m3', 'shared'], FLOWS), ['dedup', 'pipeline']);
  assert.deepEqual(tagFlows(['m1'], FLOWS), ['pipeline']);
  assert.deepEqual(tagFlows(['lib'], FLOWS), []);
  assert.deepEqual(tagFlows([], FLOWS), []);
});

test('tagFlows: does not mutate input', () => {
  const f = [{ id: 'a', spans: ['x'] }];
  tagFlows(['x'], f);
  assert.equal(f.length, 1);
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** — append to `lib/mine.js`:

```js
export function tagFlows(components, flows) {
  const set = new Set(components);
  return flows
    .filter(fl => fl.spans.some(s => set.has(s)))
    .map(fl => fl.id)
    .sort();
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `git add lib/mine.js test/mine.test.js && git commit -m "feat(mine): tagFlows (component-membership in flow spans)"`

---

## Task 3: commitAtom flows param

**Files:** Modify `lib/mine.js`; Test `test/mine.test.js`

- [ ] **Step 1: Failing test** — append to `test/mine.test.js`:

```js
test('commitAtom: flows param tags facets.flow; default empty', () => {
  const raw = { sha: 'a', ts: '2026-06-03T00:00:00Z', subject: 's', body: '', files: ['lib/x.js'] };
  assert.deepEqual(commitAtom(raw, ['lib'], 'miner:commits', [], [{ id: 'f1', spans: ['lib'] }]).facets.flow, ['f1']);
  assert.deepEqual(commitAtom(raw, ['lib']).facets.flow, []);   // default no flows
  assert.deepEqual(commitAtom(raw, ['lib'], 'miner:commits', [{ id: 'q', match: ['s'] }]).facets.theme, ['q']);   // themes (4-arg) still works
});
```

- [ ] **Step 2: Run** → FAIL (flow stays `[]`).

- [ ] **Step 3: Implement.** Read the current `commitAtom` first. Add a 5th `flows = []` param; compute `flow` from the already-computed `component`. Replace the function:

```js
export function commitAtom(raw, codeRoots, source = 'miner:commits', themes = [], flows = []) {
  const component = [...new Set(
    raw.files.map(f => pathComponent(f, codeRoots)).filter(Boolean),
  )].sort();
  const theme = tagThemes(`${raw.subject} ${raw.body}`, themes);
  const flow = tagFlows(component, flows);
  return {
    id: `commit:${raw.sha}`,
    ts: raw.ts,
    kind: 'commit',
    commit: raw.sha,
    title: raw.subject,
    why: raw.body,
    what_changed: '',
    facets: { component, flow, theme },
    refs: { files: raw.files, pitfall: null, related: [] },
    source,
    enriched: false,
    confidence: 'EXTRACTED',
  };
}
```

- [ ] **Step 4: Run** → PASS (existing 2/3/4-arg commitAtom tests still pass → `flow:[]`). **Step 5: Commit** `git add lib/mine.js test/mine.test.js && git commit -m "feat(mine): commitAtom flows param → facets.flow"`

---

## Task 4: mineCommits/mine/CLI thread flows

**Files:** Modify `lib/mine.js`; Test `test/mine.test.js`

- [ ] **Step 1: Failing test** — append to `test/mine.test.js`:

```js
test('mineCommits: passes flows → commit atoms get facets.flow', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'x', 'change lib');
    const atoms = mineCommits(root, ['lib'], [], [{ id: 'f1', spans: ['lib'] }]);
    assert.deepEqual(atoms[0].facets.flow, ['f1']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mine CLI reads config flows', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'x', 'touch lib');
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib]\n  flow:\n    values:\n    - { id: pipe, spans: [lib] }\n');
    execFileSync('node', ['lib/mine.js', root], { cwd: process.cwd() });
    const a = readAllAtoms(join(lore, 'journal')).find(x => x.title === 'touch lib');
    assert.deepEqual(a.facets.flow, ['pipe']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** In `lib/mine.js` (read current `mineCommits`/`mine`/CLI first):

(a) `mineCommits(repoRoot, codeRoots, themes = [], flows = [])` → `.map(raw => commitAtom(raw, codeRoots, 'miner:commits', themes, flows))`.

(b) `mine({ repoRoot, journalDir, codeRoots, themes = [], flows = [] })` → `mineCommits(repoRoot, codeRoots, themes, flows)`.

(c) CLI: add `parseConfigFlows` to the `./config.js` import; from the already-read `configText`, `const flows = parseConfigFlows(configText);` and pass `mine({ repoRoot, journalDir, codeRoots, themes, flows })`.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `git add lib/mine.js test/mine.test.js && git commit -m "feat(mine): thread config flows through mineCommits/mine/CLI"`

---

## Task 5: hook captureHead flows

**Files:** Modify `lib/hook.js`; Test `test/hook.test.js`

- [ ] **Step 1: Failing test** — append to `test/hook.test.js`:

```js
test('captureHead tags flow from config flows', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'x', 'lib change');
    const journalDir = join(root, '.lore', 'journal');
    const r = captureHead({ repoRoot: root, journalDir, codeRoots: ['lib'], flows: [{ id: 'pipe', spans: ['lib'] }] });
    assert.equal(r.added, 1);
    assert.deepEqual(readAllAtoms(journalDir)[0].facets.flow, ['pipe']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** In `lib/hook.js`:
(a) `captureHead({ repoRoot, journalDir, codeRoots, themes = [], flows = [] })` → `commitAtom(raws[0], codeRoots, 'hook', themes, flows)`.
(b) CLI: add `parseConfigFlows` to the `./config.js` import; from `configText`, `const flows = parseConfigFlows(configText);`, pass `captureHead({ repoRoot, journalDir, codeRoots, themes, flows })`. **Keep the try/catch + `process.exit(0)` best-effort intact.**

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `git add lib/hook.js test/hook.test.js && git commit -m "feat(hook): captureHead tags flow from config flows"`

---

## Task 6: planSync flow worklist + SYNC_AXES += flow

**Files:** Modify `lib/sync.js`; Test `test/sync.test.js`

- [ ] **Step 1: Failing test** — append to `test/sync.test.js`:

```js
test('planSync includes flow worklist items', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib]\n  flow:\n    values:\n    - { id: pipe, spans: [lib] }\n');
    const { worklist, flows } = planSync(lore);
    assert.deepEqual(flows, [{ id: 'pipe', spans: ['lib'] }]);
    assert.ok(worklist.some(w => w.axis === 'flow' && w.id === 'pipe' && w.path === 'flow/pipe.md'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('finalizeSync folds the flow axis', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki', 'flow'), { recursive: true });
    writeFileSync(join(lore, 'wiki', 'flow', 'pipe.md'), tokenPage('Pipe', 'p'));
    appendAtom(join(lore, 'journal'), { id: 'commit:a', ts: '2026-06-03T00:00:00Z', kind: 'commit', commit: 'aaaaaaa0', title: 'flow fix', why: '', facets: { component: ['lib'], flow: ['pipe'], theme: [] } });
    finalizeSync(lore, '2026-06-03T00:00:00Z');
    assert.match(readFileSync(join(lore, 'wiki', 'flow', 'pipe.md'), 'utf8'), /- \*\*flow fix\*\*/);
    assert.match(readFileSync(join(lore, 'wiki', 'INDEX.md'), 'utf8'), /## Flow/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** → FAIL (no flow worklist; SYNC_AXES lacks flow).

- [ ] **Step 3: Implement.** In `lib/sync.js`:
(a) Add `parseConfigFlows` to the `./config.js` import. In `planSync`, after the themes section, add flows:
```js
  const flows = parseConfigFlows(configText);
  ...
  for (const fl of flows) {
    worklist.push({ axis: 'flow', id: fl.id, path: `flow/${fl.id}.md`, priorExists: exists('flow', fl.id) });
  }
  return { codeRoots, themes, flows, worklist };
```
(Read current `planSync` — it reads `configText` once + builds component+theme worklist + returns `{codeRoots, themes, worklist}`. Add `flows` parse, flow worklist items, and `flows` in the return.)

(b) Change `SYNC_AXES` from `['component', 'theme']` to `['component', 'theme', 'flow']`.

- [ ] **Step 4: Run** `node --test test/sync.test.js` → PASS (update the existing `planSync` test that asserts the return object IF it does a full deepEqual — add `flows: []` where needed; `buildIndex` already lists flow so no buildIndex change). Then `node --test` full suite → green.

- [ ] **Step 5: Commit** `git add lib/sync.js test/sync.test.js && git commit -m "feat(sync): planSync flow worklist + SYNC_AXES includes flow"`

---

## Task 7: command lore-sync.md — flow pages

**Files:** Modify `commands/lore-sync.md`

- [ ] **Step 1:** Read `commands/lore-sync.md`. The intro currently says `本版产 component + theme 页（flow 推迟）。` — change to `本版产 component + theme + flow 三轴页。`. In the 合成 step, after the theme-page paragraph, ADD a flow-page paragraph:

```
对每个 `axis:'flow'` 的 worklist 项，写 `.lore/wiki/flow/<id>.md` —— 讲「这条数据流端到端怎么跑」（入口 → 各阶段经过哪些组件 → 出口）：

```markdown
---
title: <数据流显示名>
summary: <一行摘要>
---
# flow: <id>

## End-to-end path

<入口→各阶段(经过的组件)→出口；关键转换/约束>

## Decision history

{{LORE_JOURNAL}}

## Cross-links

- [[<spans 里的组件>]]
```

finalize 折标了该 flow 的原子（原子的 component ∈ flow 的 spans → 自动标）。
```

Update 给 agent 的提示 to mention flow pages (config `flow.values` 填 `spans` + mine 后原子带 flow facet)。

- [ ] **Step 2: Sanity** `node -e "const s=require('fs').readFileSync('commands/lore-sync.md','utf8'); if(!s.includes('flow/<id>.md')||s.includes('flow 推迟')) process.exit(1); console.log('ok')"` → `ok`.

- [ ] **Step 3: Commit** `git add commands/lore-sync.md && git commit -m "docs(command): /lore:sync writes flow pages (3 axes)"`

---

## Task 8: integration + README

**Files:** Modify `test/sync.test.js`; `README.md`

- [ ] **Step 1: Integration test** — append to `test/sync.test.js`:

```js
test('integration: config flow → mine tags it → sync folds into flow page', () => {
  const root = gitRepo();
  try {
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'a.js'), 'export const x = 1;');
    init({ repoRoot: root, srcSiteDir: join(process.cwd(), 'site') });
    const lore = join(root, '.lore');
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib]\n  flow:\n    values:\n    - { id: pipe, spans: [lib] }\n');
    writeFileSync(join(root, 'lib', 'b.js'), 'y');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'touch lib pipeline'], { cwd: root });
    execFileSync('node', ['lib/mine.js', root], { cwd: process.cwd() });   // atom component:[lib] → flow:[pipe]

    const flowDir = join(lore, 'wiki', 'flow');
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, 'pipe.md'), tokenPage('Pipe', 'p'));
    execFileSync('node', ['lib/sync.js', 'finalize', lore], { cwd: process.cwd() });

    assert.match(readFileSync(join(flowDir, 'pipe.md'), 'utf8'), /touch lib pipeline/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** `node --test test/sync.test.js` + full `node --test` → green. (`init`'s hook fires on the commit too — harmless, deduped.)

- [ ] **Step 3: README** — update the `/lore:sync` section: change "component + theme 两轴" to "component + theme + flow 三轴" and append:
```
flow 轴：config `flow.values` 用 `spans:[组件…]` 声明一条数据流跨哪些组件；原子的 component ∈ 某 flow 的 spans → 自动标该 flow；sync 产 `flow/<id>.md`。lore 三轴齐（component/theme/flow）。
```

- [ ] **Step 4: Commit** `git add test/sync.test.js README.md && git commit -m "docs+test(flow): integration config→mine→sync flow page + README"`

---

## Self-Review

**Spec coverage:** §2 parseConfigFlows → T1; §3 tagFlows → T2; §4 commitAtom flows + mine/hook wiring → T3/T4/T5; §5 planSync + SYNC_AXES → T6; §6 command → T7; §7 tests → all; §8 acceptance → all; §9 out-of-scope (regex/glob/desc/note-auto) → not built.

**Placeholder scan:** none.

**Type consistency:** `parseConfigFlows(text)->[{id,spans}]` (T1) → `tagFlows(components, flows)->string[]` (T2) → `commitAtom(raw, codeRoots, source, themes, flows)` 5th param (T3) → `facets.flow`. `mineCommits(repoRoot, codeRoots, themes, flows)` / `mine({...flows})` / `captureHead({...flows})` (T4/T5). `planSync->{codeRoots, themes, flows, worklist[{axis:'flow',...}]}` (T6). `SYNC_AXES=['component','theme','flow']` (T6) — `finalizeSync`/`buildIndex` already iterate flow (theme feature). Component+theme behavior preserved.

