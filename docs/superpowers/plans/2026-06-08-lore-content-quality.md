# lore 内容质量（两档好页 + 源文件级深度页）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 lore 内容质量升级——定义两档「好页」标准（概览档 + 9 节机制档 + 符号锚点）并让 sync 自动产出；用**源文件级深度页**根治「一个 code_root = 一页」的粒度过粗（lib.md 装 22 模块）。

**Architecture:** A（prompt 标准写进 `commands/sync.md` + golden page 当范例，**零引擎改**）+ B（config `deep` 声明源文件级深度页；`planSync` 列深度页工单、`finalizeSync` 给深度页按**源文件**构造 `staleScopes`）。深度页是**普通 component 页** → `manifest`/`graph` 自动支持（多出模块级节点），无需改。**深度页 v1 聚焦架构机制、不放决策史 token**（文件级 facet 分流留未来），决策史汇总在鸟瞰页。

**Tech Stack:** Node.js（零依赖、ESM）、`node:test`、`git rev-list`、正则 YAML 子集解析。

**Spec:** `docs/superpowers/specs/2026-06-08-lore-content-quality-design.md`（设计已批，A+B）。golden page 标杆：`docs/superpowers/notes/2026-06-08-lore-golden-page-sync.{html,md}`。

---

## File Structure

新增：无新 lib 文件（深度页复用现有 component 页机制）。

修改：
- `lib/config.js` —— 新增 `parseConfigDeep`（解析 `component.deep.<root>: [子模块…]`）。
- `lib/sync.js` —— `planSync` 列深度页工单（增量按源文件）；`finalizeSync` 给深度页构造 `staleScopes`（→ `[源文件]`）。import `parseConfigDeep`。
- `commands/sync.md` —— A：两档标准 + 鸟瞰/深度页区分 + 符号锚点 + 去黑话；深度页模板（无决策史 token）。
- `docs/superpowers/notes/2026-06-08-lore-golden-page-sync.{html,md}` —— 调整：深度页 v1 去掉决策史 section。
- `.lore/config.yml` —— dogfood：加 `deep`。
- `.lore/wiki/component/lib.md` + 新增 6 深度页 —— dogfood 内容重写。
- `docs/ROADMAP.md` —— 标 C-内容；订正「agent 端仍是 0」陈旧记述。

不动（测试确认无需改）：`lib/manifest.js`（A 期 `staleScopes` 已支持任意 `page→pathspec`）、`lib/graph.js`（页节点从 manifest 派生）。

扩展测试：`test/config.test.js`、`test/sync.test.js`、`test/manifest.test.js`。

---

## Task 1: `config.js` —— `parseConfigDeep`

**Files:**
- Modify: `lib/config.js`
- Test: `test/config.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/config.test.js` 末尾追加：

```js
import { parseConfigDeep } from '../lib/config.js';

test('parseConfigDeep: reads <root>: [submodules] under deep block', () => {
  const cfg = 'axes:\n  component:\n    code_roots: [lib]\n    deep:\n      lib: [sync, manifest, fingerprint]\n  flow:\n    values: []\n';
  assert.deepEqual(parseConfigDeep(cfg), { lib: ['sync', 'manifest', 'fingerprint'] });
});

test('parseConfigDeep: absent deep → {}', () => {
  assert.deepEqual(parseConfigDeep('axes:\n  component:\n    code_roots: [lib]\n'), {});
});

test('parseConfigDeep: stops at shallower key (no leak from sibling axes)', () => {
  const cfg = 'axes:\n  component:\n    deep:\n      lib: [sync]\n  theme:\n    values:\n    - { id: q, match: [a] }\n';
  assert.deepEqual(parseConfigDeep(cfg), { lib: ['sync'] });
});

test('parseConfigDeep: dequotes entries, ignores empty list', () => {
  const cfg = '    deep:\n      lib: ["sync", \'manifest\']\n      site: []\n';
  assert.deepEqual(parseConfigDeep(cfg), { lib: ['sync', 'manifest'] });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/config.test.js`
Expected: FAIL —— `parseConfigDeep is not a function`（未导出）。

- [ ] **Step 3: 写实现**

在 `lib/config.js` 末尾追加（逐行 + 缩进边界，比单正则更准——`deep` 是嵌套 block）：

