---
title: sync folds journal Implementation Plan
summary: > **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [...
source_path: docs/superpowers/plans/2026-06-02-lore-sync-journal-fold.md
last_updated: 2026-06-02
group: 设计与计划
---
> 源文档：`docs/superpowers/plans/2026-06-02-lore-sync-journal-fold.md`

# sync folds journal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/lore:sync`'s `finalizeSync` fold journal atoms into each component page's "Decision history" section — mechanically rendered (ts-desc bullets), injected via a `{{LORE_JOURNAL}}` token, with per-page real `atoms`/`commits` counts.

**Architecture:** Add a pure `renderDecisionHistory(atoms)` to `lib/sync.js`. `finalizeSync` reads `.lore/journal/` once (via the existing `lib/journal.js` `readAllAtoms`), and per component page filters atoms by `facets.component`, renders the section, replaces the agent-written `{{LORE_JOURNAL}}` token (function-form `.replace` to avoid `$`-pattern corruption), and stamps real counts. INDEX gets grand totals. Fully deterministic, no LLM.

**Tech Stack:** Node.js (ESM, `type: module`), `node:test`, zero external deps. Reuses `lib/journal.js` (`readAllAtoms`, `appendAtom`) + `lib/manifest.js` + `lib/init.js` + `lib/mine.js` (all already on this branch).

**Spec:** `docs/superpowers/specs/2026-06-02-lore-sync-journal-fold-design.md`. **Parent:** `docs/superpowers/specs/2026-05-31-lore-repo-wiki-design.md` §5.

**Branch:** `lore-sync-fold` (already created off `main`, which has init/serve/sync/mine merged).

**Current `finalizeSync` (the thing Task 2 rewrites), `lib/sync.js:54-87`:**
```js
export function finalizeSync(loreDir, now) {
  const repoRoot = join(resolve(loreDir), '..');
  const wikiDir = join(loreDir, 'wiki');
  const compDir = join(wikiDir, 'component');
  const codeSha = headShortSha(repoRoot);
  const lastUpdated = now.slice(0, 10);
  const fields = { codeSha, lastUpdated, commits: 0, atoms: 0 };

  let files = [];
  try {
    files = readdirSync(compDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => e.name)
      .sort();
  } catch { files = []; }

  const stamped = [];
  const pages = [];
  for (const f of files) {
    const p = join(compDir, f);
    const text = stampFrontmatter(readFileSync(p, 'utf8'), fields);
    writeFileSync(p, text);
    const { data } = parseFrontmatter(text);
    const id = basename(f, '.md');
    stamped.push(`component/${f}`);
    pages.push({ id, title: data.title ?? id });
  }

  if (!existsSync(wikiDir)) mkdirSync(wikiDir, { recursive: true });
  writeFileSync(join(wikiDir, 'INDEX.md'), stampFrontmatter(buildIndex(pages), fields));

  const manifestPath = runManifestCli(loreDir, now);
  return { stamped, indexWritten: true, manifestPath };
}
```

---

## File Structure

```
lib/sync.js            # MODIFY — add renderDecisionHistory; rewrite finalizeSync (journal fold + token + per-page counts); + readAllAtoms import
commands/lore-sync.md  # MODIFY — page template uses {{LORE_JOURNAL}}; tips updated
test/sync.test.js      # MODIFY — renderDecisionHistory unit + finalize-fold + backward-compat + integration
README.md              # MODIFY — sync section notes journal folding
```

**Locked contract:** `renderDecisionHistory(atoms) -> string` — empty → `暂无 journal 原子（跑 /lore:mine 补全）。`; else ts-desc bullets `- **<title>** — <why first line> (<short-sha>, <YYYY-MM-DD>)` (omit `— <why>` when why empty). Does not mutate input.

---

## Task 1: renderDecisionHistory

**Files:**
- Modify: `lib/sync.js` (add `renderDecisionHistory`)
- Test: `test/sync.test.js` (append)

- [ ] **Step 1: Write the failing test** — append to `test/sync.test.js`:

```js
import { renderDecisionHistory } from '../lib/sync.js';

test('renderDecisionHistory: empty → placeholder', () => {
  assert.equal(renderDecisionHistory([]), '暂无 journal 原子（跑 /lore:mine 补全）。');
});

test('renderDecisionHistory: atom with why → bullet with why, short sha, date', () => {
  const out = renderDecisionHistory([
    { title: 'fix crawler', why: 'anti data blowup\nsecond line', commit: 'abc1234567', ts: '2026-06-01T08:00:00Z', kind: 'commit' },
  ]);
  assert.equal(out, '- **fix crawler** — anti data blowup (abc1234, 2026-06-01)');
});

test('renderDecisionHistory: atom without why → no why segment', () => {
  const out = renderDecisionHistory([
    { title: 'add site', why: '', commit: 'def4567890', ts: '2026-05-30T10:00:00Z', kind: 'commit' },
  ]);
  assert.equal(out, '- **add site** (def4567, 2026-05-30)');
});

test('renderDecisionHistory: multiple atoms sorted ts-desc; input not mutated', () => {
  const atoms = [
    { title: 'older', why: '', commit: 'aaaaaaa0', ts: '2026-05-01T00:00:00Z', kind: 'commit' },
    { title: 'newer', why: '', commit: 'bbbbbbb0', ts: '2026-06-01T00:00:00Z', kind: 'commit' },
  ];
  const out = renderDecisionHistory(atoms);
  assert.match(out, /newer[\s\S]*older/);   // newer first
  assert.equal(atoms[0].title, 'older');     // input order unchanged
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sync.test.js`
Expected: FAIL — `renderDecisionHistory` not exported.

- [ ] **Step 3: Write minimal implementation** — add to `lib/sync.js` (place it just above `finalizeSync`, after `headShortSha`):

```js
export function renderDecisionHistory(atoms) {
  if (atoms.length === 0) return '暂无 journal 原子（跑 /lore:mine 补全）。';
  const sorted = [...atoms].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return sorted.map(a => {
    const sha = (a.commit ?? '').slice(0, 7);
    const date = (a.ts ?? '').slice(0, 10);
    const why = (a.why ?? '').split('\n')[0].trim();
    const meta = `(${sha}, ${date})`;
    return why ? `- **${a.title}** — ${why} ${meta}` : `- **${a.title}** ${meta}`;
  }).join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sync.test.js`
Expected: PASS — the 4 new tests plus all existing sync.test.js tests.

- [ ] **Step 5: Commit**

```bash
git add lib/sync.js test/sync.test.js
git commit -m "feat(sync): renderDecisionHistory (mechanical ts-desc atom bullets)"
```

---

## Task 2: finalizeSync folds journal

**Files:**
- Modify: `lib/sync.js` (rewrite `finalizeSync`, add `readAllAtoms` import)
- Test: `test/sync.test.js` (append fold + backward-compat tests)

- [ ] **Step 1: Write the failing tests** — append to `test/sync.test.js`:

```js
import { appendAtom } from '../lib/journal.js';

// agent page whose Decision history section is the injection token (new command format)
function tokenPage(title, summary) {
  return `---\ntitle: ${title}\nsummary: ${summary}\n---\n# component: ${title}\n\n` +
    `## Current architecture\n\narch prose\n\n## Decision history\n\n{{LORE_JOURNAL}}\n\n` +
    `## Cross-links\n\n- [[other]]\n`;
}

