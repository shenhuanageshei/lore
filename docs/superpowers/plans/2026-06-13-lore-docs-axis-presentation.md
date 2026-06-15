# lore docs 轴 + 呈现质量升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** docs 轴在「代码/文档在子目录」的项目上正确工作——自动发现文档目录 + 收元文档（含子目录的 CHANGELOG/README/ROADMAP）+ 通用分组（specs/plans/debugging/api 各成组、元文档独立置顶组）+ theme/flow 页排版标准。

**Architecture:** 新 `discoverDocs`（仿 `discoverComponents` 探测 + 排除噪音）；`docGroup` 从「只认 lore 自己路径」改为「元文档识别 + 语义子目录段映射」；元文档 extractor 加 `findMetaDoc` 子目录探测 + 新增 readme/roadmap；init 把发现结果写 config；theme/flow 写作标准进 axisPrompt + sync.md。

**Tech Stack:** 零依赖 Node ESM，node:test。Spec: `docs/superpowers/specs/2026-06-13-lore-docs-axis-presentation.md`。

**组名**（定死）：项目状态 / 设计 / 计划 / 架构 / 接口 / 调试 / 笔记 / 其它。

**纪律**：测试用 Write/Edit 绝不 heredoc；依赖 Edit 的 Bash 不并行发。

---

### Task 1: discoverDocs —— 探测文档目录 + 元文档位置

**Files:** Modify `lib/init.js`（加 discoverDocs + findMetaDoc）；Test `test/init.test.js` 追加

- [ ] **Step 1: 测试**（Edit `test/init.test.js` 追加；import 行加 `discoverDocs, findMetaDoc`）

```js
test('discoverDocs: 探测含≥3 md 的目录（排噪音）+ 子目录元文档', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-dd-'));
  try {
    // 代码+文档都在子目录 sub/（仿 threat-intel）
    mkdirSync(join(root, 'sub', 'docs', 'specs'), { recursive: true });
    for (const f of ['a.md', 'b.md', 'c.md']) writeFileSync(join(root, 'sub', 'docs', 'specs', f), '# x');
    writeFileSync(join(root, 'sub', 'CHANGELOG.md'), '## [1.0.0] — 2026-01-01');
    writeFileSync(join(root, 'sub', 'README.md'), '# proj');
    // 噪音：node_modules 里的 md 不算
    mkdirSync(join(root, 'sub', 'node_modules', 'pkg'), { recursive: true });
    for (const f of ['x.md', 'y.md', 'z.md', 'w.md']) writeFileSync(join(root, 'sub', 'node_modules', 'pkg', f), '# n');
    const r = discoverDocs(root);
    assert.ok(r.docsGlobs.some(g => g.replace(/\\/g, '/') === 'sub/docs/**/*.md'));
    assert.ok(!r.docsGlobs.some(g => g.includes('node_modules')));
    assert.deepEqual(r.metaDocs.find(m => m.kind === 'changelog')?.path.replace(/\\/g, '/'), 'sub/CHANGELOG.md');
    assert.deepEqual(r.metaDocs.find(m => m.kind === 'readme')?.path.replace(/\\/g, '/'), 'sub/README.md');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('findMetaDoc: 根优先，否则一层子目录（排噪音）；缺 → null', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-fm-'));
  try {
    assert.equal(findMetaDoc(root, 'CHANGELOG.md'), null);
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'app', 'CHANGELOG.md'), 'x');
    assert.equal(findMetaDoc(root, 'CHANGELOG.md').replace(/\\/g, '/'), 'app/CHANGELOG.md');
    writeFileSync(join(root, 'CHANGELOG.md'), 'x');                 // 根存在 → 根优先
    assert.equal(findMetaDoc(root, 'CHANGELOG.md'), 'CHANGELOG.md');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** `node --test test/init.test.js` → FAIL（discoverDocs/findMetaDoc 未导出）
- [ ] **Step 3: 实现**（Edit `lib/init.js`，加在 discoverComponents 之后；复用既有 EXCLUDE、isDir）

```js
// 文档目录探测：含 ≥3 个 .md 的目录（递归，排 EXCLUDE/点目录），取最浅不相交根。
function docDirsUnder(absDir, rel, hits, depth = 4) {
  if (depth < 0) return;
  let entries = [];
  try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  const mdCount = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md')).length;
  if (mdCount >= 3) { hits.push(rel); return; }                    // 命中即收，不再下钻（取最浅）
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || EXCLUDE.has(e.name)) continue;
    docDirsUnder(join(absDir, e.name), rel ? `${rel}/${e.name}` : e.name, hits, depth - 1);
  }
}

