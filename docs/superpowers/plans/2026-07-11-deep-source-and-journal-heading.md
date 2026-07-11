# Deep Source Resolution and Journal Heading Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve configured deep modules to real multi-language source files, validate nested deep roots, and materialize journals beneath supported Chinese decision-history headings.

**Architecture:** Add `lib/source.js` as the single owner of supported code extensions and exact deep-file resolution. Feed the same resolved-deep representation into planning and manifest stale scopes, while lint enforces invalid/missing/ambiguous configuration. Make journal folding accept explicit heading aliases and normalize managed sections to English.

**Tech Stack:** Node.js ESM, built-in filesystem/path APIs, `node:test`, Git CLI, PowerShell.

---

## File Map

- Create `lib/source.js`: `CODE_EXT` and exact deep source resolver.
- Create `test/source.test.js`: isolated resolver tests.
- Modify `lib/init.js` and `test/init.test.js`: share extension ownership without behavior drift.
- Modify `lib/sync.js` and `test/sync.test.js`: resolved worklist/stale scopes and heading aliases.
- Modify `lib/lint.js` and `test/lint.test.js`: deep-config diagnostics and token regression.
- Modify `commands/sync.md`: document heading compatibility and normalization.

### Task 1: Shared Deep Source Resolver

**Files:**
- Create: `lib/source.js`
- Create: `test/source.test.js`

- [ ] **Step 1: Write failing resolver tests**

Create `test/source.test.js` with this fixture and assertions:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODE_EXT, resolveDeepSource } from '../lib/source.js';

const repo = () => mkdtempSync(join(tmpdir(), 'lore-source-'));

test('CODE_EXT covers Python, JavaScript, and shell', () => {
  for (const ext of ['.py', '.js', '.sh']) assert.equal(CODE_EXT.has(ext), true);
});