test('finalizeSync folds journal atoms into the {{LORE_JOURNAL}} token + stamps per-page counts', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    const compDir = join(lore, 'wiki', 'component');
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, 'lib.md'), tokenPage('Lib', 'core'));
    writeFileSync(join(compDir, 'other.md'), tokenPage('Other', 'x'));   // no matching atoms

    const journalDir = join(lore, 'journal');
    appendAtom(journalDir, { id: 'commit:a', ts: '2026-06-01T08:00:00Z', kind: 'commit', commit: 'aaaaaaa0', title: 'newer fix', why: 'because', facets: { component: ['lib'] } });
    appendAtom(journalDir, { id: 'commit:b', ts: '2026-05-01T08:00:00Z', kind: 'commit', commit: 'bbbbbbb0', title: 'older fix', why: '', facets: { component: ['lib'] } });

    finalizeSync(lore, '2026-06-02T00:00:00Z');

    const libPage = readFileSync(join(compDir, 'lib.md'), 'utf8');
    assert.doesNotMatch(libPage, /\{\{LORE_JOURNAL\}\}/);                       // token replaced
    assert.match(libPage, /- \*\*newer fix\*\* — because \(aaaaaaa, 2026-06-01\)/);
    assert.match(libPage, /- \*\*older fix\*\* \(bbbbbbb, 2026-05-01\)/);
    assert.match(libPage, /newer fix[\s\S]*older fix/);                          // ts desc
    assert.match(libPage, /atoms: 2/);
    assert.match(libPage, /commits: 2/);

    const otherPage = readFileSync(join(compDir, 'other.md'), 'utf8');
    assert.match(otherPage, /暂无 journal 原子/);
    assert.match(otherPage, /atoms: 0/);

    const index = readFileSync(join(lore, 'wiki', 'INDEX.md'), 'utf8');
    assert.match(index, /atoms: 2/);                                            // grand totals
    assert.match(index, /commits: 2/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('finalizeSync backward-compat: page without token does not crash, still stamps counts', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    const compDir = join(lore, 'wiki', 'component');
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, 'lib.md'), agentPage('Lib', 'core'));   // old format, no token
    const journalDir = join(lore, 'journal');
    appendAtom(journalDir, { id: 'commit:a', ts: '2026-06-01T08:00:00Z', kind: 'commit', commit: 'aaaaaaa0', title: 't', why: '', facets: { component: ['lib'] } });

    finalizeSync(lore, '2026-06-02T00:00:00Z');
    const libPage = readFileSync(join(compDir, 'lib.md'), 'utf8');
    assert.match(libPage, /暂无 journal 原子/);   // agent's own placeholder untouched (no token)
    assert.match(libPage, /atoms: 1/);            // counts still stamped from journal
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

