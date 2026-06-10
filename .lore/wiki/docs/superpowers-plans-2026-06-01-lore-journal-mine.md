---
title: journal + /lore:mine Implementation Plan
summary: > **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [...
source_path: docs/superpowers/plans/2026-06-01-lore-journal-mine.md
last_updated: 2026-06-01
group: 设计与计划
---
> 源文档：`docs/superpowers/plans/2026-06-01-lore-journal-mine.md`

# journal + /lore:mine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the journal substrate (`lib/journal.js`, ndjson atom store) + the commits miner (`lib/mine.js`, `git log` → deterministic commit atoms with component facets), and extract `parseConfigCodeRoots` into a shared `lib/config.js`, so `/lore:mine` backfills `.lore/journal/` from git history.

**Architecture:** Three small focused modules — `lib/config.js` (pure config parse, extracted from sync.js), `lib/journal.js` (pure ndjson store: path/append/read/dedup), `lib/mine.js` (git log parse + atom construction + orchestration + CLI). Fully deterministic (no LLM/agent), all node:test-able. `commands/lore-mine.md` is a thin CLI wrapper.

**Tech Stack:** Node.js (ESM, `type: module`), `node:test` built-in runner (zero external deps), `node:fs`/`node:path`/`node:child_process`. No YAML library.

**Spec:** `docs/superpowers/specs/2026-06-01-lore-journal-mine-design.md`. **Parent spec:** `docs/superpowers/specs/2026-05-31-lore-repo-wiki-design.md` §4/§6/§11.

**Branch:** `lore-journal-mine` (already created off `main`).

---

## File Structure

```
D:\workspace\lore\
├── lib/
│   ├── config.js           # NEW — parseConfigCodeRoots (extracted from sync.js)
│   ├── journal.js          # NEW — atomPath, appendAtom, readAllAtoms, existingIds
│   ├── mine.js             # NEW — pathComponent, parseGitLog, commitAtom, mineCommits, mine, CLI
│   └── sync.js             # MODIFY — import parseConfigCodeRoots from './config.js' (delete local copy)
├── commands/
│   └── lore-mine.md        # NEW — /lore:mine slash command
├── test/
│   ├── config.test.js      # NEW — parseConfigCodeRoots tests (moved from sync.test.js)
│   ├── journal.test.js     # NEW
│   ├── mine.test.js        # NEW (unit + CLI + integration)
│   └── sync.test.js        # MODIFY — remove the 4 parseConfigCodeRoots tests + that import
└── README.md               # MODIFY — add /lore:mine section
```

**Module API contract (locked — later tasks must match exactly):**

- `lib/config.js`: `parseConfigCodeRoots(configText) -> string[]`
- `lib/journal.js`:
  - `atomPath(journalDir, isoTs) -> string` — `journalDir/YYYY/MM/YYYY-MM-DD.ndjson`
  - `appendAtom(journalDir, atom) -> void`
  - `readAllAtoms(journalDir) -> object[]` — `[]` if dir missing
  - `existingIds(journalDir) -> Set<string>`
- `lib/mine.js`:
  - `pathComponent(filePath, codeRoots) -> string | null`
  - `parseGitLog(stdout) -> Array<{sha, ts, subject, body, files}>`
  - `commitAtom(raw, codeRoots) -> object`
  - `mineCommits(repoRoot, codeRoots) -> object[]`
  - `mine({repoRoot, journalDir, codeRoots}) -> {scanned, added, skipped}`

---

## Task 1: Extract lib/config.js (refactor)

**Files:**
- Create: `lib/config.js`, `test/config.test.js`
- Modify: `lib/sync.js`, `test/sync.test.js`

- [ ] **Step 1: Create `lib/config.js`**

```js
// lib/config.js
export function parseConfigCodeRoots(configText) {
  const m = configText.match(/^\s*code_roots:\s*\[([^\]]*)\]/m);
  if (!m) return [];
  return m[1]
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}
```

- [ ] **Step 2: Create `test/config.test.js`** (the 4 tests moved out of sync.test.js)

```js
// test/config.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigCodeRoots } from '../lib/config.js';

test('parseConfigCodeRoots: single-line list', () => {
  assert.deepEqual(parseConfigCodeRoots('axes:\n  component:\n    code_roots: [lib, site]\n'), ['lib', 'site']);
});

test('parseConfigCodeRoots: dequotes entries with special chars', () => {
  assert.deepEqual(parseConfigCodeRoots("    code_roots: ['a b', m1, \"x\"]\n"), ['a b', 'm1', 'x']);
});

test('parseConfigCodeRoots: empty list', () => {
  assert.deepEqual(parseConfigCodeRoots('    code_roots: []\n'), []);
});

test('parseConfigCodeRoots: missing line yields []', () => {
  assert.deepEqual(parseConfigCodeRoots('axes: {}\n'), []);
});
```

Run: `node --test test/config.test.js` → Expected: PASS (4 tests).

- [ ] **Step 3: Update `lib/sync.js` to import from config.js**

In `lib/sync.js`, DELETE the local `parseConfigCodeRoots` function (the exact block):

```js
export function parseConfigCodeRoots(configText) {
  const m = configText.match(/^\s*code_roots:\s*\[([^\]]*)\]/m);
  if (!m) return [];
  return m[1]
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}
```

and ADD this import near the top of `lib/sync.js` (alongside the existing `./manifest.js` import):

```js
import { parseConfigCodeRoots } from './config.js';
```

(`planSync` still calls `parseConfigCodeRoots` — now resolved via the import. Do not change `planSync`.)

- [ ] **Step 4: Update `test/sync.test.js`**

Two edits:
1. Remove `parseConfigCodeRoots` from the `import { ... } from '../lib/sync.js'` line (keep the other names: `planSync, stampFrontmatter, buildIndex, finalizeSync`).
2. DELETE the four `test('parseConfigCodeRoots: ...')` blocks (single-line list / dequotes / empty list / missing line) — they now live in `test/config.test.js`.

(Read the file first to locate the exact import line and the four test blocks.)

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS — all files green. `config.test.js` has the 4 parseConfigCodeRoots tests; `sync.test.js` no longer has them; sync still works (planSync uses the imported parser). Total test count is unchanged from before this task (the 4 tests just moved files).

- [ ] **Step 6: Commit**

```bash
git add lib/config.js test/config.test.js lib/sync.js test/sync.test.js
git commit -m "refactor: extract parseConfigCodeRoots into lib/config.js (shared by sync + mine)"
```

---

## Task 2: journal.atomPath

**Files:**
- Create: `lib/journal.js`, `test/journal.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/journal.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomPath } from '../lib/journal.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-journal-')); }

test('atomPath maps ISO ts to YYYY/MM/YYYY-MM-DD.ndjson', () => {
  assert.equal(atomPath('/j', '2026-06-01T08:00:00Z'), join('/j', '2026', '06', '2026-06-01.ndjson'));
  assert.equal(atomPath('/j', '2025-12-31T23:59:59+09:00'), join('/j', '2025', '12', '2025-12-31.ndjson'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/journal.test.js`
Expected: FAIL — `atomPath` not exported (import error).

- [ ] **Step 3: Write minimal implementation**

```js
// lib/journal.js
import { join } from 'node:path';

export function atomPath(journalDir, isoTs) {
  const year = isoTs.slice(0, 4);
  const month = isoTs.slice(5, 7);
  const date = isoTs.slice(0, 10);   // YYYY-MM-DD
  return join(journalDir, year, month, `${date}.ndjson`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/journal.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add lib/journal.js test/journal.test.js
git commit -m "feat(journal): atomPath shards atoms by ISO date"
```

---

## Task 3: journal.appendAtom

**Files:**
- Modify: `lib/journal.js` (add `appendAtom`)
- Test: `test/journal.test.js` (append)

- [ ] **Step 1: Write the failing test**

```js
// append to test/journal.test.js
import { appendAtom } from '../lib/journal.js';

test('appendAtom writes one JSON line to the date shard; second append same day → 2 lines', () => {
  const dir = tmpDir();
  try {
    const j = join(dir, 'journal');
    appendAtom(j, { id: 'a', ts: '2026-06-01T08:00:00Z', x: 1 });
    appendAtom(j, { id: 'b', ts: '2026-06-01T09:00:00Z', x: 2 });
    const shard = join(j, '2026', '06', '2026-06-01.ndjson');
    const lines = readFileSync(shard, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { id: 'a', ts: '2026-06-01T08:00:00Z', x: 1 });
    assert.deepEqual(JSON.parse(lines[1]), { id: 'b', ts: '2026-06-01T09:00:00Z', x: 2 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/journal.test.js`
Expected: FAIL — `appendAtom` undefined.

- [ ] **Step 3: Write minimal implementation**

```js
// append to lib/journal.js
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function appendAtom(journalDir, atom) {
  const p = atomPath(journalDir, atom.ts);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(atom) + '\n');
}
```

(Merge `dirname` into the existing `node:path` import if you prefer a single line; both are valid.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/journal.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/journal.js test/journal.test.js
git commit -m "feat(journal): appendAtom (append-only ndjson per day)"
```

---

## Task 4: journal.readAllAtoms + existingIds

**Files:**
- Modify: `lib/journal.js` (add `readAllAtoms`, `existingIds`, internal `walkNdjson`)
- Test: `test/journal.test.js` (append)

- [ ] **Step 1: Write the failing test**

```js
// append to test/journal.test.js
import { readAllAtoms, existingIds } from '../lib/journal.js';

test('readAllAtoms reads across day/month/year shards; missing dir → []', () => {
  const dir = tmpDir();
  try {
    const j = join(dir, 'journal');
    assert.deepEqual(readAllAtoms(j), []);                       // missing dir
    appendAtom(j, { id: 'a', ts: '2026-06-01T08:00:00Z' });
    appendAtom(j, { id: 'b', ts: '2026-07-15T08:00:00Z' });
    appendAtom(j, { id: 'c', ts: '2025-01-02T08:00:00Z' });
    const ids = readAllAtoms(j).map(a => a.id).sort();
    assert.deepEqual(ids, ['a', 'b', 'c']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('existingIds returns the set of atom ids', () => {
  const dir = tmpDir();
  try {
    const j = join(dir, 'journal');
    appendAtom(j, { id: 'commit:x', ts: '2026-06-01T08:00:00Z' });
    appendAtom(j, { id: 'commit:y', ts: '2026-06-01T08:00:00Z' });
    const s = existingIds(j);
    assert.equal(s.has('commit:x'), true);
    assert.equal(s.has('commit:y'), true);
    assert.equal(s.has('commit:z'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/journal.test.js`
Expected: FAIL — `readAllAtoms` / `existingIds` undefined.

- [ ] **Step 3: Write minimal implementation**

```js
// append to lib/journal.js
import { readdirSync, readFileSync, existsSync } from 'node:fs';

function walkNdjson(dir) {
  let out = [];
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkNdjson(full));
    else if (e.isFile() && e.name.endsWith('.ndjson')) out.push(full);
  }
  return out;
}

export function readAllAtoms(journalDir) {
  if (!existsSync(journalDir)) return [];
  const atoms = [];
  for (const f of walkNdjson(journalDir)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (t) atoms.push(JSON.parse(t));
    }
  }
  return atoms;
}

export function existingIds(journalDir) {
  return new Set(readAllAtoms(journalDir).map(a => a.id));
}
```

(Merge the new `node:fs` names into the existing `node:fs` import line.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/journal.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/journal.js test/journal.test.js
git commit -m "feat(journal): readAllAtoms + existingIds (recursive ndjson walk)"
```

---

## Task 5: mine.pathComponent

**Files:**
- Create: `lib/mine.js`, `test/mine.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/mine.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathComponent } from '../lib/mine.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-mine-')); }

test('pathComponent: prefix match → last segment', () => {
  assert.equal(pathComponent('lib/sync.js', ['lib', 'site']), 'lib');
  assert.equal(pathComponent('site/shell.mjs', ['lib', 'site']), 'site');
});

test('pathComponent: longest match wins, last segment name', () => {
  assert.equal(pathComponent('src/pkg/core.py', ['src', 'src/pkg']), 'pkg');
});

test('pathComponent: no match → null (and prefix-of-name does not falsely match)', () => {
  assert.equal(pathComponent('README.md', ['lib', 'site']), null);
  assert.equal(pathComponent('libfoo/x.js', ['lib']), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mine.test.js`
Expected: FAIL — `pathComponent` not exported (import error).

- [ ] **Step 3: Write minimal implementation**

```js
// lib/mine.js
export function pathComponent(filePath, codeRoots) {
  let best = null;
  for (const root of codeRoots) {
    if (filePath === root || filePath.startsWith(root + '/')) {
      if (best === null || root.length > best.length) best = root;
    }
  }
  return best === null ? null : best.split('/').pop();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/mine.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/mine.js test/mine.test.js
git commit -m "feat(mine): pathComponent maps file path to component (longest code_root)"
```

---

## Task 6: mine.parseGitLog

**Files:**
- Modify: `lib/mine.js` (add `parseGitLog`)
- Test: `test/mine.test.js` (append)

- [ ] **Step 1: Write the failing test**

```js
// append to test/mine.test.js
import { parseGitLog } from '../lib/mine.js';

test('parseGitLog parses commits with multi-line body and files', () => {
  const RS = '\x1e', US = '\x1f';
  const stdout =
    `${RS}abc123${US}2026-06-01T08:00:00Z${US}fix bug${US}body line1\nbody line2${US}\n\nlib/a.js\nlib/b.js\n` +
    `${RS}def456${US}2026-05-30T10:00:00+09:00${US}add feature${US}${US}\n\nsite/x.mjs\n`;
  const commits = parseGitLog(stdout);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0], {
    sha: 'abc123', ts: '2026-06-01T08:00:00Z', subject: 'fix bug',
    body: 'body line1\nbody line2', files: ['lib/a.js', 'lib/b.js'],
  });
  assert.deepEqual(commits[1], {
    sha: 'def456', ts: '2026-05-30T10:00:00+09:00', subject: 'add feature',
    body: '', files: ['site/x.mjs'],
  });
});

test('parseGitLog: empty stdout → []', () => {
  assert.deepEqual(parseGitLog(''), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mine.test.js`
Expected: FAIL — `parseGitLog` undefined.

- [ ] **Step 3: Write minimal implementation**

```js
// append to lib/mine.js
export function parseGitLog(stdout) {
  return stdout
    .split('\x1e')
    .slice(1)
    .map(rec => {
      const [sha, ts, subject, body, filesBlob = ''] = rec.split('\x1f');
      const files = filesBlob.split('\n').map(s => s.trim()).filter(Boolean);
      return { sha, ts, subject, body, files };
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/mine.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/mine.js test/mine.test.js
git commit -m "feat(mine): parseGitLog (RS/US-delimited git log → raw commits)"
```

---

## Task 7: mine.commitAtom

**Files:**
- Modify: `lib/mine.js` (add `commitAtom`)
- Test: `test/mine.test.js` (append)

- [ ] **Step 1: Write the failing test**

```js
// append to test/mine.test.js
import { commitAtom } from '../lib/mine.js';

test('commitAtom builds full-schema atom with component facets', () => {
  const raw = {
    sha: 'abc123def', ts: '2026-06-01T08:00:00Z', subject: 'fix crawler',
    body: 'why text', files: ['m1_crawler/fetch.py', 'shared/util.py', 'README.md'],
  };
  const atom = commitAtom(raw, ['m1_crawler', 'shared']);
  assert.equal(atom.id, 'commit:abc123def');
  assert.equal(atom.ts, '2026-06-01T08:00:00Z');
  assert.equal(atom.kind, 'commit');
  assert.equal(atom.commit, 'abc123def');
  assert.equal(atom.title, 'fix crawler');
  assert.equal(atom.why, 'why text');
  assert.equal(atom.what_changed, '');
  assert.deepEqual(atom.facets.component, ['m1_crawler', 'shared']); // sorted, deduped, README excluded
  assert.deepEqual(atom.facets.flow, []);
  assert.deepEqual(atom.facets.theme, []);
  assert.deepEqual(atom.refs.files, ['m1_crawler/fetch.py', 'shared/util.py', 'README.md']);
  assert.equal(atom.refs.pitfall, null);
  assert.deepEqual(atom.refs.related, []);
  assert.equal(atom.source, 'miner:commits');
  assert.equal(atom.enriched, false);
  assert.equal(atom.confidence, 'EXTRACTED');
});

test('commitAtom: no matching component → empty component facet', () => {
  const atom = commitAtom(
    { sha: 'x', ts: '2026-06-01T08:00:00Z', subject: 's', body: '', files: ['README.md'] },
    ['lib'],
  );
  assert.deepEqual(atom.facets.component, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mine.test.js`
Expected: FAIL — `commitAtom` undefined.

- [ ] **Step 3: Write minimal implementation**

```js
// append to lib/mine.js
export function commitAtom(raw, codeRoots) {
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
    source: 'miner:commits',
    enriched: false,
    confidence: 'EXTRACTED',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/mine.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/mine.js test/mine.test.js
git commit -m "feat(mine): commitAtom builds full journal atom + component facets"
```

---

## Task 8: mine.mineCommits

**Files:**
- Modify: `lib/mine.js` (add `mineCommits` + `GIT_FORMAT`)
- Test: `test/mine.test.js` (append; uses a real temp git repo)

- [ ] **Step 1: Write the failing test**

```js
// append to test/mine.test.js
import { mineCommits } from '../lib/mine.js';

function gitRepo() {
  const root = tmpDir();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  return root;
}

function commitFile(root, relpath, content, msg) {
  const p = join(root, relpath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', msg], { cwd: root });
}

test('mineCommits returns commit atoms with component facets from a real repo', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'x', 'add lib');
    commitFile(root, 'site/b.mjs', 'y', 'add site');
    const atoms = mineCommits(root, ['lib', 'site']);
    assert.equal(atoms.length, 2);
    const byTitle = Object.fromEntries(atoms.map(a => [a.title, a]));
    assert.deepEqual(byTitle['add lib'].facets.component, ['lib']);
    assert.deepEqual(byTitle['add site'].facets.component, ['site']);
    assert.equal(byTitle['add lib'].kind, 'commit');
    assert.match(byTitle['add lib'].id, /^commit:[0-9a-f]{40}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mine.test.js`
Expected: FAIL — `mineCommits` undefined.

- [ ] **Step 3: Write minimal implementation**

```js
// append to lib/mine.js
import { execFileSync } from 'node:child_process';

const GIT_FORMAT = '%x1e%H%x1f%aI%x1f%s%x1f%b%x1f';

export function mineCommits(repoRoot, codeRoots) {
  const stdout = execFileSync(
    'git',
    ['log', '--no-merges', `--pretty=format:${GIT_FORMAT}`, '--name-only'],
    { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
  ).toString();
  return parseGitLog(stdout).map(raw => commitAtom(raw, codeRoots));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/mine.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/mine.js test/mine.test.js
git commit -m "feat(mine): mineCommits runs git log → commit atoms"
```

---

## Task 9: mine.mine (orchestrate + dedup)

**Files:**
- Modify: `lib/mine.js` (add `mine`)
- Test: `test/mine.test.js` (append)

- [ ] **Step 1: Write the failing test**

```js
// append to test/mine.test.js
import { mine } from '../lib/mine.js';

test('mine appends new atoms; re-run is idempotent (dedup by id)', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'x', 'c1');
    commitFile(root, 'lib/b.js', 'y', 'c2');
    const journalDir = join(root, '.lore', 'journal');
    const r1 = mine({ repoRoot: root, journalDir, codeRoots: ['lib'] });
    assert.deepEqual(r1, { scanned: 2, added: 2, skipped: 0 });
    const r2 = mine({ repoRoot: root, journalDir, codeRoots: ['lib'] });
    assert.deepEqual(r2, { scanned: 2, added: 0, skipped: 2 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mine.test.js`
Expected: FAIL — `mine` undefined.

- [ ] **Step 3: Write minimal implementation**

```js
// append to lib/mine.js
import { appendAtom, existingIds } from './journal.js';

export function mine({ repoRoot, journalDir, codeRoots }) {
  const seen = existingIds(journalDir);
  const atoms = mineCommits(repoRoot, codeRoots);
  let added = 0, skipped = 0;
  for (const a of atoms) {
    if (seen.has(a.id)) { skipped++; continue; }
    appendAtom(journalDir, a);
    seen.add(a.id);
    added++;
  }
  return { scanned: atoms.length, added, skipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/mine.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/mine.js test/mine.test.js
git commit -m "feat(mine): mine orchestration with id-based dedup (idempotent)"
```

---

## Task 10: mine CLI + integration

**Files:**
- Modify: `lib/mine.js` (add CLI guard)
- Test: `test/mine.test.js` (append CLI + integration test)

- [ ] **Step 1: Write the failing test**

```js
// append to test/mine.test.js
import { init } from '../lib/init.js';
import { readAllAtoms } from '../lib/journal.js';

test('CLI integration: init + mine populates journal with component facets, idempotent', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'export const x = 1;', 'add lib module');
    // real init writes .lore/config.yml (discovers lib/ → code_roots: [lib]) + shell
    init({ repoRoot: root, srcSiteDir: join(process.cwd(), 'site') });
    const journalDir = join(root, '.lore', 'journal');

    const out = execFileSync('node', ['lib/mine.js', root], { cwd: process.cwd() }).toString();
    assert.match(out, /mined 1 new commit atom/);

    const atoms = readAllAtoms(journalDir);
    assert.equal(atoms.length, 1);
    assert.equal(atoms[0].title, 'add lib module');
    assert.deepEqual(atoms[0].facets.component, ['lib']);
    assert.equal(atoms[0].source, 'miner:commits');

    // idempotent re-run via CLI
    const out2 = execFileSync('node', ['lib/mine.js', root], { cwd: process.cwd() }).toString();
    assert.match(out2, /mined 0 new commit atom/);
    assert.equal(readAllAtoms(journalDir).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mine.test.js`
Expected: FAIL — `node lib/mine.js <root>` prints nothing (no CLI block), so the `/mined 1 new commit atom/` match fails.

- [ ] **Step 3: Write minimal implementation**

```js
// append to lib/mine.js
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfigCodeRoots } from './config.js';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = process.argv[2] ?? process.cwd();
  const loreDir = join(repoRoot, '.lore');
  const configPath = join(loreDir, 'config.yml');
  const codeRoots = existsSync(configPath)
    ? parseConfigCodeRoots(readFileSync(configPath, 'utf8'))
    : [];
  const journalDir = join(loreDir, 'journal');
  const r = mine({ repoRoot, journalDir, codeRoots });
  console.log(`✓ mined ${r.added} new commit atom(s) (${r.skipped} already present, ${r.scanned} scanned)`);
  if (!existsSync(configPath)) {
    console.log('  note: no .lore/config.yml — run /lore:init for component tagging');
  }
  console.log('  next: /lore:sync');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/mine.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS — every file green (config, journal, mine, manifest, server, serve, shell, init, sync, integration).

- [ ] **Step 6: Commit**

```bash
git add lib/mine.js test/mine.test.js
git commit -m "feat(mine): CLI entry + init→mine integration (component facets, idempotent)"
```

---

## Task 11: /lore:mine slash command definition

**Files:**
- Create: `commands/lore-mine.md`

- [ ] **Step 1: Write the command file**

Create `commands/lore-mine.md` with EXACTLY this content (the ```bash fence is a REAL triple-backtick code block; file starts with the YAML frontmatter `---`; keep Chinese UTF-8):

````markdown
---
description: bootstrap 回填 journal —— 挖 git commit 历史 → commit 原子（确定性，component facet 打标），幂等
---

# /lore:mine

把 git 历史挖进 journal：每个非 merge commit → 一条 commit 原子（`title`/`why`/变更文件/component facet），写进 `.lore/journal/YYYY/MM/*.ndjson`。一次性 bootstrap 回填，幂等可重跑。本版只挖 commits（changelog/pitfalls 推迟）。

## 用法

- `/lore:mine` —— 在当前仓库根目录回填 journal

## 行为

本命令是 `lib/mine.js` 的薄封装。在目标仓库根目录运行：

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/mine.js" "$(pwd)"
```

它会：读 `.lore/config.yml` 的 `code_roots`；`git log --no-merges` 全历史；每 commit → 原子（`facets.component` 由变更路径前缀匹配 `code_roots` 机械推导）；按 atom id（`commit:<sha>`）去重；append 到 `.lore/journal/`。

## 给 agent 的提示

- 一次性 bootstrap：把 hook 之前的历史回填进 journal。幂等 —— 重跑只加新 commit。
- component 打标需 `.lore/config.yml` 的 `code_roots` → 先跑 `/lore:init`（没 config 也能挖，但 component facet 为空）。
- 纯确定性零 LLM —— 不需要你写任何 prose。
- 下一步 `/lore:sync`（未来版本会把 journal 折叠进 wiki 的「决策历史」段）。
- 零侵入：只写 `.lore/journal/`，绝不改业务源码。
````

> Note: in the actual file the `bash` fence uses real triple backticks (escaped here only to keep this plan's outer block intact).

- [ ] **Step 2: Sanity check the file**

Run: `node -e "const s=require('fs').readFileSync('commands/lore-mine.md','utf8'); if(!s.includes('lib/mine.js')||!s.startsWith('---')) process.exit(1); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add commands/lore-mine.md
git commit -m "feat(command): /lore:mine slash command definition"
```

---

## Task 12: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a `/lore:mine` section before the `/lore:sync` section**

Insert this block immediately before the line `## \`/lore:sync\`（已实现）`:

```markdown
## `/lore:mine`（已实现）

bootstrap 回填 journal：挖 `git log` 历史 → 每个非 merge commit 一条 commit 原子（`title`/`why`/变更文件 + `component` facet 由路径→`code_roots` 机械推导），按 `commit:<sha>` 去重，写 `.lore/journal/YYYY/MM/*.ndjson`。纯确定性，零 LLM。本版只挖 commits。

\`\`\`bash
node lib/mine.js <目标仓库>          # 回填（幂等，重跑只加新 commit）
\`\`\`

捕获链：`/lore:mine` 填 journal（生产者）→ 未来 `/lore:sync` 折叠进「决策历史」段（消费者）。component 打标需先 `/lore:init` 生成 `config.yml`。
```

> Note: the inner bash fence uses real triple backticks in the actual file (escaped here only to preserve this plan's formatting).

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README with /lore:mine usage"
```

---

## Self-Review

**1. Spec coverage** (spec §-by-§ → task):
- §1 scope (journal substrate + commits miner + config extract; component facets) → Tasks 1-10.
- §2 architecture (config.js/journal.js/mine.js + command + tests; touch sync.js/sync.test.js) → Tasks 1-12.
- §3 API contract: `parseConfigCodeRoots` → Task 1; `atomPath` → Task 2; `appendAtom` → Task 3; `readAllAtoms`/`existingIds` → Task 4; `pathComponent` → Task 5; `parseGitLog` → Task 6; `commitAtom` → Task 7; `mineCommits` → Task 8; `mine` → Task 9; CLI → Task 10.
- §4 git log parse (RS/US format + trailing %x1f) → Task 6 (`parseGitLog`) + Task 8 (`GIT_FORMAT`).
- §5 component facet (longest prefix, last segment, no false prefix-of-name match) → Task 5; aggregated/sorted/deduped in `commitAtom` → Task 7.
- §6 commit atom full schema (id=commit:<full-sha>, kind, source=miner:commits, enriched:false, confidence:EXTRACTED, what_changed:"") → Task 7.
- §7 ndjson (atomPath by date, append-only, recursive read, missing→[]) → Tasks 2-4.
- §8 mine orchestration + id dedup (idempotent) → Task 9.
- §9 CLI/errors/edge (no config → []; summary line) → Task 10.
- §10 command def → Task 11.
- §11 testing (config moved, journal, mine units, real-git, dedup, CLI, integration) → Tasks 1-10.
- §12 acceptance: #1 backfill → Tasks 8/10; #2 component facet → Tasks 5/7/10; #3 idempotent → Tasks 9/10; #4 ndjson layout → Tasks 2-4; #5 config extract + suite green → Task 1; #6 zero-dep/zero-intrusion → all (only `.lore/journal/` written; no new deps); #7 deterministic testable → Tasks 1-10.
- §13 out of scope (changelog/pitfalls, flow/theme, hook/note, sync-fold, since-sha, enrich, merge commits) → not built (correct).

No gaps.

**2. Placeholder scan:** No TBD/TODO. Every code step has full code. Task 11 (command) + Task 12 (README) include complete content with explicit backtick-escaping notes. Task 1 is a refactor (move/edit) — its steps spell out the exact block to delete from sync.js and the exact tests to remove from sync.test.js.

**3. Type consistency:**
- `parseConfigCodeRoots(configText) -> string[]` — defined in config.js (Task 1), imported by sync.js (Task 1) and mine.js CLI (Task 10).
- `atomPath(journalDir, isoTs)`, `appendAtom(journalDir, atom)`, `readAllAtoms(journalDir)`, `existingIds(journalDir)` — defined Tasks 2-4, used by `mine` (Task 9) and the integration test (Task 10).
- `pathComponent(filePath, codeRoots) -> string|null` — Task 5, used by `commitAtom` (Task 7).
- `parseGitLog(stdout) -> {sha,ts,subject,body,files}[]` — Task 6, used by `mineCommits` (Task 8); the raw shape feeds `commitAtom(raw, codeRoots)` (Task 7) — field names (`sha`/`ts`/`subject`/`body`/`files`) match.
- `commitAtom` output `{id, ts, kind, commit, title, why, what_changed, facets:{component,flow,theme}, refs:{files,pitfall,related}, source, enriched, confidence}` — asserted in Task 7, consumed via `readAllAtoms` in Task 10.
- `mine({repoRoot, journalDir, codeRoots}) -> {scanned, added, skipped}` — Task 9 (def + test), Task 10 (CLI uses `r.added`/`r.skipped`/`r.scanned`).
- `GIT_FORMAT` = `'%x1e%H%x1f%aI%x1f%s%x1f%b%x1f'` (Task 8) matches the RS/US scheme `parseGitLog` splits on (Task 6).
- Reused `init({repoRoot, srcSiteDir})` (Task 10) — matches the real `lib/init.js` signature.

Fixed inline during review: none needed.

