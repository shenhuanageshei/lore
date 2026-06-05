# lore docs 轴 v2 + mermaid 懒加载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** docs 页嵌入文档全文（解薄页 + 404）、docs 轴按时间降序、mermaid 仅在有图页才加载。

**Architecture:** 仍零依赖 / 物化视图 / 确定性。`lib/docs.js`：3 extractor 加 `body`、`renderDocsPage` 改嵌入正文 + 纯文本源引用、`buildDocsAxis` 按 date 降序。`lib/manifest.js`：`emitManifest` 对 docs 轴页按 `last_updated` 降序。`site/index.html`：删静态 mermaid script，改 promise 缓存的按需注入。

**Tech Stack:** Node 内置 · `node --test` · 浏览器壳。

**Spec:** `docs/superpowers/specs/2026-06-05-lore-docs-axis-v2-design.md`

---

## File Structure
- `lib/docs.js` — Modify：`docsExtractor`/`changelogExtractor` 加 `body`；`renderDocsPage` 重写嵌入；`buildDocsAxis` 加 date 排序。
- `lib/manifest.js` — Modify：`emitManifest` docs 轴 date 排序。
- `site/index.html` — Modify：mermaid 懒加载（壳 only，无单测）。
- `test/docs.test.js`、`test/manifest.test.js` — Modify。

**page-spec（本轮扩展）：** `{ id, title, summary, sourcePath, date, body?, entries? }` —— `body`（可选）= 嵌入用源文档正文。

---

## Task 1: extractors 加 `body`（TDD）

**Files:** Modify `lib/docs.js` · Modify `test/docs.test.js`

- [ ] **Step 1: 失败测试** — append 到 `test/docs.test.js`：
```js
test('docsExtractor: spec carries body (front-matter stripped)', () => {
  const root = tmp();
  try {
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'a.md'), '---\ntitle: A\n---\n# A\n\npara body\n');
    const s = docsExtractor(root, 'docs/**/*.md')[0];
    assert.equal(s.body, '# A\n\npara body\n');   // FM stripped, rest verbatim
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('changelogExtractor: spec carries CHANGELOG body', () => {
  const root = tmp();
  try {
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [0.1.0] — 2026-06-03\n- x\n');
    const s = changelogExtractor(root)[0];
    assert.match(s.body, /# Changelog/);
    assert.match(s.body, /## \[0\.1\.0\]/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑，确认失败** — `node --test test/docs.test.js` → FAIL（`s.body` undefined）。

- [ ] **Step 3: 实现** — `lib/docs.js`：
  - `docsExtractor` 的 `return rels.map(...)` 对象里加一行 `body`：
```js
    return {
      id: slugifyDocPath(rel),
      title: extractTitle(text, fallback),
      summary: extractSummary(text),
      sourcePath: `${prefix}/${rel}`,
      date: extractDate(rel),
      body: parseFrontmatter(text).body,
    };
```
  - `changelogExtractor` 的返回对象里加 `body`（CHANGELOG 无 FM → body = 全文）：
```js
  return [{
    id: 'changelog',
    title: 'CHANGELOG',
    summary: `${entries.length} 个版本，最新 ${entries[0].version}`,
    sourcePath: 'CHANGELOG.md',
    date: (entries.find(e => e.date) || entries[0]).date,
    entries,
    body: parseFrontmatter(text).body,
  }];
