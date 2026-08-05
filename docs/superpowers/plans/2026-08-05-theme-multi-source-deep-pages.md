# Theme Multi-Source Deep Pages（axes.theme.deep）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入 `axes.theme.deep`——父主题下声明分组的多源子页，每个子页拥有自己的源文件/glob 作用域、源级陈旧度、决策史、lint 质量门与 manifest/图谱/导航/MCP 可见性。

**Architecture:** 分四层落地：① `parseConfigThemeDeep`（纯语法，config.js）+ 块级作用域化 `parseConfigDocsAxis`（修复 theme-deep `sources:` 劫持 docs 的 bug）；② `resolveThemeDeepSource`/`resolveThemeDeepSources`/`resolveConfiguredThemeDeep`（source.js，字面量走 fs、glob 走 `git ls-files :(glob)`，零新依赖）；③ sync 消费（planSync 建 work item、finalizeSync 建 staleScopes + 子页决策史源级过滤 + 受管孤儿删除 + manifest 排序/嵌套元数据）；④ 全链路可见性（manifest 可选字段、INDEX 嵌套、graph `contains` 边、shell 侧栏嵌套、ask/mcp parent/kind 元数据、lint 诊断）。

**Tech Stack:** Node.js ESM（node:test / assert/strict），零新依赖。git CLI 是既有运行时依赖（`execFileSync('git')`），glob 展开复用。

**Spec:** `docs/superpowers/specs/2026-08-05-theme-multi-source-deep-pages-design.md`（含 2026-08-06 Amendments，8 条全部落实）

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `lib/config.js` | `parseConfigThemeDeep`（新）+ `parseConfigDocsAxis` 块级作用域化 | Modify |
| `lib/source.js` | `resolveThemeDeepSource` / `resolveThemeDeepSources` / `resolveConfiguredThemeDeep` + 预算常量 | Modify |
| `lib/sync.js` | `planSync` 子页 work item；`finalizeSync` 子页决策史 / staleScopes / 孤儿删除 / theme 排序元数据；`buildIndex` 嵌套 | Modify |
| `lib/manifest.js` | `emitManifest`/`runManifestCli` 加 themeOrder/themeDeepMeta/themeDeepActive，子页可选字段 + 排序 + 孤儿排除 | Modify |
| `lib/graph.js` | `buildGraph` 加 `contains` 结构边 | Modify |
| `lib/lint.js` | `lintThemeDeepConfig` / `lintThemeDeepPages` + lint() 接线 + CLI 输出 | Modify |
| `lib/ask.js` | `searchPages` 命中携带 parent/kind | Modify |
| `lib/mcp.js` | `lore_ask` 结果透传 parent/kind | Modify |
| `site/shell.mjs` | `buildThemeRows`（侧栏嵌套数据模型） | Modify |
| `site/index.html` | 侧栏 theme 嵌套渲染 + CSS | Modify |
| `lib/migrate.js` | theme 配置模板补 `deep:` 注释脚手架 | Modify |
| `commands/sync.md` | 主题深度页段落补语法/契约说明 | Modify |
| `test/config.test.js` | docs 回归 + parseConfigThemeDeep | Modify |
| `test/source.test.js` | 解析器/聚合/配置校验 | Modify |
| `test/sync.test.js` | planSync / finalizeSync / buildIndex | Modify |
| `test/manifest.test.js` | emitManifest 子页字段 + theme 排序/排除 | Modify |
| `test/graph.test.js` | contains 边 | Modify |
| `test/lint.test.js` | theme-deep 诊断 | Modify |
| `test/shell.test.js` | buildThemeRows | Modify |
| `test/ask.test.js` | searchPages parent/kind | Modify |
| `test/mcp.test.js` | lore_ask 透传 | Modify |

测试命令（Git Bash，仓库根目录 `d:\workspace\lore` 下执行）：
- 单文件：`node --test test/<file>.test.js`
- 全量：`node --test test/*.test.js`（`serve.test.js` 全量并行下偶发 flake——已知坑，失败先重跑一次确认）

---

### Task 1: `parseConfigDocsAxis` 块级作用域化（Amendment 2 的前置修复）

**Files:**
- Modify: `lib/config.js:39-50`
- Test: `test/config.test.js`

> 背景：theme-deep 子记录的多行写法 `sources:` 会命中 `parseConfigDocsAxis` 的首个 `sources:` 正则，劫持 docs 轴检测（config.js 原 ASSUMPTION 注释已被本功能打破）。改为只在 `axes:` 块内 `docs:` 子块中匹配。

- [ ] **Step 1: 写失败测试**（`test/config.test.js`，`parseConfigDocsAxis` 用例区追加）

```js
test('parseConfigDocsAxis ignores theme.deep sources (docs block scoping)', () => {
  const cfg = `axes:
  theme:
    deep:
      sidecar-config-decryption:
        发现与关联:
          - { id: discovery-association,
              sources: [mal_analyze/sidecar/probe.py,
                        mal_analyze/sidecar/associations.py] }
  docs:
    sources: [docs, changelog, claude_md_pitfalls]
    docs_glob: docs/**/*.md
`;
  const r = parseConfigDocsAxis(cfg);
  assert.deepEqual(r.sources, ['docs', 'changelog', 'claude_md_pitfalls']);
  assert.equal(r.docsGlob, 'docs/**/*.md');
});

test('parseConfigDocsAxis returns null when only theme.deep has sources (no docs block)', () => {
  const cfg = `axes:
  theme:
    deep:
      sidecar-config-decryption:
        发现与关联:
          - { id: discovery-association, sources: [a.py, b.py] }
`;
  assert.equal(parseConfigDocsAxis(cfg), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/config.test.js`
Expected: FAIL —— 第一个用例返回 theme-deep 的 sources、第二个返回非 null。

- [ ] **Step 3: 实现**（`lib/config.js`，整体替换 `parseConfigDocsAxis`，39-50 行）

```js
export function parseConfigDocsAxis(configText) {
  // 块级作用域：只认 axes 块内 docs: 子块的 sources:/docs_glob:。
  // 否则 theme.deep 子记录的 `sources:` 行（多行写法）会劫持 docs 检测
  // （config.js 原 ASSUMPTION「无其他块用 sources:」已被本功能打破）。
  const lines = configText.split(/\r?\n/);
  let inAxes = false, axesIndent = -1, docsIndent = -1;
  const docsLines = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const indent = line.match(/^\s*/)[0].length;
    const content = line.slice(indent);
    if (!inAxes) {
      if (content === 'axes:') { inAxes = true; axesIndent = indent; }
      continue;
    }
    if (indent <= axesIndent) break;                       // 出 axes 块
    if (docsIndent === -1) {
      if (/^docs:\s*(?:#.*)?$/.test(content)) docsIndent = indent;
      continue;
    }
    if (indent <= docsIndent) break;                       // 出 docs 子块
    docsLines.push(line);
  }
  const block = docsLines.join('\n');
  const srcM = block.match(/^[ \t]*sources:[ \t]*\[([^\]]*)\]/m);
  if (!srcM) return null;
  const sources = srcM[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '').trim()).filter(Boolean);
  if (!sources.length) return null;
  const globM = block.match(/^[ \t]*docs_glob:[ \t]*(\S+)/m);
  const docsGlob = globM ? globM[1].trim().replace(/^['"]|['"]$/g, '') : 'docs/**/*.md';
  return { sources, docsGlob };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/config.test.js`
Expected: PASS —— 既有 5 个 parseConfigDocsAxis 用例（`axes:\n  docs:` 形态）不破 + 2 个新回归用例。

- [ ] **Step 5: 提交**

```bash
git add lib/config.js test/config.test.js
git commit -m "fix(config): block-scope parseConfigDocsAxis to axes.docs (theme.deep sources no longer hijack docs)"
```

---

### Task 2: `parseConfigThemeDeep` 配置解析器

**Files:**
- Modify: `lib/config.js`
- Test: `test/config.test.js`

- [ ] **Step 1: 写失败测试**（`test/config.test.js` 末尾追加；import 行第 3 行改为 `import { parseConfigCodeRoots, parseConfigDocsAxis, parseConfigThemeDeep } from '../lib/config.js';`）

```js
test('parseConfigThemeDeep parses one-line child records preserving groups and order', () => {
  const cfg = `axes:
  theme:
    values:
      - { id: sidecar-config-decryption, desc: d, match: [sidecar] }
    deep:
      sidecar-config-decryption:
        发现与关联:
          - { id: discovery-association, sources: [probe.py, associations.py] }
        执行与传播:
          - { id: crypto-execution, sources: [executor.py] }
          - { id: canonical-propagation, sources: [finalize.py] }
`;
  const r = parseConfigThemeDeep(cfg);
  assert.deepEqual(r.parents, ['sidecar-config-decryption']);
  assert.deepEqual(r.children, [
    { parent: 'sidecar-config-decryption', id: 'discovery-association', group: '发现与关联', sources: ['probe.py', 'associations.py'] },
    { parent: 'sidecar-config-decryption', id: 'crypto-execution', group: '执行与传播', sources: ['executor.py'] },
    { parent: 'sidecar-config-decryption', id: 'canonical-propagation', group: '执行与传播', sources: ['finalize.py'] },
  ]);
});

test('parseConfigThemeDeep tolerates multi-line child records', () => {
  const cfg = `axes:
  theme:
    deep:
      parent-1:
        g1:
          - { id: c1,
              sources: [a.py,
                        b.py] }
`;
  const r = parseConfigThemeDeep(cfg);
  assert.deepEqual(r.children, [{ parent: 'parent-1', id: 'c1', group: 'g1', sources: ['a.py', 'b.py'] }]);
});

test('parseConfigThemeDeep multiple parents stay isolated', () => {
  const cfg = `axes:
  theme:
    deep:
      p1:
        组1:
          - { id: c1, sources: [a.py] }
      p2:
        组A:
          - { id: c2, sources: [b.py] }
`;
  const r = parseConfigThemeDeep(cfg);
  assert.deepEqual(r.parents, ['p1', 'p2']);
  assert.deepEqual(r.children, [
    { parent: 'p1', id: 'c1', group: '组1', sources: ['a.py'] },
    { parent: 'p2', id: 'c2', group: '组A', sources: ['b.py'] },
  ]);
});

test('parseConfigThemeDeep returns empty when no theme.deep block', () => {
  assert.deepEqual(parseConfigThemeDeep('axes:\n  theme:\n    values: []\n'), { parents: [], children: [] });
  assert.deepEqual(parseConfigThemeDeep(''), { parents: [], children: [] });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/config.test.js`
Expected: FAIL —— `parseConfigThemeDeep is not defined`。

- [ ] **Step 3: 实现**（`lib/config.js` 末尾追加）