```js
// 解析 component.deep —— `<code_root>: [子模块…]` 映射（源文件级深度页声明）。
// 缺 deep: → {}。块内每行 `root: [a, b]`；遇到缩进 <= deep: 的行即出块（不泄漏同级轴）。
export function parseConfigDeep(configText) {
  const lines = configText.split(/\r?\n/);
  const deep = {};
  let inBlock = false, baseIndent = 0;
  for (const line of lines) {
    if (!inBlock) {
      const m = line.match(/^(\s*)deep:\s*(?:#.*)?$/);
      if (m) { inBlock = true; baseIndent = m[1].length; }
      continue;
    }
    if (line.trim() === '') continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= baseIndent) break;                       // 回到同级/更浅 → 出块
    const m = line.match(/^\s*([A-Za-z0-9_.\/-]+):\s*\[([^\]]*)\]/);
    if (!m) continue;
    const mods = m[2].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '').trim()).filter(Boolean);
    if (mods.length) deep[m[1].trim()] = mods;
  }
  return deep;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/config.test.js`
Expected: PASS（4 个新用例 + 原有全绿）。

- [ ] **Step 5: Commit**

```bash
git add lib/config.js test/config.test.js
git commit -m "feat(config): parseConfigDeep — per-file deep-page declarations"
```

---

## Task 2: `sync.js` `planSync` —— 深度页工单 + 增量

**Files:**
- Modify: `lib/sync.js`（import + `planSync`）
- Test: `test/sync.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/sync.test.js` 末尾追加（自带 `fzRepoDeep` helper —— 建带 `deep` 的真 repo）：

```js
// --- deep pages (content-quality) ---
function fzRepoDeep() {
  const root = mkN(jN(tmpN(), 'lore-deep-'));
  const git = (...a) => exN2('git', a, { cwd: root, stdio: 'pipe' }).toString().trim();
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  mdN(jN(root, 'lib'), { recursive: true });
  wfN(jN(root, 'lib', 'sync.js'), 'export const a = 1;\n');
  wfN(jN(root, 'lib', 'manifest.js'), 'export const b = 1;\n');
  const lore = jN(root, '.lore');
  mdN(jN(lore, 'wiki', 'component'), { recursive: true });
  mdN(jN(lore, 'journal'), { recursive: true });
  mdN(jN(lore, '.state'), { recursive: true });
  wfN(jN(lore, 'config.yml'), 'axes:\n  component:\n    code_roots: [lib]\n    deep:\n      lib: [sync, manifest]\n');
  exN2('git', ['add', '-A'], { cwd: root, stdio: 'pipe' });
  exN2('git', ['commit', '-q', '-m', 'init'], { cwd: root, stdio: 'pipe' });
  return { root, loreDir: lore, git, sha: () => git('rev-parse', '--short', 'HEAD') };
}

test('planSync: deep 声明 → 列深度页工单（kind:deep, sourceFile, path）', () => {
  const r = fzRepoDeep();
  try {
    const wl = pl(r.loreDir, { all: true }).worklist.filter(w => w.kind === 'deep');
    assert.equal(wl.length, 2);
    const s = wl.find(w => w.id === 'sync');
    assert.equal(s.sourceFile, 'lib/sync.js');
    assert.equal(s.path, 'component/sync.md');
    assert.equal(s.reason, 'all');
  } finally { rmN(r.root, { recursive: true, force: true }); }
});

test('planSync 增量：深度页无指纹 → new 入；动其源文件 → code-changed', () => {
  const r = fzRepoDeep();
  try {
    // 无指纹（深度页 wiki 文件还没写）→ new 入
    let deep = pl(r.loreDir).worklist.filter(w => w.kind === 'deep');
    assert.equal(deep.length, 2);
    assert.equal(deep.find(w => w.id === 'sync').reason, 'new');

    // 写深度页 + finalize seed 指纹
    wfN(jN(r.loreDir, 'wiki', 'component', 'sync.md'),
      '---\ntitle: sync\nsummary: s\n---\n# component: sync\n\n## Current architecture\n\nv1\n');
    wfN(jN(r.loreDir, 'wiki', 'component', 'manifest.md'),
      '---\ntitle: manifest\nsummary: s\n---\n# component: manifest\n\n## Current architecture\n\nv1\n');
    fz(r.loreDir, '2026-06-08T00:00:00Z');
    deep = pl(r.loreDir).worklist.filter(w => w.kind === 'deep');
    assert.equal(deep.length, 0);                            // 都 fresh → 跳

    // 动 lib/sync.js + commit → 只有 sync 深度页回列
    wfN(jN(r.root, 'lib', 'sync.js'), 'export const a = 2;\n');
    exN2('git', ['commit', '-aqm', 'touch sync'], { cwd: r.root, stdio: 'pipe' });
    deep = pl(r.loreDir).worklist.filter(w => w.kind === 'deep');
    assert.equal(deep.length, 1);
    assert.equal(deep[0].id, 'sync');
    assert.equal(deep[0].reason, 'code-changed');
  } finally { rmN(r.root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/sync.test.js`