export function findMetaDoc(repoRoot, name) {
  if (existsSync(join(repoRoot, name))) return name;
  let entries = [];
  try { entries = readdirSync(repoRoot, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || EXCLUDE.has(e.name)) continue;
    if (existsSync(join(repoRoot, e.name, name))) return `${e.name}/${name}`;
  }
  return null;
}

export function discoverDocs(repoRoot) {
  const hits = [];
  docDirsUnder(repoRoot, '', hits);
  const docsGlobs = hits.map(h => `${h}/**/*.md`);
  const metaDocs = [];
  for (const [kind, name] of [['changelog', 'CHANGELOG.md'], ['readme', 'README.md'], ['roadmap', 'ROADMAP.md']]) {
    const p = findMetaDoc(repoRoot, name);
    if (p) metaDocs.push({ kind, path: p });
  }
  return { docsGlobs, metaDocs };
}
```

- [ ] **Step 4: Run** `node --test test/init.test.js` → PASS
- [ ] **Step 5: Commit** `feat(init): discoverDocs — find doc dirs + meta docs in subdirs, exclude noise`

---

### Task 2: docGroup 通用化 + GROUP_RANK

**Files:** Modify `lib/docs.js`（docGroup）、`lib/manifest.js`（GROUP_RANK）；Test `test/docs.test.js`（更新断言）

- [ ] **Step 1: 改测试**（Edit `test/docs.test.js:218-224` 整个 docGroup 测试）

```js
test('docGroup: 元文档→项目状态；语义子目录段映射；未知→其它；lore 自己兼容', () => {
  // 元文档（不论路径）
  assert.equal(docGroup('CHANGELOG.md'), '项目状态');
  assert.equal(docGroup('CLAUDE.md'), '项目状态');                  // pitfalls
  assert.equal(docGroup('threat-intel/README.md'), '项目状态');
  assert.equal(docGroup('docs/ROADMAP.md'), '项目状态');
  // 语义子目录段
  assert.equal(docGroup('docs/superpowers/specs/x-design.md'), '设计');
  assert.equal(docGroup('docs/superpowers/plans/x.md'), '计划');
  assert.equal(docGroup('threat-intel/docs/debugging/x.md'), '调试');
  assert.equal(docGroup('threat-intel/docs/api/x.md'), '接口');
  assert.equal(docGroup('threat-intel/docs/architecture/x.md'), '架构');
  assert.equal(docGroup('docs/superpowers/notes/y.md'), '笔记');
  // 未知
  assert.equal(docGroup('threat-intel/docs/DEPLOY.md'), '其它');
});
```

同时更新 `test/docs.test.js:126` 的 buildDocsAxis 断言：`docs/a.md` 无语义段、非元文档 → `其它`（原断言写的 `项目状态`，改为 `其它`）。

- [ ] **Step 2: Run** `node --test test/docs.test.js` → FAIL
- [ ] **Step 3: 实现**（Edit `lib/docs.js` docGroup）

```js
// 元文档（changelog/readme/roadmap/pitfalls，不论路径）独立置顶组；其余按语义子目录段。
const META_DOC_RE = /(^|\/)(changelog|readme|roadmap)\.md$|(^|\/)claude\.md$/i;
const SEMANTIC_DIR = {
  specs: '设计', spec: '设计', design: '设计', plans: '计划', plan: '计划',
  debugging: '调试', debug: '调试', api: '接口', architecture: '架构', arch: '架构',
  notes: '笔记', note: '笔记',
};
export function docGroup(sourcePath) {
  const p = (sourcePath ?? '').replace(/\\/g, '/');
  if (META_DOC_RE.test(p)) return '项目状态';
  for (const seg of p.toLowerCase().split('/')) if (SEMANTIC_DIR[seg]) return SEMANTIC_DIR[seg];
  return '其它';
}
```

（Edit `lib/manifest.js:91` GROUP_RANK）

```js
        const GROUP_RANK = { '项目状态': 0, '设计': 1, '计划': 2, '架构': 3, '接口': 4, '调试': 5, '笔记': 6, '其它': 7 };