```js
// 解析 axes.theme.deep —— 父主题 → 分组 → 子记录（`- { id, sources: [...] }`）。
// 规范形为单行记录；容忍多行记录（sources 续行，{ } 配平后收束）。缺 deep → { parents: [], children: [] }。
export function parseConfigThemeDeep(configText) {
  const lines = configText.split(/\r?\n/).map(l => l.replace(/\r$/, ''));
  const children = [];
  const parents = [];
  let axesIndent = -1, themeIndent = -1, deepIndent = -1;
  let curParent = null, curGroup = '', parentIndent = -1;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    i++;
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const indent = line.match(/^\s*/)[0].length;
    const content = line.slice(indent);
    if (axesIndent === -1) {
      if (content === 'axes:') axesIndent = indent;
      continue;
    }
    if (indent <= axesIndent) break;                       // 出 axes 块
    if (themeIndent === -1) {
      if (/^theme:\s*(?:#.*)?$/.test(content)) themeIndent = indent;
      continue;
    }
    if (indent <= themeIndent) break;                      // 出 theme 子块（到别的轴）
    if (deepIndent === -1) {
      if (/^deep:\s*(?:#.*)?$/.test(content)) deepIndent = indent;
      continue;
    }
    if (indent <= deepIndent) break;                       // 出 deep 块
    if (curParent === null || indent === parentIndent) {
      const parentM = content.match(/^([A-Za-z0-9_-]+):\s*(?:#.*)?$/);
      if (parentM) {
        curParent = parentM[1]; parentIndent = indent; curGroup = '';
        if (!parents.includes(curParent)) parents.push(curParent);
        continue;
      }
    }
    if (indent > parentIndent && content.startsWith('- {')) {
      // 子记录：{ } 配平前继续吃续行（容忍多行 sources）
      let buf = content;
      let depth = (content.match(/\{/g) ?? []).length - (content.match(/\}/g) ?? []).length;
      while (depth > 0 && i < lines.length) {
        const more = lines[i];
        buf += '\n' + more.trim();
        depth += (more.match(/\{/g) ?? []).length - (more.match(/\}/g) ?? []).length;
        i++;
      }
      const rec = parseThemeDeepRecordText(buf);
      if (rec) children.push({ parent: curParent, id: rec.id, group: curGroup, sources: rec.sources });
      continue;
    }
    if (indent > parentIndent) {
      const groupM = content.match(/^([^:{][^:]*):\s*(?:#.*)?$/);
      if (groupM) { curGroup = groupM[1].trim(); }
    }
  }
  return { parents, children };
}

// 单条子记录：`{ id: X, sources: [a, b] }`（可能跨行）。返回 { id, sources } 或 null。
function parseThemeDeepRecordText(text) {
  const m = text.match(/\{\s*id:\s*([A-Za-z0-9_-]+)\s*,\s*sources:\s*\[([\s\S]*?)\]\s*\}/);
  if (!m) return null;
  const sources = m[2].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '').trim()).filter(Boolean);
  return { id: m[1], sources };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/config.test.js`
Expected: PASS —— 全绿（含既有 parseConfigDeep 用例）。

- [ ] **Step 5: 提交**

```bash
git add lib/config.js test/config.test.js
git commit -m "feat(config): parseConfigThemeDeep — parent→group→child records (one-line canonical, multi-line tolerant)"
```

---

### Task 3: `resolveThemeDeepSource` / `resolveThemeDeepSources` / `resolveConfiguredThemeDeep` 源解析

**Files:**
- Modify: `lib/source.js`
- Test: `test/source.test.js`

> 设计契约：字面量走 fs（可含未跟踪文件）；glob 走 `git ls-files --cached --others --exclude-standard ':(glob)<p>'`（gitignore 感知天然免费、`.lore/`/`.git/`/依赖缓存自动排除，零新依赖）。预算超限是配置诊断，不是静默截断。

- [ ] **Step 1: 写失败测试**（`test/source.test.js`；import 行改为 `import { CODE_EXT, parseDeepEntry, resolveConfiguredDeep, resolveDeepSource, resolveThemeDeepSource, resolveThemeDeepSources, resolveConfiguredThemeDeep } from '../lib/source.js';`，并加 `import { parseConfigThemeDeep } from '../lib/config.js';`）

```js
test('resolveThemeDeepSource: literal file resolves to slash-normalized repo path', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'mal_analyze', 'sidecar'), { recursive: true });
    writeFileSync(join(root, 'mal_analyze', 'sidecar', 'probe.py'), 'x');
    assert.deepEqual(resolveThemeDeepSource(root, 'mal_analyze/sidecar/probe.py'), {
      status: 'ok', sourceFiles: ['mal_analyze/sidecar/probe.py'],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveThemeDeepSource: literal missing → missing with matches []', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    assert.deepEqual(resolveThemeDeepSource(root, 'pkg/nope.py'), { status: 'missing', matches: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveThemeDeepSource: absolute / drive / .. paths → invalid', () => {
  const root = tmpRepo();
  try {
    for (const entry of ['C:/x/y.py', '/etc/passwd', '../outside.py', 'a/../../b.py']) {
      assert.equal(resolveThemeDeepSource(root, entry).status, 'invalid', entry);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// git 仓库：glob 展开尊重 .gitignore；零匹配 → missing
function gitRepoWith(files, ignoreLines = []) {
  const root = tmpRepo();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  if (ignoreLines.length) writeFileSync(join(root, '.gitignore'), ignoreLines.join('\n') + '\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  return root;
}

test('resolveThemeDeepSource: glob expands via git, excludes gitignored files', () => {
  const root = gitRepoWith({
    'server/analyst/a.py': 'x',
    'server/analyst/b.py': 'x',
    'server/analyst/nested/c.py': 'x',
    'server/analyst/ignored.py': 'x',
  }, ['server/analyst/ignored.py']);
  try {
    const r = resolveThemeDeepSource(root, 'server/analyst/**');
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.sourceFiles, ['server/analyst/a.py', 'server/analyst/b.py', 'server/analyst/nested/c.py']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveThemeDeepSource: glob no match → missing', () => {
  const root = gitRepoWith({ 'f.txt': 'x' });
  try {
    assert.deepEqual(resolveThemeDeepSource(root, 'server/**'), { status: 'missing', matches: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveThemeDeepSource: glob budget overflow → invalid (configuration diagnostic)', () => {
  const many = {};
  for (let k = 0; k < 250; k++) many[`gen/f${k}.py`] = 'x';
  const root = gitRepoWith(many);
  try {
    const r = resolveThemeDeepSource(root, 'gen/**');
    assert.equal(r.status, 'invalid');
    assert.match(r.reason, /expanded to 250 files/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveThemeDeepSources: aggregates, dedupes, sorts across entries', () => {
  const root = gitRepoWith({ 'pkg/a.py': 'x', 'pkg/b.py': 'x' });
  try {
    assert.deepEqual(resolveThemeDeepSources(root, ['pkg/b.py', 'pkg/a.py', 'pkg/b.py']), {
      status: 'ok', sourceFiles: ['pkg/a.py', 'pkg/b.py'],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveThemeDeepSources: first failing entry short-circuits', () => {
  const root = gitRepoWith({ 'pkg/a.py': 'x' });
  try {
    const r = resolveThemeDeepSources(root, ['pkg/a.py', 'pkg/missing.py']);
    assert.equal(r.status, 'missing');
    assert.equal(r.entry, 'pkg/missing.py');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveConfiguredThemeDeep: valid config → children with deduped sorted sourceFiles', () => {
  const root = gitRepoWith({ 'sidecar/probe.py': 'x', 'sidecar/assoc.py': 'x' });
  try {
    const themes = [{ id: 'sidecar-config-decryption', match: [] }];
    const themeDeep = parseConfigThemeDeep(`axes:
  theme:
    deep:
      sidecar-config-decryption:
        发现与关联:
          - { id: discovery-association, sources: [sidecar/assoc.py, sidecar/probe.py] }
`);
    const r = resolveConfiguredThemeDeep(root, themes, themeDeep);
    assert.deepEqual(r.children, [{
      parent: 'sidecar-config-decryption', id: 'discovery-association', group: '发现与关联',
      sources: ['sidecar/assoc.py', 'sidecar/probe.py'], sourceFiles: ['sidecar/assoc.py', 'sidecar/probe.py'],
    }]);
    assert.deepEqual(r.issues, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveConfiguredThemeDeep: missing parent / duplicate child / empty sources / shared source', () => {
  const root = gitRepoWith({ 'a.py': 'x', 'b.py': 'x' });
  try {
    const themes = [{ id: 'p', match: [] }];
    const themeDeep = parseConfigThemeDeep(`axes:
  theme:
    deep:
      p:
        g:
          - { id: c1, sources: [a.py] }
          - { id: c1, sources: [b.py] }
          - { id: c2, sources: [] }
          - { id: c3, sources: [a.py] }
      ghost:
        g:
          - { id: c4, sources: [a.py] }
`);
    const r = resolveConfiguredThemeDeep(root, themes, themeDeep);
    assert.deepEqual(r.children.map(c => c.id), ['c1', 'c3']);        // c2 空 sources、c4 父缺失 → 不进 children；c1/c3 共享 a.py 都保留
    const kinds = r.issues.map(i => i.kind);
    assert.ok(kinds.includes('theme-deep-id-collision'));
    assert.ok(kinds.includes('theme-deep-sources-empty'));
    assert.ok(kinds.includes('theme-deep-parent-missing'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveConfiguredThemeDeep: symlink/junction outside repo → outside-repo', (t) => {
  const root = tmpRepo();
  const outside = tmpRepo();
  try {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    mkdirSync(join(outside, 'pkg'), { recursive: true });
    writeFileSync(join(outside, 'pkg', 'x.py'), 'x');
    try {
      if (process.platform === 'win32') {
        execFileSync('cmd', ['/c', 'mklink', '/J', join(root, 'pkg', 'link'), outside], { stdio: 'pipe' });
      } else {
        execFileSync('ln', ['-s', outside, join(root, 'pkg', 'link')], { stdio: 'pipe' });
      }
    } catch { t.skip('symlink/junction unavailable'); return; }
    const r = resolveThemeDeepSource(root, 'pkg/link/pkg/x.py');
    assert.equal(r.status, 'outside-repo');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/source.test.js`
Expected: FAIL —— 新导出不存在（`resolveThemeDeepSource is not defined`）。

- [ ] **Step 3: 实现**（`lib/source.js`；`import` 行加 `execFileSync`，常量与函数追加到文件末尾）