Expected: FAIL —— `planSync` 不列深度页工单（`kind:'deep'` 过滤为空），断言 `length === 2` 失败。

- [ ] **Step 3: 写实现**

在 `lib/sync.js` 顶部 import（第 7 行那条 config import）加 `parseConfigDeep`：

```js
import { parseConfigCodeRoots, parseConfigThemes, parseConfigFlows, parseConfigDocsAxis, parseConfigLanguage, parseConfigDeep } from './config.js';
```

在 `planSync` 里，`for (const codeRoot of codeRoots) { … }` 循环**之后**、`for (const th of themes)` **之前**，插入深度页循环：

```js
  // 深度页（源文件级）：config deep 声明 → 每个子模块一页 component/<mod>.md，
  // 增量按其源文件（<root>/<mod>.js）的 git 变更算 stale。
  const deep = parseConfigDeep(configText);
  for (const [codeRoot, mods] of Object.entries(deep)) {
    for (const mod of mods) {
      const rel = `component/${mod}.md`;
      const sourceFile = `${codeRoot}/${mod}.js`;            // v1 假设 .js（lore 是 JS 项目）；多语言后缀留后
      const fp = fingerprints[rel];
      let stale = null, reason;
      if (all) { reason = 'all'; }
      else if (!fp) { reason = 'new'; }
      else { stale = countSince(fp.prose_sha, [sourceFile]); reason = stale > 0 ? 'code-changed' : 'fresh'; }
      const include = all || !fp || (stale ?? 0) > 0;
      if (include) {
        worklist.push({ axis: 'component', id: mod, component: mod, sourceFile, kind: 'deep', path: rel, priorExists: exists('component', mod), stale, reason });
      }
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/sync.test.js`
Expected: PASS（2 个深度页用例 + 原有全绿；鸟瞰页工单不受影响——deep 是新增循环）。

- [ ] **Step 5: Commit**

```bash
git add lib/sync.js test/sync.test.js
git commit -m "feat(sync): planSync lists per-file deep-page worklist items (incremental by source file)"
```

---

## Task 3: `sync.js` `finalizeSync` —— 深度页 `staleScopes`

**Files:**
- Modify: `lib/sync.js`（`finalizeSync` 的 `staleScopes` 构造）
- Test: `test/sync.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/sync.test.js` 末尾追加（复用 Task 2 的 `fzRepoDeep`，确保在其后）：

```js
test('finalize: 深度页 staleScopes → [源文件]，stale 按源文件精确', () => {
  const r = fzRepoDeep();
  try {
    // 写 sync 深度页（带正文）
    const syncPage = jN(r.loreDir, 'wiki', 'component', 'sync.md');
    wfN(syncPage, '---\ntitle: sync\nsummary: s\n---\n# component: sync\n\n## Current architecture\n\nv1\n');
    fz(r.loreDir, '2026-06-08T00:00:00Z');                  // seed：prose_sha = 当前
    const sha0 = r.sha();
    // 动 lib/manifest.js（不是 sync.js）+ commit
    wfN(jN(r.root, 'lib', 'manifest.js'), 'export const b = 2;\n');
    exN2('git', ['commit', '-aqm', 'touch manifest'], { cwd: r.root, stdio: 'pipe' });
    fz(r.loreDir, '2026-06-08T00:00:00Z');                  // 机械刷新（正文未变 → prose_sha 保持）
    const manifest = JSON.parse(rdN(jN(r.loreDir, 'wiki', '.manifest.json'), 'utf8'));
    const page = manifest.axes.find(a => a.id === 'component').pages.find(p => p.id === 'sync');
    assert.equal(page.stale, 0);                            // 动的是 manifest.js，不是 sync.js → sync 深度页 stale 0
  } finally { rmN(r.root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/sync.test.js`
