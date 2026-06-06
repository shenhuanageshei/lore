# lore Human HOME + Persistent Translation Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a human-first HOME page and persistent bilingual translation layer for lore wiki.

**Architecture:** Add a root `HOME.md` page that opens before `INDEX.md`, with deterministic status injection during `finalizeSync`. Add repo language config, user preferences, translation sidecar discovery, localized shell routing, and a local request queue for page-triggered translation.

**Tech Stack:** Node ESM, `node --test`, zero third-party runtime dependencies, local-only Node HTTP server, Markdown materialized wiki pages.

**Spec:** `docs/superpowers/specs/2026-06-06-lore-human-home-translation-design.md`

---

## File Structure

- Modify `lib/config.js`: parse `language.default` and `language.available`.
- Modify `lib/init.js`: include language config in generated `.lore/config.yml`.
- Create `lib/i18n.js`: language normalization, translation sidecar naming, source hashing, preference read/write.
- Modify `lib/manifest.js`: emit `HOME`, language metadata, translation sidecars, and ignore sidecars as primary pages.
- Create `lib/home.js`: HOME template, `{{LORE_HOME_STATUS}}` replacement, status summary.
- Modify `lib/sync.js`: include HOME work item, finalize HOME before manifest, keep INDEX as directory.
- Modify `site/shell.mjs`: pure functions for language preference and localized page resolution.
- Modify `site/index.html`: language selector, translate action state, localized fetch routing.
- Modify `server.js`: local API for preferences and translation requests.
- Modify `lib/serve.js`: prefer Node server when local APIs are needed.
- Create `lib/translate.js`: deterministic plan/finalize helper for sidecar translations.
- Modify `commands/sync.md`: instruct agents to create/update HOME.
- Create `commands/translate.md`: command contract for translating requested pages.
- Modify tests: `test/config.test.js`, `test/manifest.test.js`, `test/sync.test.js`, `test/shell.test.js`, `test/serve.test.js`.
- Create tests: `test/i18n.test.js`, `test/home.test.js`, `test/translate.test.js`, `test/server-api.test.js`.

---

## Task 1: Language Config Parsing

**Files:**
- Modify: `lib/config.js`
- Modify: `test/config.test.js`

- [ ] **Step 1: Write failing tests**

Append to `test/config.test.js`:

```js
import { parseConfigLanguage } from '../lib/config.js';

test('parseConfigLanguage: defaults to English when block is absent', () => {
  assert.deepEqual(parseConfigLanguage('axes:\n  component:\n    code_roots: [lib]\n'), {
    default: 'en',
    available: ['en'],
  });
});

test('parseConfigLanguage: reads default and available languages', () => {
  const cfg = 'language:\n  default: zh\n  available: [zh, en]\n';
  assert.deepEqual(parseConfigLanguage(cfg), {
    default: 'zh',
    available: ['zh', 'en'],
  });
});

test('parseConfigLanguage: dequotes, dedupes, and keeps default available', () => {
  const cfg = 'language:\n  default: "zh"\n  available: [en, zh, en]\n';
  assert.deepEqual(parseConfigLanguage(cfg), {
    default: 'zh',
    available: ['zh', 'en'],
  });
});

test('parseConfigLanguage: invalid default falls back to en', () => {
  const cfg = 'language:\n  default: ???\n  available: []\n';
  assert.deepEqual(parseConfigLanguage(cfg), {
    default: 'en',
    available: ['en'],
  });
});

test('parseConfigLanguage: only reads the language block, not stray default: keys', () => {
  const cfg = 'axes:\n  component:\n    default: en\nlanguage:\n  default: zh\n  available: [zh, en]\n';
  assert.deepEqual(parseConfigLanguage(cfg), { default: 'zh', available: ['zh', 'en'] });
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
node --test test/config.test.js
```

Expected: fail with `The requested module '../lib/config.js' does not provide an export named 'parseConfigLanguage'`.

- [ ] **Step 3: Implement `parseConfigLanguage`**

Add to `lib/config.js`:

```js
function parseList(raw) {
  return raw
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}

function validLang(s) {
  return /^[a-z]{2}(?:-[A-Za-z0-9]+)?$/.test(s);
}

export function parseConfigLanguage(configText) {
  // Scope to the `language:` block so a stray `default:`/`available:` in another
  // axis can't leak in (same single-block discipline as parseConfigDocsAxis).
  const blockM = configText.match(/^language:[ \t]*\n((?:[ \t]+.*\n?)*)/m);
  const block = blockM ? blockM[1] : '';

  const defM = block.match(/^\s*default:\s*([^\n#]+)/m);
  let defaultLang = defM ? defM[1].trim().replace(/^['"]|['"]$/g, '').trim() : 'en';
  if (!validLang(defaultLang)) defaultLang = 'en';

  const availM = block.match(/^\s*available:\s*\[([^\]]*)\]/m);
  const rawAvailable = availM ? parseList(availM[1]).filter(validLang) : [defaultLang];
  const available = [];
  for (const lang of [defaultLang, ...rawAvailable]) {
    if (!available.includes(lang)) available.push(lang);
  }
  return { default: defaultLang, available };
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
node --test test/config.test.js
```

Expected: all config tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/config.js test/config.test.js
git commit -m "feat(config): parse wiki language preferences"
```

---

## Task 2: i18n Helpers

**Files:**
- Create: `lib/i18n.js`
- Create: `test/i18n.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/i18n.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  translationPathFor,
  isTranslationSidecar,
  translationSourceHash,
  discoverTranslations,
  readPreferences,
  writePreferences,
} from '../lib/i18n.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-i18n-')); }

test('translationPathFor inserts language before .md', () => {
  assert.equal(translationPathFor('component/lib.md', 'en'), 'component/lib.en.md');
  assert.equal(translationPathFor('HOME.md', 'zh'), 'HOME.zh.md');
});

test('isTranslationSidecar detects available non-default language files', () => {
  assert.equal(isTranslationSidecar('lib.en.md', ['zh', 'en'], 'zh'), true);
  assert.equal(isTranslationSidecar('lib.zh.md', ['zh', 'en'], 'zh'), false);
  assert.equal(isTranslationSidecar('lib.md', ['zh', 'en'], 'zh'), false);
});

test('translationSourceHash ignores frontmatter and normalizes line endings', () => {
  const a = '---\ntitle: A\n---\n# A\r\nbody\r\n';
  const b = '---\ntitle: B\n---\n# A\nbody\n';
  assert.equal(translationSourceHash(a), translationSourceHash(b));
  assert.match(translationSourceHash(a), /^sha256:[0-9a-f]{64}$/);
});