```js
import { execFileSync } from 'node:child_process';

// theme-deep 预算（设计「安全与资源边界」）：具名常量 + 边界测试。
export const THEME_DEEP_MAX_GLOB_FILES = 200;    // 每 glob 展开上限
export const THEME_DEEP_MAX_CHILD_SOURCES = 200; // 每子源文件总数上限
export const THEME_DEEP_MAX_TOTAL_FILES = 1000;  // 每计划全部分子展开总数上限

const THEME_GLOB_CHARS = /[*?[\]{}]/;

function normalizeRepoRel(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

// 语法校验（规则 4/5）：仓库相对、斜杠归一、无绝对/盘符/.. /NUL。
function validateThemeDeepEntry(entry) {
  if (entry.includes('\0')) return { ok: false, reason: 'NUL byte' };
  if (entry.startsWith(':')) return { ok: false, reason: 'pathspec magic not allowed' };
  if (isAbsolute(entry)) return { ok: false, reason: 'absolute path' };
  const norm = normalizeRepoRel(entry);
  if (/^[A-Za-z]:\//.test(norm)) return { ok: false, reason: 'drive-qualified path' };
  if (norm.split('/').some(s => s === '..')) return { ok: false, reason: '".." traversal' };
  return { ok: true, norm };
}

// 字面量文件：realpath 解析（含最深存在祖先），拒绝落出仓库的 symlink/junction。
function canonicalizeRepoFile(repoRoot, rel) {
  const abs = join(repoRoot, rel);
  let cursor = abs, suffix = [];
  while (true) {
    try { lstatSync(cursor); break; } catch (err) {
      if (err.code !== 'ENOENT') return null;
      const parent = dirname(cursor);
      if (parent === cursor) return null;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
  try { return resolve(realpathSync(cursor), ...suffix); } catch { return null; }
}

function resolveThemeDeepLiteral(repoRoot, entry, norm) {
  const repoPath = resolve(repoRoot);
  const abs = join(repoPath, norm);
  if (!pathContains(repoPath, abs)) return { status: 'outside-repo', entry, resolvedPath: norm };
  const canon = canonicalizeRepoFile(repoPath, norm);
  if (canon === null) return { status: 'missing', entry, matches: [] };
  let st;
  try { st = lstatSync(canon); } catch { return { status: 'missing', entry, matches: [] }; }
  if (!st.isFile()) return { status: 'missing', entry, matches: [] };   // 规则 6：必须普通文件
  const repoReal = realpathSync(repoPath);
  if (!pathContains(repoReal, canon)) return { status: 'outside-repo', entry, resolvedPath: relative(repoRoot, canon).replaceAll('\\', '/') };
  return { status: 'ok', entry, sourceFiles: [relative(repoRoot, canon).replaceAll('\\', '/')] };
}

function resolveThemeDeepGlob(repoRoot, entry, norm) {
  try {
    const out = execFileSync('git',
      ['ls-files', '--cached', '--others', '--exclude-standard', `:(glob)${norm}`],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }).toString();
    const files = out.split('\n').map(s => s.trim().replace(/\\/g, '/')).filter(Boolean);
    if (files.length === 0) return { status: 'missing', entry, matches: [] };   // 规则 7：零匹配 = missing，绝不当作新页
    if (files.length > THEME_DEEP_MAX_GLOB_FILES) {
      return { status: 'invalid', entry, reason: `glob expanded to ${files.length} files (max ${THEME_DEEP_MAX_GLOB_FILES})` };
    }
    return { status: 'ok', entry, sourceFiles: files };
  } catch {
    return { status: 'invalid', entry, reason: 'git unavailable (non-git repo?)' };
  }
}

// 单条源条目（字面量或 glob）→ 4 态结果（设计「源解析契约」）。
export function resolveThemeDeepSource(repoRoot, entry) {
  const v = validateThemeDeepEntry(entry);
  if (!v.ok) return { status: 'invalid', entry, reason: v.reason };
  if (THEME_GLOB_CHARS.test(v.norm)) return resolveThemeDeepGlob(repoRoot, entry, v.norm);
  return resolveThemeDeepLiteral(repoRoot, entry, v.norm);
}

// 一个子的全部源条目 → ok(sourceFiles 去重排序) 或首个失败态（设计公开契约，ok 不带 entry）。
export function resolveThemeDeepSources(repoRoot, entries) {
  const all = [];
  for (const entry of entries) {
    const r = resolveThemeDeepSource(repoRoot, entry);
    if (r.status !== 'ok') return r;
    all.push(...r.sourceFiles);
  }
  if (all.length > THEME_DEEP_MAX_CHILD_SOURCES) {
    return { status: 'invalid', entry: entries[0], reason: `child expanded to ${all.length} files (max ${THEME_DEEP_MAX_CHILD_SOURCES})` };
  }
  const seen = new Set();
  const files = [];
  for (const f of all) if (!seen.has(f)) { seen.add(f); files.push(f); }   // 规则 8：去重 + 排序 → 指纹稳定
  files.sort();
  return { status: 'ok', sourceFiles: files };
}

// 配置级校验 + 解析（规则 1-10）。children = 合法子（{parent,id,group,sources,sourceFiles}）；issues 累积不崩溃。
export function resolveConfiguredThemeDeep(repoRoot, themes, themeDeep) {
  const issues = [];
  const children = [];
  const canonicalSeen = new Map();
  let totalFiles = 0;
  for (const parent of themeDeep.parents) {
    const parentChildren = themeDeep.children.filter(c => c.parent === parent);
    const seenIds = new Set();
    const parentCount = themes.filter(t => t.id === parent).length;
    for (const c of parentChildren) {
      // 规则 2：子 id 父内唯一 + 规范 id 全局唯一
      if (seenIds.has(c.id)) { issues.push({ kind: 'theme-deep-id-collision', parent, child: c.id }); continue; }
      seenIds.add(c.id);
      const canonicalId = `${parent}--${c.id}`;
      if (canonicalSeen.has(canonicalId)) { issues.push({ kind: 'theme-deep-id-collision', parent, child: c.id, canonical: canonicalId }); continue; }
      canonicalSeen.set(canonicalId, true);
      // 规则 1：父必须恰出现一次
      if (parentCount !== 1) { issues.push({ kind: 'theme-deep-parent-missing', parent, child: c.id }); continue; }
      // 规则 3：至少 1 条源
      if (!c.sources || c.sources.length === 0) { issues.push({ kind: 'theme-deep-sources-empty', parent, child: c.id }); continue; }
      // 规则 4-9：逐条解析；规则 10：共享源合法（两子各持己份，不静默删）
      const r = resolveThemeDeepSources(repoRoot, c.sources);
      if (r.status !== 'ok') {
        issues.push({ kind: `theme-deep-source-${r.status}`, parent, child: c.id, entry: r.entry, reason: r.reason, resolvedPath: r.resolvedPath, matches: r.matches });
        continue;
      }
      totalFiles += r.sourceFiles.length;
      children.push({ parent, id: c.id, group: c.group, sources: c.sources, sourceFiles: r.sourceFiles });
    }
  }
  if (totalFiles > THEME_DEEP_MAX_TOTAL_FILES) {
    issues.push({ kind: 'theme-deep-source-invalid', parent: '', child: '', entry: '', reason: `total expanded sources ${totalFiles} exceed max ${THEME_DEEP_MAX_TOTAL_FILES}` });
  }
  return { children, issues };
}
```

> **Amendment 7 词汇说明（Task 12 写入注释）**：`resolveThemeDeepSource` 的 4 态词汇与 `resolveDeepSource`（ok/missing/ambiguous）互补——输入域不同（显式路径/glob vs 目录内裸名扫描），错误形状纪律共享（都返回 `{status, …}`）。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `node --test test/source.test.js`
Expected: PASS —— 全绿（既有 9 个 deep 用例 + 新 10 个）。

- [ ] **Step 5: 提交**

```bash
git add lib/source.js test/source.test.js
git commit -m "feat(source): theme-deep source resolution — literal fs + git-pathspec globs, budgets, config validation"
```

---

### Task 4: `planSync` 建 theme-deep 子页 work item

**Files:**
- Modify: `lib/sync.js:21-73`
- Test: `test/sync.test.js`

> 设计规划规则：`--all` 全排；子页缺失 → `missing-page`；否则按「影响已解析源文件的 commit 数」算陈旧；兄弟子源没变不排队；非法配置只产诊断。**注意：`planSync` 返回结构不能加顶层字段**（既有 deepEqual 断言精确匹配）。auto 模式把子页当普通 theme work item 计数一次（设计「exactly once」由 worklist 结构天然满足，runner 无需改）。

