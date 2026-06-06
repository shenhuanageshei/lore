---
title: theme axis Implementation Plan
summary: > **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.
source_path: docs/superpowers/plans/2026-06-03-lore-theme.md
last_updated: 2026-06-03
---
> 源文档：`docs/superpowers/plans/2026-06-03-lore-theme.md`

# theme axis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** A second wiki axis — `theme` — where commit atoms are auto-tagged by config `match:` keywords (case-insensitive substring), and sync produces `theme/<id>.md` pages folding theme-tagged atoms, generalizing finalize/buildIndex from component-only to multi-axis.

**Architecture:** `parseConfigThemes` (config.js) reads theme id+keywords. `tagThemes` (mine.js, pure) tags text. `commitAtom` gains a `themes` param → `facets.theme`. `mineCommits`/`captureHead` read config themes. sync's `planSync`/`finalizeSync`/`buildIndex` generalize over axes `['component','theme']` (filter atoms by `facets[axis]`). Deterministic; agent writes theme-page narrative.

**Tech Stack:** Node ESM, `node:test`, zero deps.

**Spec:** `docs/superpowers/specs/2026-06-03-lore-theme-design.md`. **Branch:** `lore-theme` (off main).

---

## Task 1: config.parseConfigThemes

**Files:** Modify `lib/config.js`; Test `test/config.test.js`

- [ ] **Step 1: Failing test** — append to `test/config.test.js`:

```js
import { parseConfigThemes } from '../lib/config.js';

test('parseConfigThemes: commented example → []', () => {
  assert.deepEqual(parseConfigThemes('  theme:\n    values: []\n    # - { id: quality, match: [质量, accuracy] }\n'), []);
});

test('parseConfigThemes: uncommented themes (field order independent)', () => {
  const cfg = '  theme:\n    values:\n    - { id: quality, desc: "质量", match: [质量, accuracy, 误报] }\n    - { match: [性能, latency], id: perf }\n';
  assert.deepEqual(parseConfigThemes(cfg), [
    { id: 'quality', match: ['质量', 'accuracy', '误报'] },
    { id: 'perf', match: ['性能', 'latency'] },
  ]);
});

test('parseConfigThemes: ignores flow items (spans, no match)', () => {
  assert.deepEqual(parseConfigThemes('    - { id: f1, spans: [lib] }\n    - { id: x, match: [a] }\n'), [{ id: 'x', match: ['a'] }]);
});
```

- [ ] **Step 2: Run** `node --test test/config.test.js` → FAIL (`parseConfigThemes` not exported).

- [ ] **Step 3: Implement** — append to `lib/config.js`:

```js
export function parseConfigThemes(configText) {
  const themes = [];
  for (const line of configText.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('- {') || !/\bmatch:/.test(t)) continue;
    const idM = t.match(/\bid:\s*([A-Za-z0-9_-]+)/);
    const matchM = t.match(/\bmatch:\s*\[([^\]]*)\]/);
    if (!idM || !matchM) continue;
    const match = matchM[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '').trim()).filter(Boolean);
    themes.push({ id: idM[1], match });
  }
  return themes;
}
```

- [ ] **Step 4: Run** `node --test test/config.test.js` → PASS. **Step 5: Commit** `git commit -m "feat(config): parseConfigThemes (theme id + match keywords)"`

---

## Task 2: mine.tagThemes

**Files:** Modify `lib/mine.js`; Test `test/mine.test.js`

- [ ] **Step 1: Failing test** — append to `test/mine.test.js`:

```js
import { tagThemes } from '../lib/mine.js';

const THEMES = [{ id: 'quality', match: ['质量', 'accuracy'] }, { id: 'perf', match: ['性能', 'latency'] }];

test('tagThemes: substring case-insensitive, sorted unique', () => {
  assert.deepEqual(tagThemes('fix Accuracy and 性能 issue', THEMES), ['perf', 'quality']);
  assert.deepEqual(tagThemes('improve LATENCY', THEMES), ['perf']);
  assert.deepEqual(tagThemes('unrelated change', THEMES), []);
});

test('tagThemes: empty text / does not mutate input', () => {
  assert.deepEqual(tagThemes('', THEMES), []);
  const t = [{ id: 'a', match: ['x'] }];
  tagThemes('x', t);
  assert.equal(t.length, 1);
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** — append to `lib/mine.js`:

```js
export function tagThemes(text, themes) {
  const lower = (text ?? '').toLowerCase();
  return themes
    .filter(th => th.match.some(kw => lower.includes(kw.toLowerCase())))
    .map(th => th.id)
    .sort();
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `git commit -m "feat(mine): tagThemes (case-insensitive keyword substring)"`

---

## Task 3: commitAtom themes param

**Files:** Modify `lib/mine.js`; Test `test/mine.test.js`

- [ ] **Step 1: Failing test** — append to `test/mine.test.js`:

```js
test('commitAtom: themes param tags facets.theme; default empty', () => {
  const raw = { sha: 'a', ts: '2026-06-03T00:00:00Z', subject: 'fix accuracy bug', body: 'better 质量', files: [] };
  assert.deepEqual(commitAtom(raw, [], 'miner:commits', [{ id: 'quality', match: ['accuracy', '质量'] }]).facets.theme, ['quality']);
  assert.deepEqual(commitAtom(raw, []).facets.theme, []);          // default no themes
  assert.equal(commitAtom(raw, []).source, 'miner:commits');       // 3-arg default still works
});
```

- [ ] **Step 2: Run** → FAIL (theme stays `[]` with themes passed). 

- [ ] **Step 3: Implement.** In `lib/mine.js`, change `commitAtom` to add a 4th `themes` param and tag theme. Replace the function:

```js
export function commitAtom(raw, codeRoots, source = 'miner:commits', themes = []) {
  const component = [...new Set(
    raw.files.map(f => pathComponent(f, codeRoots)).filter(Boolean),
  )].sort();
  const theme = tagThemes(`${raw.subject} ${raw.body}`, themes);
  return {
    id: `commit:${raw.sha}`,
    ts: raw.ts,
    kind: 'commit',
    commit: raw.sha,
    title: raw.subject,
    why: raw.body,
    what_changed: '',
    facets: { component, flow: [], theme },
    refs: { files: raw.files, pitfall: null, related: [] },
    source,
    enriched: false,
    confidence: 'EXTRACTED',
  };
}
```

- [ ] **Step 4: Run** `node --test test/mine.test.js` → PASS (existing commitAtom tests use default themes → `theme:[]`, unchanged). **Step 5: Commit** `git commit -m "feat(mine): commitAtom themes param → facets.theme"`

---

## Task 4: mineCommits + mine + CLI thread config themes

**Files:** Modify `lib/mine.js`; Test `test/mine.test.js`

- [ ] **Step 1: Failing test** — append to `test/mine.test.js`:

```js
test('mineCommits: passes themes → commit atoms get facets.theme', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'x', 'improve accuracy');
    const atoms = mineCommits(root, ['lib'], [{ id: 'quality', match: ['accuracy'] }]);
    assert.deepEqual(atoms[0].facets.theme, ['quality']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mine: reads config themes (CLI integration)', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'x', 'fix latency');
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib]\n  theme:\n    values:\n    - { id: perf, match: [latency] }\n');
    execFileSync('node', ['lib/mine.js', root], { cwd: process.cwd() });
    const atoms = readAllAtoms(join(lore, 'journal'));
    const a = atoms.find(x => x.title === 'fix latency');
    assert.deepEqual(a.facets.theme, ['perf']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

(`gitRepo`/`commitFile`/`mineCommits`/`readAllAtoms` already in `test/mine.test.js`; `mkdirSync`/`writeFileSync` likely imported — merge if needed.)

- [ ] **Step 2: Run** → FAIL (`mineCommits` ignores 3rd arg; CLI doesn't read themes).

- [ ] **Step 3: Implement.** In `lib/mine.js`:

(a) `mineCommits` takes `themes`:
```js
export function mineCommits(repoRoot, codeRoots, themes = []) {
  const stdout = execFileSync(
    'git',
    ['log', '--no-merges', `--pretty=format:${GIT_FORMAT}`, '--name-only'],
    { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
  ).toString();
  return parseGitLog(stdout).map(raw => commitAtom(raw, codeRoots, 'miner:commits', themes));
}
```

(b) `mine` takes `themes` and passes it:
```js
export function mine({ repoRoot, journalDir, codeRoots, themes = [] }) {
  const seen = existingIds(journalDir);
  const atoms = mineCommits(repoRoot, codeRoots, themes);
  let added = 0, skipped = 0;
  for (const a of atoms) {
    if (seen.has(a.id)) { skipped++; continue; }
    appendAtom(journalDir, a); seen.add(a.id); added++;
  }
  return { scanned: atoms.length, added, skipped };
}
```

(c) In the CLI block, read themes from config and pass. Find where the CLI reads `codeRoots` (via `parseConfigCodeRoots`) and add `parseConfigThemes`. Update the import `import { parseConfigCodeRoots } from './config.js';` → `import { parseConfigCodeRoots, parseConfigThemes } from './config.js';`. In the CLI, after reading config text once:
```js
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const codeRoots = parseConfigCodeRoots(configText);
  const themes = parseConfigThemes(configText);
  const journalDir = join(loreDir, 'journal');
  const r = mine({ repoRoot, journalDir, codeRoots, themes });
```
(Read the current CLI block to adapt — it currently does `existsSync(configPath) ? parseConfigCodeRoots(readFileSync(...)) : []`. Read the file once into `configText`, then parse both.)

- [ ] **Step 4: Run** `node --test test/mine.test.js` → PASS. **Step 5: Commit** `git commit -m "feat(mine): thread config themes through mineCommits/mine/CLI"`

---

## Task 5: hook captureHead reads config themes

**Files:** Modify `lib/hook.js`; Test `test/hook.test.js`

- [ ] **Step 1: Failing test** — append to `test/hook.test.js`:

```js
test('captureHead tags theme from config themes', () => {
  const root = gitRepo();
  try {
    commitFile(root, 'lib/a.js', 'x', 'improve accuracy');
    const journalDir = join(root, '.lore', 'journal');
    const r = captureHead({ repoRoot: root, journalDir, codeRoots: ['lib'], themes: [{ id: 'quality', match: ['accuracy'] }] });
    assert.equal(r.added, 1);
    assert.deepEqual(readAllAtoms(journalDir)[0].facets.theme, ['quality']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** → FAIL (`captureHead` ignores `themes`).

- [ ] **Step 3: Implement.** In `lib/hook.js`:
(a) `captureHead` takes `themes` and passes to `commitAtom`:
```js
export function captureHead({ repoRoot, journalDir, codeRoots, themes = [] }) {
  const stdout = execFileSync(
    'git',
    ['log', '-1', '--no-merges', `--pretty=format:${GIT_FORMAT}`, '--name-only', 'HEAD'],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
  ).toString();
  const raws = parseGitLog(stdout);
  if (raws.length === 0) return { added: 0 };
  const atom = commitAtom(raws[0], codeRoots, 'hook', themes);
  if (existingIds(journalDir).has(atom.id)) return { added: 0 };
  appendAtom(journalDir, atom);
  return { added: 1 };
}
```
(b) In the CLI block, read config themes (add `parseConfigThemes` to the `./config.js` import) and pass: read `configText` once, `codeRoots = parseConfigCodeRoots(configText)`, `themes = parseConfigThemes(configText)`, `captureHead({ repoRoot, journalDir, codeRoots, themes })`.

- [ ] **Step 4: Run** `node --test test/hook.test.js` → PASS. **Step 5: Commit** `git commit -m "feat(hook): captureHead tags theme from config themes"`

---

## Task 6: planSync theme worklist

**Files:** Modify `lib/sync.js`; Test `test/sync.test.js`

- [ ] **Step 1: Failing test** — append to `test/sync.test.js`:

```js
test('planSync includes theme worklist items with axis', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib]\n  theme:\n    values:\n    - { id: quality, match: [质量] }\n');
    const { worklist, themes } = planSync(lore);
    assert.deepEqual(themes, [{ id: 'quality', match: ['质量'] }]);
    assert.ok(worklist.some(w => w.axis === 'component' && w.id === 'lib' && w.path === 'component/lib.md'));
    assert.ok(worklist.some(w => w.axis === 'theme' && w.id === 'quality' && w.path === 'theme/quality.md'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** In `lib/sync.js`: add `parseConfigThemes` to the `./config.js` import. Replace `planSync` with:

```js
export function planSync(loreDir) {
  const configPath = join(loreDir, 'config.yml');
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const codeRoots = parseConfigCodeRoots(configText);
  const themes = parseConfigThemes(configText);
  const wikiDir = join(loreDir, 'wiki');
  const exists = (axis, id) => existsSync(join(wikiDir, axis, `${id}.md`));
  const worklist = [];
  for (const codeRoot of codeRoots) {
    const id = codeRoot.split('/').pop();
    worklist.push({ axis: 'component', id, component: id, codeRoot, path: `component/${id}.md`, priorExists: exists('component', id) });
  }
  for (const th of themes) {
    worklist.push({ axis: 'theme', id: th.id, path: `theme/${th.id}.md`, priorExists: exists('theme', th.id) });
  }
  return { codeRoots, themes, worklist };
}
```

(Read the current `planSync` first; it returns `{codeRoots, worklist}` with component items shaped `{component, codeRoot, path, priorExists}`. The new shape adds `axis`/`id` + theme items + `themes`. Update the EXISTING planSync test that asserts the old worklist shape to match the new shape — read `test/sync.test.js` for it.)

- [ ] **Step 4: Run** `node --test test/sync.test.js` → PASS (update the old planSync test). **Step 5: Commit** `git commit -m "feat(sync): planSync adds theme worklist items (axis field)"`

---

## Task 7: finalizeSync + buildIndex multi-axis

**Files:** Modify `lib/sync.js`; Test `test/sync.test.js`

- [ ] **Step 1: Failing test** — append to `test/sync.test.js`:

```js
test('buildIndex: object form renders per-axis sections', () => {
  const out = buildIndex({ component: [{ id: 'lib', title: 'Lib' }], theme: [{ id: 'quality', title: 'Quality' }] });
  assert.match(out, /## Component\n- \[\[lib\]\]/);
  assert.match(out, /## Theme\n- \[\[quality\]\]/);
});

test('finalizeSync folds both component and theme axes', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    for (const axis of ['component', 'theme']) mkdirSync(join(lore, 'wiki', axis), { recursive: true });
    writeFileSync(join(lore, 'wiki', 'component', 'lib.md'), tokenPage('Lib', 'c'));
    writeFileSync(join(lore, 'wiki', 'theme', 'quality.md'), tokenPage('Quality', 't'));
    const journalDir = join(lore, 'journal');
    appendAtom(journalDir, { id: 'commit:a', ts: '2026-06-03T00:00:00Z', kind: 'commit', commit: 'aaaaaaa0', title: 'lib fix', why: '', facets: { component: ['lib'], flow: [], theme: ['quality'] } });

    finalizeSync(lore, '2026-06-03T00:00:00Z');

    assert.match(readFileSync(join(lore, 'wiki', 'component', 'lib.md'), 'utf8'), /- \*\*lib fix\*\*/);     // component page folds it
    assert.match(readFileSync(join(lore, 'wiki', 'theme', 'quality.md'), 'utf8'), /- \*\*lib fix\*\*/);     // theme page folds it
    const index = readFileSync(join(lore, 'wiki', 'INDEX.md'), 'utf8');
    assert.match(index, /## Component/);
    assert.match(index, /## Theme/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** → FAIL (finalize only does component; buildIndex takes a flat array).

- [ ] **Step 3: Implement.** In `lib/sync.js`:

(a) Replace `buildIndex` (currently takes a flat `pages` array → `## Component`). New signature takes `axisPages` (object axis→pages):
```js
export function buildIndex(axisPages) {
  const sections = [];
  for (const axis of ['component', 'theme', 'flow']) {
    const pages = axisPages[axis];
    if (!pages || pages.length === 0) continue;
    const heading = axis.charAt(0).toUpperCase() + axis.slice(1);
    sections.push(`## ${heading}\n${pages.map(p => `- [[${p.id}]]`).join('\n')}`);
  }
  return `---\ntitle: Index\nsummary: table of contents\n---\n# lore wiki — index\n\n${sections.join('\n\n')}\n`;
}
```
Update the EXISTING `buildIndex` test (which passes a flat array) to pass `{ component: [...] }` and assert `## Component`.

(b) Replace `finalizeSync` to loop over axes. The new function:
```js
const SYNC_AXES = ['component', 'theme'];

export function finalizeSync(loreDir, now) {
  const repoRoot = join(resolve(loreDir), '..');
  const wikiDir = join(loreDir, 'wiki');
  const codeSha = headShortSha(repoRoot);
  const lastUpdated = now.slice(0, 10);
  const allAtoms = readAllAtoms(join(loreDir, 'journal'));

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
      const atomsFor = allAtoms.filter(a => a.facets?.[axis]?.includes(id));
      const md = renderDecisionHistory(atomsFor);
      let text = readFileSync(p, 'utf8').replace('{{LORE_JOURNAL}}', () => md);
      text = stampFrontmatter(text, {
        codeSha, lastUpdated,
        atoms: atomsFor.length,
        commits: atomsFor.filter(a => a.kind === 'commit').length,
      });
      writeFileSync(p, text);
      const { data } = parseFrontmatter(text);
      stamped.push(`${axis}/${f}`);
      axisPages[axis].push({ id, title: data.title ?? id });
    }
  }

  if (!existsSync(wikiDir)) mkdirSync(wikiDir, { recursive: true });
  const indexFields = {
    codeSha, lastUpdated,
    atoms: allAtoms.length,
    commits: allAtoms.filter(a => a.kind === 'commit').length,
  };
  writeFileSync(join(wikiDir, 'INDEX.md'), stampFrontmatter(buildIndex(axisPages), indexFields));

  const manifestPath = runManifestCli(loreDir, now);
  return { stamped, indexWritten: true, manifestPath };
}
```

(Read the current `finalizeSync` + `buildIndex` first. The change: component-only loop → `SYNC_AXES` loop; atom filter `facets?.component` → `facets?.[axis]`; `buildIndex(pages)` → `buildIndex(axisPages)`. Update any existing finalize test that relied on component-only behavior — they should still pass since component is still axis 0; only buildIndex's call shape changed internally.)

- [ ] **Step 4: Run** `node --test test/sync.test.js` → PASS (component-axis tests still green; new multi-axis tests green). **Step 5: Run** `node --test` (full suite) → green. **Step 6: Commit** `git commit -m "feat(sync): finalizeSync + buildIndex generalize to multi-axis (component + theme)"`

---

## Task 8: command lore-sync.md — theme pages

**Files:** Modify `commands/lore-sync.md`

- [ ] **Step 1:** Read `commands/lore-sync.md`. The intro currently says `本版只产 component 页（flow/theme 推迟）。` — change to `本版产 component + theme 页（flow 推迟）。`. In the 合成 (synthesis) step, after the component-page instruction, ADD a paragraph instructing the agent to also write theme pages:

```
对每个 `axis:'theme'` 的 worklist 项，写 `.lore/wiki/theme/<id>.md`，格式同 component 页但讲「这条横切主线怎么演进」：
\`\`\`markdown
---
title: <主线显示名>
summary: <一行摘要>
---
# theme: <id>

## Current state

<这条主线当前状态/约束/为什么重要>

## Decision history

{{LORE_JOURNAL}}

## Cross-links

- [[<相关组件/主题>]]
\`\`\`
finalize 会把标了该 theme 的原子自动折进 `{{LORE_JOURNAL}}`。
```

Update the 给 agent 的提示 to mention theme pages.

- [ ] **Step 2: Sanity** `node -e "const s=require('fs').readFileSync('commands/lore-sync.md','utf8'); if(!s.includes('theme/')||s.includes('flow/theme 推迟')) process.exit(1); console.log('ok')"` → `ok`.

- [ ] **Step 3: Commit** `git commit -m "docs(command): /lore:sync writes theme pages"`

---

## Task 9: integration + README

**Files:** Modify `test/sync.test.js`; `README.md`

- [ ] **Step 1: Integration test** — append to `test/sync.test.js`:

```js
test('integration: config theme → mine tags it → sync folds into theme page', () => {
  const root = gitRepo();
  try {
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'a.js'), 'export const x = 1;');
    init({ repoRoot: root, srcSiteDir: join(process.cwd(), 'site') });
    const lore = join(root, '.lore');
    // rewrite config with code_roots + a theme whose keyword the commit will contain
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib]\n  theme:\n    values:\n    - { id: quality, match: [accuracy] }\n');
    // a commit whose subject contains the keyword
    writeFileSync(join(root, 'lib', 'b.js'), 'y');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'improve accuracy'], { cwd: root });
    execFileSync('node', ['lib/mine.js', root], { cwd: process.cwd() });   // tags theme:quality

    const themeDir = join(lore, 'wiki', 'theme');
    mkdirSync(themeDir, { recursive: true });
    writeFileSync(join(themeDir, 'quality.md'), tokenPage('Quality', 'q'));   // agent theme page (stub)
    execFileSync('node', ['lib/sync.js', 'finalize', lore], { cwd: process.cwd() });

    assert.match(readFileSync(join(themeDir, 'quality.md'), 'utf8'), /improve accuracy/);   // theme page folds the commit
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** `node --test test/sync.test.js` + full `node --test` → green. (The `init` hook fires on `improve accuracy` commit too — also tags theme; harmless, deduped by mine.)

- [ ] **Step 3: README** — update the `/lore:sync` section: change "只产 component 页" framing to note theme pages now too. Append a sentence:
```
本版产 component + theme 两轴页（theme 由 config `match:` 关键词自动给 commit 原子打标，sync 产 `theme/<id>.md` 折该主线原子）。flow 轴随后。
```

- [ ] **Step 4: Commit** `git commit -m "docs+test(theme): integration config→mine→sync theme page + README"`

---

## Self-Review

**Spec coverage:** §2 parseConfigThemes → T1; §3 tagThemes → T2; §4 commitAtom theme + mine/hook wiring → T3/T4/T5; §5 planSync + finalizeSync + buildIndex multi-axis → T6/T7; §6 command → T8; §7 tests → all; §8 acceptance → all; §9 out-of-scope (flow/regex/desc/note-auto) → not built.

**Placeholder scan:** none. T9's first config-write line is a deliberate "ensure newline then rewrite" — simplify in the implementer's hands (the second `writeFileSync` with the full theme config is authoritative; the implementer may drop the first redundant line).

**Type consistency:** `parseConfigThemes(text)->[{id,match}]` (T1) → used by `tagThemes`-callers + `mineCommits`/`captureHead`/`planSync`. `tagThemes(text, themes)->string[]` (T2) → `commitAtom(raw, codeRoots, source, themes)` (T3) → `facets.theme`. `mineCommits(repoRoot, codeRoots, themes)` / `mine({...themes})` (T4) / `captureHead({...themes})` (T5). `planSync->{codeRoots, themes, worklist[{axis,id,...}]}` (T6). `buildIndex(axisPages)` + `finalizeSync` axis loop filtering `facets[axis]` (T7). All consistent; component axis behavior preserved (axis 0).