```

- [ ] **Step 4: Run** `node --test test/docs.test.js` → PASS
- [ ] **Step 5: Commit** `feat(docs): generic docGroup — meta docs pinned top, semantic dir mapping`

---

### Task 3: 元文档 extractor 子目录适配 + readme/roadmap

**Files:** Modify `lib/docs.js`（changelogExtractor 用 findMetaDoc；加 readmeExtractor/roadmapExtractor；EXTRACTORS 注册）；Test `test/docs.test.js` 追加

- [ ] **Step 1: 测试**（Edit `test/docs.test.js` 追加；import 行确保有 `changelogExtractor`，加 `readmeExtractor, roadmapExtractor`）

```js
test('changelogExtractor: 子目录 CHANGELOG 也能收', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-cl-'));
  try {
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'app', 'CHANGELOG.md'), '## [1.2.0] — 2026-06-01\n- x\n## [1.1.0] — 2026-05-01\n- y');
    const specs = changelogExtractor(root);
    assert.equal(specs.length, 1);
    assert.equal(specs[0].id, 'changelog');
    assert.match(specs[0].sourcePath.replace(/\\/g, '/'), /app\/CHANGELOG\.md/);
    assert.equal(specs[0].entries.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readmeExtractor: 子目录 README → 单页，首段为 summary', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-rm-'));
  try {
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'app', 'README.md'), '# My Project\n\n一句话介绍这个项目。\n\n## 安装\n\nsteps');
    const specs = readmeExtractor(root);
    assert.equal(specs[0].id, 'readme');
    assert.equal(specs[0].title, 'My Project');
    assert.match(specs[0].summary, /一句话介绍/);
    assert.match(specs[0].sourcePath.replace(/\\/g, '/'), /app\/README\.md/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** `node --test test/docs.test.js` → FAIL
- [ ] **Step 3: 实现**（Edit `lib/docs.js`；顶部 import 加 `findMetaDoc` from './init.js'——注意 init.js 已 import docs.js 的 alignHookStub？不，init import migrate；docs 不被 init import，安全无环）

确认无循环依赖：`init.js` import `migrate.js`；`docs.js` 不被 `init.js`/`migrate.js` import（sync.js import docs.js，init.js 不 import docs.js）。`docs.js` import `init.js` 的 findMetaDoc → 单向，安全。

```js
import { findMetaDoc } from './init.js';

export function changelogExtractor(repoRoot) {
  const rel = findMetaDoc(repoRoot, 'CHANGELOG.md');
  if (!rel) return [];
  const text = readFileSync(join(repoRoot, rel), 'utf8');
  const entries = [];
  const re = /^##\s*\[([^\]]+)\]([^\n]*)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const dm = m[2].match(/(\d{4}-\d{2}-\d{2})/);
    entries.push({ version: m[1], date: dm ? dm[1] : '' });
  }
  if (!entries.length) return [];
  return [{
    id: 'changelog', title: 'CHANGELOG',
    summary: `${entries.length} 个版本，最新 ${entries[0].version}`,
    sourcePath: rel, date: (entries.find(e => e.date) || entries[0]).date, entries,
  }];
}

export function readmeExtractor(repoRoot) {
  const rel = findMetaDoc(repoRoot, 'README.md');
  if (!rel) return [];
  const text = readFileSync(join(repoRoot, rel), 'utf8');
  const body = parseFrontmatter(text).body;
  const fallback = 'README';
  return [{
    id: 'readme', title: extractTitle(text, fallback), summary: extractSummary(text),
    sourcePath: rel, date: '', body,
  }];
}

export function roadmapExtractor(repoRoot) {
  const rel = findMetaDoc(repoRoot, 'ROADMAP.md');
  if (!rel) return [];
  const text = readFileSync(join(repoRoot, rel), 'utf8');
  return [{
    id: 'roadmap', title: extractTitle(text, 'ROADMAP'), summary: extractSummary(text),
    sourcePath: rel, date: '', body: parseFrontmatter(text).body,
  }];
}
```

（Edit EXTRACTORS 注册）

```js
const EXTRACTORS = {
  docs: (root, cfg) => docsExtractor(root, cfg.docsGlob),
  changelog: (root) => changelogExtractor(root),
  readme: (root) => readmeExtractor(root),
  roadmap: (root) => roadmapExtractor(root),
  claude_md_pitfalls: (root) => pitfallsExtractor(root),
};
```

- [ ] **Step 4: Run** `node --test test/docs.test.js test/init.test.js` → PASS
- [ ] **Step 5: Commit** `feat(docs): meta-doc extractors find subdir CHANGELOG/README/ROADMAP`

---

### Task 4: init 接线 —— 自动发现写进 config

**Files:** Modify `lib/init.js`（renderConfigYaml 用 discoverDocs 结果）；Test `test/init.test.js` 追加

- [ ] **Step 1: 测试**（Edit `test/init.test.js` 追加）

```js
test('renderConfigYaml: 注入发现的 docs_glob + 元文档 sources', () => {
  const yaml = renderConfigYaml(['sub/m1'], { docsGlobs: ['sub/docs/**/*.md'], metaDocs: [{ kind: 'changelog', path: 'sub/CHANGELOG.md' }, { kind: 'readme', path: 'sub/README.md' }] });
  assert.match(yaml, /docs_glob:\s*sub\/docs\/\*\*\/\*\.md/);
  assert.match(yaml, /sources:\s*\[[^\]]*changelog[^\]]*\]/);
  assert.match(yaml, /sources:\s*\[[^\]]*readme[^\]]*\]/);
  assert.match(yaml, /sources:\s*\[[^\]]*claude_md_pitfalls[^\]]*\]/);  // 默认仍含
});

test('renderConfigYaml: 无发现结果 → 默认 docs/**/*.md（向后兼容）', () => {
  const yaml = renderConfigYaml(['lib']);
  assert.match(yaml, /docs_glob:\s*docs\/\*\*\/\*\.md/);
});
```

- [ ] **Step 2: Run** `node --test test/init.test.js` → FAIL
- [ ] **Step 3: 实现**（Edit `lib/init.js`：renderConfigYaml 签名加第二参 docsDisc；docs 块拼装用它。注意 CONFIG_BLOCKS 的 `config:axes.docs` 模板——renderConfigYaml 从块拼装，docs 块要参数化）

renderConfigYaml 第二参 `docsDisc = { docsGlobs: [], metaDocs: [] }`；docs 部分不再用 CONFIG_BLOCKS 静态块，改为：

```js
export function renderConfigYaml(codeRoots, docsDisc = { docsGlobs: [], metaDocs: [] }) {
  const fmt = r => /^[A-Za-z0-9_./-]+$/.test(r) ? r : `'${r.replace(/'/g, "''")}'`;
  const roots = `[${codeRoots.map(fmt).join(', ')}]`;
  const sample = codeRoots[0] ?? 'module';
  const fill = t => t.replace('<component>', sample);
  const docsGlob = docsDisc.docsGlobs[0] ?? 'docs/**/*.md';
  const metaSources = docsDisc.metaDocs.map(m => m.kind).filter(k => k !== 'roadmap' || true);  // changelog/readme/roadmap
  const sources = ['docs', ...metaSources, 'claude_md_pitfalls'];
  const docsBlock = `  docs:                      # 文档轴 — 自动发现的文档目录 + 元文档（机械、物化视图、零 LLM）
    sources: [${sources.join(', ')}]
    docs_glob: ${docsGlob}`;
  return `# .lore/config.yml —— lore 引擎配置（唯一存放本 repo 特定信息处）
# component 由 /lore:init 自动发现。请按需改：重命名 / 分组 / 删 / 增。
${cfgBlock('config:language')}

axes:
  component:                 # 内置轴 + 自动发现
    discover: auto
    code_roots: ${roots}
${fill(cfgBlock('config:axes.flow'))}
${fill(cfgBlock('config:axes.theme'))}
${docsBlock}
${cfgBlock('config:journal')}
${cfgBlock('config:resident-note')}
`;
}
```

init() 调用处（126-128）：

```js
  const docsDisc = discoverDocs(repoRoot);
  if (!existsSync(configPath)) {
    writeFileSync(configPath, renderConfigYaml(codeRoots, docsDisc));
    configWritten = true;
  }