```
  - `pitfallsExtractor` 不动（无 body，仍走 entries）。

- [ ] **Step 4: 跑，确认通过** — `node --test test/docs.test.js` → PASS（新 2 + 原有全过）。

- [ ] **Step 5: 提交**
```bash
git add lib/docs.js test/docs.test.js
git commit -m "feat(docs): extractors carry source body for embedding"
```

---

## Task 2: renderDocsPage 嵌入正文 + 纯文本源引用（TDD）

**Files:** Modify `lib/docs.js`（`renderDocsPage`，现 line 131-136）· Modify `test/docs.test.js`

- [ ] **Step 1: 失败测试** — 替换/更新 `test/docs.test.js` 里现有的两个 renderDocsPage 测试（它们断言旧的薄页格式，会与新格式冲突）。先删掉这两个旧测试：
  - `'renderDocsPage: plain doc spec → front-matter + summary + source link'`
  - `'renderDocsPage: spec with entries (changelog) → bullet list'`
  - `'renderDocsPage: pitfalls entries → problem + 修复/预防 tail'`
  并 append 这三个新测试：
```js
test('renderDocsPage: spec with body → embeds body, plain-text source ref, no link, no # docs:', () => {
  const md = renderDocsPage({ id: 'a', title: 'Doc A', summary: 'about A', sourcePath: 'docs/a.md', date: '2026-06-04', body: '# Doc A\n\nfull content here.\n' });
  assert.match(md, /^---\ntitle: Doc A\nsummary: about A\nsource_path: docs\/a\.md\nlast_updated: 2026-06-04\n---/);
  assert.match(md, /> 源文档：`docs\/a\.md`/);     // plain-text reference
  assert.match(md, /# Doc A\n\nfull content here\./); // body embedded verbatim
  assert.doesNotMatch(md, /\]\(\.\.\/\.\.\/\.\.\//);  // NO markdown link → no 404
  assert.doesNotMatch(md, /# docs:/);                 // no double-H1 wrapper
});

test('renderDocsPage: pitfalls (no body, has entries) → # title + entries list', () => {
  const md = renderDocsPage({ id: 'pitfalls', title: 'Pitfalls', summary: '1 条', sourcePath: 'CLAUDE.md', date: '', entries: [{ problem: 'P', fix: 'F', prevention: 'V' }] });
  assert.match(md, /> 源文档：`CLAUDE\.md`/);
  assert.match(md, /# Pitfalls/);
  assert.match(md, /- \*\*P\*\* — 修复：F；预防：V/);
});

test('renderDocsPage: changelog body embeds (entries not rendered as list)', () => {
  const md = renderDocsPage({ id: 'changelog', title: 'CHANGELOG', summary: '1 版本', sourcePath: 'CHANGELOG.md', date: '2026-06-03', entries: [{ version: '0.1.0', date: '2026-06-03' }], body: '# Changelog\n\n## [0.1.0] — 2026-06-03\n- x\n' });
  assert.match(md, /# Changelog/);
  assert.match(md, /## \[0\.1\.0\]/);
  assert.doesNotMatch(md, /- \*\*0\.1\.0\*\* —/);  // entries NOT rendered (body present wins)
});
```

- [ ] **Step 2: 跑，确认失败** — `node --test test/docs.test.js` → FAIL（旧 renderDocsPage 出 `# docs:` + markdown 链接）。

- [ ] **Step 3: 实现** — 替换 `renderDocsPage`（保留上方 `renderEntries` 不动）：
```js
export function renderDocsPage(spec) {
  const fm = `---\ntitle: ${spec.title}\nsummary: ${spec.summary}\nsource_path: ${spec.sourcePath}\nlast_updated: ${spec.date}\n---`;
  const ref = `> 源文档：\`${spec.sourcePath}\``;        // plain-text reference (not a link → no 404)
  const main = spec.body !== undefined
    ? spec.body                                          // embed the doc's body verbatim (its own H1 is the title)
    : `# ${spec.title}${renderEntries(spec.entries)}`;   // pitfalls etc.: header + entries list
  return `${fm}\n${ref}\n\n${main}\n`;
}
```

- [ ] **Step 4: 跑，确认通过** — `node --test test/docs.test.js` → PASS。

- [ ] **Step 5: 提交**
```bash
git add lib/docs.js test/docs.test.js
git commit -m "feat(docs): renderDocsPage embeds full body + plain-text source ref (no 404)"
```

---

## Task 3: buildDocsAxis 按 date 降序（TDD）

**Files:** Modify `lib/docs.js`（`buildDocsAxis`，现 line 144-158）· Modify `test/docs.test.js`

- [ ] **Step 1: 失败测试** — append 到 `test/docs.test.js`：
```js
test('buildDocsAxis: returns specs sorted by date desc (tiebreak id)', () => {
  const root = tmp();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', '2026-06-01-old.md'), '# Old\n\nx\n');
    writeFileSync(join(root, 'docs', '2026-06-10-new.md'), '# New\n\nx\n');
    writeFileSync(join(root, 'docs', '2026-06-05-mid.md'), '# Mid\n\nx\n');
    const pages = buildDocsAxis(lore, root, { sources: ['docs'], docsGlob: 'docs/**/*.md' });
    assert.deepEqual(pages.map(p => p.id), ['2026-06-10-new', '2026-06-05-mid', '2026-06-01-old']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑，确认失败** — `node --test test/docs.test.js` → FAIL（现按 walk 顺序，非 date 降序）。

- [ ] **Step 3: 实现** — `buildDocsAxis` 里，gather specs 的 for-loop 之后、`if (!specs.length)` 之前，加排序：
```js
  for (const src of docsConfig.sources) {
    const fn = EXTRACTORS[src];
    if (fn) specs.push(...fn(repoRoot, docsConfig));   // unknown source key → skip silently (config-gated)
  }
  specs.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.id.localeCompare(b.id));   // newest docs first
  if (!specs.length) return [];
```

- [ ] **Step 4: 跑，确认通过** — `node --test test/docs.test.js` → PASS。

- [ ] **Step 5: 提交**
```bash
git add lib/docs.js test/docs.test.js
git commit -m "feat(docs): buildDocsAxis returns specs sorted by date desc"
```

---

## Task 4: manifest docs 轴按 last_updated 降序（TDD）

**Files:** Modify `lib/manifest.js`（`emitManifest`，现 line 45-64）· Modify `test/manifest.test.js`

- [ ] **Step 1: 失败测试** — append 到 `test/manifest.test.js`（用其既有 import：`mkdtempSync`/`mkdirSync`/`writeFileSync`/`rmSync`/`join`/`tmpdir`/`emitManifest`；若缺则补，勿重复）：
```js
test('emitManifest: docs axis pages sorted by last_updated desc (other axes stay alpha)', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mf-docs-'));
  try {
    const wiki = join(root, 'wiki');
    mkdirSync(join(wiki, 'docs'), { recursive: true });
    const page = (d) => `---\ntitle: ${d}\nsummary: s\nlast_updated: ${d}\n---\nbody`;
    writeFileSync(join(wiki, 'docs', 'old.md'), page('2026-06-01'));
    writeFileSync(join(wiki, 'docs', 'new.md'), page('2026-06-10'));
    writeFileSync(join(wiki, 'docs', 'mid.md'), page('2026-06-05'));
    const m = emitManifest({ wikiDir: wiki, currentSha: 'abc', countCommitsSince: () => 0, now: 'now' });
    const docs = m.axes.find(a => a.id === 'docs');
    assert.deepEqual(docs.pages.map(p => p.id), ['new', 'mid', 'old']);   // date desc, not alpha (mid/new/old)
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑，确认失败** — `node --test test/manifest.test.js` → FAIL（现字母序 → `mid,new,old`）。

- [ ] **Step 3: 实现** — `lib/manifest.js` `emitManifest`，在非-INDEX 分支里、`for (const f of files)` push 完 pageEntry 之后、`builtAxes.push(...)` 之前，加：
```js
      if (ax.id === 'docs') {
        pages.sort((a, b) => (b.last_updated || '').localeCompare(a.last_updated || '') || a.id.localeCompare(b.id));
      }
```
（即放在 `builtAxes.push({ id: ax.id, label: ax.label, pages });` 紧前。）

- [ ] **Step 4: 跑，确认通过** — `node --test test/manifest.test.js` → PASS。再 `node --test`（全套）确认 0 fail。

- [ ] **Step 5: 提交**
```bash
git add lib/manifest.js test/manifest.test.js
git commit -m "feat(manifest): sort docs axis pages by last_updated desc"
```

---

## Task 5: mermaid 懒加载（`site/index.html`，浏览器手验）

**Files:** Modify `site/index.html`

你在编辑壳浏览器代码，无单测；做精确编辑 + 静态自检，浏览器渲染验证留给控制器（Step 5 不是你的活）。

- [ ] **Step 1: 删静态 script** — 删除 `site/index.html` 第 136 行：
```html
<script src="./mermaid.min.js"></script>
```
（保留紧随其后的 `<script type="module">`。）

- [ ] **Step 2: 加按需加载器** — 在 `const mapMermaidTheme = t => (t === 'dark' ? 'dark' : 'default');` 之后插入：
```js
let mermaidLoad = null;   // Promise once mermaid.min.js has been injected + initialized
function ensureMermaid() {
  if (!mermaidLoad) {
    mermaidLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = './mermaid.min.js';
      s.onload = () => {
        window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: mapMermaidTheme(document.documentElement.getAttribute('data-theme')) });
        resolve();
      };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  return mermaidLoad;
}
```

- [ ] **Step 3: route() 仅有图才加载** — 把 `route()` 里现有的 mermaid 块（`if (window.mermaid) { try { await mermaid.run(...) } catch {...} }`）替换为：
```js
  const mNodes = document.querySelectorAll('#content .mermaid');
  if (mNodes.length) {
    try { await ensureMermaid(); await window.mermaid.run({ nodes: mNodes }); }
    catch { /* missing asset or bad diagram: leave source text visible, page stays usable */ }
  }
```

- [ ] **Step 4: wireTheme 去掉加载期 init、change 仅在已载时重渲** — 把 `wireTheme()` 改为：
```js
function wireTheme() {
  const sel = document.getElementById('theme');
  const saved = localStorage.getItem('lore-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  sel.value = saved;
  sel.addEventListener('change', () => {
    document.documentElement.setAttribute('data-theme', sel.value);
    localStorage.setItem('lore-theme', sel.value);
    if (mermaidLoad) {   // mermaid already on this page → re-theme + re-render its diagrams
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: mapMermaidTheme(sel.value) });
      route();
    }
  });
}
```
（删掉了原加载期的 `window.mermaid?.initialize(...)`——mermaid 此刻尚未加载；初始化已移进 `ensureMermaid`。）

- [ ] **Step 5（控制器做，非你的活，跳过）：浏览器验证。**

- [ ] **静态自检（你能做）**：把 module 脚本体抽到临时 `.mjs` 跑 `node --check` 确认语法 OK（引用 `document`/`window` 仅解析不执行，无妨）；确认 `route()` 仍 `async`；确认全文件无残留 `<script src="./mermaid.min.js">`。

- [ ] **Step 6: 提交**
```bash
git add site/index.html
git commit -m "feat(shell): lazy-load mermaid only on pages that have a diagram"
```

## 约束（Task 1-5）
- post-commit hook 弄脏 `.lore/journal/*` —— 忽略，绝不 stage。每任务 `git add` 仅列出的文件。
- TDD（Task 1-4）：测试先失败再实现。

---

## Task 6: 端到端验证 + 全套绿 + dogfood（控制器做）

- [ ] `node --test` 全套 0 fail（基线 190 + 本轮新测；约 195+）。
- [ ] **浏览器手验**（Task 5）：刷新 `.lore/site` → serve → (a) 打开一个 docs 页（如 ROADMAP）→ 看到**全文嵌入** + `> 源文档：` 纯文本（点不动、无 404）；(b) docs 侧栏**新文档在上**（时间降序）；(c) 打开 component/lib（有 mermaid）→ 图渲染（懒加载）；(d) 一个无图 docs 页 → Network 里 **mermaid.min.js 未加载**。
- [ ] dogfood：lore 自身 `node lib/sync.js finalize .lore` → docs 页现含全文 + 时间序；提交 `.lore` 更新（可选）。
- [ ] 不变量：零依赖、零侵入（只写 `.lore/`）、物化视图（nuke+重建字节一致）。

---

## Self-Review（plan 对照 spec）
- **Spec coverage**：A 嵌入（extractor body→T1、renderDocsPage→T2）；B 时间序（buildDocsAxis→T3、manifest→T4）；C 懒加载→T5；验证→T6。全覆盖。
- **Placeholder scan**：每步完整代码/命令；无 TBD。删旧 renderDocsPage 测试已显式列出（T2 Step1）。
- **类型/名一致**：page-spec `body?`/`entries?`；`renderDocsPage` 用 `spec.body !== undefined`；排序规则 `(b.date||'').localeCompare(a.date||'')||a.id.localeCompare(b.id)`（buildDocsAxis 用 `date`，manifest 用 `last_updated`——各自字段名正确）；`ensureMermaid`/`mermaidLoad` 跨 T5 步骤一致。
- **顺序依赖**：T2 依赖 T1 的 `body` 字段；T6 验证依赖全部。编号已保证。