(`gitRepo` and `agentPage` already exist in `test/sync.test.js` from prior sync tasks — reuse them, do not redefine.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sync.test.js`
Expected: FAIL — current `finalizeSync` ignores journal: it leaves `{{LORE_JOURNAL}}` literally in the page and stamps `atoms: 0`, so the fold assertions fail.

- [ ] **Step 3: Rewrite `finalizeSync`** in `lib/sync.js`.

First add the import (merge into the existing imports near the top — there is no `./journal.js` import yet):

```js
import { readAllAtoms } from './journal.js';
```

Then REPLACE the entire existing `finalizeSync` function (shown in the plan header) with:

```js
export function finalizeSync(loreDir, now) {
  const repoRoot = join(resolve(loreDir), '..');
  const wikiDir = join(loreDir, 'wiki');
  const compDir = join(wikiDir, 'component');
  const codeSha = headShortSha(repoRoot);
  const lastUpdated = now.slice(0, 10);

  const allAtoms = readAllAtoms(join(loreDir, 'journal'));

  let files = [];
  try {
    files = readdirSync(compDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => e.name)
      .sort();
  } catch { files = []; }

  const stamped = [];
  const pages = [];
  for (const f of files) {
    const p = join(compDir, f);
    const component = basename(f, '.md');
    const atomsFor = allAtoms.filter(a => a.facets?.component?.includes(component));
    const md = renderDecisionHistory(atomsFor);
    let text = readFileSync(p, 'utf8').replace('{{LORE_JOURNAL}}', () => md);
    text = stampFrontmatter(text, {
      codeSha,
      lastUpdated,
      atoms: atomsFor.length,
      commits: atomsFor.filter(a => a.kind === 'commit').length,
    });
    writeFileSync(p, text);
    const { data } = parseFrontmatter(text);
    stamped.push(`component/${f}`);
    pages.push({ id: component, title: data.title ?? component });
  }

  if (!existsSync(wikiDir)) mkdirSync(wikiDir, { recursive: true });
  const indexFields = {
    codeSha,
    lastUpdated,
    atoms: allAtoms.length,
    commits: allAtoms.filter(a => a.kind === 'commit').length,
  };
  writeFileSync(join(wikiDir, 'INDEX.md'), stampFrontmatter(buildIndex(pages), indexFields));

  const manifestPath = runManifestCli(loreDir, now);
  return { stamped, indexWritten: true, manifestPath };
}
```

Key points: `.replace('{{LORE_JOURNAL}}', () => md)` uses the **function form** so a `$` in `md` (from a commit message) is inserted literally, not interpreted as a `$&`/`$1` pattern. A page without the token is unchanged by `replace` (backward-compat). Counts are computed per page; INDEX uses grand totals.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/sync.test.js`
Expected: PASS — the 2 new tests plus all existing sync.test.js tests (the existing `finalizeSync` test uses fixtures with no `journal/` dir → `readAllAtoms` returns `[]` → `atoms: 0`, and its `agentPage` has no token → unchanged, so it still passes).

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS — every file green (no regression in init/serve/manifest/mine/journal).

- [ ] **Step 6: Commit**

```bash
git add lib/sync.js test/sync.test.js
git commit -m "feat(sync): finalizeSync folds journal atoms into decision-history (token + per-page counts)"
```

---

## Task 3: update /lore:sync command

**Files:**
- Modify: `commands/lore-sync.md`

- [ ] **Step 1: Three edits to `commands/lore-sync.md`** (read it first to locate exact lines).

Edit 1 — the intro line (currently): `本版只产 component 页（flow/theme/journal 折叠推迟）。` → replace with:
```
本版只产 component 页（flow/theme 推迟）。
```

Edit 2 — the page template's Decision history section (currently):
```
   ## Decision history

   暂无 journal 原子（跑 /lore:mine 或 /lore:note 后再 sync 补全）。
```
→ replace with:
```
   ## Decision history

   {{LORE_JOURNAL}}
```

Edit 3 — the agent-tip bullet (currently): `- 「决策历史」段本版填占位（journal 未接）。` → replace with:
```
- 「决策历史」段写占位符 `{{LORE_JOURNAL}}` —— finalize 自动用 journal 原子机械填充（按 component facet 过滤、ts 倒序）。先跑 `/lore:mine` 让 journal 有料。
```

- [ ] **Step 2: Sanity check**

Run: `node -e "const s=require('fs').readFileSync('commands/lore-sync.md','utf8'); if(!s.includes('{{LORE_JOURNAL}}')||s.includes('journal 折叠推迟')) process.exit(1); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add commands/lore-sync.md
git commit -m "docs(command): /lore:sync writes {{LORE_JOURNAL}} token (finalize folds journal)"
```

---

## Task 4: integration — mine → sync folds atom into page

**Files:**
- Modify: `test/sync.test.js` (append integration test)

- [ ] **Step 1: Write the test** — append to `test/sync.test.js`:

```js
test('integration: init → mine → sync folds commit atom into component page', () => {
  const root = gitRepo();   // has an initial commit (f.txt)
  try {
    // a commit touching lib/ so mine tags it component:[lib]
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'a.js'), 'export const x = 1;');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'add lib feature'], { cwd: root });

    init({ repoRoot: root, srcSiteDir: join(process.cwd(), 'site') });   // config code_roots: [lib]
    const lore = join(root, '.lore');
    const compDir = join(lore, 'wiki', 'component');
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, 'lib.md'), tokenPage('Lib', 'core'));   // agent page with the token

    execFileSync('node', ['lib/mine.js', root], { cwd: process.cwd() });             // populate journal
    execFileSync('node', ['lib/sync.js', 'finalize', lore], { cwd: process.cwd() }); // fold + manifest

    const libPage = readFileSync(join(compDir, 'lib.md'), 'utf8');
    assert.match(libPage, /add lib feature/);            // commit atom title now in decision history
    assert.doesNotMatch(libPage, /\{\{LORE_JOURNAL\}\}/);
    assert.match(libPage, /atoms: 1/);                   // only the lib-touching commit matches

    const manifest = JSON.parse(readFileSync(join(lore, 'wiki', '.manifest.json'), 'utf8'));
    const libEntry = manifest.axes.find(a => a.id === 'component').pages.find(p => p.id === 'lib');
    assert.equal(libEntry.synthesized_from.atoms, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

(Reuses `gitRepo`, `tokenPage` (Task 2), `init` import. `init`/`mine`/`sync` all exist on this branch.)

- [ ] **Step 2: Run the test**

Run: `node --test test/sync.test.js`
Expected: PASS — `init` writes config `[lib]`, `mine` writes 2 commit atoms (the `f.txt` init commit → no component; the `lib/a.js` commit → component `lib`), `sync finalize` folds the 1 lib atom into `lib.md` and stamps `atoms: 1`. If it fails, investigate the real wiring (don't weaken assertions).

- [ ] **Step 3: Run the full suite**

Run: `node --test`
Expected: PASS — all green.

- [ ] **Step 4: Commit**

```bash
git add test/sync.test.js
git commit -m "test(sync): integration mine → sync folds commit atom into component page"
```

---

## Task 5: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the `/lore:sync` section.** In the `## /lore:sync（已实现）` section, the second paragraph ends with the O1 two-phase description. Append this sentence to that paragraph (read the section first to place it correctly):

```
「决策历史」段现由 finalize 机械折叠 `.lore/journal/` 原子（按 component facet 过滤、ts 倒序）填充 —— 先跑 `/lore:mine` 让 journal 有料。
```

- [ ] **Step 2: Sanity check**

Run: `node -e "const s=require('fs').readFileSync('README.md','utf8'); if(!s.includes('决策历史') || !s.includes('折叠')) process.exit(1); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README notes sync folds journal into decision-history"
```

---

## Self-Review

**1. Spec coverage** (spec §-by-§ → task):
- §1 scope (finalize folds journal, renderDecisionHistory, command, tests, README) → Tasks 1-5.
- §2 architecture (sync.js + command + tests + README; reuse readAllAtoms) → Tasks 1-5.
- §3 `renderDecisionHistory` contract (empty→placeholder; ts-desc; why-optional; no mutation) → Task 1.
- §4 finalizeSync (read allAtoms; per-page filter+render+inject+per-page counts) → Task 2.
- §5 token injection (function-form `.replace`; no-token→no-op) → Task 2 (impl + backward-compat test).
- §6 INDEX grand totals → Task 2 (`indexFields`).
- §7 command change (token in template, tips, drop "journal 折叠推迟") → Task 3.
- §8 errors/edge (no journal→[]; no-match→placeholder; no-token→counts only; optional chaining on facets) → Task 2 (impl + tests).
- §9 testing (renderDecisionHistory; finalize-with-journal; backward-compat; integration) → Tasks 1, 2, 4.
- §10 acceptance: #1 token replaced with filtered/sorted atoms → Tasks 2/4; #2 counts + manifest → Tasks 2/4; #3 graceful empty → Task 2 (other.md); #4 deterministic node:test → Tasks 1-2; #5 end-to-end mine→sync → Task 4; #6 backward-compat → Task 2.
- §11 out of scope (LLM connective/grouping, flow/theme, note/incident specialization, incremental) → not built (correct).

No gaps.

**2. Placeholder scan:** No TBD/TODO. Every code step has full code. Task 3 (command) + Task 5 (README) give exact find/replace strings. Task 2 shows both the full old function (plan header) and the full new function.

**3. Type consistency:**
- `renderDecisionHistory(atoms) -> string` — defined Task 1, called in `finalizeSync` (Task 2). Atom fields used (`ts`, `commit`, `why`, `title`, `kind`, `facets.component`) match the journal atom schema produced by `lib/mine.js` `commitAtom` (id/ts/kind/commit/title/why/facets…).
- `finalizeSync(loreDir, now) -> {stamped, indexWritten, manifestPath}` — return shape unchanged (existing CLI + tests rely on it).
- `stampFrontmatter(pageText, {codeSha, lastUpdated, commits, atoms})` — already exists; Task 2 passes per-page `atoms`/`commits` (the param names match).
- `readAllAtoms(journalDir) -> atom[]` — from `lib/journal.js` (already on branch); returns `[]` when dir missing (so no-journal case is graceful).
- `appendAtom(journalDir, atom)` — from `lib/journal.js`, used in Task 2 tests to seed the journal.
- `tokenPage` (Task 2) reused by Task 4. `gitRepo`/`agentPage` reused from existing sync tests (not redefined).

Fixed inline during review: none needed.