```

（注意 CONFIG_BLOCKS 的 `config:axes.docs` 块仍被 migrate.js 的 config 补缺用——保留它，仅 renderConfigYaml 改为动态 docsBlock。migrate 给老 config 补的是注释默认块，可接受。）

- [ ] **Step 4: Run** `node --test test/init.test.js test/migrate.test.js` → PASS（migrate 的 renderConfigYaml 调用兼容——第二参可省）
- [ ] **Step 5: Commit** `feat(init): wire discoverDocs into config — auto docs_glob + meta sources`

---

### Task 5: theme/flow 排版标准

**Files:** Modify `lib/runner.js`（axisPrompt）、`commands/sync.md`；Test `test/runner.test.js`（axisPrompt 断言扩展）

- [ ] **Step 1: 测试**（Edit `test/runner.test.js` 的 axisPrompt 测试追加断言）

```js
  assert.match(axisPrompt({ axis: 'theme', path: 'theme/x.md' }), /小标题|分层|表格/);
  assert.match(axisPrompt({ axis: 'flow', path: 'flow/x.md' }), /小标题|分层|表格/);
```

- [ ] **Step 2: Run** `node --test test/runner.test.js` → FAIL
- [ ] **Step 3: 实现**（Edit `lib/runner.js` axisPrompt 的 theme/flow 分支，各加一句排版要求）

theme 分支加：
```js
      '排版：用 ### 小标题把内容分成 3-6 段，枚举/对照用列表或表格承载，避免连续大段密集文字（单段控制在 ~150 字内）。',