test('discoverTranslations reports ready and stale sidecars', () => {
  const root = tmp();
  try {
    mkdirSync(join(root, 'wiki', 'component'), { recursive: true });
    const source = '---\ntitle: Lib\n---\n# Lib\nbody\n';
    const hash = translationSourceHash(source);
    writeFileSync(join(root, 'wiki', 'component', 'lib.en.md'),
      `---\nlang: en\ntranslation_of: component/lib.md\ntranslation_source_hash: ${hash}\n---\n# Lib\n`);
    writeFileSync(join(root, 'wiki', 'component', 'lib.ja.md'),
      '---\nlang: ja\ntranslation_of: component/lib.md\ntranslation_source_hash: sha256:bad\n---\n# Lib\n');
    const found = discoverTranslations({
      wikiDir: join(root, 'wiki'),
      pagePath: 'component/lib.md',
      pageText: source,
      available: ['zh', 'en', 'ja'],
      defaultLang: 'zh',
    });
    assert.deepEqual(found.map(t => ({ lang: t.lang, path: t.path, stale: t.stale })), [
      { lang: 'en', path: 'component/lib.en.md', stale: false },
      { lang: 'ja', path: 'component/lib.ja.md', stale: true },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readPreferences and writePreferences round-trip .state/preferences.json', () => {
  const root = tmp();
  try {
    const state = join(root, '.lore', '.state');
    assert.deepEqual(readPreferences(state), {});
    writePreferences(state, { language: 'zh' });
    assert.deepEqual(JSON.parse(readFileSync(join(state, 'preferences.json'), 'utf8')), { language: 'zh' });
    assert.deepEqual(readPreferences(state), { language: 'zh' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
node --test test/i18n.test.js
```

Expected: fail because `lib/i18n.js` does not exist.

- [ ] **Step 3: Implement helpers**

Create `lib/i18n.js`:

```js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseFrontmatter } from './manifest.js';

export function translationPathFor(pagePath, lang) {
  return pagePath.replace(/\.md$/i, `.${lang}.md`);
}

export function isTranslationSidecar(fileName, available, defaultLang) {
  const m = fileName.match(/\.([A-Za-z]{2}(?:-[A-Za-z0-9]+)?)\.md$/);
  return Boolean(m && available.includes(m[1]) && m[1] !== defaultLang);
}

export function translationSourceHash(text) {
  const body = parseFrontmatter(text).body.replace(/\r\n/g, '\n').trimEnd();
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

function slash(p) {
  return p.replace(/\\/g, '/');
}

export function discoverTranslations({ wikiDir, pagePath, pageText, available, defaultLang }) {
  const hash = translationSourceHash(pageText);
  const out = [];
  for (const lang of available) {
    if (lang === defaultLang) continue;
    const rel = translationPathFor(pagePath, lang);
    const abs = join(wikiDir, rel);
    if (!existsSync(abs)) continue;
    const { data } = parseFrontmatter(readFileSync(abs, 'utf8'));
    out.push({
      lang,
      path: slash(rel),
      stale: data.translation_source_hash !== hash,
      source_hash: hash,
    });
  }
  return out;
}

export function readPreferences(stateDir) {
  const p = join(stateDir, 'preferences.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch { return {}; }
}

export function writePreferences(stateDir, prefs) {
  const p = join(stateDir, 'preferences.json');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(prefs, null, 2) + '\n');
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
node --test test/i18n.test.js
```

Expected: all i18n tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/i18n.js test/i18n.test.js
git commit -m "feat(i18n): add translation sidecar helpers"
```

---

## Task 3: Manifest HOME and Translation Metadata

**Files:**
- Modify: `lib/manifest.js`
- Modify: `test/manifest.test.js`

- [ ] **Step 1: Write failing tests**

Append to `test/manifest.test.js`:

```js
test('emitManifest includes HOME before INDEX when HOME.md exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-home-mf-'));
  try {
    const wiki = join(root, 'wiki');
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, 'HOME.md'), '---\ntitle: Home\nsummary: orient\n---\n# Home');
    writeFileSync(join(wiki, 'INDEX.md'), '---\ntitle: Index\nsummary: toc\n---\n# Index');
    const m = emitManifest({ wikiDir: wiki, currentSha: 'abc', countCommitsSince: () => 0, now: 'now' });
    assert.deepEqual(m.axes.slice(0, 2).map(a => a.id), ['HOME', 'INDEX']);
    assert.equal(m.axes[0].pages[0].path, 'HOME.md');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('emitManifest attaches language metadata and hides translation sidecars', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-lang-mf-'));
  try {
    const wiki = join(root, 'wiki');
    mkdirSync(join(wiki, 'component'), { recursive: true });
    const source = '---\ntitle: Lib\nsummary: core\n---\n# Lib\n正文';
    writeFileSync(join(wiki, 'component', 'lib.md'), source);
    writeFileSync(join(wiki, 'component', 'lib.en.md'),
      '---\nlang: en\ntranslation_of: component/lib.md\ntranslation_source_hash: sha256:bad\n---\n# Lib\nEnglish');
    const m = emitManifest({
      wikiDir: wiki,
      currentSha: 'abc',
      countCommitsSince: () => 0,
      now: 'now',
      language: { default: 'zh', available: ['zh', 'en'] },
      preferences: { language: 'en' },
    });
    assert.deepEqual(m.language, { default: 'zh', available: ['zh', 'en'] });
    assert.deepEqual(m.user_preferences, { language: 'en' });
    const comp = m.axes.find(a => a.id === 'component');
    assert.deepEqual(comp.pages.map(p => p.id), ['lib']);
    assert.equal(comp.pages[0].lang, 'zh');
    assert.equal(comp.pages[0].translations[0].lang, 'en');
    assert.equal(comp.pages[0].translations[0].path, 'component/lib.en.md');
    assert.equal(comp.pages[0].translations[0].stale, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
node --test test/manifest.test.js
```

Expected: fail because `HOME.md` is ignored and language metadata is absent.

- [ ] **Step 3: Implement manifest changes**

In `lib/manifest.js`:

1. Import i18n helpers:

```js
import { discoverTranslations, isTranslationSidecar } from './i18n.js';
```

2. Replace `AXIS_ORDER`:

```js
const AXIS_ORDER = ['HOME', 'INDEX', 'component', 'flow', 'theme', 'docs'];
const ROOT_AXIS_FILES = { HOME: 'HOME.md', INDEX: 'INDEX.md' };
```

3. Update root detection in `emitManifest`:

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
  const entries = readdirSync(wikiDir, { withFileTypes: true });
  const subdirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  const rootAxes = Object.entries(ROOT_AXIS_FILES)
    .filter(([, file]) => entries.some(e => e.isFile() && e.name === file))
    .map(([axis]) => axis);
  const axisDefs = axes ?? deriveAxes([...rootAxes, ...subdirs]);

  const builtAxes = [];
  for (const ax of axisDefs) {
    const pages = [];
    if (ROOT_AXIS_FILES[ax.id]) {
      if (rootAxes.includes(ax.id)) {
        pages.push(pageEntry(wikiDir, '', ax.id, currentSha, countCommitsSince, language));
      }
    } else {
      const axisDir = join(wikiDir, ax.id);
      let files = [];
      try {
        files = readdirSync(axisDir, { withFileTypes: true })
          .filter(e => e.isFile() && e.name.endsWith('.md'))
          .filter(e => !isTranslationSidecar(e.name, language.available, language.default))
          .map(e => e.name);
      } catch { files = []; }
      files.sort();
      for (const f of files) {
        pages.push(pageEntry(wikiDir, ax.id, f.replace(/\.md$/, ''), currentSha, countCommitsSince, language));
      }
      if (ax.id === 'docs') {
        pages.sort((a, b) => (b.last_updated || '').localeCompare(a.last_updated || '') || a.id.localeCompare(b.id));
      }
    }
    builtAxes.push({ id: ax.id, label: ax.label, pages });
  }
  return { generated: now, current_code_sha: currentSha, language, user_preferences: preferences, axes: builtAxes };
}
```

4. Update `pageEntry` signature and return value:

```js
function pageEntry(wikiDir, axisId, id, currentSha, countCommitsSince, language) {
  const rel = axisId ? `${axisId}/${id}.md` : `${id}.md`;
  const text = readFileSync(join(wikiDir, rel), 'utf8');
  const { data } = parseFrontmatter(text);
  const sha = data.code_sha ?? '';
  const stale = sha && sha !== currentSha ? countCommitsSince(sha) : 0;
  return {
    id,
    title: data.title ?? id,
    summary: data.summary ?? '',
    last_updated: data.last_updated ?? '',
    path: rel,
    lang: data.lang ?? language.default,
    translations: discoverTranslations({
      wikiDir,
      pagePath: rel,
      pageText: text,
      available: language.available,
      defaultLang: language.default,
    }),
    stale,
    code_sha: sha,
    synthesized_from: { atoms: data.atoms ?? 0, commits: data.commits ?? 0 },
  };
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
node --test test/manifest.test.js test/i18n.test.js
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/manifest.js test/manifest.test.js
git commit -m "feat(manifest): expose home and translations"
```

---

## Task 4: HOME Generation and Sync Integration

**Files:**
- Create: `lib/home.js`
- Create: `test/home.test.js`
- Modify: `lib/sync.js`
- Modify: `test/sync.test.js`

- [ ] **Step 1: Write home helper tests**

Create `test/home.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHomeStatus, defaultHomePage, finalizeHomeText } from '../lib/home.js';

test('defaultHomePage contains the home status token and required sections', () => {
  const md = defaultHomePage({ title: 'lore' });
  assert.match(md, /title: Home/);
  assert.match(md, /\{\{LORE_HOME_STATUS\}\}/);
  assert.match(md, /## Knowledge flow/);
  assert.match(md, /```mermaid/);
  assert.match(md, /## Understand the project/);
  assert.match(md, /## Debug a problem/);
  assert.match(md, /## Decisions and timeline/);
});

test('buildHomeStatus renders code, axes, language, and translation counts', () => {
  const md = buildHomeStatus({
    version: '0.4.1',
    codeSha: 'abc1234',
    lastUpdated: '2026-06-06',
    axisPages: {
      component: [{ id: 'lib' }],
      docs: [{ id: 'changelog' }],
    },
    language: { default: 'zh', available: ['zh', 'en'] },
    translationStats: { ready: 2, stale: 1, missing: 3 },
  });
  assert.match(md, /## Status/);
  assert.match(md, /Version: `0.4.1`/);
  assert.match(md, /Code: `abc1234`/);
  assert.match(md, /component 1/);
  assert.match(md, /docs 1/);
  assert.match(md, /Language: `zh` default/);
  assert.match(md, /Translations: `2 ready`/);
});

test('finalizeHomeText replaces the token once and leaves prose intact', () => {
  const out = finalizeHomeText('# Home\n\nintro\n\n{{LORE_HOME_STATUS}}\n', '## Status\n\n- x');
  assert.match(out, /intro/);
  assert.match(out, /## Status/);
  assert.doesNotMatch(out, /\{\{LORE_HOME_STATUS\}\}/);
});

test('finalizeHomeText is idempotent: re-finalize swaps the region, no duplicate Status', () => {
  const once = finalizeHomeText('# Home\n\nintro\n\n{{LORE_HOME_STATUS}}\n', '## Status\n\n- a');
  const twice = finalizeHomeText(once, '## Status\n\n- b');
  assert.equal((twice.match(/## Status/g) || []).length, 1);   // exactly one block
  assert.match(twice, /- b/);                                   // refreshed
  assert.doesNotMatch(twice, /- a/);                            // stale values gone
  assert.doesNotMatch(twice, /\{\{LORE_HOME_STATUS\}\}/);
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
node --test test/home.test.js
```

Expected: fail because `lib/home.js` does not exist.

- [ ] **Step 3: Implement `lib/home.js`**

Create `lib/home.js`:

```js
export const HOME_STATUS_TOKEN = '{{LORE_HOME_STATUS}}';
const STATUS_START = '<!-- LORE_HOME_STATUS:START -->';
const STATUS_END = '<!-- LORE_HOME_STATUS:END -->';

export function defaultHomePage({ title = 'lore', axisPages = {} } = {}) {
  const ids = axis => (axisPages[axis] ?? []).map(p => p.id);
  const docs = ids('docs');
  // Only link pages that exist; fall back to INDEX (always present post-finalize)
  // so the mechanical scaffold never ships dangling wikilinks.
  const bullets = arr => (arr.length ? arr : ['INDEX']).map(id => `- [[${id}]]`).join('\n');
  const understand = bullets(ids('component').slice(0, 3));
  const debug = bullets(['pitfalls', 'ROADMAP', 'troubleshooting'].filter(id => docs.includes(id)));
  const decisions = bullets(docs.includes('changelog') ? ['changelog'] : []);
  return `---\ntitle: Home\nsummary: human-readable orientation map for this repository\n---\n# ${title}\n\nThis repository is documented as a living wiki: code, docs, decisions, and flows are folded into pages humans and agents can both use.\n\n${HOME_STATUS_TOKEN}\n\n## Knowledge flow\n\n\`\`\`mermaid\nflowchart LR\n  repo["Repo code/docs"] --> capture["Capture"]\n  capture --> journal[".lore/journal"]\n  journal --> sync["Sync"]\n  sync --> wiki[".lore/wiki"]\n  wiki --> human["Human reading"]\n  wiki --> agent["Agent retrieval"]\n\`\`\`\n\n## Understand the project\n\n${understand}\n\n## Debug a problem\n\n${debug}\n\n## Decisions and timeline\n\n${decisions}\n`;
}

export function buildHomeStatus({ version, codeSha, lastUpdated, axisPages, language, translationStats }) {
  const axisLine = Object.entries(axisPages)
    .filter(([, pages]) => pages && pages.length)
    .map(([axis, pages]) => `${axis} ${pages.length}`)
    .join(' · ') || 'none';
  const langs = language.available.join(', ');
  return `## Status\n\n- Version: \`${version}\`\n- Code: \`${codeSha}\`\n- Updated: \`${lastUpdated}\`\n- Axes: \`${axisLine}\`\n- Language: \`${language.default}\` default · \`${langs}\` available\n- Translations: \`${translationStats.ready} ready\` · \`${translationStats.stale} stale\` · \`${translationStats.missing} missing\``;
}

// Idempotent: the status lives inside a sentinel-delimited region so re-running
// sync swaps it in place. The {{LORE_HOME_STATUS}} token only exists on a freshly
// authored page (first finalize); after that the region carries the marker pair.
export function finalizeHomeText(text, statusMarkdown) {
  const block = `${STATUS_START}\n${statusMarkdown}\n${STATUS_END}`;
  const re = new RegExp(`${STATUS_START}[\\s\\S]*?${STATUS_END}`);
  if (re.test(text)) return text.replace(re, () => block);
  if (text.includes(HOME_STATUS_TOKEN)) return text.replace(HOME_STATUS_TOKEN, () => block);
  return `${text.replace(/\s+$/, '')}\n\n${block}\n`;
}
```

- [ ] **Step 4: Add sync tests**

Append to `test/sync.test.js`:

```js
test('planSync includes HOME as the first work item', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    writeFileSync(join(lore, 'config.yml'), 'axes:\n  component:\n    code_roots: [lib]\n');
    const r = planSync(lore);
    assert.equal(r.worklist[0].axis, 'HOME');
    assert.equal(r.worklist[0].path, 'HOME.md');
    assert.equal(r.worklist[0].priorExists, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('finalizeSync writes HOME before manifest and keeps INDEX', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    writeFileSync(join(lore, 'config.yml'), 'language:\n  default: zh\n  available: [zh, en]\n');
    finalizeSync(lore, '2026-06-06T00:00:00Z');
    const home = readFileSync(join(lore, 'wiki', 'HOME.md'), 'utf8');
    assert.match(home, /title: Home/);
    assert.match(home, /## Status/);
    assert.doesNotMatch(home, /\{\{LORE_HOME_STATUS\}\}/);
    assert.equal(existsSync(join(lore, 'wiki', 'INDEX.md')), true);
    const manifest = JSON.parse(readFileSync(join(lore, 'wiki', '.manifest.json'), 'utf8'));
    assert.deepEqual(manifest.axes.slice(0, 2).map(a => a.id), ['HOME', 'INDEX']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

Then update the three existing `planSync` tests in `test/sync.test.js` — HOME is now the first work item, so their exact-array/length assertions must change:

- `planSync builds worklist from config code_roots`: prepend `{ axis: 'HOME', id: 'HOME', path: 'HOME.md', priorExists: false }` as `worklist[0]` in the expected array (the two component items follow).
- `planSync returns empty when config missing`: expected `worklist` is now `[{ axis: 'HOME', id: 'HOME', path: 'HOME.md', priorExists: false }]` (HOME is always planned, even on a bare `.lore`).
- `CLI plan prints worklist JSON`: `parsed.worklist.length` is now `3`; assert `parsed.worklist[0].axis === 'HOME'` and `parsed.worklist[1].component === 'lib'`.

- [ ] **Step 5: Run failing sync tests**

Run:

```bash
node --test test/home.test.js test/sync.test.js
```

Expected: home tests pass, sync tests fail because sync does not emit HOME.

- [ ] **Step 6: Integrate HOME into sync**

Modify imports in `lib/sync.js`:

```js
import { parseConfigCodeRoots, parseConfigThemes, parseConfigFlows, parseConfigDocsAxis, parseConfigLanguage } from './config.js';
import { discoverTranslations } from './i18n.js';
import { buildHomeStatus, defaultHomePage, finalizeHomeText } from './home.js';
```

Add the HOME work item as the **first** entry in `planSync`, right after `const worklist = []`:

```js
worklist.push({ axis: 'HOME', id: 'HOME', path: 'HOME.md', priorExists: existsSync(join(wikiDir, 'HOME.md')) });
```

Add a disk-scanning translation-stats helper inside `lib/sync.js`. The sidecars live on disk, not on the lightweight `{id,title}` `axisPages` entries, so re-derive counts here; `missing` = an available non-default language with no sidecar on disk:

```js
function translationStats({ wikiDir, axisPages, language }) {
  const others = language.available.filter(l => l !== language.default);
  if (!others.length) return { ready: 0, stale: 0, missing: 0 };
  let ready = 0, stale = 0, missing = 0;
  for (const [axis, pages] of Object.entries(axisPages)) {
    for (const p of pages) {
      const rel = `${axis}/${p.id}.md`;
      const abs = join(wikiDir, rel);
      if (!existsSync(abs)) continue;
      const found = discoverTranslations({
        wikiDir, pagePath: rel, pageText: readFileSync(abs, 'utf8'),
        available: language.available, defaultLang: language.default,
      });
      const byLang = new Map(found.map(t => [t.lang, t]));
      for (const lang of others) {
        const t = byLang.get(lang);
        if (!t) missing++; else if (t.stale) stale++; else ready++;
      }
    }
  }
  return { ready, stale, missing };
}
```

In `finalizeSync`, collapse the existing docs-only config read into **one** `configText` read that feeds both docs and language. This REPLACES the current `const docsConfig = existsSync(configPath) ? parseConfigDocsAxis(readFileSync(...)) : null;` block — do **not** add a second `configPath`/`configText` declaration or the module fails to parse with `Identifier 'configPath' has already been declared`:

```js
const configPath = join(loreDir, 'config.yml');
const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
const docsConfig = parseConfigDocsAxis(configText);
const language = parseConfigLanguage(configText);
if (docsConfig) {
  const docsPages = buildDocsAxis(loreDir, repoRoot, docsConfig);
  if (docsPages.length) axisPages.docs = docsPages;
}
```

Then, after `if (!existsSync(wikiDir)) mkdirSync(...)` and **before** writing `INDEX.md`, write HOME:

```js
const pkgPath = join(repoRoot, 'package.json');
let version = 'unknown';
try { version = JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? 'unknown'; } catch {}

const homePath = join(wikiDir, 'HOME.md');
const existingHome = existsSync(homePath) ? readFileSync(homePath, 'utf8') : defaultHomePage({ title: 'lore', axisPages });
const homeStatus = buildHomeStatus({
  version, codeSha, lastUpdated, axisPages, language,
  translationStats: translationStats({ wikiDir, axisPages, language }),
});
writeFileSync(homePath, stampFrontmatter(finalizeHomeText(existingHome, homeStatus), {
  codeSha,
  lastUpdated,
  atoms: allAtoms.length,
  commits: allAtoms.filter(a => a.kind === 'commit').length,
}));
```

`runManifestCli(loreDir, now)` stays as the last call — Task 6 makes it re-read config + preferences itself, so no extra argument is needed here. HOME.md is on disk before the manifest is emitted, so the `HOME` axis lands first.

- [ ] **Step 7: Run tests**

Run:

```bash
node --test test/home.test.js test/sync.test.js test/manifest.test.js
```

Expected: selected tests pass after adjusting `runManifestCli` in Task 6 if needed.

- [ ] **Step 8: Commit**

```bash
git add lib/home.js lib/sync.js test/home.test.js test/sync.test.js
git commit -m "feat(sync): generate human home page"
```

---

## Task 5: Init Config Language Defaults

**Files:**
- Modify: `lib/init.js`
- Modify: `test/init.test.js`

- [ ] **Step 1: Write failing test**

Append to `test/init.test.js`:

```js
test('renderConfigYaml includes language defaults', () => {
  const out = renderConfigYaml(['lib']);
  assert.match(out, /language:/);
  assert.match(out, /default: en/);
  assert.match(out, /available: \[en\]/);
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
node --test test/init.test.js
```

Expected: fail because config template has no `language` block.

- [ ] **Step 3: Update config template**

In `lib/init.js`, update `renderConfigYaml` output so the generated YAML starts with:

```yaml
language:
  default: en                 # repo primary wiki language
  available: [en]             # add zh when translated pages are desired

axes:
```

Keep the existing axes config below it.

- [ ] **Step 4: Run tests**

Run:

```bash
node --test test/init.test.js test/config.test.js
```

Expected: selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/init.js test/init.test.js
git commit -m "feat(init): include language defaults"
```

---

## Task 6: Manifest CLI Reads Language and Preferences

**Files:**
- Modify: `lib/manifest.js`
- Modify: `test/manifest.test.js`

> The single `configText` read in `finalizeSync` was already established in Task 4, so this task only touches `runManifestCli` in `lib/manifest.js` — no `lib/sync.js` edit.

- [ ] **Step 1: Write failing test**

Append to `test/manifest.test.js`:

```js
test('runManifestCli reads language config and user preferences', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mf-lang-cli-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    mkdirSync(join(root, '.lore', 'wiki'), { recursive: true });
    mkdirSync(join(root, '.lore', '.state'), { recursive: true });
    writeFileSync(join(root, '.lore', 'config.yml'), 'language:\n  default: zh\n  available: [zh, en]\n');
    writeFileSync(join(root, '.lore', '.state', 'preferences.json'), '{"language":"en"}\n');
    writeFileSync(join(root, '.lore', 'wiki', 'HOME.md'), '---\ntitle: Home\nsummary: h\n---\n# Home');
    writeFileSync(join(root, 'f.txt'), 'hi');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });

    runManifestCli(join(root, '.lore'), 'now');
    const m = JSON.parse(readFileSync(join(root, '.lore', 'wiki', '.manifest.json'), 'utf8'));
    assert.deepEqual(m.language, { default: 'zh', available: ['zh', 'en'] });
    assert.deepEqual(m.user_preferences, { language: 'en' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
node --test test/manifest.test.js
```

Expected: fail because `runManifestCli` does not read config/preferences.

- [ ] **Step 3: Update `runManifestCli`**

Modify imports in `lib/manifest.js`:

```js
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseConfigLanguage } from './config.js';
import { readPreferences } from './i18n.js';
```

Update `runManifestCli`:

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
  const out = join(wikiDir, '.manifest.json');
  writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  return out;
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
node --test test/manifest.test.js test/sync.test.js
```

Expected: selected tests pass. (`finalizeSync` already reads a single `configText` from Task 4; this task only changed `runManifestCli`.)

- [ ] **Step 5: Commit**

```bash
git add lib/manifest.js test/manifest.test.js
git commit -m "feat(manifest): read language and preferences"
```

---

## Task 7: Shell Language Resolution

**Files:**
- Modify: `site/shell.mjs`
- Modify: `test/shell.test.js`

- [ ] **Step 1: Write failing tests**

Append to `test/shell.test.js`:

```js
import { chooseInitialLanguage, resolveLocalizedPage } from '../site/shell.mjs';

test('chooseInitialLanguage prefers saved language when available', () => {
  const manifest = { language: { default: 'zh', available: ['zh', 'en'] }, user_preferences: { language: 'zh' } };
  assert.equal(chooseInitialLanguage(manifest, 'en'), 'en');
  assert.equal(chooseInitialLanguage(manifest, 'ja'), 'zh');
  assert.equal(chooseInitialLanguage(manifest, null), 'zh');
});

test('resolveLocalizedPage returns base page for default language', () => {
  const page = { path: 'component/lib.md', lang: 'zh', translations: [{ lang: 'en', path: 'component/lib.en.md', stale: false }] };
  assert.deepEqual(resolveLocalizedPage(page, 'zh'), {
    path: 'component/lib.md',
    lang: 'zh',
    missing: false,
    stale: false,
  });
});

test('resolveLocalizedPage returns ready translation for selected language', () => {
  const page = { path: 'component/lib.md', lang: 'zh', translations: [{ lang: 'en', path: 'component/lib.en.md', stale: false }] };
  assert.deepEqual(resolveLocalizedPage(page, 'en'), {
    path: 'component/lib.en.md',
    lang: 'en',
    missing: false,
    stale: false,
  });
});

test('resolveLocalizedPage falls back to base page when translation is missing or stale', () => {
  const missing = { path: 'component/lib.md', lang: 'zh', translations: [] };
  assert.deepEqual(resolveLocalizedPage(missing, 'en'), {
    path: 'component/lib.md',
    lang: 'en',
    missing: true,
    stale: false,
  });
  const stale = { path: 'component/lib.md', lang: 'zh', translations: [{ lang: 'en', path: 'component/lib.en.md', stale: true }] };
  assert.deepEqual(resolveLocalizedPage(stale, 'en'), {
    path: 'component/lib.md',
    lang: 'en',
    missing: false,
    stale: true,
  });
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
node --test test/shell.test.js
```

Expected: fail because exports are missing.

- [ ] **Step 3: Implement shell helpers**

Add to `site/shell.mjs`:

```js
export function chooseInitialLanguage(manifest, saved) {
  const cfg = manifest.language ?? { default: 'en', available: ['en'] };
  if (saved && cfg.available.includes(saved)) return saved;
  const preferred = manifest.user_preferences?.language;
  if (preferred && cfg.available.includes(preferred)) return preferred;
  return cfg.default;
}

export function resolveLocalizedPage(page, selectedLang) {
  if (!page) return null;
  if (!selectedLang || selectedLang === page.lang) {
    return { path: page.path, lang: page.lang, missing: false, stale: false };
  }
  const found = (page.translations ?? []).find(t => t.lang === selectedLang);
  if (!found) return { path: page.path, lang: selectedLang, missing: true, stale: false };
  if (found.stale) return { path: page.path, lang: selectedLang, missing: false, stale: true };
  return { path: found.path, lang: selectedLang, missing: false, stale: false };
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
node --test test/shell.test.js
```

Expected: shell tests pass.

- [ ] **Step 5: Commit**

```bash
git add site/shell.mjs test/shell.test.js
git commit -m "feat(shell): resolve localized pages"
```

---

## Task 8: Shell UI for Language Switching and Translation Requests

**Files:**
- Modify: `site/index.html`
- Modify: `site/shell.mjs`
- Modify: `test/shell.test.js`

- [ ] **Step 1: Add language selector markup**

In `site/index.html`, add a language select beside the theme select:

```html
<select id="language" title="Language"></select>
```

Add a translation action container inside `#meta` rendering by route:

```html
<div id="translate-state"></div>
```

If placing inside `#meta` conflicts with current structure, render the action as the last chip in `#meta`.

Also add explicit sidebar dot colors for the root axes in the `<style>` block — the existing `.dot.*` rules are keyed by lowercase axis id, but the `HOME`/`INDEX` axis ids are uppercase, so without these their nav dots render blank:

```css
.dot.HOME { background: var(--accent); }
.dot.INDEX { background: var(--fg-dim); }
```

- [ ] **Step 2: Update imports**

Change the import block in `site/index.html`:

```js
import {
  stripFrontmatter, renderMarkdown, buildPageIndex, preprocessWikilinks,
  buildNavModel, buildMeta, chooseInitialLanguage, resolveLocalizedPage,
} from './shell.mjs';
```

- [ ] **Step 3: Add selected language state**

After `let MANIFEST = ...`:

```js
let SELECTED_LANG = 'en';
```

In `boot()` after manifest fetch:

```js
SELECTED_LANG = chooseInitialLanguage(MANIFEST, localStorage.getItem('lore-language'));
wireLanguage();
```

- [ ] **Step 4: Implement `wireLanguage`**

Add to `site/index.html`:

```js
function wireLanguage() {
  const sel = document.getElementById('language');
  const cfg = MANIFEST.language ?? { default: 'en', available: ['en'] };
  sel.innerHTML = cfg.available.map(lang => `<option value="${lang}">${lang}</option>`).join('');
  sel.value = SELECTED_LANG;
  sel.style.display = cfg.available.length > 1 ? '' : 'none';
  sel.addEventListener('change', async () => {
    SELECTED_LANG = sel.value;
    localStorage.setItem('lore-language', SELECTED_LANG);
    try {
      await fetch('../api/preferences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ language: SELECTED_LANG }),
      });
    } catch {}
    route();
  });
}
```

- [ ] **Step 5: Use localized routing**

In `route()`, replace:

```js
const raw = await (await fetch('../wiki/' + page.path)).text();
```

with:

```js
const localized = resolveLocalizedPage(page, SELECTED_LANG);
const raw = await (await fetch('../wiki/' + localized.path)).text();
```

After content rendering, append translation state into `#meta`:

```js
document.getElementById('meta').innerHTML = renderMeta(page) + renderTranslateState(page, localized);
```

Add:

```js
function renderTranslateState(page, localized) {
  if (!localized.missing && !localized.stale) return '';
  const text = localized.stale ? `translation stale: ${localized.lang}` : `translation missing: ${localized.lang}`;
  return `<button id="translate-page" class="chip stale" data-page="${page.path}" data-lang="${localized.lang}">${text}</button>`;
}
```

After rendering Mermaid in `route()`, wire the button:

```js
const translateBtn = document.getElementById('translate-page');
if (translateBtn) {
  translateBtn.onclick = async () => {
    translateBtn.disabled = true;
    translateBtn.textContent = 'translation requested';
    try {
      await fetch('../api/translation-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page: translateBtn.dataset.page, target_lang: translateBtn.dataset.lang }),
      });
    } catch {
      translateBtn.textContent = `run: node lib/translate.js plan .lore ${translateBtn.dataset.page} ${translateBtn.dataset.lang}`;
    }
  };
}
```

- [ ] **Step 6: Run shell tests**

Run:

```bash
node --test test/shell.test.js
```

Expected: tests pass. `site/index.html` is browser-integrated and covered by manual serve check in Task 13.

- [ ] **Step 7: Commit**

```bash
git add site/index.html site/shell.mjs test/shell.test.js
git commit -m "feat(shell): add language switcher"
```

---

## Task 9: Local Server APIs

**Files:**
- Modify: `server.js`
- Create: `test/server-api.test.js`

- [ ] **Step 1: Write failing API tests**

Create `test/server-api.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-api-')); }

async function withServer(root, fn) {
  const server = createServer(root);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try { await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('POST /api/preferences writes .state/preferences.json', async () => {
  const root = tmp();
  try {
    mkdirSync(join(root, 'site'), { recursive: true });
    await withServer(root, async base => {
      const res = await fetch(base + '/api/preferences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ language: 'zh' }),
      });
      assert.equal(res.status, 200);
    });
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.state', 'preferences.json'), 'utf8')), { language: 'zh' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('POST /api/translation-requests appends ndjson request', async () => {
  const root = tmp();
  try {
    mkdirSync(join(root, 'wiki', 'component'), { recursive: true });
    writeFileSync(join(root, 'wiki', 'component', 'lib.md'), '---\ntitle: Lib\n---\n# Lib\nbody\n');
    await withServer(root, async base => {
      const res = await fetch(base + '/api/translation-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page: 'component/lib.md', target_lang: 'en' }),
      });
      assert.equal(res.status, 200);
    });
    const lines = readFileSync(join(root, '.state', 'translation-requests.ndjson'), 'utf8').trim().split('\n');
    const request = JSON.parse(lines[0]);
    assert.equal(request.page, 'component/lib.md');
    assert.equal(request.target_lang, 'en');
    assert.match(request.source_hash, /^sha256:/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
node --test test/server-api.test.js
```

Expected: fail with 404 for API routes.

- [ ] **Step 3: Implement API routes**

In `server.js`, expand imports:

```js
import { appendFileSync, createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep, extname } from 'node:path';
import { translationSourceHash } from './lib/i18n.js';
```

Add helper functions:

```js
async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || '{}');
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value) + '\n');
}

function safeWikiPage(root, rel) {
  if (!/^[A-Za-z0-9_./-]+\.md$/.test(rel)) return null;
  const full = normalize(join(root, 'wiki', rel));
  const wikiRoot = normalize(join(root, 'wiki'));
  if (full !== wikiRoot && full.startsWith(wikiRoot + sep)) return full;
  return null;
}
```

At the top of the request handler, before static file handling:

```js
if (req.method === 'POST' && pathname === '/api/preferences') {
  try {
    const body = await readJson(req);
    const lang = String(body.language ?? '');
    if (!/^[a-z]{2}(?:-[A-Za-z0-9]+)?$/.test(lang)) return sendJson(res, 400, { error: 'invalid language' });
    const out = join(root, '.state', 'preferences.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ language: lang }, null, 2) + '\n');
    return sendJson(res, 200, { ok: true });
  } catch {
    return sendJson(res, 400, { error: 'bad json' });
  }
}

if (req.method === 'POST' && pathname === '/api/translation-requests') {
  try {
    const body = await readJson(req);
    const page = String(body.page ?? '');
    const targetLang = String(body.target_lang ?? '');
    const full = safeWikiPage(root, page);
    if (!full || !/^[a-z]{2}(?:-[A-Za-z0-9]+)?$/.test(targetLang)) return sendJson(res, 400, { error: 'invalid request' });
    const text = readFileSync(full, 'utf8');
    const request = {
      ts: new Date().toISOString(),
      page,
      target_lang: targetLang,
      source_hash: translationSourceHash(text),
    };
    const out = join(root, '.state', 'translation-requests.ndjson');
    mkdirSync(dirname(out), { recursive: true });
    appendFileSync(out, JSON.stringify(request) + '\n');
    return sendJson(res, 200, { ok: true, request });
  } catch {
    return sendJson(res, 400, { error: 'bad request' });
  }
}
```

Because this uses `await`, change the handler passed to `http.createServer` to `async (req, res) => { ... }`.

- [ ] **Step 4: Run tests**

Run:

```bash
node --test test/server-api.test.js test/serve.test.js
```

Expected: server API and existing serve tests pass.

- [ ] **Step 5: Commit**

```bash
git add server.js test/server-api.test.js
git commit -m "feat(server): add local wiki state APIs"
```

---

## Task 10: Translation Plan and Finalize Command

**Files:**
- Create: `lib/translate.js`
- Create: `test/translate.test.js`
- Create: `commands/translate.md`

- [ ] **Step 1: Write failing tests**

Create `test/translate.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planTranslation, finalizeTranslation } from '../lib/translate.js';
import { translationSourceHash } from '../lib/i18n.js';

// finalizeTranslation regenerates the manifest, which needs a real git sha,
// so each fixture is a tiny git repo (mirrors test/sync.test.js gitRepo()).
function tmp() {
  const root = mkdtempSync(join(tmpdir(), 'lore-translate-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  writeFileSync(join(root, 'f.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  return root;
}

test('planTranslation returns source, target path, and hash', () => {
  const root = tmp();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki', 'component'), { recursive: true });
    writeFileSync(join(lore, 'wiki', 'component', 'lib.md'), '---\ntitle: Lib\nsummary: core\n---\n# Lib\nbody');
    const plan = planTranslation(lore, 'component/lib.md', 'en');
    assert.equal(plan.source_path, 'component/lib.md');
    assert.equal(plan.target_path, 'component/lib.en.md');
    assert.equal(plan.target_lang, 'en');
    assert.match(plan.source_hash, /^sha256:/);
    assert.match(plan.source_body, /# Lib/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('finalizeTranslation stamps sidecar frontmatter', () => {
  const root = tmp();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki', 'component'), { recursive: true });
    const source = '---\ntitle: Lib\nsummary: core\n---\n# Lib\nbody';
    writeFileSync(join(lore, 'wiki', 'component', 'lib.md'), source);
    writeFileSync(join(lore, 'wiki', 'component', 'lib.en.md'), '# Lib\ntranslated');
    finalizeTranslation(lore, 'component/lib.md', 'en', '2026-06-06T00:00:00Z');
    const out = readFileSync(join(lore, 'wiki', 'component', 'lib.en.md'), 'utf8');
    assert.match(out, /lang: en/);
    assert.match(out, /translation_of: component\/lib.md/);
    assert.match(out, new RegExp(`translation_source_hash: ${translationSourceHash(source)}`));
    assert.match(out, /last_updated: 2026-06-06/);
    assert.match(out, /# Lib\ntranslated/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
node --test test/translate.test.js
```

Expected: fail because `lib/translate.js` does not exist.

- [ ] **Step 3: Implement `lib/translate.js`**

Create `lib/translate.js`:

```js
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { parseFrontmatter, runManifestCli } from './manifest.js';
import { translationPathFor, translationSourceHash } from './i18n.js';

function safePage(loreDir, rel) {
  if (!/^[A-Za-z0-9_./-]+\.md$/.test(rel)) throw new Error(`invalid page path: ${rel}`);
  const wiki = normalize(join(loreDir, 'wiki'));
  const full = normalize(join(wiki, rel));
  if (full !== wiki && !full.startsWith(wiki + sep)) throw new Error(`page escapes wiki: ${rel}`);
  return full;
}

export function planTranslation(loreDir, pagePath, targetLang) {
  const sourceFull = safePage(loreDir, pagePath);
  if (!existsSync(sourceFull)) throw new Error(`source page not found: ${pagePath}`);
  const text = readFileSync(sourceFull, 'utf8');
  const { data, body } = parseFrontmatter(text);
  return {
    source_path: pagePath,
    target_path: translationPathFor(pagePath, targetLang),
    target_lang: targetLang,
    source_hash: translationSourceHash(text),
    title: data.title ?? '',
    summary: data.summary ?? '',
    source_body: body,
    instructions: [
      'Translate Markdown prose into the target language.',
      'Keep code fences, wikilinks, tables, frontmatter meaning, and Mermaid syntax intact.',
      'Write only the translated Markdown body to target_path before finalize.',
    ],
  };
}

export function finalizeTranslation(loreDir, pagePath, targetLang, nowIso = new Date().toISOString()) {
  const plan = planTranslation(loreDir, pagePath, targetLang);
  const targetFull = safePage(loreDir, plan.target_path);
  if (!existsSync(targetFull)) throw new Error(`translation page not found: ${plan.target_path}`);
  const target = readFileSync(targetFull, 'utf8');
  const { data, body } = parseFrontmatter(target);
  const title = data.title ?? plan.title;
  const summary = data.summary ?? plan.summary;
  const fm = [
    '---',
    `title: ${title}`,
    `summary: ${summary}`,
    `lang: ${targetLang}`,
    `translation_of: ${pagePath}`,
    `translation_source_hash: ${plan.source_hash}`,
    `last_updated: ${nowIso.slice(0, 10)}`,
    '---',
    '',
  ].join('\n');
  mkdirSync(dirname(targetFull), { recursive: true });
  writeFileSync(targetFull, fm + body);
  runManifestCli(loreDir, nowIso);
  return plan.target_path;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , sub, loreDir, pagePath, targetLang] = process.argv;
  if (!sub || !loreDir || !pagePath || !targetLang) {
    console.error('usage: node lib/translate.js <plan|finalize> <loreDir> <pagePath> <targetLang>');
    process.exit(1);
  }
  if (sub === 'plan') {
    console.log(JSON.stringify(planTranslation(loreDir, pagePath, targetLang), null, 2));
  } else if (sub === 'finalize') {
    console.log(`wrote ${finalizeTranslation(loreDir, pagePath, targetLang)}`);
  } else {
    console.error(`unknown subcommand: ${sub}`);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Create command docs**

Create `commands/translate.md`:

```markdown
# /lore:translate

Translate one wiki page into a target language sidecar.

1. Run `node lib/translate.js plan <loreDir> <pagePath> <targetLang>`.
2. Read `source_body`, translate prose, and write the Markdown body to `target_path`.
3. Run `node lib/translate.js finalize <loreDir> <pagePath> <targetLang>`.
4. Review the sidecar diff and `.lore/wiki/.manifest.json`.

Keep code fences, wikilinks, Mermaid syntax, tables, and command names unchanged unless the surrounding prose requires translation.
```

- [ ] **Step 5: Run tests**

Run:

```bash
node --test test/translate.test.js test/manifest.test.js
```

Expected: selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/translate.js test/translate.test.js commands/translate.md
git commit -m "feat(translate): add sidecar translation command"
```

---

## Task 11: Serve Runtime Preference

**Files:**
- Modify: `lib/serve.js`
- Modify: `test/serve.test.js`

- [ ] **Step 1: Write failing test**

Append to `test/serve.test.js`:

```js
test('probeRuntime can prefer node for local APIs', () => {
  const r = probeRuntime(cmd => cmd === 'python3', { preferNode: true });
  assert.equal(r.kind, 'node');
  assert.equal(r.cmd, process.execPath);
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
node --test test/serve.test.js
```

Expected: fail because `probeRuntime` does not accept `preferNode`.

- [ ] **Step 3: Update runtime selection**

In `lib/serve.js`, change `probeRuntime` signature:

```js
export function probeRuntime(canRun = defaultCanRun, { preferNode = false } = {}) {
  if (preferNode) return nodeRuntime();
  ...
}
```

Extract current Node fallback object to:

```js
function nodeRuntime() {
  return {
    kind: 'node',
    cmd: process.execPath,
    buildArgs: (port, dir) => [join(dirname(fileURLToPath(import.meta.url)), '..', 'server.js'), dir, String(port)],
  };
}
```

Add an import at the top of `lib/serve.js`:

```js
import { parseConfigLanguage } from './config.js';
```

In `start`, prefer the Node server **only when the repo is bilingual** — the preferences + translation-request APIs only matter when `available` has more than one language. Replace `const runtime = probeRuntime(can);` with:

```js
const cfgPath = join(loreDir, 'config.yml');
const language = existsSync(cfgPath)
  ? parseConfigLanguage(readFileSync(cfgPath, 'utf8'))
  : { default: 'en', available: ['en'] };
const runtime = probeRuntime(can, { preferNode: language.available.length > 1 });
```

Monolingual repos keep using the Python static server when present; only bilingual repos force Node so the local write APIs are available. (`lib/serve.js` already imports `readFileSync`, `existsSync`, and `join`.)

- [ ] **Step 4: Run tests**

Run:

```bash
node --test test/serve.test.js test/server-api.test.js
```

Expected: selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/serve.js test/serve.test.js
git commit -m "feat(serve): prefer node server for local APIs"
```

---

## Task 12: Sync Command Prompt Updates

**Files:**
- Modify: `commands/sync.md`
- Modify: `test/sync.test.js`

- [ ] **Step 1: Update sync command instructions**

In `commands/sync.md`, add a HOME section to the page-writing instructions:

```markdown
## HOME page

When the worklist contains `{ "axis": "HOME", "id": "HOME" }`, write `.lore/wiki/HOME.md`.

The page must follow this order:

1. One-sentence repository positioning.
2. `{{LORE_HOME_STATUS}}` on its own line.
3. A `## Knowledge flow` section with a Mermaid diagram.
4. A `## Understand the project` section with wikilinks.
5. A `## Debug a problem` section with wikilinks.
6. A `## Decisions and timeline` section with wikilinks.

Do not write mechanical status values by hand; finalize replaces the token.
```

- [ ] **Step 2: Add a command-doc smoke test**

If there is an existing command docs test, extend it. If not, append to `test/sync.test.js`:

```js
test('commands/sync.md documents HOME work item', () => {
  const doc = readFileSync(join(process.cwd(), 'commands', 'sync.md'), 'utf8');
  assert.match(doc, /HOME page/);
  assert.match(doc, /\{\{LORE_HOME_STATUS\}\}/);
  assert.match(doc, /Knowledge flow/);
});
```

- [ ] **Step 3: Run tests**

Run:

```bash
node --test test/sync.test.js
```

Expected: sync tests pass.

- [ ] **Step 4: Commit**

```bash
git add commands/sync.md test/sync.test.js
git commit -m "docs(sync): describe home page generation"
```

---

## Task 13: Full Verification and Manual Browser Check

**Files:**
- No source edits expected.

- [ ] **Step 1: Run full test suite**

Run:

```bash
node --test
```

Expected: all tests pass.

- [ ] **Step 2: Run sync on this repo**

Run (this repo dogfoods its own `.lore`, so use the worktree-relative path; the shell here is bash):

```bash
node lib/sync.js finalize .lore
```

Expected:

```text
✓ sync finalized: ...
  next: /lore:serve
```

Also verify HOME exists and that re-syncing does **not** stack duplicate status blocks (proves the sentinel region is idempotent):

```bash
test -f .lore/wiki/HOME.md && echo "HOME ok"
node lib/sync.js finalize .lore            # run a second time
grep -c '## Status' .lore/wiki/HOME.md     # expect: 1
```

- [ ] **Step 3: Start server**

Run:

```bash
node lib/serve.js start --lore .lore --port 7842
```

Expected: output includes `http://127.0.0.1:7842/site/`.

- [ ] **Step 4: Browser smoke check**

Open:

```text
http://127.0.0.1:7842/site/
```

Verify:

- First page is Home.
- Sidebar lists Home before INDEX.
- HOME includes status, knowledge flow, project/debug/decision sections.
- Language selector appears when `available` contains more than one language.
- Switching language persists after refresh.
- Missing translation button creates `.lore/.state/translation-requests.ndjson`.

- [ ] **Step 5: Lint docs state**

Run:

```bash
node lib/lint.js .lore
```

Expected: no new HOME/translation-specific lint errors. Existing stale/unfolded warnings can be handled separately if they predate this work.

- [ ] **Step 6: Commit verification changes**

If Task 13 changed generated `.lore/wiki` files that the project intentionally tracks, commit them:

```bash
git add .lore/wiki .lore/site
git commit -m "chore(wiki): refresh home and manifest"
```

If `.lore/wiki` changes are not intended for the implementation branch, leave them unstaged and document the verification output in the PR.

---

## Self-Review

- Spec coverage: HOME first page, HOME order, repo/user language config, persistent switching, page-triggered translation requests, sidecar persistence, manifest language metadata, and graph-friendly metadata are covered by tasks.
- Placeholder scan: no empty tasks or vague test-only steps remain.
- Type consistency: `language.default`, `language.available`, `translations[].source_hash`, `translation_source_hash`, `target_lang`, and `HOME_STATUS_TOKEN` names are consistent across tasks.
- Risk note: Task 4 owns the single `configText` read in `finalizeSync` (docs + language from one read); Task 6 only changes `runManifestCli`. HOME status lives inside a sentinel-delimited region (`<!-- LORE_HOME_STATUS:START/END -->`) so re-sync swaps it in place instead of stacking duplicate `## Status` blocks. `finalizeTranslation` regenerates the manifest, so its tests run inside a git repo. Adding HOME as the first `planSync` work item requires updating three existing `planSync` tests (folded into Task 4). `translationStats` is computed by scanning sidecars on disk, not from `axisPages` entries, so the HOME counts are real.
