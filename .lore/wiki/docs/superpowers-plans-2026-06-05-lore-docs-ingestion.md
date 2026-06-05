---
title: lore docs 摄取 Implementation Plan
summary: > **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [...
source_path: docs/superpowers/plans/2026-06-05-lore-docs-ingestion.md
last_updated: 2026-06-05
---
> 源文档：`docs/superpowers/plans/2026-06-05-lore-docs-ingestion.md`

# lore docs 摄取 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增确定性 docs 轴，`/lore:sync` 把当前 `docs/**/*.md` + `CHANGELOG.md` + `CLAUDE.md`(踩坑) 机械生成可导航 wiki 页。

**Architecture:** 物化视图（架构 Y）——无 journal、无 LLM。新 `lib/docs.js`（三 extractor → page-spec → `renderDocsPage` → `buildDocsAxis` nuke-rebuild `wiki/docs/`）。`finalizeSync` 在 SYNC_AXES 折叠后、INDEX/manifest 前调 `buildDocsAxis`；`AXIS_ORDER`/`buildIndex` 加 `docs`；壳加 1 行配色。复用既有多轴 manifest/serve。

**Tech Stack:** Node 内置（零依赖）· `node --test` · 纯函数 extractor。

**Spec:** `docs/superpowers/specs/2026-06-05-lore-docs-ingestion-design.md`

---

## File Structure
- `lib/config.js` — Modify：加 `parseConfigDocsAxis`。
- `lib/docs.js` — Create：三 extractor + `slugifyDocPath`/`extractTitle`/`extractSummary`/`extractDate`/`walkMd` 助手 + `renderDocsPage` + `buildDocsAxis`。
- `lib/manifest.js` — Modify：`AXIS_ORDER` 加 `'docs'`。
- `lib/sync.js` — Modify：`finalizeSync` 调 `buildDocsAxis`；`buildIndex` 加 `docs`。
- `lib/init.js` — Modify：`renderConfigYaml` 加 `axes.docs` 注释示例。
- `site/index.html` — Modify：`.dot.docs` 配色。
- `commands/sync.md` — Modify：docs 轴机械生成注记。
- `test/docs.test.js` — Create；`test/config.test.js`、`test/manifest.test.js` — Modify。

**page-spec 接口（跨任务统一）：** `{ id, title, summary, sourcePath, date, entries? }`，其中 `entries`（可选）= changelog/pitfalls 折叠页的条目数组。

---

## Task 1: config — parseConfigDocsAxis（TDD）

**Files:** Modify `lib/config.js` · Test `test/config.test.js`

- [ ] **Step 1: 失败测试** — append 到 `test/config.test.js`：

```js
import { parseConfigDocsAxis } from '../lib/config.js';

test('parseConfigDocsAxis reads sources + docs_glob', () => {
  const cfg = `axes:\n  docs:\n    sources: [docs, changelog, claude_md_pitfalls]\n    docs_glob: docs/**/*.md\n`;
  const r = parseConfigDocsAxis(cfg);
  assert.deepEqual(r.sources, ['docs', 'changelog', 'claude_md_pitfalls']);
  assert.equal(r.docsGlob, 'docs/**/*.md');
});

test('parseConfigDocsAxis defaults docs_glob when omitted', () => {
  const r = parseConfigDocsAxis(`axes:\n  docs:\n    sources: [docs]\n`);
  assert.deepEqual(r.sources, ['docs']);
  assert.equal(r.docsGlob, 'docs/**/*.md');
});

test('parseConfigDocsAxis returns null when axes.docs absent', () => {
  assert.equal(parseConfigDocsAxis(`axes:\n  component:\n    code_roots: [lib]\n`), null);
});
```

- [ ] **Step 2: 跑，确认失败** — `node --test test/config.test.js` → FAIL（`parseConfigDocsAxis` 未定义）。

- [ ] **Step 3: 实现** — append 到 `lib/config.js`：

```js
export function parseConfigDocsAxis(configText) {
  // detect an `axes.docs:` block (its `sources:` line is the signal)
  const srcM = configText.match(/^\s*sources:\s*\[([^\]]*)\]/m);
  if (!srcM) return null;
  const sources = srcM[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '').trim()).filter(Boolean);
  if (!sources.length) return null;
  const globM = configText.match(/^\s*docs_glob:\s*(\S+)/m);
  const docsGlob = globM ? globM[1].trim().replace(/^['"]|['"]$/g, '') : 'docs/**/*.md';
  return { sources, docsGlob };
}
```

- [ ] **Step 4: 跑，确认通过** — `node --test test/config.test.js` → PASS（新 3 测 + 原有全过）。

- [ ] **Step 5: 提交**
```bash
git add lib/config.js test/config.test.js
git commit -m "feat(config): parseConfigDocsAxis (docs axis sources + glob)"
```

---

## Task 2: docs.js — docsExtractor + 助手（TDD）

**Files:** Create `lib/docs.js` · Create `test/docs.test.js`

- [ ] **Step 1: 失败测试** — create `test/docs.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { docsExtractor } from '../lib/docs.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-docs-')); }

test('docsExtractor: one spec per .md, recursive, sorted', () => {
  const root = tmp();
  try {
    mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'a.md'), '# Title A\n\nFirst para of A.\n');
    writeFileSync(join(root, 'docs', 'specs', '2026-06-04-thing.md'),
      '---\ntitle: Thing FM\nsummary: from front-matter\n---\n# H1 ignored when FM title\nbody');
    const specs = docsExtractor(root, 'docs/**/*.md');
    assert.equal(specs.length, 2);
    // sorted by path: docs/a.md before docs/specs/...
    assert.equal(specs[0].id, 'a');
    assert.equal(specs[0].title, 'Title A');
    assert.equal(specs[0].summary, 'First para of A.');
    assert.equal(specs[0].sourcePath, 'docs/a.md');
    const thing = specs[1];
    assert.equal(thing.id, 'specs-2026-06-04-thing');
    assert.equal(thing.title, 'Thing FM');           // front-matter title wins
    assert.equal(thing.summary, 'from front-matter');
    assert.equal(thing.date, '2026-06-04');          // from filename
    assert.equal(thing.sourcePath, 'docs/specs/2026-06-04-thing.md');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('docsExtractor: empty/missing docs dir → []', () => {
  const root = tmp();
  try { assert.deepEqual(docsExtractor(root, 'docs/**/*.md'), []); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑，确认失败** — `node --test test/docs.test.js` → FAIL（模块/函数缺）。

- [ ] **Step 3: 实现** — create `lib/docs.js`：

```js
// lib/docs.js — deterministic docs-axis extractors (zero-dep, no LLM, no journal)
import { readdirSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from './manifest.js';

export function slugifyDocPath(relFromDocs) {
  return relFromDocs.replace(/\.md$/i, '').replace(/[\\/]/g, '-');
}

export function extractDate(name) {
  const m = name.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

export function extractTitle(text, fallback) {
  const { data, body } = parseFrontmatter(text);
  if (data.title) return data.title;
  const h1 = body.match(/^#\s+(.+)$/m);
  return h1 ? h1[1].trim() : fallback;
}

export function extractSummary(text) {
  const { data, body } = parseFrontmatter(text);
  if (data.summary) return data.summary;
  // first non-empty paragraph after the first H1 (or from top), excluding headings
  const lines = body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^#\s/.test(lines[i])) i++;   // skip to first H1 if present
  if (i < lines.length) i++;                                 // past the H1 line
  while (i < lines.length && lines[i].trim() === '') i++;    // skip blanks
  let para = '';
  while (i < lines.length && lines[i].trim() !== '' && !/^#/.test(lines[i])) { para += (para ? ' ' : '') + lines[i].trim(); i++; }
  return para.length > 200 ? para.slice(0, 197) + '...' : para;
}

function walkMd(absDir, relPrefix, out) {
  let entries = [];
  try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
    if (e.isDirectory()) walkMd(join(absDir, e.name), rel, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(rel);
  }
}

export function docsExtractor(repoRoot, docsGlob = 'docs/**/*.md') {
  const prefix = docsGlob.split('/**')[0];               // 'docs/**/*.md' → 'docs'
  const base = join(repoRoot, prefix);
  if (!existsSync(base)) return [];
  const rels = [];
  walkMd(base, '', rels);                                 // relative to docs/
  return rels.map(rel => {
    const text = readFileSync(join(base, rel), 'utf8');
    const fallback = rel.replace(/\.md$/i, '').split('/').pop();
    return {
      id: slugifyDocPath(rel),
      title: extractTitle(text, fallback),
      summary: extractSummary(text),
      sourcePath: `${prefix}/${rel}`,
      date: extractDate(rel),
    };
  });
}
```

- [ ] **Step 4: 跑，确认通过** — `node --test test/docs.test.js` → PASS。

- [ ] **Step 5: 提交**
```bash
git add lib/docs.js test/docs.test.js
git commit -m "feat(docs): docsExtractor (docs/**/*.md → page specs)"
```

---

## Task 3: docs.js — changelogExtractor（TDD）

**Files:** Modify `lib/docs.js` · Modify `test/docs.test.js`

- [ ] **Step 1: 失败测试** — append 到 `test/docs.test.js`：

```js
import { changelogExtractor } from '../lib/docs.js';

test('changelogExtractor: versions → single folded spec', () => {
  const root = tmp();
  try {
    writeFileSync(join(root, 'CHANGELOG.md'),
      '# Changelog\n\n## [0.2.0] — 2026-06-04\n\n### 新增\n- mermaid\n\n## [0.1.0] — 2026-06-03\n\n- first\n');
    const specs = changelogExtractor(root);
    assert.equal(specs.length, 1);
    const s = specs[0];
    assert.equal(s.id, 'changelog');
    assert.equal(s.title, 'CHANGELOG');
    assert.equal(s.sourcePath, 'CHANGELOG.md');
    assert.equal(s.date, '2026-06-04');               // newest version date
    assert.equal(s.entries.length, 2);
    assert.deepEqual(s.entries[0], { version: '0.2.0', date: '2026-06-04' });
    assert.deepEqual(s.entries[1], { version: '0.1.0', date: '2026-06-03' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('changelogExtractor: no CHANGELOG → []', () => {
  const root = tmp();
  try { assert.deepEqual(changelogExtractor(root), []); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑，确认失败** — `node --test test/docs.test.js` → FAIL（`changelogExtractor` 缺）。

- [ ] **Step 3: 实现** — append 到 `lib/docs.js`：

```js
export function changelogExtractor(repoRoot) {
  const p = join(repoRoot, 'CHANGELOG.md');
  if (!existsSync(p)) return [];
  const text = readFileSync(p, 'utf8');
  const entries = [];
  // match `## [x.y.z] — date` / `## [x.y.z] - date`; capture the heading tail, then find the date in it
  const re = /^##\s*\[([^\]]+)\]([^\n]*)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const dm = m[2].match(/(\d{4}-\d{2}-\d{2})/);
    entries.push({ version: m[1], date: dm ? dm[1] : '' });
  }
  if (!entries.length) return [];
  return [{
    id: 'changelog',
    title: 'CHANGELOG',
    summary: `${entries.length} 个版本，最新 ${entries[0].version}`,
    sourcePath: 'CHANGELOG.md',
    date: entries[0].date,
    entries,
  }];
}
```

- [ ] **Step 4: 跑，确认通过** — `node --test test/docs.test.js` → PASS。

- [ ] **Step 5: 提交**
```bash
git add lib/docs.js test/docs.test.js
git commit -m "feat(docs): changelogExtractor (versions → one folded spec)"
```

---

## Task 4: docs.js — pitfallsExtractor（TDD）

**Files:** Modify `lib/docs.js` · Modify `test/docs.test.js`

- [ ] **Step 1: 失败测试** — append 到 `test/docs.test.js`：

```js
import { pitfallsExtractor } from '../lib/docs.js';

test('pitfallsExtractor: Problem/Fix/Prevention blocks → single folded spec', () => {
  const root = tmp();
  try {
    writeFileSync(join(root, 'CLAUDE.md'),
      'project notes\n\n**Problem**: tokens leak\n**Fix**: escape them\n**Prevention**: add a test\n\n' +
      '**问题**：超时\n**修复**：加重试\n**预防**：监控\n');
    const specs = pitfallsExtractor(root);
    assert.equal(specs.length, 1);
    assert.equal(specs[0].id, 'pitfalls');
    assert.equal(specs[0].entries.length, 2);
    assert.equal(specs[0].entries[0].problem, 'tokens leak');
    assert.equal(specs[0].entries[0].fix, 'escape them');
    assert.equal(specs[0].entries[0].prevention, 'add a test');
    assert.equal(specs[0].entries[1].problem, '超时');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pitfallsExtractor: no CLAUDE.md or no markers → []', () => {
  const root = tmp();
  try {
    assert.deepEqual(pitfallsExtractor(root), []);              // no file
    writeFileSync(join(root, 'CLAUDE.md'), 'just prose, no pitfalls\n');
    assert.deepEqual(pitfallsExtractor(root), []);              // no markers
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑，确认失败** — `node --test test/docs.test.js` → FAIL（`pitfallsExtractor` 缺）。

- [ ] **Step 3: 实现** — append 到 `lib/docs.js`：

```js
const PITFALL_PROBLEM = /\*\*(?:Problem|问题)\*\*[：:]\s*(.+)/;
const PITFALL_FIX = /\*\*(?:Fix|修复)\*\*[：:]\s*(.+)/;
const PITFALL_PREVENTION = /\*\*(?:Prevention|预防)\*\*[：:]\s*(.+)/;

export function pitfallsExtractor(repoRoot) {
  const p = join(repoRoot, 'CLAUDE.md');
  if (!existsSync(p)) return [];
  const text = readFileSync(p, 'utf8');
  // split at each Problem label; each chunk (after the first, which is preamble) is one pitfall
  const chunks = text.split(/(?=\*\*(?:Problem|问题)\*\*[：:])/);
  const entries = [];
  for (const c of chunks) {
    const pm = c.match(PITFALL_PROBLEM);
    if (!pm) continue;
    const fm = c.match(PITFALL_FIX);
    const vm = c.match(PITFALL_PREVENTION);
    entries.push({ problem: pm[1].trim(), fix: fm ? fm[1].trim() : '', prevention: vm ? vm[1].trim() : '' });
  }
  if (!entries.length) return [];
  return [{
    id: 'pitfalls',
    title: 'Pitfalls',
    summary: `${entries.length} 条踩坑`,
    sourcePath: 'CLAUDE.md',
    date: '',
    entries,
  }];
}
```

- [ ] **Step 4: 跑，确认通过** — `node --test test/docs.test.js` → PASS。

- [ ] **Step 5: 提交**
```bash
git add lib/docs.js test/docs.test.js
git commit -m "feat(docs): pitfallsExtractor (CLAUDE.md Problem/Fix/Prevention)"
```

---

## Task 5: docs.js — renderDocsPage（TDD）

**Files:** Modify `lib/docs.js` · Modify `test/docs.test.js`

- [ ] **Step 1: 失败测试** — append 到 `test/docs.test.js`：

```js
import { renderDocsPage } from '../lib/docs.js';

test('renderDocsPage: plain doc spec → front-matter + summary + source link', () => {
  const md = renderDocsPage({ id: 'a', title: 'Doc A', summary: 'about A', sourcePath: 'docs/a.md', date: '2026-06-04' });
  assert.match(md, /^---\ntitle: Doc A\nsummary: about A\nsource_path: docs\/a\.md\nlast_updated: 2026-06-04\n---/);
  assert.match(md, /# docs: Doc A/);
  assert.match(md, /about A/);
  assert.match(md, /\[docs\/a\.md\]\(\.\.\/\.\.\/\.\.\/docs\/a\.md\)/);   // repo-relative source link
});

test('renderDocsPage: spec with entries (changelog) → bullet list', () => {
  const md = renderDocsPage({
    id: 'changelog', title: 'CHANGELOG', summary: '2 versions', sourcePath: 'CHANGELOG.md', date: '2026-06-04',
    entries: [{ version: '0.2.0', date: '2026-06-04' }, { version: '0.1.0', date: '2026-06-03' }],
  });
  assert.match(md, /- \*\*0\.2\.0\*\* — 2026-06-04/);
  assert.match(md, /- \*\*0\.1\.0\*\* — 2026-06-03/);
});
```

- [ ] **Step 2: 跑，确认失败** — `node --test test/docs.test.js` → FAIL（`renderDocsPage` 缺）。

- [ ] **Step 3: 实现** — append 到 `lib/docs.js`：

```js
function renderEntries(entries) {
  if (!entries || !entries.length) return '';
  // changelog entries have {version,date}; pitfalls have {problem,fix,prevention}
  const lines = entries.map(e => {
    if (e.version !== undefined) return `- **${e.version}** — ${e.date}`;
    const tail = [e.fix && `修复：${e.fix}`, e.prevention && `预防：${e.prevention}`].filter(Boolean).join('；');
    return tail ? `- **${e.problem}** — ${tail}` : `- **${e.problem}**`;
  });
  return '\n\n' + lines.join('\n');
}

export function renderDocsPage(spec) {
  const fm = `---\ntitle: ${spec.title}\nsummary: ${spec.summary}\nsource_path: ${spec.sourcePath}\nlast_updated: ${spec.date}\n---`;
  const link = `源文档：[${spec.sourcePath}](../../../${spec.sourcePath})`;
  return `${fm}\n# docs: ${spec.title}\n\n${spec.summary}\n\n${link}${renderEntries(spec.entries)}\n`;
}
```

- [ ] **Step 4: 跑，确认通过** — `node --test test/docs.test.js` → PASS。

- [ ] **Step 5: 提交**
```bash
git add lib/docs.js test/docs.test.js
git commit -m "feat(docs): renderDocsPage (front-matter + source link + entries)"
```

---

## Task 6: docs.js — buildDocsAxis（TDD, nuke-rebuild）

**Files:** Modify `lib/docs.js` · Modify `test/docs.test.js`

- [ ] **Step 1: 失败测试** — append 到 `test/docs.test.js`：

```js
import { buildDocsAxis } from '../lib/docs.js';
import { existsSync as exists } from 'node:fs';

test('buildDocsAxis: writes wiki/docs pages; nuke-rebuild drops removed docs', () => {
  const root = tmp();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'a.md'), '# A\n\npara\n');
    writeFileSync(join(root, 'docs', 'b.md'), '# B\n\npara\n');
    writeFileSync(join(root, 'CHANGELOG.md'), '## [0.1.0] — 2026-06-03\n- x\n');

    let pages = buildDocsAxis(lore, root, { sources: ['docs', 'changelog'], docsGlob: 'docs/**/*.md' });
    assert.deepEqual(pages.map(p => p.id).sort(), ['a', 'b', 'changelog']);
    assert.ok(exists(join(lore, 'wiki', 'docs', 'a.md')));
    assert.ok(exists(join(lore, 'wiki', 'docs', 'changelog.md')));

    // remove b.md, rebuild → b page must disappear (materialized view)
    rmSync(join(root, 'docs', 'b.md'));
    pages = buildDocsAxis(lore, root, { sources: ['docs', 'changelog'], docsGlob: 'docs/**/*.md' });
    assert.ok(!exists(join(lore, 'wiki', 'docs', 'b.md')));
    assert.ok(exists(join(lore, 'wiki', 'docs', 'a.md')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑，确认失败** — `node --test test/docs.test.js` → FAIL（`buildDocsAxis` 缺）。

- [ ] **Step 3: 实现** — append 到 `lib/docs.js`：

```js
const EXTRACTORS = { docs: (root, cfg) => docsExtractor(root, cfg.docsGlob), changelog: (root) => changelogExtractor(root), claude_md_pitfalls: (root) => pitfallsExtractor(root) };

export function buildDocsAxis(loreDir, repoRoot, docsConfig) {
  const docsDir = join(loreDir, 'wiki', 'docs');
  rmSync(docsDir, { recursive: true, force: true });   // nuke — materialized view
  mkdirSync(docsDir, { recursive: true });
  const specs = [];
  for (const src of docsConfig.sources) {
    const fn = EXTRACTORS[src];
    if (fn) specs.push(...fn(repoRoot, docsConfig));
  }
  for (const spec of specs) writeFileSync(join(docsDir, `${spec.id}.md`), renderDocsPage(spec));
  return specs.map(s => ({ id: s.id, title: s.title }));
}
```

- [ ] **Step 4: 跑，确认通过** — `node --test test/docs.test.js` → PASS。

- [ ] **Step 5: 提交**
```bash
git add lib/docs.js test/docs.test.js
git commit -m "feat(docs): buildDocsAxis (nuke-rebuild wiki/docs from current files)"
```

---

## Task 7: 接线 — manifest AXIS_ORDER + sync finalize/buildIndex（TDD）

**Files:** Modify `lib/manifest.js` · Modify `lib/sync.js` · Modify `test/sync.test.js`

- [ ] **Step 1: 失败测试** — append 到 `test/sync.test.js`（集成：config 有 docs 轴 → finalize 出 docs 页 + INDEX 有 Docs + manifest 含 docs 轴）：

```js
test('finalizeSync builds docs axis from config + files (INDEX + manifest)', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-sync-docs-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root,
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki', 'component'), { recursive: true });
    mkdirSync(join(lore, 'journal'), { recursive: true });
    writeFileSync(join(lore, 'config.yml'),
      'axes:\n  component:\n    code_roots: [lib]\n  docs:\n    sources: [docs, changelog]\n    docs_glob: docs/**/*.md\n');
    writeFileSync(join(lore, 'wiki', 'component', 'lib.md'), '---\ntitle: lib\nsummary: s\n---\n# component: lib\n## Decision history\n{{LORE_JOURNAL}}\n');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'design.md'), '# Design\n\nthe design.\n');
    writeFileSync(join(root, 'CHANGELOG.md'), '## [0.1.0] — 2026-06-03\n- x\n');

    finalizeSync(lore, '2026-06-05T00:00:00Z', { warn() {} });

    assert.ok(existsSync(join(lore, 'wiki', 'docs', 'design.md')));
    assert.ok(existsSync(join(lore, 'wiki', 'docs', 'changelog.md')));
    const index = readFileSync(join(lore, 'wiki', 'INDEX.md'), 'utf8');
    assert.match(index, /## Docs/);
    assert.match(index, /\[\[design\]\]/);
    const manifest = JSON.parse(readFileSync(join(lore, 'wiki', '.manifest.json'), 'utf8'));
    assert.ok(manifest.axes.some(a => a.id === 'docs' && a.pages.some(p => p.id === 'design')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```
(Ensure the test file imports `finalizeSync`, `mkdtempSync`, `execFileSync`, `existsSync`, `readFileSync` — add any missing to its import block.)

- [ ] **Step 2: 跑，确认失败** — `node --test test/sync.test.js` → FAIL（docs 页/INDEX Docs/manifest docs 轴缺）。

- [ ] **Step 3a: manifest AXIS_ORDER** — `lib/manifest.js` line 28：
```js
const AXIS_ORDER = ['INDEX', 'component', 'flow', 'theme', 'docs'];
```

- [ ] **Step 3b: sync import + buildIndex** — `lib/sync.js`：
  - line 6 import 加 `parseConfigDocsAxis` 与 `buildDocsAxis`：
```js
import { parseConfigCodeRoots, parseConfigThemes, parseConfigFlows, parseConfigDocsAxis } from './config.js';
import { buildDocsAxis } from './docs.js';
```
  - `buildIndex`（line 35）的轴列表加 `'docs'`：
```js
  for (const axis of ['component', 'theme', 'flow', 'docs']) {
```

- [ ] **Step 3c: finalizeSync 调 buildDocsAxis** — `lib/sync.js`，在 SYNC_AXES 循环结束后（line 137 `}` 之后）、`if (!existsSync(wikiDir))`（line 139）之前插入：
```js
  // docs axis — mechanical materialized view of docs/ + CHANGELOG + CLAUDE.md (no journal, no LLM)
  const configPath = join(loreDir, 'config.yml');
  const docsConfig = existsSync(configPath) ? parseConfigDocsAxis(readFileSync(configPath, 'utf8')) : null;
  if (docsConfig) {
    const docsPages = buildDocsAxis(loreDir, repoRoot, docsConfig);
    if (docsPages.length) axisPages.docs = docsPages;
  }
```

- [ ] **Step 4: 跑，确认通过** — `node --test test/sync.test.js` → PASS。再 `node --test test/manifest.test.js` 确认 AXIS_ORDER 改动未破坏（应仍全过）。

- [ ] **Step 5: 提交**
```bash
git add lib/manifest.js lib/sync.js test/sync.test.js
git commit -m "feat(sync): finalize builds docs axis; AXIS_ORDER + buildIndex include docs"
```

---

## Task 8: 壳 + init + 命令文档（无测试）

**Files:** Modify `site/index.html` · `lib/init.js` · `commands/sync.md`

- [ ] **Step 1: 壳配色** — `site/index.html`，`:root` 调色板加 docs 变量（在 `--comp/--flow/--theme` 那行后）：
```css
    --comp: #7dcfff; --flow: #bb9af7; --theme: #ff9e64; --docs: #9ece6a;
```
并在 `.dot.theme { background: var(--theme); }` 后加：
```css
  .dot.docs { background: var(--docs); }
```
（light/sepia 主题块同理可加 `--docs`，可选；缺省回退到该变量未定义时用 component 色——为简洁本轮只加暗色主题的 `--docs`，亮/护眼用浏览器默认继承。若要严谨，三个主题块各加一行 `--docs`。）

- [ ] **Step 2: init 注释示例** — `lib/init.js` `renderConfigYaml`，在 `theme:` 块后、`journal:` 前加 docs 轴注释示例：
```js
  docs:                      # 文档轴 — 把 docs/ + CHANGELOG + CLAUDE.md 收进 wiki（机械、物化视图）
    # sources: [docs, changelog, claude_md_pitfalls]
    # docs_glob: docs/**/*.md
```
（保持模板字符串缩进与既有轴一致。）

- [ ] **Step 3: sync.md 注记** — `commands/sync.md`「给 agent 的提示」段加一条：
```markdown
- **docs 轴**（若 config 声明 `axes.docs`）由 finalize **机械生成**（读当前 `docs/**/*.md` + `CHANGELOG.md` + `CLAUDE.md` 踩坑 → `wiki/docs/<id>.md`，nuke-rebuild）。你（agent）**不用**写 docs 页。
```

- [ ] **Step 4: 提交**
```bash
git add site/index.html lib/init.js commands/sync.md
git commit -m "feat(docs): shell dot color + init config example + sync.md note"
```

---

## Task 9: 端到端验证 + 全套绿

**Files:** 无（验证）

- [ ] **Step 1: 全套测试** — `node --test`，Expected PASS、0 fail（基线 170 + 本特性新增；约 180+，0 fail）。
- [ ] **Step 2: 真实 dogfood** — 在 lore 自身：编辑 `.lore/config.yml` 取消注释 `axes.docs.sources: [docs, changelog]` → `node lib/sync.js finalize .lore` → 确认 `.lore/wiki/docs/` 出现 spec/plan/note 页 + `changelog.md`，INDEX 有 `## Docs`。serve 看侧栏多出 docs 轴。
- [ ] **Step 3: 不变量自查**
  - 零依赖：`lib/docs.js` 纯 Node 内置、无 import 三方。
  - 零侵入：只写 `.lore/wiki/docs/`（+ config 注释、壳、命令文档属引擎侧）。
  - 物化视图：删一个 docs/ 文件 → re-sync → 对应 `wiki/docs/` 页消失。
  - 确定性：同输入两次 finalize → `wiki/docs/` 字节一致。

---

## Self-Review（plan 对照 spec）
- **Spec coverage**：config→T1；docsExtractor→T2；changelog→T3；pitfalls→T4；renderDocsPage→T5；buildDocsAxis(nuke-rebuild)→T6；manifest/finalize/buildIndex 接线→T7；壳/init/sync.md→T8；测试散落各任务 + T9 集成。全覆盖。
- **Placeholder scan**：每步给完整代码/命令；无 TBD。
- **类型/名一致**：page-spec `{id,title,summary,sourcePath,date,entries?}` 跨 T2-T7 一致；`parseConfigDocsAxis`→`{sources,docsGlob}`、`buildDocsAxis(loreDir,repoRoot,docsConfig)→[{id,title}]`、`EXTRACTORS` 键 `docs/changelog/claude_md_pitfalls` 与 config `sources` 值一致、与 spec 一致。
- **顺序依赖**：T7 import `buildDocsAxis`（T6）、`parseConfigDocsAxis`（T1）——故 T1/T6 必先于 T7（任务编号已保证）。