Expected: FAIL —— 深度页 `staleScopes` 未构造 → manifest 用全仓计数，动 manifest.js 也让 sync 深度页 `stale > 0`，断言 `=== 0` 失败。

- [ ] **Step 3: 写实现**

在 `lib/sync.js` `finalizeSync` 里，构造 `staleScopes` 那段（`for (const cr of codeRoots) …` / `for (const fl of flows) …` 之后）追加深度页映射：

```js
  // 深度页：component/<mod>.md → [<root>/<mod>.js]（按源文件精确 stale）
  const deep = parseConfigDeep(configText);
  for (const [cr, mods] of Object.entries(deep)) {
    for (const mod of mods) staleScopes[`component/${mod}.md`] = [`${cr}/${mod}.js`];
  }
```

> `parseConfigDeep` 已在 Task 2 import 进 `sync.js`。`configText` 在该函数内已读（docs/language 解析用的同一份）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/sync.test.js`
Expected: PASS（深度页 stale 用例 + 原有全绿）。

- [ ] **Step 5: Commit**

```bash
git add lib/sync.js test/sync.test.js
git commit -m "feat(sync): finalize maps deep pages to per-file staleScopes (honest per-module stale)"
```

---

## Task 4: `manifest` / `graph` —— 深度页节点（确认无需改）

**Files:**
- Test: `test/manifest.test.js`（characterization：证明深度页自动进 manifest + graph）

- [ ] **Step 1: 写测试（预期直接通过，锁定「无需改」）**

在 `test/sync.test.js` 末尾追加（复用 `fzRepoDeep`；验证深度页进 manifest + graph 模块级节点）：

```js
test('深度页自动进 manifest + graph 模块级节点（manifest/graph 无需改）', () => {
  const r = fzRepoDeep();
  try {
    wfN(jN(r.loreDir, 'wiki', 'component', 'sync.md'),
      '---\ntitle: sync\nsummary: s\n---\n# component: sync\n\n## Current architecture\n\nv1\n');
    fz(r.loreDir, '2026-06-08T00:00:00Z');
    const manifest = JSON.parse(rdN(jN(r.loreDir, 'wiki', '.manifest.json'), 'utf8'));
    const ids = manifest.axes.find(a => a.id === 'component').pages.map(p => p.id);
    assert.ok(ids.includes('sync'));                        // 深度页进 manifest
    const graph = JSON.parse(rdN(jN(r.loreDir, 'wiki', '.graph.json'), 'utf8'));
    assert.ok(graph.nodes.some(n => n.id === 'page:component/sync'));   // graph 模块级节点
  } finally { rmN(r.root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试**

Run: `node --test test/sync.test.js`
Expected: PASS **直接通过** —— 证明深度页是普通 component 页，`manifest`（扫 component 目录）+ `graph`（从 manifest axes 派生节点）**无需改**。
若 FAIL：说明某处对 component 页有隐式假设，需排查（不预期发生）。

- [ ] **Step 3: Commit**

```bash
git add test/sync.test.js
git commit -m "test(sync): deep pages auto-flow into manifest + graph (no manifest/graph change needed)"
```

---

## Task 5: A —— `commands/sync.md` prompt 标准 + golden page 调整

**Files:**
- Modify: `commands/sync.md`
- Modify: `docs/superpowers/notes/2026-06-08-lore-golden-page-sync.{html,md}`
- Test: `test/sync.test.js`（文档断言）

- [ ] **Step 1: 写失败测试**

在 `test/sync.test.js` 末尾追加（仿现有 `commands/sync.md documents HOME work item` 模式，断言关键标准串存在）：

```js
test('commands/sync.md documents two-tier page standard + deep pages', () => {
  const doc = readFileSync(join(process.cwd(), 'commands', 'sync.md'), 'utf8');
  assert.match(doc, /概览档/);                  // 两档标准
  assert.match(doc, /机制档/);
  assert.match(doc, /深度页/);                  // 粒度
  assert.match(doc, /鸟瞰页/);
  assert.match(doc, /符号/);                    // 锚点锚符号
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/sync.test.js`
Expected: FAIL —— 当前 `sync.md` 无这些标准串。

- [ ] **Step 3: 改 `commands/sync.md`**

在「## 给 agent 的提示」节后，新增一节「## 内容质量标准（两档好页 + 深度页）」，写入：

```md
## 内容质量标准（两档好页 + 深度页）

每页正文按**两档**写，范例见 `docs/superpowers/notes/2026-06-08-lore-golden-page-sync.html`：

- **概览档**（默认展示，目标「30 秒读懂」）：一句话定位 + 类比 · 主干 mermaid 图 · 用**场景**串讲核心机制 · 讲「为什么这么设计」。**零黑话**：内部术语（如 `prose_sha`）首次出现就地用大白话锚定，别预设读者懂。
- **机制档**（`<details>` 折叠，给查 BUG / 改代码的人和 agent）：⓪ 调用入口&I/O（读写哪些文件）· ① 接口签名 · ② 模块内数据流 · ③ 数据契约 schema · ④ 状态机 · ⑤ 边界/坑 · ⑥ 故障地图（症状→定位）· ⑦ 测试锚点 · ⑧ 不变量。
- **锚点锚符号**：写 `resolveProseSha @ lib/sync.js`，**绝不写行号**（行号一改代码就 stale）。

**两层粒度**：
- **鸟瞰页**（`component/<code_root>`，如 `lib`）：只要**概览档** —— 系统定位 + 模块间架构图 + 模块清单（每条 `[[深度页]]` cross-link）。不要求 9 节机制档。
- **深度页**（`component/<子模块>`，如 `sync`）：**完整两档**。由 config `axes.component.deep.<root>: [子模块…]` 声明、`plan` 列出（`kind:'deep'`）。**深度页不放 `## Decision history` token**（决策史汇总在鸟瞰页；文件级分流见 ROADMAP 未来项）。
```

- [ ] **Step 4: 调整 golden page（深度页 v1 去决策史 section）**

`docs/superpowers/notes/2026-06-08-lore-golden-page-sync.md`：删除 `## Decision history\n\n{{LORE_JOURNAL}}` 这一节（深度页 v1 不放）；在 Cross-links 处保留指向鸟瞰页 `[[lib]]`。

`...-sync.html`：删除末尾 `<p>...Decision history...{{LORE_JOURNAL}}</p>` 那行（第「Decision history（真实页此处由 finalize 机械折入…）」段），改为一句 `<p class="anchor">决策史汇总在鸟瞰页 <a class="wlink">lib</a>（深度页 v1 不放）</p>`。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test test/sync.test.js`
Expected: PASS（文档断言 + 原有全绿）。

- [ ] **Step 6: Commit**

```bash
git add commands/sync.md docs/superpowers/notes/2026-06-08-lore-golden-page-sync.md docs/superpowers/notes/2026-06-08-lore-golden-page-sync.html test/sync.test.js
git commit -m "feat(sync.md): two-tier page standard + deep-page guidance; golden page v1 drops decision-history"
```

---

## Task 6: dogfood —— config `deep` + 重写鸟瞰页 + 6 深度页

> 内容 task（agent 按 Task 5 标准产出），非红绿 TDD。产出后用 finalize 机械验证结构。

**Files:**
- Modify: `.lore/config.yml`
- Modify: `.lore/wiki/component/lib.md`（鸟瞰页）
- Create: `.lore/wiki/component/{sync,manifest,fingerprint,hook,fold,mine}.md`（6 深度页）

- [ ] **Step 1: config 加 deep**

`.lore/config.yml` 的 `component` 块改为：

```yaml
  component:                 # 内置轴 + 自动发现
    discover: auto
    code_roots: [lib]
    deep:
      lib: [sync, manifest, fingerprint, hook, fold, mine]
```

- [ ] **Step 2: 确认 plan 列出 6 深度页**

Run: `node lib/sync.js plan "$(pwd)/.lore" --all`
Expected: worklist 含 6 个 `"kind": "deep"` 项（sync/manifest/fingerprint/hook/fold/mine），各带 `sourceFile`。

- [ ] **Step 3: 重写鸟瞰页 `component/lib.md`**

按 Task 5「鸟瞰页」标准：保留系统定位 + 模块间架构图；模块清单每条用 `[[sync]]` 等 cross-link 链到深度页；保留 `## Decision history` 的 `{{LORE_JOURNAL}}` token（鸟瞰页汇总全 lib 决策史）。

- [ ] **Step 4: 写 6 深度页**

每页按 Task 5「深度页」标准（完整两档 + 符号锚点 + `<details>` 机制档 ⓪–⑧），以 `sync` 深度页对标 golden page。**不放** `## Decision history` section。`sync.md` 深度页可直接以 golden page 的 `.md` 正文为蓝本。

- [ ] **Step 5: finalize + 机械验证**

```bash
node lib/sync.js finalize "$(pwd)/.lore"
node lib/sync.js plan "$(pwd)/.lore" | grep -c '"kind": "deep"'
```

Expected:
- finalize 成功（stamped 含 7 张 component 页：lib + 6 深度页）。
- 重新 plan：6 深度页因刚 finalize（prose_sha seed = 当前）应**不在** worklist（fresh）→ `grep -c` 得 `0`。
- `.lore/wiki/.graph.json` 含 `page:component/sync` 等 6 个模块级节点（从 1 组件节点 → 7 个）。

- [ ] **Step 6: Commit**

```bash
git add .lore/config.yml .lore/wiki/component/
git commit -m "dogfood(lore): per-file deep pages (sync/manifest/fingerprint/hook/fold/mine) + lib overview rewrite"
```

---

## Task 7: 文档 + 全量验证

**Files:**
- Modify: `docs/ROADMAP.md`
- 验证：全测试

- [ ] **Step 1: ROADMAP 标记 + 订正陈旧**

`docs/ROADMAP.md`：
- 在「呈现」或新增「内容质量」小节标记「C-内容（两档好页 + 源文件级深度页）✅ 已实现」，引用本 spec。
- 订正「待办（北极星 agent 端）」节里「agent 端（graph + MCP）仍是 0 / 只打磨了人读端」—— 改为「✅ 已实现 `graph.js` + `mcp.js`（`lore_ask/page/neighbors`）；余 `lore_stale` + resident-mode 纪律」。

- [ ] **Step 2: 全量测试全绿**

Run: `node --test`
Expected: PASS —— 0 failures。记录实际 `# tests` / `# pass` / `# fail`。

- [ ] **Step 3: Commit**

```bash
git add docs/ROADMAP.md
git commit -m "docs(roadmap): content-quality C done; correct stale 'agent-side is 0' note"
```

---

## Self-Review（计划自查，已执行）

**1. Spec 覆盖：** 两档标准 + 机制档 9 节 + 概览去黑话 + 符号锚点（决策表 1-4）→ Task 5（sync.md）+ golden page。两层粒度 / `deep` 语法 / 扁平路径 / 深度页 stale 按源文件（决策 5-9）→ Task 1（config）+ Task 2（planSync）+ Task 3（finalize staleScopes）。manifest/graph 无需改 → Task 4 characterization 锁定。dogfood 验证 → Task 6。ROADMAP + 订正陈旧 → Task 7。spec 测试 1-5 全部对应（config→T1、planSync→T2、staleScopes→T3、manifest/graph→T4、回归→T7 全量）。

**2. Placeholder 扫描：** 每个代码步骤含完整代码或完整 old→new 替换；命令带期望输出。Task 6 是内容 task（标注非 TDD），给了产出标准引用 + 机械验证命令，非占位。

**3. 类型/签名一致性：** `parseConfigDeep(configText) → { root: [mod…] }`（T1 定义、T2/T3 消费一致）。深度页工单字段 `{ axis:'component', id, component, sourceFile, kind:'deep', path, priorExists, stale, reason }`（T2 定义、T4 测试读 `id`/`page:component/<id>` 一致）。`staleScopes['component/<mod>.md'] = ['<root>/<mod>.js']`（T3）与 planSync 的 `sourceFile`（T2）同构。fingerprints key 用 `component/<mod>.md` 与现有页 rel 拼法一致。

**4. 风险点复核：** 深度页是普通 component 页 → finalizeSync 逐页循环自动处理（指纹/stamp）；无决策史 token → `foldJournal` no-op（无 token/哨兵 → 返回原文，见现有 `foldJournal: no-op` 测试）。深度页 `sourceFile` 假设 `.js`（lore 是 JS 项目，dogfood 全 `.js`）；多语言后缀留后。深度页决策史 v1 空缺已转 ROADMAP 未来项（文件级 facet 分流）。`parseConfigDeep` 缩进边界出块 → 不泄漏同级轴（T1 测试 3 覆盖）。