test('resolveDeepSource resolves Python and nested roots with slash paths', () => {
  const root = repo();
  try {
    mkdirSync(join(root, 'mal_analyze', 'native_enrichment'), { recursive: true });
    writeFileSync(join(root, 'mal_analyze', 'cli.py'), '');
    writeFileSync(join(root, 'mal_analyze', 'native_enrichment', 'startup_paths.py'), '');
    assert.deepEqual(resolveDeepSource(root, 'mal_analyze', 'cli'),
      { status: 'ok', sourceFile: 'mal_analyze/cli.py' });
    assert.deepEqual(resolveDeepSource(root, 'mal_analyze/native_enrichment', 'startup_paths'),
      { status: 'ok', sourceFile: 'mal_analyze/native_enrichment/startup_paths.py' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveDeepSource reports missing and ambiguous sources', () => {
  const root = repo();
  try {
    mkdirSync(join(root, 'pkg'));
    assert.deepEqual(resolveDeepSource(root, 'pkg', 'absent'),
      { status: 'missing', candidates: [] });
    writeFileSync(join(root, 'pkg', 'entry.py'), '');
    writeFileSync(join(root, 'pkg', 'entry.js'), '');
    assert.deepEqual(resolveDeepSource(root, 'pkg', 'entry'), {
      status: 'ambiguous', candidates: ['pkg/entry.js', 'pkg/entry.py'],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Verify the test is red**

Run: `node --test test/source.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/source.js`.

- [ ] **Step 3: Implement the resolver**

Create `lib/source.js`:

```js
import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

export const CODE_EXT = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs',
  '.java', '.kt', '.rb', '.php', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.cs', '.swift', '.scala', '.sh',
]);

export function resolveDeepSource(repoRoot, deepRoot, mod) {
  let entries = [];
  try { entries = readdirSync(join(repoRoot, deepRoot), { withFileTypes: true }); }
  catch { return { status: 'missing', candidates: [] }; }
  const candidates = entries
    .filter(e => e.isFile() && CODE_EXT.has(extname(e.name)))
    .filter(e => e.name.slice(0, -extname(e.name).length) === mod)
    .map(e => join(deepRoot, e.name).replace(/\\/g, '/'))
    .sort();
  if (candidates.length === 1) return { status: 'ok', sourceFile: candidates[0] };
  if (candidates.length === 0) return { status: 'missing', candidates };
  return { status: 'ambiguous', candidates };
}
```

- [ ] **Step 4: Verify green and commit**

Run: `node --test test/source.test.js`

Expected: 3 tests pass.

```powershell
git add lib/source.js test/source.test.js
git commit -m "feat(source): resolve deep module files"
```

### Task 2: Share Extension Ownership with Init

**Files:**
- Modify: `lib/init.js`
- Modify: `test/init.test.js`

- [ ] **Step 1: Add a characterization test**

Append to `test/init.test.js`:

```js
test('discoverDeepModules uses shared Python, shell, and JavaScript extensions', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-deep-mixed-'));
  try {
    mkdirSync(join(root, 'pkg'));
    writeFileSync(join(root, 'pkg', 'cli.py'), '');
    writeFileSync(join(root, 'pkg', 'deploy.sh'), '');
    writeFileSync(join(root, 'pkg', 'worker.js'), '');
    assert.deepEqual(discoverDeepModules(join(root, 'pkg')), ['cli', 'deploy', 'worker']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run before refactoring**

Run: `node --test test/init.test.js`

Expected: PASS; this locks current behavior.

- [ ] **Step 3: Move ownership**

In `lib/init.js`, import `CODE_EXT` from `./source.js` and delete the local `CODE_EXT` declaration. Do not change `dirHasCode` or `discoverDeepModules`.

- [ ] **Step 4: Verify and commit**

Run: `node --test test/source.test.js test/init.test.js`

Expected: all pass.

```powershell
git add lib/init.js test/init.test.js
git commit -m "refactor(init): share source extensions"
```

### Task 3: Resolve Deep Worklist Entries

**Files:**
- Modify: `lib/sync.js`
- Modify: `test/sync.test.js`

- [ ] **Step 1: Add a Python/nested repository fixture**

Near `fzRepoDeep` in `test/sync.test.js`, add `fzRepoDeepPython()` that creates and commits:

```text
mal_analyze/cli.py
mal_analyze/native_enrichment/startup_paths.py
.lore/config.yml
```

Use this exact config:

```yaml
axes:
  component:
    code_roots: [mal_analyze]
    deep:
      mal_analyze: [cli]
      mal_analyze/native_enrichment: [startup_paths]
```

Return `{ root, loreDir, git }` using the same `mkN/jN/wfN/exN2` helpers as `fzRepoDeep`.

- [ ] **Step 2: Add failing worklist tests**

```js
test('planSync resolves Python and nested deep worklist metadata', () => {
  const r = fzRepoDeepPython();
  try {
    const plan = pl(r.loreDir, { all: true });
    const cli = plan.worklist.find(w => w.kind === 'deep' && w.id === 'cli');
    const startup = plan.worklist.find(w => w.kind === 'deep' && w.id === 'startup_paths');
    assert.deepEqual([cli.codeRoot, cli.sourceFile], ['mal_analyze', 'mal_analyze/cli.py']);
    assert.deepEqual([startup.codeRoot, startup.sourceFile], [
      'mal_analyze/native_enrichment',
      'mal_analyze/native_enrichment/startup_paths.py',
    ]);
    assert.deepEqual(plan.configIssues, []);
  } finally { rmN(r.root, { recursive: true, force: true }); }
});

test('planSync skips unresolved deep entries and reports configIssues', () => {
  const r = fzRepoDeepPython();
  try {
    wfN(jN(r.loreDir, 'config.yml'),
      'axes:\n  component:\n    code_roots: [mal_analyze]\n    deep:\n      mal_analyze: [absent]\n');
    const plan = pl(r.loreDir, { all: true });
    assert.equal(plan.worklist.some(w => w.kind === 'deep'), false);
    assert.deepEqual(plan.configIssues, [{
      kind: 'deep-source-missing', deepRoot: 'mal_analyze', mod: 'absent',
      expectedBase: 'mal_analyze/absent',
    }]);
  } finally { rmN(r.root, { recursive: true, force: true }); }
});
```

Also test ambiguity by adding `mal_analyze/cli.js`; expect no `cli` work item and a `deep-source-ambiguous` issue with both candidates.

- [ ] **Step 3: Verify red**

Run: `node --test --test-name-pattern="resolves Python|unresolved deep|ambiguous" test/sync.test.js`

Expected: FAIL on `.js`, missing `codeRoot`, and missing `configIssues`.

- [ ] **Step 4: Add one configured-deep resolver**

Import `resolveDeepSource` in `lib/sync.js`, then add:

```js
function validDeepRoot(deepRoot, codeRoots) {
  return codeRoots.some(cr => deepRoot === cr || deepRoot.startsWith(`${cr}/`));
}

export function resolveConfiguredDeep(repoRoot, codeRoots, deep) {
  const entries = [], issues = [];
  for (const [deepRoot, { order }] of Object.entries(deep)) {
    if (!validDeepRoot(deepRoot, codeRoots)) {
      issues.push({ kind: 'deep-root-invalid', deepRoot });
      continue;
    }
    for (const mod of order) {
      const result = resolveDeepSource(repoRoot, deepRoot, mod);
      if (result.status === 'ok') entries.push({ deepRoot, mod, sourceFile: result.sourceFile });
      else if (result.status === 'missing') issues.push({
        kind: 'deep-source-missing', deepRoot, mod, expectedBase: `${deepRoot}/${mod}`,
      });
      else issues.push({
        kind: 'deep-source-ambiguous', deepRoot, mod, candidates: result.candidates,
      });
    }
  }
  return { entries, issues };
}
```

In `planSync`, resolve once and loop over `{ deepRoot, mod, sourceFile }`. Use `sourceFile` for `countSince`; add `codeRoot: deepRoot` and `sourceFile` to the work item; return `configIssues: resolvedDeep.issues`.

- [ ] **Step 5: Verify and commit**

Run: `node --test --test-name-pattern="planSync" test/sync.test.js`

Expected: all plan tests pass. Extend the existing JS assertion to require `codeRoot === 'lib'`.

```powershell
git add lib/sync.js test/sync.test.js
git commit -m "fix(sync): resolve deep source paths"
```

### Task 4: Apply Resolved Files to Both Staleness Paths

**Files:**
- Modify: `lib/sync.js`
- Modify: `test/sync.test.js`

- [ ] **Step 1: Add precise Python incremental tests**

Using `fzRepoDeepPython`, create `cli.md` and `startup_paths.md`, finalize, and assert no deep work. Commit a change only to `mal_analyze/cli.py`; assert only `cli` returns with `reason: 'code-changed'` and `sourceFile: 'mal_analyze/cli.py'`.

- [ ] **Step 2: Add a manifest integration test**

Seed/finalize `cli.md`, commit a change to `startup_paths.py`, finalize, and assert manifest `cli.stale === 0`. Then commit a change to `cli.py`, finalize without changing prose, and assert manifest `cli.stale === 1`.

- [ ] **Step 3: Verify the staleScopes test is red**

Run: `node --test --test-name-pattern="Python source only|Python manifest stale" test/sync.test.js`

Expected: planning test passes after Task 3; manifest test FAILS because finalize still uses `.js`.

- [ ] **Step 4: Replace finalize's hard-coded staleScopes loop**

Use:

```js
const resolvedDeep = resolveConfiguredDeep(repoRoot, codeRoots, deep);
for (const { mod, sourceFile } of resolvedDeep.entries) {
  staleScopes[`component/${mod}.md`] = [sourceFile];
}
```

Do not add guessed scopes for unresolved entries.

- [ ] **Step 5: Verify and commit**

Run: `node --test test/sync.test.js`

Expected: all pass.

```powershell
git add lib/sync.js test/sync.test.js
git commit -m "fix(sync): scope deep stale to real files"
```

### Task 5: Add Deep Configuration Lint

**Files:**
- Modify: `lib/lint.js`
- Modify: `test/lint.test.js`

- [ ] **Step 1: Add failing validation tests**

Import `lintDeepConfig` and add tests with these exact expectations:

```js
assert.deepEqual(lintDeepConfig(root, ['mal_analyze'], {
  mal_analyze: { order: ['cli'], groups: [] },
  'mal_analyze/native_enrichment': { order: ['startup_paths'], groups: [] },
}), []);

assert.deepEqual(lintDeepConfig(root, ['mal_analyze'], {
  native_enrichment: { order: ['startup_paths'], groups: [] },
  'mal_analyze_extra/sub': { order: ['x'], groups: [] },
}), [
  { kind: 'invalid-root', deepRoot: 'native_enrichment',
    message: 'deep root must equal a code_root or be its child' },
  { kind: 'invalid-root', deepRoot: 'mal_analyze_extra/sub',
    message: 'deep root must equal a code_root or be its child' },
]);
```

Create files `pkg/entry.py` and `pkg/entry.js`, then assert `missing-source` for `pkg/absent` and `ambiguous-source` for `pkg/entry`, including sorted candidates.

Assert an invalid deep root does not legitimize its module:

```js
const deep = { native_enrichment: { order: ['startup_paths'], groups: [] } };
assert.deepEqual(lintOrphans(['startup_paths'], ['mal_analyze'], deep), ['startup_paths']);
```

- [ ] **Step 2: Add lint orchestration/CLI test**

Create a git fixture with `code_roots: [mal_analyze]` and invalid `deep.native_enrichment`. Assert `result.deepConfig[0].kind === 'invalid-root'`, `result.clean === false`, and CLI output contains `deep-config (1)`.

- [ ] **Step 3: Verify red**

Run: `node --test --test-name-pattern="lintDeepConfig|invalid deep roots|deepConfig" test/lint.test.js`

Expected: FAIL because the API/result field does not exist.

- [ ] **Step 4: Implement diagnostics**

Import `resolveDeepSource` and add:

```js
function validDeepRoot(deepRoot, codeRoots) {
  return codeRoots.some(cr => deepRoot === cr || deepRoot.startsWith(`${cr}/`));
}

export function lintDeepConfig(repoRoot, codeRoots, deep = {}) {
  const out = [];
  for (const [deepRoot, { order }] of Object.entries(deep)) {
    if (!validDeepRoot(deepRoot, codeRoots)) {
      out.push({ kind: 'invalid-root', deepRoot,
        message: 'deep root must equal a code_root or be its child' });
      continue;
    }
    for (const mod of order ?? []) {
      const r = resolveDeepSource(repoRoot, deepRoot, mod);
      if (r.status === 'missing') out.push({ kind: 'missing-source', deepRoot, mod,
        message: `no supported source file found for ${deepRoot}/${mod}` });
      if (r.status === 'ambiguous') out.push({ kind: 'ambiguous-source', deepRoot, mod,
        candidates: r.candidates,
        message: `multiple supported source files found for ${deepRoot}/${mod}` });
    }
  }
  return out;
}
```

Change `legalIds` to iterate entries and add modules only when `validDeepRoot` is true. In `lint()`, define `repoRoot` outside the Git try, calculate `deepConfig`, add it to the return object, and require `deepConfig.length === 0` for `clean`. Print:

```js
if (r.deepConfig.length) console.log(`deep-config (${r.deepConfig.length}): ` +
  r.deepConfig.map(i => `${i.deepRoot}${i.mod ? `/${i.mod}` : ''} — ${i.message}`).join('; '));
```

Update existing full-result assertions with `deepConfig: []`.

- [ ] **Step 5: Verify and commit**

Run: `node --test test/lint.test.js test/source.test.js test/init.test.js test/sync.test.js`

Expected: all pass.

```powershell
git add lib/lint.js test/lint.test.js
git commit -m "fix(lint): validate deep source config"
```

### Task 6: Fold and Normalize Chinese Decision Headings

**Files:**
- Modify: `lib/sync.js`
- Modify: `test/sync.test.js`
- Modify: `test/lint.test.js`
- Modify: `commands/sync.md`

- [ ] **Step 1: Add alias folding tests**

```js
for (const heading of ['## 决策史', '## 决策历史', '## 决策历史 (Decision history)']) {
  test(`foldJournal materializes localized heading: ${heading}`, () => {
    const input = `# C\n\n${heading}\n\n{{LORE_JOURNAL}}\n\n## Cross-links\n\n- [[x]]\n`;
    const once = foldJournal(input, '- **fresh** (2026-07-11)', { warn() {} });
    assert.match(once, /^## Decision history$/m);
    assert.doesNotMatch(once, /^## 决策/m);
    assert.doesNotMatch(once, /\{\{LORE_JOURNAL\}\}/);
    assert.equal((once.match(/LORE_JOURNAL:START/g) ?? []).length, 1);
    assert.match(once, /## Cross-links\n\n- \[\[x\]\]/);
    assert.equal(foldJournal(once, '- **fresh** (2026-07-11)', { warn() {} }), once);
  });
}
```

- [ ] **Step 2: Prove lint is already heading-independent**

Add a finalized component page with `code_sha`, `## 决策历史`, and the literal token. Assert `lintUnfolded(...)` returns `['component/lib.md']`.

- [ ] **Step 3: Verify the folding tests are red and lint test is green**

Run: `node --test --test-name-pattern="localized heading|heading-independent" test/sync.test.js test/lint.test.js`

Expected: three sync tests FAIL unchanged; lint test PASS.

- [ ] **Step 4: Implement explicit aliases**

In `lib/sync.js` add:

```js
const DH_HEADING_RE = /^## (?:Decision history|决策史|决策历史(?: \(Decision history\))?)[^\n]*\n/m;
```

Use `DH_HEADING_RE.exec(text)` in `foldJournal`. Keep `DH_HEADING = '## Decision history'` in block construction so managed sections normalize to English.

- [ ] **Step 5: Document and verify**

Add to `commands/sync.md`:

```markdown
- 决策史规范标题是 `## Decision history`；finalize 兼容历史页的 `## 决策史` / `## 决策历史` / `## 决策历史 (Decision history)`，物化时自动归一为英文标题。
```

Run: `node --test test/sync.test.js test/lint.test.js`

Expected: all pass, including existing no-heading, hand-managed, and idempotence tests.

- [ ] **Step 6: Commit**

```powershell
git add lib/sync.js test/sync.test.js test/lint.test.js commands/sync.md
git commit -m "fix(sync): fold localized decision headings"
```

### Task 7: Full Engine Verification

**Files:** No changes expected.

- [ ] **Step 1: Run focused tests**

Run: `node --test test/source.test.js test/init.test.js test/sync.test.js test/lint.test.js`

Expected: 0 failures.

- [ ] **Step 2: Run the complete suite**

Run: `node --test test/*.test.js`

Expected: 0 failures. Preserve and report any unrelated pre-existing flaky failure; do not weaken assertions.

- [ ] **Step 3: Check scope and whitespace**

```powershell
git diff c38d494..HEAD --check
git diff c38d494..HEAD --stat
git status --short
```

Expected: only planned files changed; existing `.clinerules/`, `.codex/`, and `AGENTS.md` remain untouched.

### Task 8: mal-analyze-cli Regression Without Persistent Edits

**Files:** No persistent mal-analyze-cli changes.

- [ ] **Step 1: Capture its starting status**

Run: `git -C D:\workspace\mal-analyze-cli status --short`

Save the output for comparison.

- [ ] **Step 2: Verify representative real paths**

```powershell
$plan = node D:\workspace\lore\lib\sync.js plan D:\workspace\mal-analyze-cli\.lore --all | ConvertFrom-Json
$plan.worklist | Where-Object { $_.kind -eq 'deep' -and $_.id -in @('cli','worker','deploy') } |
  Select-Object id, codeRoot, sourceFile
```

Expected:

```text
cli     mal_analyze mal_analyze/cli.py
worker  server      server/worker.py
deploy  scripts     scripts/deploy.sh
```

- [ ] **Step 3: Verify a nested deep root in a temporary sibling lore directory**

Create `D:\workspace\mal-analyze-cli\.lore-regression`, copy the real `config.yml`, create empty `wiki/component` and `.state`, and add only to the temporary config:

```yaml
mal_analyze/native_enrichment: [startup_paths]
```

Run plan against `.lore-regression --all`. Expected:

```text
codeRoot: mal_analyze/native_enrichment
sourceFile: mal_analyze/native_enrichment/startup_paths.py
```

- [ ] **Step 4: Clean the temporary directory safely**

```powershell
$target = (Resolve-Path -LiteralPath D:\workspace\mal-analyze-cli\.lore-regression).Path
if ($target -ne 'D:\workspace\mal-analyze-cli\.lore-regression') { throw "unexpected cleanup path: $target" }
Remove-Item -LiteralPath $target -Recurse -Force
```

- [ ] **Step 5: Run real lint and compare status**

```powershell
node D:\workspace\lore\lib\lint.js D:\workspace\mal-analyze-cli\.lore
git -C D:\workspace\mal-analyze-cli status --short
```

Expected: no `unfolded` and no `deep-config` findings; final Git status equals the captured starting status. Report unrelated lint findings separately.

### Task 9: Final Evidence and Handoff

**Files:** No changes expected.

- [ ] **Step 1: Confirm requirement coverage**

Confirm from test output and plan JSON:

- `.py`, `.sh`, and `.js` resolve.
- Nested roots carry complete `codeRoot` and exact `sourceFile`.
- Plan and manifest use the same file.
- Invalid/missing/ambiguous deep config makes lint unclean.
- Chinese aliases materialize and normalize.
- Finalized literal tokens remain detectable independent of heading language.

- [ ] **Step 2: Run final repository checks**

Run: `git status --short` and `git log -6 --oneline`.

Expected: implementation commits are present and no planned work is uncommitted.

- [ ] **Step 3: Report evidence**

Report focused/full test totals, representative resolved paths, nested regression result, real lint result, and any unrelated findings kept out of scope.