```
flow 分支加同句。

（Edit `commands/sync.md` 内容质量标准节，补一句：theme「Current state」/ flow「End-to-end path」用 `###` 小标题分层 + 列表/表格，避免大段密集文字。）

- [ ] **Step 4: Run** `node --test test/runner.test.js` → PASS
- [ ] **Step 5: Commit** `feat(runner,sync): theme/flow layout standard — sub-headings + lists, no dense walls`

---

### Task 6: dogfood + 全量回归

**Files:** threat-intel `.lore/config.yml`（加 sources）+ wiki 重排；lore `.lore` 回归

- [ ] **Step 1: 全量回归** `node --test test/*.test.js` → 全绿（更新过的 docs.test/init.test/runner.test + 全套）

- [ ] **Step 2: lore 自己回归**：`node lib/sync.js finalize .lore` → docs 重分组（superpowers/specs→设计、plans→计划、changelog/pitfalls→项目状态）；`node lib/ask.js .lore "踩坑"` 仍命中 pitfalls。

- [ ] **Step 3: threat-intel docs 重分组**：config sources 加 changelog/readme（`node -e` 改 `.lore/config.yml` 的 `sources: [docs, claude_md_pitfalls]` → `[docs, changelog, readme, claude_md_pitfalls]`）→ `node lib/sync.js finalize /d/workspace/threat-intel/.lore` → 验证 manifest docs 组分布（specs/plans/debugging/接口/架构/项目状态 多组，CHANGELOG/README 进「项目状态」）。

- [ ] **Step 4: threat-intel theme/flow 重排**：派 subagent 按 T5 新标准重排 theme 4 页（accuracy/ioc/security/performance）+ flow 3 页（intel-pipeline/tweet-pipeline/report-pipeline）——`###` 小标题分层 + 列表/表格，决策史节保持 token 态 `{{LORE_JOURNAL}}`。finalize 重新物化。

- [ ] **Step 5: 验收 + 文档 + commit**：portal 实测 theme/accuracy 分层渲染 + docs 多组；CHANGELOG v0.8.x 段补本特性；ROADMAP 标 docs-axis ✅。Commit + push 按用户指令。