- [ ] **Step 1: 写失败测试**（`test/sync.test.js` 末尾追加；用 mid-file 别名 `pl`/`fz`/`mkN`/`jN`/`mdN`/`wfN`/`rdN`/`rmN`/`tmpN`/`exN2`——[sync.test.js:746-820](test/sync.test.js#L746-L820) 已导入）

```js
// theme-deep fixture（Task 6 用例复用）：父主题 + 1 分组 1 子（源 2 文件）；
// language zh/en —— en 是翻译 sidecar 语言（孤儿测试要删 .en.md）
function fzRepoThemeDeep() {
  const root = mkN(tmpN() + 'lore-theme-deep-');
  const git = (...a) => exN2('git', a, { cwd: root, stdio: 'pipe' }).toString().trim();
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  mdN(jN(root, 'sidecar'), { recursive: true });
  wfN(jN(root, 'sidecar', 'probe.py'), 'PROBE = 1\n');
  wfN(jN(root, 'sidecar', 'assoc.py'), 'ASSOC = 1\n');
  mdN(jN(root, 'server'), { recursive: true });
  wfN(jN(root, 'server', 'finalize.py'), 'FINAL = 1\n');
  const lore = jN(root, '.lore');
  mdN(jN(lore, 'wiki', 'theme'), { recursive: true });
  mdN(jN(lore, 'journal'), { recursive: true });
  mdN(jN(lore, '.state'), { recursive: true });
  wfN(jN(lore, 'config.yml'),
    'language:\n  default: zh\n  available: [zh, en]\naxes:\n  theme:\n    values:\n      - { id: sidecar-config-decryption, desc: d, match: [sidecar] }\n    deep:\n      sidecar-config-decryption:\n        发现与关联:\n          - { id: discovery-association, sources: [sidecar/probe.py, sidecar/assoc.py] }\n');
  exN2('git', ['add', '-A'], { cwd: root, stdio: 'pipe' });
  exN2('git', ['commit', '-qm', 'init'], { cwd: root, stdio: 'pipe' });
  return { root, loreDir: lore, git };
}

test('planSync: theme-deep child work item with canonical id, sources, missing-page reason', () => {
  const r = fzRepoThemeDeep();
  try {
    const plan = pl(r.loreDir, { all: true });
    const child = plan.worklist.find(w => w.kind === 'deep' && w.axis === 'theme');
    assert.deepEqual(child, {
      axis: 'theme', id: 'sidecar-config-decryption--discovery-association', kind: 'deep',
      parent: 'sidecar-config-decryption', group: '发现与关联',
      sourceFiles: ['sidecar/assoc.py', 'sidecar/probe.py'],
      path: 'theme/sidecar-config-decryption--discovery-association.md',
      priorExists: false, stale: null, reason: 'all',
    });
    assert.deepEqual(plan.configIssues, []);
  } finally { rmN(r.root, { recursive: true, force: true }); }
});

test('planSync: incremental — one changed source queues only the affected child', () => {
  const r = fzRepoThemeDeep();
  try {
    const lore = r.loreDir;
    const themeDir = jN(lore, 'wiki', 'theme');
    // 两个子页都先落盘（第二次 finalize 后都有指纹）
    wfN(jN(themeDir, 'sidecar-config-decryption--discovery-association.md'),
      '---\ntitle: DA\nsummary: s\n---\n# theme-deep: discovery-association\n\n## 机制详解\n\nv1\n');
    wfN(jN(themeDir, 'sidecar-config-decryption--canonical-propagation.md'),
      '---\ntitle: CP\nsummary: s\n---\n# theme-deep: canonical-propagation\n\n## 机制详解\n\nv1\n');
    // 加第二个子（源 server/finalize.py）
    const cfg = rdN(jN(lore, 'config.yml'), 'utf8');
    wfN(jN(lore, 'config.yml'), cfg + '        执行与传播:\n          - { id: canonical-propagation, sources: [server/finalize.py] }\n');
    const plan1 = pl(lore);                       // 首次：两子都 new
    assert.ok(plan1.worklist.some(w => w.kind === 'deep' && w.id === 'sidecar-config-decryption--discovery-association'));
    fz(lore, '2026-08-05T00:00:00Z');             // finalize 建立两子指纹
    // 只改 probe.py
    wfN(jN(r.root, 'sidecar', 'probe.py'), 'PROBE = 2\n');
    exN2('git', ['add', '-A'], { cwd: r.root, stdio: 'pipe' });
    exN2('git', ['commit', '-qm', 'change probe'], { cwd: r.root, stdio: 'pipe' });
    const plan2 = pl(lore);
    const da = plan2.worklist.find(w => w.kind === 'deep' && w.id === 'sidecar-config-decryption--discovery-association');
    const cp = plan2.worklist.find(w => w.kind === 'deep' && w.id === 'sidecar-config-decryption--canonical-propagation');
    assert.equal(da.reason, 'source-changed');
    assert.ok((da.stale ?? 0) >= 1);
    assert.equal(cp, undefined);                  // 兄弟子源没变 → 不排队（fresh）
  } finally { rmN(r.root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/sync.test.js`
Expected: FAIL —— 第一个用例无 theme-deep work item；第二个在增量阶段无 `source-changed` 子项。

- [ ] **Step 3: 实现**（`lib/sync.js`；import 行 7 加 `parseConfigThemeDeep`，15 行加 `resolveConfiguredThemeDeep`）

import 行改：
```js
import { parseConfigCodeRoots, parseConfigThemes, parseConfigFlows, parseConfigDocsAxis, parseConfigLanguage, parseConfigDeep, parseConfigThemeDeep } from './config.js';
import { resolveConfiguredDeep, parseDeepEntry, resolveConfiguredThemeDeep } from './source.js';
```

`planSync` 内 themes 循环之后（66-68 行 `for (const th of themes)` 块之后）追加：

```js
  // 主题深度页（多源子页）：一子一 work item，源级增量（与组件深度页同精神）。
  const themeDeep = parseConfigThemeDeep(configText);
  const resolvedThemeDeep = resolveConfiguredThemeDeep(repoRoot, themes, themeDeep);
  for (const child of resolvedThemeDeep.children) {
    const id = `${child.parent}--${child.id}`;
    const rel = `theme/${id}.md`;
    const fp = fingerprints[rel];
    const pageExists = exists('theme', id);
    let stale = null, reason;
    if (all) reason = 'all';
    else if (!fp) reason = 'new';
    else if (!pageExists) reason = 'missing-page';
    else { stale = countSince(fp.prose_sha, child.sourceFiles); reason = stale > 0 ? 'source-changed' : 'fresh'; }
    const include = all || !fp || reason === 'missing-page' || (stale ?? 0) > 0;
    if (include) {
      worklist.push({ axis: 'theme', id, kind: 'deep', parent: child.parent, group: child.group, sourceFiles: child.sourceFiles, path: rel, priorExists: pageExists, stale, reason });
    }
  }
```

`configIssues` 返回改（73 行）：
```js
  return { codeRoots, themes, flows, worklist, configIssues: [...resolvedDeep.issues, ...resolvedThemeDeep.issues] };
```

> Amendment 7 措辞校正已内建：父主题鸟瞰页依旧无条件排队（既有 themes 循环不动）；子页独立按源增量，互不驱动。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `node --test test/sync.test.js`
Expected: PASS —— 既有 planSync/finalize 用例（精确 deepEqual worklist 的只在无 theme.deep 的 config 下，不受影响）+ 2 个新用例。

- [ ] **Step 5: 提交**

```bash
git add lib/sync.js test/sync.test.js
git commit -m "feat(sync): planSync queues theme-deep children with per-source staleness"
```

---

### Task 5: manifest —— 子页可选字段 + theme 排序/导航排除

**Files:**
- Modify: `lib/manifest.js:43-101,161-183`
- Test: `test/manifest.test.js`

> 先于 finalizeSync（Task 6）：finalize 的孤儿删除依赖 manifest 里 `kind:'deep'` 证明，本任务先让 manifest 发出来。

- [ ] **Step 1: 写失败测试**（`test/manifest.test.js`；import 行加 `emitManifest`，并补 `mkdtempSync/mkdirSync/writeFileSync/rmSync`、`tmpdir`、`join`、`execFileSync`）

```js
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

function themeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'lore-manifest-theme-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  const lore = join(root, '.lore');
  mkdirSync(join(lore, 'wiki', 'theme'), { recursive: true });
  mkdirSync(join(lore, '.state'), { recursive: true });
  writeFileSync(join(lore, 'config.yml'), 'axes:\n  theme:\n    values:\n      - { id: p, desc: d, match: [x] }\n    deep:\n      p:\n        g1:\n          - { id: c1, sources: [a.py] }\n');
  writeFileSync(join(root, 'a.py'), 'x');
  writeFileSync(join(lore, 'wiki', 'theme', 'p.md'), '---\ntitle: P\nsummary: s\n---\n# theme: p\n');
  writeFileSync(join(lore, 'wiki', 'theme', 'p--c1.md'), '---\ntitle: P-C1\nsummary: s\n---\n# theme-deep: p--c1\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  return { root, lore };
}

test('emitManifest: theme child page emits kind/parent/group/sources; ordinary pages omit', () => {
  const { root, lore } = themeFixture();
  try {
    const manifest = emitManifest({
      wikiDir: join(lore, 'wiki'),
      currentSha: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim(),
      countCommitsSince: () => 0,
      now: 'NOW',
      axes: [{ id: 'theme', label: 'Theme' }],
      staleScopes: {}, componentOrder: [], pageGroups: {},
      themeOrder: ['p', 'p--c1'], themeDeepMeta: { 'p--c1': { parent: 'p', group: 'g1', sources: ['a.py'] } }, themeDeepActive: true,
    });
    const pages = manifest.axes[0].pages;
    assert.deepEqual(pages.map(p => p.id), ['p', 'p--c1']);        // 父先子后（themeOrder 序）
    const child = pages.find(p => p.id === 'p--c1');
    assert.equal(child.kind, 'deep');
    assert.equal(child.parent, 'p');
    assert.equal(child.group, 'g1');
    assert.deepEqual(child.sources, ['a.py']);
    const parent = pages.find(p => p.id === 'p');
    assert.equal(parent.kind, undefined);
    assert.equal(parent.parent, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('emitManifest: orphan child path excluded from theme nav when theme-deep active', () => {
  const { root, lore } = themeFixture();
  try {
    writeFileSync(join(lore, 'wiki', 'theme', 'p--ghost.md'), '---\ntitle: G\nsummary: s\n---\n# x\n');
    const manifest = emitManifest({
      wikiDir: join(lore, 'wiki'),
      currentSha: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim(),
      countCommitsSince: () => 0,
      now: 'NOW',
      axes: [{ id: 'theme', label: 'Theme' }],
      staleScopes: {}, componentOrder: [], pageGroups: {},
      themeOrder: ['p', 'p--c1'], themeDeepMeta: { 'p--c1': { parent: 'p', group: 'g1', sources: ['a.py'] } }, themeDeepActive: true,
    });
    const ids = manifest.axes[0].pages.map(p => p.id);
    assert.deepEqual(ids, ['p', 'p--c1']);
    assert.ok(!ids.includes('p--ghost'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('emitManifest: theme-deep inactive → theme pages alphabetical, no exclusion (backward compat)', () => {
  const { root, lore } = themeFixture();
  try {
    const manifest = emitManifest({
      wikiDir: join(lore, 'wiki'),
      currentSha: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim(),
      countCommitsSince: () => 0,
      now: 'NOW',
      axes: [{ id: 'theme', label: 'Theme' }],
      staleScopes: {}, componentOrder: [], pageGroups: {},
    });
    const ids = manifest.axes[0].pages.map(p => p.id);
    assert.deepEqual(ids, ['p--c1', 'p']);      // 字母序：'-'(0x2D) < '.'(0x2E) → 'p--c1' 在前
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/manifest.test.js`
Expected: FAIL —— 子页无 kind/parent/sources、`p--ghost` 未被排除。

- [ ] **Step 3: 实现**（`lib/manifest.js`）

**3a. `emitManifest` 签名加三参（默认值保证既有调用不变）：**
```js
export function emitManifest({
  wikiDir, currentSha, countCommitsSince, now, axes,
  language = { default: 'en', available: ['en'] },
  preferences = {}, staleScopes = {}, componentOrder = [], pageGroups = {},
  themeOrder = [], themeDeepMeta = {}, themeDeepActive = false,
}) {
```

**3b. theme 排序分支（原 `else files.sort()` 处）：**
```js
      if (ax.id === 'component' && componentOrder.length) {
        const rank = id => { const i = componentOrder.indexOf(id); return i === -1 ? Infinity : i; };
        files.sort((a, b) => {
          const ra = rank(a.replace(/\.md$/, '')), rb = rank(b.replace(/\.md$/, ''));
          return ra !== rb ? ra - rb : a.localeCompare(b);
        });
      } else if (ax.id === 'theme' && themeDeepActive && themeOrder.length) {
        const rank = id => { const i = themeOrder.indexOf(id); return i === -1 ? Infinity : i; };
        files.sort((a, b) => {
          const ra = rank(a.replace(/\.md$/, '')), rb = rank(b.replace(/\.md$/, ''));
          return ra !== rb ? ra - rb : a.localeCompare(b);
        });
      } else {
        files.sort();
      }
```

**3c. 页循环排除 + 可选字段 overlay（原 `for (const f of files) { pages.push(pageEntry(...)); }` 处）：**
```js
      for (const f of files) {
        const id = f.replace(/\.md$/, '');
        // theme-deep 激活时：含 `--` 且不在配置（themeOrder）里的页 = 孤儿子路径 → 排除出导航（lint 报 theme-deep-orphan）
        if (ax.id === 'theme' && themeDeepActive && id.includes('--') && !themeOrder.includes(id)) continue;
        const entry = pageEntry(wikiDir, ax.id, id, currentSha, countCommitsSince, language, staleScopes, pageGroups);
        if (ax.id === 'theme' && id in themeDeepMeta) {
          entry.kind = 'deep';
          entry.parent = themeDeepMeta[id].parent;
          entry.group = themeDeepMeta[id].group;
          entry.sources = themeDeepMeta[id].sources;
        }
        pages.push(entry);
      }
```

**3d. `runManifestCli` 签名加三参并透传：**
```js
export function runManifestCli(loreDir, nowIso, staleScopes = {}, componentOrder = [], pageGroups = {}, themeOrder = [], themeDeepMeta = {}, themeDeepActive = false) {
  ...
  const manifest = emitManifest({ wikiDir, currentSha, countCommitsSince, now: nowIso, language, preferences, staleScopes, componentOrder, pageGroups, themeOrder, themeDeepMeta, themeDeepActive });
  ...
}
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `node --test test/manifest.test.js test/sync.test.js`
Expected: PASS —— 既有 manifest/sync 用例（无 themeOrder 默认 [] → 行为不变）+ 3 个新用例。

- [ ] **Step 5: 提交**

```bash
git add lib/manifest.js test/manifest.test.js
git commit -m "feat(manifest): theme child optional fields (kind/parent/group/sources) + theme ordering + orphan nav exclusion"
```

---

### Task 6: `finalizeSync` —— 子页决策史 / staleScopes / 孤儿删除 / theme 元数据

**Files:**
- Modify: `lib/sync.js:193-325`
- Test: `test/sync.test.js`

> 依赖 Task 5（manifest 先发 `kind:'deep'`，孤儿删除测试才能证明「受管」）。四个改动点：① configText/language/themes 解析提前到顶部（轴循环要用）；② 轴循环里 theme 子页按 `refs.files` 源级过滤决策史（Amendment 1）；③ 受管孤儿删除 + sidecar（Amendment 5）；④ staleScopes + themeOrder/themeDeepMeta 喂 manifest。

- [ ] **Step 1: 写失败测试**（`test/sync.test.js` 末尾追加；`appendAtom` 已在顶部 [sync.test.js:10](test/sync.test.js#L10) 导入，`fzRepoThemeDeep` 复用 Task 4 fixture）

```js
test('finalizeSync: theme-deep child decision history is source-filtered (Amendment 1)', () => {
  const r = fzRepoThemeDeep();
  try {
    const lore = r.loreDir;
    const git = r.git;
    // 三个真实可达 commit 原子：init（触达 probe+assoc）、probe change（触达 probe）、unrelated（只触达别处）
    const sha1 = git('rev-parse', 'HEAD');
    wfN(jN(r.root, 'sidecar', 'probe.py'), 'PROBE = 2\n');
    exN2('git', ['add', '-A'], { cwd: r.root, stdio: 'pipe' });
    exN2('git', ['commit', '-qm', 'probe change'], { cwd: r.root, stdio: 'pipe' });
    const sha2 = git('rev-parse', 'HEAD');
    wfN(jN(r.root, 'unrelated.txt'), 'x\n');
    exN2('git', ['add', '-A'], { cwd: r.root, stdio: 'pipe' });
    exN2('git', ['commit', '-qm', 'unrelated'], { cwd: r.root, stdio: 'pipe' });
    const sha3 = git('rev-parse', 'HEAD');
    const atoms = [
      { id: `commit:${sha1}`, ts: '2026-08-04T00:00:00Z', kind: 'commit', commit: sha1, title: 'init', why: 'seed', facets: { theme: ['sidecar-config-decryption'], component: [], flow: [] }, refs: { files: ['sidecar/probe.py', 'sidecar/assoc.py'], pitfall: null, related: [] } },
      { id: `commit:${sha2}`, ts: '2026-08-05T00:00:00Z', kind: 'commit', commit: sha2, title: 'probe change', why: 'touched probe', facets: { theme: ['sidecar-config-decryption'], component: [], flow: [] }, refs: { files: ['sidecar/probe.py'], pitfall: null, related: [] } },
      { id: `commit:${sha3}`, ts: '2026-08-05T01:00:00Z', kind: 'commit', commit: sha3, title: 'unrelated', why: 'not sidecar', facets: { theme: ['sidecar-config-decryption'], component: [], flow: [] }, refs: { files: ['unrelated.txt'], pitfall: null, related: [] } },
    ];
    for (const a of atoms) appendAtom(jN(lore, 'journal'), a);
    // 父页 + 子页（含 Decision history token，foldJournal 才物化）
    wfN(jN(lore, 'wiki', 'theme', 'sidecar-config-decryption.md'), '---\ntitle: SCD\nsummary: s\n---\n# theme: sidecar-config-decryption\n');
    wfN(jN(lore, 'wiki', 'theme', 'sidecar-config-decryption--discovery-association.md'),
      '---\ntitle: DA\nsummary: s\n---\n# theme-deep: discovery-association\n\n## 机制详解\n\nv1\n\n## Decision history\n\n{{LORE_JOURNAL}}\n');
    fz(lore, '2026-08-05T02:00:00Z');
    const childText = rdN(jN(lore, 'wiki', 'theme', 'sidecar-config-decryption--discovery-association.md'), 'utf8');
    assert.match(childText, /probe change/);          // 触达 probe 的原子在
    assert.doesNotMatch(childText, /unrelated/);      // 无关原子被过滤
    assert.match(childText, /seed/);                  // 触达 probe/assoc 的 init 原子在
  } finally { rmN(r.root, { recursive: true, force: true }); }
});

test('finalizeSync: managed theme-deep orphan removed with translation sidecar (Amendment 5)', () => {
  const r = fzRepoThemeDeep();
  try {
    const lore = r.loreDir;
    const wd = jN(lore, 'wiki');
    const childRel = 'theme/sidecar-config-decryption--discovery-association.md';
    wfN(jN(wd, childRel), '---\ntitle: DA\nsummary: s\n---\n# x\n\n## 机制详解\n\nv1\n');
    wfN(jN(wd, 'theme', 'sidecar-config-decryption--discovery-association.en.md'), '---\ntitle: DA\nsummary: s\ntranslation_source_hash: x\n---\n# x\n');
    fz(lore, '2026-08-05T00:00:00Z');                 // 第一轮：manifest 建立 kind:deep 证明（Task 5 已实现）
    // 第二轮：config 移除该子 → 受管孤儿应被删（含 .en.md sidecar；zh 默认 en 非默认）
    const cfg = rdN(jN(lore, 'config.yml'), 'utf8');
    wfN(jN(lore, 'config.yml'), cfg.replace(/    deep:[\s\S]*$/, ''));
    fz(lore, '2026-08-05T01:00:00Z');
    assert.equal(existsSync(jN(wd, childRel)), false);
    assert.equal(existsSync(jN(wd, 'theme', 'sidecar-config-decryption--discovery-association.en.md')), false);
  } finally { rmN(r.root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/sync.test.js`
Expected: FAIL —— 子页决策史含 unrelated 原子；孤儿未删除（两用例在 Task 6 前各自失败点不同，见 Step 3 后全绿）。

- [ ] **Step 3: 实现**（`lib/sync.js`：import 加 `rmSync`、`parseConfigThemeDeep`、`resolveConfiguredThemeDeep`）

import 行改：
```js
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { parseConfigCodeRoots, parseConfigThemes, parseConfigFlows, parseConfigDocsAxis, parseConfigLanguage, parseConfigDeep, parseConfigThemeDeep } from './config.js';
import { resolveConfiguredDeep, parseDeepEntry, resolveConfiguredThemeDeep } from './source.js';
```

`finalizeSync` 重构：configText 解析提前到顶部（原 250-253 行的 docs/language 解析上移），加 theme-deep 结构。

**3a. 顶部解析（`const repoRoot...` 后立即加）：**
```js
  const configPath = join(loreDir, 'config.yml');
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const codeRoots = parseConfigCodeRoots(configText);
  const themes = parseConfigThemes(configText);
  const flows = parseConfigFlows(configText);
  const deep = parseConfigDeep(configText);
  const themeDeepCfg = parseConfigThemeDeep(configText);
  const language = parseConfigLanguage(configText);
  const docsConfig = parseConfigDocsAxis(configText);
  const resolvedDeep = resolveConfiguredDeep(repoRoot, codeRoots, deep);
  const resolvedThemeDeep = resolveConfiguredThemeDeep(repoRoot, themes, themeDeepCfg);
  const themeChildById = new Map(resolvedThemeDeep.children.map(c => [`${c.parent}--${c.id}`, c]));
```

**3b. 删除**原 250-253 行的 `configPath`/`configText`/`docsConfig`/`language` 重复声明；删除原 295-297、304-305 行重复的 `codeRoots`/`flows`/`deep`/`resolvedDeep` 声明。

**3c. 受管孤儿删除（轴循环前）：**
```js
  // 受管 theme-deep 孤儿清理（Amendment 5）：仅删「上一轮 manifest 证明 kind:'deep' + parent」的页，翻译 sidecar 一并删；
  // 手写页（无管理证明）保留——manifest 排除出导航、lint 报 theme-deep-orphan。
  const prevManagedThemePages = (() => {
    const p = join(wikiDir, '.manifest.json');
    if (!existsSync(p)) return new Set();
    let m; try { m = JSON.parse(readFileSync(p, 'utf8')); } catch { return new Set(); }
    const set = new Set();
    for (const ax of m.axes ?? []) {
      if (ax.id !== 'theme') continue;
      for (const pg of ax.pages ?? []) if (pg.kind === 'deep' && pg.parent) set.add(pg.path);
    }
    return set;
  })();
  const configThemePaths = new Set(themes.map(t => `theme/${t.id}.md`));
  const configChildPaths = new Set(resolvedThemeDeep.children.map(c => `theme/${c.parent}--${c.id}.md`));
  const themeOrphanDir = join(wikiDir, 'theme');
  let themeFilesOnDisk = [];
  try {
    themeFilesOnDisk = readdirSync(themeOrphanDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name);
  } catch {}
  for (const f of themeFilesOnDisk) {
    const rel = `theme/${f}`;
    if (configThemePaths.has(rel) || configChildPaths.has(rel)) continue;
    if (prevManagedThemePages.has(rel)) {
      rmSync(join(wikiDir, rel));
      const base = rel.replace(/\.md$/, '');
      for (const lang of language.available) {
        if (lang === language.default) continue;
        const sc = join(wikiDir, `${base}.${lang}.md`);
        if (existsSync(sc)) rmSync(sc);
      }
    }
  }
```

**3d. 轴循环内 theme 子页决策史 + axisPages 元数据（替换 `const atomsFor = ...` 到 `axisPages[axis].push({ id, title: data.title ?? id });` 段）：**
```js
      const id = basename(f, '.md');
      const rel = `${axis}/${f}`;
      const child = (axis === 'theme') ? (themeChildById.get(id) ?? null) : null;
      let atomsFor = allAtoms.filter(a => a.facets?.[axis]?.includes(id));
      if (child) {
        // Amendment 1：子页决策史 = 父主题原子 ∩ (refs.files 命中已解析源列表)——零新 git 调用
        const srcs = new Set(child.sourceFiles);
        atomsFor = allAtoms
          .filter(a => a.facets?.theme?.includes(child.parent))
          .filter(a => (a.refs?.files ?? []).some(ff => srcs.has(ff)));
      }
      const md = renderDecisionHistory(atomsFor);
      let text = foldJournal(readFileSync(p, 'utf8'), md, { page: rel, warn });
      const proseSha = resolveProseSha(rel, text);           // 对折叠后的稳定文本算指纹
      text = stampFrontmatter(text, {
        codeSha: proseSha,
        lastUpdated,
        atoms: atomsFor.length,
        commits: atomsFor.filter(a => a.kind === 'commit').length,
      });
      writeFileSync(p, text);
      const { data } = parseFrontmatter(text);
      stamped.push(rel);
      const entry = { id, title: data.title ?? id };
      if (child) { entry.parent = child.parent; entry.kind = 'deep'; entry.group = child.group; }
      axisPages[axis].push(entry);
```

**3e. staleScopes + theme 排序元数据（原 294-308 行 staleScopes 构建之后追加）：**
```js
  // theme-deep 子页：源级 staleScopes（与 plan/finalize/lint 同一解析列表）
  for (const child of resolvedThemeDeep.children) {
    staleScopes[`theme/${child.parent}--${child.id}.md`] = child.sourceFiles;
  }
```
```js
  const themeOrder = [...themes.map(t => t.id)];
  const themeDeepMeta = {};
  for (const child of resolvedThemeDeep.children) {
    themeOrder.push(`${child.parent}--${child.id}`);
    themeDeepMeta[`${child.parent}--${child.id}`] = { parent: child.parent, group: child.group, sources: child.sourceFiles };
  }
```

**3f. runManifestCli 调用加三参：**
```js
  const { manifestPath, manifest } = runManifestCli(loreDir, now, staleScopes, componentOrder, pageGroups, themeOrder, themeDeepMeta, resolvedThemeDeep.children.length > 0);
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `node --test test/sync.test.js test/manifest.test.js`
Expected: PASS —— 既有 50+ 用例（无 theme.deep 的 config 路径行为不变；themeDeepActive=false → manifest 走字母序旧路径）+ 2 个新用例。

- [ ] **Step 5: 提交**

```bash
git add lib/sync.js test/sync.test.js
git commit -m "feat(sync): finalizeSync theme-deep — source-filtered decision history, staleScopes, managed orphan removal, theme order/meta"
```

---

### Task 7: `buildIndex` theme 嵌套

**Files:**
- Modify: `lib/sync.js:77-86`
- Test: `test/sync.test.js`

- [ ] **Step 1: 写失败测试**（`test/sync.test.js` 末尾追加）

```js
test('buildIndex nests theme children under parents with group labels', () => {
  const out = buildIndex({
    theme: [
      { id: 'p', title: 'P' },
      { id: 'p--c1', title: 'C1', parent: 'p', kind: 'deep', group: 'g1' },
      { id: 'p--c2', title: 'C2', parent: 'p', kind: 'deep', group: 'g1' },
      { id: 'p--c3', title: 'C3', parent: 'p', kind: 'deep', group: 'g2' },
    ],
  });
  assert.match(out, /## Theme/);
  assert.match(out, /- \[\[p\]\]/);
  assert.match(out, /  - g1/);
  assert.match(out, /    - \[\[p--c1\]\]/);
  assert.match(out, /    - \[\[p--c2\]\]/);
  assert.match(out, /  - g2/);
  assert.match(out, /    - \[\[p--c3\]\]/);
  // 无 parent 的普通主题页保持平铺
  const flat = buildIndex({ theme: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] });
  assert.match(flat, /- \[\[a\]\]\n- \[\[b\]\]/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/sync.test.js`
Expected: FAIL —— theme 段平铺，无嵌套/组标签。

- [ ] **Step 3: 实现**（`lib/sync.js`，`buildIndex` 整体替换 + 新增 helper）

```js
export function buildIndex(axisPages) {
  const sections = [];
  for (const axis of ['component', 'flow', 'theme', 'docs']) {   // keep in sync with manifest AXIS_ORDER (minus INDEX)
    const pages = axisPages[axis];
    if (!pages || pages.length === 0) continue;
    const heading = axis.charAt(0).toUpperCase() + axis.slice(1);
    const body = (axis === 'theme' && pages.some(p => p.parent))
      ? renderThemeIndex(pages)
      : pages.map(p => `- [[${p.id}]]`).join('\n');
    sections.push(`## ${heading}\n${body}`);
  }
  return `---\ntitle: Index\nsummary: table of contents\n---\n# lore wiki — index\n\n${sections.join('\n\n')}\n`;
}

// theme 段：鸟瞰页顶层 + 子页按父分组/顺序嵌套，组名作缩进标签。
function renderThemeIndex(pages) {
  const parents = pages.filter(p => !p.parent);
  const children = pages.filter(p => p.parent);
  const byParent = new Map();
  for (const c of children) {
    if (!byParent.has(c.parent)) byParent.set(c.parent, []);
    byParent.get(c.parent).push(c);
  }
  const lines = [];
  for (const p of parents) {
    lines.push(`- [[${p.id}]]`);
    const kids = byParent.get(p.id) ?? [];
    if (!kids.length) continue;
    let lastGroup = null;
    for (const k of kids) {
      if (k.group && k.group !== lastGroup) { lines.push(`  - ${k.group}`); lastGroup = k.group; }
      lines.push(`    - [[${k.id}]]`);
    }
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/sync.test.js`
Expected: PASS —— 既有 buildIndex 用例（无 parent 字段 → 平铺路径不变）+ 1 个新用例。

- [ ] **Step 5: 提交**

```bash
git add lib/sync.js test/sync.test.js
git commit -m "feat(sync): INDEX nests theme children under parents (group labels)"
```

---

### Task 8: graph `contains` 结构边

**Files:**
- Modify: `lib/graph.js:30-41`
- Test: `test/graph.test.js`

- [ ] **Step 1: 写失败测试**（`test/graph.test.js` 末尾追加）

```js
test('buildGraph: theme parent → child adds contains edge (both traversal directions)', () => {
  const manifest = mf([
    { id: 'theme', pages: [
      { id: 'p', title: 'P', path: 'theme/p.md' },
      { id: 'p--c1', title: 'C1', parent: 'p', kind: 'deep', path: 'theme/p--c1.md' },
      { id: 'p--ghost', title: 'G', parent: 'p', kind: 'deep', path: 'theme/p--ghost.md' },
    ] },
    { id: 'component', pages: [{ id: 'lib', title: 'Lib', path: 'component/lib.md' }] },
  ]);
  const g = buildGraph([], manifest, 'NOW');
  const contains = g.edges.filter(e => e.type === 'contains');
  assert.deepEqual(contains, [{ from: 'page:theme/p', to: 'page:theme/p--c1', type: 'contains' }]);
  // neighbors 双向：父→子（out），子→父（in）
  const childNeighbors = neighbors(g, 'page:theme/p--c1');
  assert.ok(childNeighbors.some(n => n.id === 'page:theme/p' && n.dir === 'in' && n.edge === 'contains'));
  const parentNeighbors = neighbors(g, 'page:theme/p');
  assert.ok(parentNeighbors.some(n => n.id === 'page:theme/p--c1' && n.dir === 'out' && n.edge === 'contains'));
  // 悬挂边（父页不存在）丢弃
  const g2 = buildGraph([], mf([{ id: 'theme', pages: [{ id: 'orphan--c', title: 'C', parent: 'orphan', path: 'theme/orphan--c.md' }] }]), 'NOW');
  assert.equal(g2.edges.filter(e => e.type === 'contains').length, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/graph.test.js`
Expected: FAIL —— 无 contains 边。

- [ ] **Step 3: 实现**（`lib/graph.js`，`buildGraph` 边段尾部追加）

```js
  // 结构边：theme 父页 → 子页（manifest parent 元数据；双向遍历经 neighbors，悬挂目标丢弃）
  for (const ax of manifest.axes ?? []) {
    if (ax.id === 'INDEX') continue;
    for (const p of ax.pages ?? []) {
      if (!p.parent) continue;
      const from = `page:${ax.id}/${p.parent}`;
      const to = `page:${ax.id}/${p.id}`;
      if (pageIds.has(from) && pageIds.has(to)) edges.push({ from, to, type: 'contains' });
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/graph.test.js`
Expected: PASS —— 既有用例 + 1 个新用例。

- [ ] **Step 5: 提交**

```bash
git add lib/graph.js test/graph.test.js
git commit -m "feat(graph): theme parent→child contains structural edges"
```

---

### Task 9: lint theme-deep 诊断

**Files:**
- Modify: `lib/lint.js`
- Test: `test/lint.test.js`

- [ ] **Step 1: 写失败测试**（`test/lint.test.js`；import 行 7 加 `lintThemeDeepConfig, lintThemeDeepPages`）

```js
test('lintThemeDeepConfig maps resolution issues to actionable diagnostics', () => {
  const root = tmpDir();
  try {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'a.py'), 'x');
    const themes = [{ id: 'p', match: [] }];
    const themeDeep = { parents: ['p', 'ghost'], children: [
      { parent: 'p', id: 'c1', group: '', sources: ['pkg/a.py'] },
      { parent: 'p', id: 'c1', group: '', sources: ['pkg/b.py'] },        // 父内重复
      { parent: 'p', id: 'c2', group: '', sources: [] },                  // 空 sources
      { parent: 'p', id: 'c3', group: '', sources: ['pkg/missing.py'] },  // 源缺失
      { parent: 'ghost', id: 'c4', group: '', sources: ['pkg/a.py'] },    // 父缺失
    ] };
    const diag = lintThemeDeepConfig(root, themes, themeDeep);
    const kinds = diag.map(d => d.kind);
    assert.ok(kinds.includes('theme-deep-id-collision'));
    assert.ok(kinds.includes('theme-deep-sources-empty'));
    assert.ok(kinds.includes('theme-deep-source-missing'));
    assert.ok(kinds.includes('theme-deep-parent-missing'));
    const missing = diag.find(d => d.kind === 'theme-deep-source-missing');
    assert.equal(missing.entry, 'pkg/missing.py');
    assert.match(missing.message, /no source file matched/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lintThemeDeepPages: mechanism, diagram, links, missing page, orphan, separator warning', () => {
  const root = tmpDir();
  try {
    const themeDir = join(root, 'wiki', 'theme');
    mkdirSync(themeDir, { recursive: true });
    // 合法子页：机制 + 图 + 父链接齐全
    writeFileSync(join(themeDir, 'p--good.md'),
      '---\ntitle: G\nsummary: s\n---\n# x\n\n[[p]]\n\n## 机制详解\n\nok\n\n```mermaid\nflowchart LR\n  a-->b\n```\n');
    // 缺机制 + 缺图 + 缺父链接
    writeFileSync(join(themeDir, 'p--bad.md'), '---\ntitle: B\nsummary: s\n---\n# x\n\nprose\n');
    // 父页缺子链接
    writeFileSync(join(themeDir, 'p.md'), '---\ntitle: P\nsummary: s\n---\n# x\n');
    // 孤儿子路径 + 历史 `--` 顶层主题
    writeFileSync(join(themeDir, 'p--ghost.md'), '---\ntitle: G2\nsummary: s\n---\n# x\n');
    writeFileSync(join(themeDir, 'legacy--theme.md'), '---\ntitle: L\nsummary: s\n---\n# x\n');
    const children = [
      { parent: 'p', id: 'good', group: 'g1', sourceFiles: ['a.py'] },
      { parent: 'p', id: 'bad', group: 'g1', sourceFiles: ['b.py'] },
      { parent: 'p', id: 'missing', group: 'g1', sourceFiles: ['c.py'] },
    ];
    const themes = [{ id: 'p', match: [] }, { id: 'legacy--theme', match: [] }];
    const diag = lintThemeDeepPages(join(root, 'wiki'), children, themes);
    const byKind = k => diag.filter(d => d.kind === k);
    assert.equal(byKind('theme-deep-mechanism-missing').some(d => d.child === 'bad'), true);
    assert.equal(byKind('theme-deep-diagram-missing').some(d => d.child === 'bad'), true);
    assert.equal(byKind('theme-deep-parent-link-missing').some(d => d.child === 'bad'), true);
    assert.equal(byKind('theme-deep-child-link-missing').some(d => d.child === 'good'), true);
    assert.equal(byKind('theme-deep-page-missing').some(d => d.child === 'missing'), true);
    assert.equal(byKind('theme-deep-orphan').some(d => d.child === 'p--ghost'), true);
    assert.equal(byKind('theme-id-reserved-separator').some(d => d.parent === 'legacy--theme'), true);
    // good 页零诊断
    assert.equal(byKind('theme-deep-mechanism-missing').some(d => d.child === 'good'), false);
    assert.equal(byKind('theme-deep-diagram-missing').some(d => d.child === 'good'), false);
    assert.equal(byKind('theme-deep-parent-link-missing').some(d => d.child === 'good'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/lint.test.js`
Expected: FAIL —— 导出不存在 / 诊断为空。

- [ ] **Step 3: 实现**（`lib/lint.js`）

**3a. import 行 7 改：**
```js
import { parseConfigCodeRoots, parseConfigDeep, parseConfigThemes, parseConfigThemeDeep } from './config.js';
import { resolveConfiguredDeep, parseDeepEntry, resolveConfiguredThemeDeep } from './source.js';
```

**3b. 文件末尾追加两个函数：**
```js
// ---- theme deep 诊断 ----
export function lintThemeDeepConfig(repoRoot, themes, themeDeep) {
  const { issues } = resolveConfiguredThemeDeep(repoRoot, themes, themeDeep);
  return issues.map(i => {
    switch (i.kind) {
      case 'theme-deep-parent-missing': return {
        kind: 'theme-deep-parent-missing', parent: i.parent, child: i.child,
        message: `parent "${i.parent}" must exist exactly once in axes.theme.values (child "${i.child}")`,
      };
      case 'theme-deep-id-collision': return {
        kind: 'theme-deep-id-collision', parent: i.parent, child: i.child,
        message: i.canonical
          ? `canonical id "${i.canonical}" collides with another theme page — keep one`
          : `child id "${i.child}" duplicated under parent "${i.parent}"`,
      };
      case 'theme-deep-sources-empty': return {
        kind: 'theme-deep-sources-empty', parent: i.parent, child: i.child,
        message: `child "${i.child}" declares no sources`,
      };
      case 'theme-deep-source-invalid': return {
        kind: 'theme-deep-source-invalid', parent: i.parent, child: i.child, entry: i.entry,
        message: `source "${i.entry}": ${i.reason}`,
      };
      case 'theme-deep-source-missing': return {
        kind: 'theme-deep-source-missing', parent: i.parent, child: i.child, entry: i.entry,
        message: `no source file matched "${i.entry}" for parent "${i.parent}" / child "${i.child}"`,
      };
      case 'theme-deep-source-outside-repo': return {
        kind: 'theme-deep-source-outside-repo', parent: i.parent, child: i.child, entry: i.entry,
        message: `source "${i.entry}" resolves outside the repository`,
      };
      default: throw new Error(`lintThemeDeepConfig: unknown issue kind "${i.kind}"`);
    }
  });
}

// 页级诊断：缺页 / 缺机制 / 缺图 / 双向缺链接 / 孤儿子路径 / 历史 `--` 顶层主题（非阻断）。
export function lintThemeDeepPages(wikiDir, children, themes) {
  const out = [];
  const childByCanonical = new Map(children.map(c => [`${c.parent}--${c.id}`, c]));
  const parentSet = new Set(themes.map(t => t.id));
  const themeDir = join(wikiDir, 'theme');
  let files = [];
  try {
    files = readdirSync(themeDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md')).map(e => basename(e.name, '.md'));
  } catch {}
  const pageSet = new Set(files);

  for (const [canonical, c] of childByCanonical) {
    if (!pageSet.has(canonical)) {
      out.push({ kind: 'theme-deep-page-missing', parent: c.parent, child: c.id, message: `child page theme/${canonical}.md missing — run /lore:sync` });
      continue;
    }
    const text = readFileSync(join(wikiDir, 'theme', `${canonical}.md`), 'utf8');
    const { body } = parseFrontmatter(text);
    if (!/^##\s+机制详解/m.test(body)) out.push({ kind: 'theme-deep-mechanism-missing', parent: c.parent, child: c.id, message: `child theme/${canonical}.md lacks "## 机制详解"` });
    if (!/```mermaid/.test(body)) out.push({ kind: 'theme-deep-diagram-missing', parent: c.parent, child: c.id, message: `child theme/${canonical}.md lacks a mermaid architecture diagram` });
    if (!text.includes(`[[${c.parent}]]`)) out.push({ kind: 'theme-deep-parent-link-missing', parent: c.parent, child: c.id, message: `child theme/${canonical}.md must link its parent [[${c.parent}]]` });
  }

  for (const parent of parentSet) {
    if (!pageSet.has(parent)) continue;
    const text = readFileSync(join(wikiDir, 'theme', `${parent}.md`), 'utf8');
    for (const [canonical, c] of childByCanonical) {
      if (c.parent !== parent) continue;
      if (!text.includes(`[[${canonical}]]`)) out.push({ kind: 'theme-deep-child-link-missing', parent, child: c.id, message: `overview theme/${parent}.md must list child [[${canonical}]]` });
    }
  }

  for (const id of pageSet) {
    if (childByCanonical.has(id) || parentSet.has(id)) continue;
    if (id.includes('--')) out.push({ kind: 'theme-deep-orphan', parent: id.split('--')[0], child: id, message: `theme page theme/${id}.md is no longer configured — remove or re-add under theme.deep` });
  }

  // Amendment 4：历史 `--` 顶层主题 id —— 非阻断警告（不使 clean 变红）。
  for (const id of parentSet) {
    if (id.includes('--')) out.push({ kind: 'theme-id-reserved-separator', parent: id, child: '', message: `top-level theme id "${id}" contains the reserved "--" separator (theme-deep children share this namespace)` });
  }
  return out;
}
```

**3c. `lint()` 接线**（`lintDeepConfig` 之后）：
```js
  const themeDeepCfg = configText ? parseConfigThemeDeep(configText) : { parents: [], children: [] };
  const themes = configText ? parseConfigThemes(configText) : [];
  const resolvedThemeDeep = resolveConfiguredThemeDeep(repoRoot, themes, themeDeepCfg);
  const themeDeepDiag = [
    ...lintThemeDeepConfig(repoRoot, themes, themeDeepCfg),
    ...lintThemeDeepPages(wikiDir, resolvedThemeDeep.children, themes),
  ];
  const themeDeepWarnings = themeDeepDiag.filter(d => d.kind === 'theme-id-reserved-separator');
  const themeDeepFatal = themeDeepDiag.filter(d => d.kind !== 'theme-id-reserved-separator');
```
返回对象加 `themeDeep: themeDeepFatal, themeDeepWarnings`，`clean` 加 `&& themeDeepFatal.length === 0`。

**3d. CLI 输出**（`r.deepConfig.length` 打印后）：
```js
    if (r.themeDeep.length) console.log(`theme-deep (${r.themeDeep.length}): ` + r.themeDeep.map(d => `${d.parent ? d.parent + '/' : ''}${d.child ?? ''} ${d.kind} — ${d.message}`).join('; '));
    if (r.themeDeepWarnings.length) console.log(`theme-deep-warning (${r.themeDeepWarnings.length}): ` + r.themeDeepWarnings.map(d => d.message).join('; '));
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `node --test test/lint.test.js`
Expected: PASS —— 既有用例 + 2 个新用例。

> 检查：`lint.test.js` 是否有对 `lint()` 返回对象的整体 deepEqual？若有，Step 4 会暴露——同步在返回对象里补 `themeDeep`/`themeDeepWarnings` 字段到断言。

- [ ] **Step 5: 提交**

```bash
git add lib/lint.js test/lint.test.js
git commit -m "feat(lint): theme-deep diagnostics (config + page-level) + reserved-separator non-blocking warning"
```

---

### Task 10: shell 侧栏 theme 嵌套

**Files:**
- Modify: `site/shell.mjs`
- Modify: `site/index.html`
- Test: `test/shell.test.js`

- [ ] **Step 1: 写失败测试**（`test/shell.test.js`，import 区加 `buildThemeRows`）

```js
test('buildThemeRows nests children under parents with group order', () => {
  const pages = [
    { id: 'p', title: 'P' },
    { id: 'p--c1', title: 'C1', parent: 'p', group: 'g1' },
    { id: 'p--c2', title: 'C2', parent: 'p', group: 'g1' },
    { id: 'p--c3', title: 'C3', parent: 'p', group: 'g2' },
    { id: 'other', title: 'O' },
  ];
  const rows = buildThemeRows(pages);
  assert.deepEqual(rows.map(r => r.page.id), ['p', 'other']);
  const p = rows.find(r => r.page.id === 'p');
  assert.deepEqual(p.groups.map(g => g.group), ['g1', 'g2']);
  assert.deepEqual(p.groups[0].rows.map(r => r.id), ['p--c1', 'p--c2']);
  assert.deepEqual(p.groups[1].rows.map(r => r.id), ['p--c3']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/shell.test.js`
Expected: FAIL —— `buildThemeRows is not defined`。

- [ ] **Step 3: 实现**

**3a. `site/shell.mjs` 末尾追加：**
```js
// theme 轴侧栏模型：鸟瞰页顶层 + 子页按父分组/顺序嵌套（manifest 排序单一来源；组名作子块头）。
export function buildThemeRows(pages) {
  const parents = pages.filter(p => !p.parent);
  const children = pages.filter(p => p.parent);
  const byParent = new Map();
  for (const c of children) {
    if (!byParent.has(c.parent)) byParent.set(c.parent, []);
    byParent.get(c.parent).push(c);
  }
  return parents.map(p => ({
    page: p,
    groups: (byParent.get(p.id) ?? []).reduce((acc, k) => {
      const g = k.group || '';
      const last = acc[acc.length - 1];
      if (!last || last.group !== g) acc.push({ group: g, rows: [] });
      acc[acc.length - 1].rows.push(k);
      return acc;
    }, []),
  }));
}
```

**3b. `site/index.html`：**
- import 行（~245 行）加 `buildThemeRows`：
```html
  buildNavModel, buildMeta, chooseInitialLanguage, resolveLocalizedPage, buildThemeRows,
```
- `pagesHtml`（338-349 行）改为 theme 分支：
```js
  const themeHtml = (ax) => buildThemeRows(ax.pages).map(row => {
    const kids = row.groups.map(g =>
      `<div class="grp">▸ ${g.group}</div>${g.rows.map(k => linkHtml(ax, k)).join('')}`
    ).join('');
    return linkHtml(ax, row.page) + (kids ? `<div class="theme-children">${kids}</div>` : '');
  }).join('');
  const pagesHtml = (ax) => {
    if (ax.id === 'docs') return docsHtml(ax);
    if (ax.id === 'theme') return themeHtml(ax);
    if (ax.id !== 'component') return ax.pages.map(p => linkHtml(ax, p)).join('');
    ...
  };
```
- CSS（侧栏区，~106 行 `.dot.theme` 后）加：
```css
  .theme-children { padding-left: 12px; border-left: 2px solid var(--border); margin: 2px 0 6px; }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/shell.test.js`
Expected: PASS —— 既有用例 + 1 个新用例。

> index.html 改动无法单测（浏览器侧），由 Task 12 全量 + 手动 `/lore:serve` 目验兜底。

- [ ] **Step 5: 提交**

```bash
git add site/shell.mjs site/index.html test/shell.test.js
git commit -m "feat(shell): theme sidebar nests children under parents (buildThemeRows + index.html)"
```

---

### Task 11: ask/mcp parent-kind 元数据

**Files:**
- Modify: `lib/ask.js:23`
- Modify: `lib/mcp.js:44-52`
- Test: `test/ask.test.js`, `test/mcp.test.js`

- [ ] **Step 1: 写失败测试**

`test/ask.test.js` 末尾追加：
```js
test('searchPages includes parent/kind metadata for theme-deep children', () => {
  const manifest = {
    axes: [{
      id: 'theme', pages: [
        { id: 'p', title: 'P', summary: 's', path: 'theme/p.md', sections: [] },
        { id: 'p--c1', title: 'C1', summary: 'decrypt', path: 'theme/p--c1.md', sections: [], kind: 'deep', parent: 'p' },
      ],
    }],
  };
  const hits = searchPages(manifest, 'decrypt');
  const c1 = hits.find(h => h.id === 'p--c1');
  assert.equal(c1.parent, 'p');
  assert.equal(c1.kind, 'deep');
  const p = hits.find(h => h.id === 'p');
  assert.equal(p.parent, undefined);
});
```

`test/mcp.test.js` 用例区追加（用既有 `rpc` helper，见 [mcp.test.js:41](test/mcp.test.js#L41)）：
```js
test('lore_ask returns parent/kind metadata for theme-deep children', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mcp-theme-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki', 'theme'), { recursive: true });
    mkdirSync(join(lore, '.state'), { recursive: true });
    writeFileSync(join(lore, 'config.yml'), 'axes:\n  theme:\n    values:\n      - { id: p, desc: d, match: [x] }\n    deep:\n      p:\n        g1:\n          - { id: c1, sources: [a.py] }\n');
    writeFileSync(join(root, 'a.py'), 'x');
    writeFileSync(join(lore, 'wiki', 'theme', 'p.md'), '---\ntitle: P\nsummary: s\n---\n# x\n');
    writeFileSync(join(lore, 'wiki', 'theme', 'p--c1.md'), '---\ntitle: P-C1\nsummary: decrypt stuff\n---\n# x\n');
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
    execFileSync('node', ['lib/sync.js', 'finalize', lore], { cwd: process.cwd() });
    const replies = await rpc(root, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lore_ask', arguments: { query: 'decrypt' } } },
    ]);
    const text = JSON.parse(replies[0].result.content[0].text);
    const hit = (text ?? []).find(h => h.id === 'page:theme/p--c1');
    assert.equal(hit.parent, 'p');
    assert.equal(hit.kind, 'deep');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/ask.test.js test/mcp.test.js`
Expected: FAIL —— searchPages 无 parent/kind；lore_ask 无元数据。

- [ ] **Step 3: 实现**

**3a. `lib/ask.js` searchPages hit 构造（23 行）改：**
```js
        const hit = { axis: axis.id, id: p.id, title: p.title, summary: p.summary, path: p.path, score };
        if (p.kind) hit.kind = p.kind;
        if (p.parent) hit.parent = p.parent;
        if (bestSection) hit.section = bestSection;
```

**3b. `lib/mcp.js` lore_ask 结果构造（44-46 行）改：**
```js
    const hits = searchPages(readJson('.manifest.json'), args.query ?? '');
    return hits.slice(0, 8).map(h => {
      const entry = { id: `page:${h.axis}/${h.id}`, title: h.title, axis: h.axis, score: h.score };
      if (h.parent) entry.parent = h.parent;
      if (h.kind) entry.kind = h.kind;
      if (h.section) {
        entry.section = h.section;
        try { entry.slice = sliceSection(readFileSync(join(wikiDir, h.path), 'utf8'), h.section) ?? undefined; }
        catch { /* 页文件缺失 → 无切片，条目仍返回 */ }
      }
      return entry;
    });
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `node --test test/ask.test.js test/mcp.test.js`
Expected: PASS —— 既有用例（hits 加字段是附加的，不影响既有断言）+ 2 个新用例。

- [ ] **Step 5: 提交**

```bash
git add lib/ask.js lib/mcp.js test/ask.test.js test/mcp.test.js
git commit -m "feat(ask/mcp): theme-deep children carry parent/kind metadata in search results"
```

---

### Task 12: 文档 + 脚手架 + 全量验证

**Files:**
- Modify: `commands/sync.md`
- Modify: `lib/migrate.js:157-166`（theme 模板补 deep 注释脚手架）
- Modify: `lib/source.js`（顶部注释，Amendment 7 词汇说明）

- [ ] **Step 1: `commands/sync.md` 补主题深度页说明**

在深度页段落（~161 行，钉法说明所在处）之后追加：

```markdown
**主题深度页**（`theme/<parent>--<child>`）：`axes.theme.deep` 声明——父主题下按分组列子页，每个子页带一组仓库相对源路径/glob。子页是机制级页（`## 机制详解` + mermaid 架构图，lint 双向检查），决策史按「commit 是否触达该子源文件」源级过滤；父鸟瞰页列全部子页、子页必须链回父页。`--` 为父/子分隔符，顶层主题 id 含 `--` 会收到 lint 警告。规范写法（子记录单行）：

```yaml
    deep:
      <parent-theme-id>:
        <分组名>:
          - { id: <child-id>, sources: [path/a.py, server/**] }
```

删除子页配置 → 受管页自动删除（含翻译 sidecar）；源文件缺失/越界/预算超限 → `theme-deep-*` 诊断。
```

- [ ] **Step 2: `lib/migrate.js` theme 配置块模板补注释**

CONFIG_BLOCKS 的 `config:axes.theme` 模板（~160 行）改为：

```js
    template: `  theme:                     # 自定义横切轴 — "这条长期主线怎么演进"（示例，按需填）
    values: []
    # - { id: quality, desc: "质量保证", match: [质量, accuracy, 误报] }
    # deep:                       # 主题深度页：父主题下按分组列多源子页（见 commands/sync.md）
    #   quality:
    #     合成:
    #       - { id: <child>, sources: [<repo-relative-path-or-glob>, ...] }`,
```

- [ ] **Step 3: `lib/source.js` 顶部补词汇注释（Amendment 7）**

文件顶部（`CODE_EXT` 上方）追加：

```js
// 深度页两套源解析词汇互补：
//   resolveDeepSource / resolveConfiguredDeep —— 目录内裸名/显式扫描（component.deep），ok/missing/ambiguous；
//   resolveThemeDeepSource / resolveConfiguredThemeDeep —— 显式路径/glob（theme.deep），ok/missing/invalid/outside-repo。
// 错误形状纪律共享（{status, …}），禁止跨层独立重解析——路径/glob 漂移会制造矛盾的「新鲜度」。
```

- [ ] **Step 4: 全量验证**

Run: `node --test test/*.test.js`
Expected: 全绿（若 `serve.test.js` 并行下偶发 flake——已知坑，重跑一次确认；仍失败且单跑 `node --test test/serve.test.js` 稳定则如实记录，不掩盖）。

Run: `node lib/sync.js plan .lore --all`（dogfood：本仓库无 theme.deep → plan 结构不变）
Expected: 输出含既有 component/theme 结构，无 theme-deep 项、无报错。

- [ ] **Step 5: 提交**

```bash
git add commands/sync.md lib/migrate.js lib/source.js
git commit -m "docs: theme-deep page syntax (sync.md, init scaffold, resolver vocab)"
```

---

## 验收（对照设计 + Amendments）

1. fixture 主题可声明 ≥2 个分组的多源子页（Task 2/3 用例覆盖）。
2. 改一个源精确排队受影响子页，兄弟子不排队（Task 4 `source-changed` 用例）。
3. plan/finalize/manifest/graph/INDEX/shell/lint/MCP 在子身份、父、分组、源集合上一致（Task 4-11 各自断言同一 canonical id `parent--child`）。
4. 负面路径（缺父/重复/空源/源缺失/越界/预算超限）与孤儿以可执行诊断失败（Task 3/9）。
5. Windows/Linux 归一化源身份一致（Task 3 glob/斜杠用例）。
6. 无 `theme.deep` 的仓库保留既有产物、全过既有套件（Task 5 `theme-deep inactive` 用例 + Task 12 全量）。
7. 端到端：一个含 `theme.deep` 的 fixture 能生成 1 个鸟瞰页 + 4 个职责向子页（Task 4/6 用例的组合验证；mal-analyze-cli 真实配置留给实施后 dogfood）。
8. Amendment 1：子页决策史严格按源过滤（Task 6 用例）。
9. Amendment 2：theme-deep `sources:` 不再劫持 docs（Task 1 回归用例）。
10. Amendment 5：受管孤儿删除 + sidecar（Task 6 用例）。
