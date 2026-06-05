---
title: lore mermaid 图 Implementation Plan
summary: > **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [...
source_path: docs/superpowers/plans/2026-06-04-lore-mermaid-diagrams.md
last_updated: 2026-06-04
---
> 源文档：`docs/superpowers/plans/2026-06-04-lore-mermaid-diagrams.md`

# lore mermaid 图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** component 页出架构图、flow 页出数据流图，作为页内 ```mermaid``` 文本块，由浏览器壳客户端渲染。

**Architecture:** mermaid 是 vendored 的全量 UMD `site/mermaid.min.js`，init 随 shell 拷进每个 `.lore/site/`；壳 `renderMarkdown` 把 ```mermaid``` fence 渲成 `<div class="mermaid">`，`index.html` 加载 mermaid 并在每次路由后 `mermaid.run`（securityLevel strict）；`/lore:sync` 命令模板引导 agent 出图。确定性部分（fence 渲染、文件拷贝）入 node:test；浏览器渲染手验。

**Tech Stack:** Node 内置（零依赖）· `node --test` · 浏览器 UMD mermaid@11 · 纯函数壳渲染器。

**Spec:** `docs/superpowers/specs/2026-06-04-lore-mermaid-diagrams-design.md`

---

## File Structure

- `site/shell.mjs` — Modify `renderMarkdown` fence 分支：识别 `mermaid` info-string。纯函数，单测。
- `test/shell.test.js` — 加 mermaid fence 测试。
- `site/mermaid.min.js` — Create（vendored 全量 UMD，~2.8MB，pin 11.x）。
- `lib/init.js` — Modify `SHELL_FILES` 加 `'mermaid.min.js'`（copyShell 逻辑零改）。
- `test/init.test.js` — Modify：fake src-site 补 mermaid 桩 + 3 处期望值 + CLI 断言。
- `site/index.html` — Modify：加载 mermaid + 路由后渲染 + 主题联动。浏览器，手验。
- `commands/sync.md` — Modify：component/flow 模板加 mermaid 块 + agent 引导。文档。

---

## Task 1: 壳渲染 mermaid fence（纯函数，TDD）

**Files:**
- Modify: `site/shell.mjs`（`renderMarkdown` fence 分支，现 line 38-42）
- Test: `test/shell.test.js`

- [ ] **Step 1: 写失败测试** — 追加到 `test/shell.test.js` 末尾（line 96 后）：

```js
test('renderMarkdown renders ```mermaid as <div class="mermaid">, escaped not <pre>', () => {
  const html = renderMarkdown('```mermaid\nflowchart TD\nA-->B\n```');
  assert.match(html, /<div class="mermaid">/);
  assert.match(html, /A--&gt;B/);           // escaped; browser textContent decodes back to A-->B
  assert.doesNotMatch(html, /<pre>/);       // mermaid is NOT a code block
});

test('renderMarkdown still renders non-mermaid fences as <pre><code>', () => {
  const html = renderMarkdown('```js\nconst x = 1;\n```');
  assert.match(html, /<pre><code>const x = 1;/);
  assert.doesNotMatch(html, /class="mermaid"/);
});

test('renderMarkdown escapes < and & inside mermaid source', () => {
  const html = renderMarkdown('```mermaid\ngraph LR\nA["a<b & c"]-->B\n```');
  assert.match(html, /&lt;b &amp; c/);
  assert.match(html, /<div class="mermaid">/);
});

test('renderMarkdown bare ``` (no lang) stays a code block', () => {
  const html = renderMarkdown('```\nplain\n```');
  assert.match(html, /<pre><code>plain/);
  assert.doesNotMatch(html, /class="mermaid"/);
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test test/shell.test.js`
Expected: FAIL — 新 mermaid 测试报 `<div class="mermaid">` 缺失（当前 ```mermaid``` 渲成 `<pre><code>`）。

- [ ] **Step 3: 改 `renderMarkdown` fence 分支** — `site/shell.mjs` 现：

```js
    if (/^```/.test(ln)) {
      let buf = ''; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf += lines[i] + '\n'; i++; }
      i++; html += `<pre><code>${esc(buf)}</code></pre>`; continue;
    }
```

改为：

```js
    if (/^```/.test(ln)) {
      const lang = ln.slice(3).trim();                 // info-string after ```
      let buf = ''; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf += lines[i] + '\n'; i++; }
      i++;
      // mermaid source is HTML-escaped into the div; the browser decodes entities
      // via textContent before mermaid parses, so A--&gt;B → A-->B. Escaping also
      // prevents raw < / & in diagram labels from breaking the page HTML.
      html += lang === 'mermaid'
        ? `<div class="mermaid">${esc(buf)}</div>`
        : `<pre><code>${esc(buf)}</code></pre>`;
      continue;
    }
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `node --test test/shell.test.js`
Expected: PASS（新 4 测 + 原有全过；尤其原 line 16「bare ``` → `<pre><code>code`」仍绿）。

- [ ] **Step 5: 提交**

```bash
git add site/shell.mjs test/shell.test.js
git commit -m "feat(shell): render ```mermaid fences as <div class=mermaid>"
```

---

## Task 2: vendor mermaid.min.js 资产

**Files:**
- Create: `site/mermaid.min.js`（全量 UMD，pin 11.x）

- [ ] **Step 1: 下载 vendored 资产**

Run（curl 跟随重定向）：
```bash
curl -L https://unpkg.com/mermaid@11/dist/mermaid.min.js -o site/mermaid.min.js
```
若环境无 curl，用 node 兜底（跟随一次 302）：
```bash
node -e "const https=require('https'),fs=require('fs');function get(u){https.get(u,r=>{if(r.statusCode>=300&&r.headers.location)return get(new URL(r.headers.location,u).href);r.pipe(fs.createWriteStream('site/mermaid.min.js'))})}get('https://unpkg.com/mermaid@11/dist/mermaid.min.js')"
```
Expected: `site/mermaid.min.js` 落地。记下 unpkg 解析到的具体版本（写进 commit message）。

- [ ] **Step 2: 校验资产**

Run:
```bash
node -e "const fs=require('fs');const s=fs.statSync('site/mermaid.min.js').size;const t=fs.readFileSync('site/mermaid.min.js','utf8');if(s<1000000)throw new Error('too small: '+s);if(!/mermaid/i.test(t.slice(0,5000))&&!/mermaid/i.test(t))throw new Error('no mermaid marker');console.log('OK',s,'bytes')"
```
Expected: `OK <~2.8e6> bytes`（>1MB，含 mermaid 标记）。

- [ ] **Step 3: 提交**

```bash
git add site/mermaid.min.js
git commit -m "chore(site): vendor mermaid@11 UMD for offline diagram render"
```

---

## Task 3: init 拷贝 mermaid（SHELL_FILES，TDD）

**Files:**
- Modify: `lib/init.js`（`SHELL_FILES`，line 12）
- Test: `test/init.test.js`（copyShell 测试 line 22-36；`mkSrcSite` 助手 line ~153-155；init 断言 line 171；CLI 断言 line 205）

- [ ] **Step 1: 改测试期望（RED）** — `test/init.test.js`：

(a) copyShell 测试（line 22-36）：fake src 补 mermaid 桩 + 期望值。在 `writeFileSync(join(src, 'shell.mjs'), ...)` 后加：
```js
    writeFileSync(join(src, 'mermaid.min.js'), 'window.mermaid={};');
```
把该测试内两处 `['index.html', 'shell.mjs']` 改为 `['index.html', 'shell.mjs', 'mermaid.min.js']`，并加断言：
```js
    assert.equal(readFileSync(join(lore, 'site', 'mermaid.min.js'), 'utf8'), 'window.mermaid={};');
```

(b) `mkSrcSite` 助手（line ~153-155，写 index.html + shell.mjs 那段）补一行：
```js
  writeFileSync(join(src, 'mermaid.min.js'), 'window.mermaid={};');
```

(c) init 测试 `assert.deepEqual(r.copied, ['index.html', 'shell.mjs'])`（line 171）改为：
```js
    assert.deepEqual(r.copied, ['index.html', 'shell.mjs', 'mermaid.min.js']);
```

(d) CLI 测试断言（line 205）`/shell copied: index\.html, shell\.mjs/` 改为：
```js
    assert.match(out, /shell copied: index\.html, shell\.mjs, mermaid\.min\.js/);
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test test/init.test.js`
Expected: FAIL — copyShell 返回仍是 2 项；且改了期望后不匹配。

- [ ] **Step 3: 改 `SHELL_FILES`** — `lib/init.js` line 12：

```js
const SHELL_FILES = ['index.html', 'shell.mjs', 'mermaid.min.js'];
```
（`copyShell` 循环 `SHELL_FILES`、零改。）

- [ ] **Step 4: 跑测试，确认通过**

Run: `node --test test/init.test.js`
Expected: PASS。CLI 测试用 REAL plugin `site/`——依赖 Task 2 已 vendor `site/mermaid.min.js`，否则 `copyFileSync` ENOENT。

- [ ] **Step 5: 提交**

```bash
git add lib/init.js test/init.test.js
git commit -m "feat(init): copy vendored mermaid.min.js into .lore/site/"
```

---

## Task 4: index.html 加载 + 渲染 mermaid（浏览器，手验）

**Files:**
- Modify: `site/index.html`（module script：`route` line ~176-191、`wireTheme` line ~210-219、加经典 `<script>`）

- [ ] **Step 1: 加载 mermaid UMD** — 在 `<script type="module">`（line 135）**前**插入经典脚本（同步加载、先于 deferred module 执行 → `window.mermaid` 就绪）：

```html
<script src="./mermaid.min.js"></script>
```

- [ ] **Step 2: 加主题映射 + 初始化** — module 脚本内（`import` 后、`boot` 前）加：

```js
const mapMermaidTheme = t => (t === 'dark' ? 'dark' : 'default');
```

在 `wireTheme()` 内、读到 `saved` 后（`sel.value = saved;` 之后）加初始化：

```js
  window.mermaid?.initialize({ startOnLoad: false, securityLevel: 'strict', theme: mapMermaidTheme(saved) });
```

并在其 `change` 处理器末尾（`localStorage.setItem('lore-theme', sel.value);` 之后）加重渲：

```js
    window.mermaid?.initialize({ startOnLoad: false, securityLevel: 'strict', theme: mapMermaidTheme(sel.value) });
    route();   // re-render current page so diagrams pick up the new mermaid theme
```

- [ ] **Step 3: 路由后渲染图** — `route()` 内、`document.getElementById('content').innerHTML = html;` 之后、`scrollTop = 0` 之前加：

```js
  if (window.mermaid) {
    try {
      await mermaid.run({ nodes: document.querySelectorAll('#content .mermaid') });
    } catch { /* bad diagram syntax: leave the source text visible, page stays usable */ }
  }
```
（`route` 已是 `async`。新 innerHTML → 新 `.mermaid` 节点未带 `data-processed` → `run` 渲染之。）

- [ ] **Step 4: 手验渲染** — 给 lore 自己的页临时塞一个 mermaid 块验证：

```bash
printf '\n## Diagram smoke\n\n```mermaid\nflowchart TD\n  A[init] --> B[mine] --> C[sync] --> D[serve]\n```\n' >> .lore/wiki/component/lib.md
node lib/serve.js start --lore .lore
```
打开打印的 `http://127.0.0.1:PORT/site/`，进 component/lib：
- [ ] 图渲染成 flowchart（非文字码块）。
- [ ] 顶栏切「亮/暗」→ 图主题跟随、不报错。
- [ ] 把块改成坏语法（`flowchart ZZ`）刷新 → 页面其余正常、不白屏。
还原：
```bash
git checkout -- .lore/wiki/component/lib.md
node lib/serve.js stop --lore .lore
```

- [ ] **Step 5: 提交**

```bash
git add site/index.html
git commit -m "feat(shell): load vendored mermaid + render diagrams per route (strict)"
```

---

## Task 5: sync 命令引导 agent 出图（文档）

**Files:**
- Modify: `commands/sync.md`（component 模板「## Current architecture」line 32；flow 模板「## End-to-end path」line 78；agent 提示段）

- [ ] **Step 1: component 模板加架构图** — `commands/sync.md` component 页模板内，`## Current architecture` 标题下、prose 占位前，插入：

````markdown
   ## Current architecture

   ```mermaid
   flowchart TD
     %% 据真实代码画：入口 / 关键模块 / 依赖方向。~5-15 节点保持可读。
     A[入口] --> B[关键模块]
   ```

   <读源码写当前真实架构：入口、关键模块、数据流、职责。非泛词。>
````

- [ ] **Step 2: flow 模板加数据流图** — flow 页模板内 `## End-to-end path` 标题下、prose 前，插入：

````markdown
   ## End-to-end path

   ```mermaid
   flowchart LR
     %% 据 spans 组件画端到端：入口 → 各阶段(经过的组件) → 出口。
     IN[入口] --> S1[阶段1] --> S2[阶段2] --> OUT[出口]
   ```

   <入口 → 各阶段(经过的组件) → 出口；关键转换/约束>
````

- [ ] **Step 3: 加 agent 提示** — `commands/sync.md`「## 给 agent 的提示」段加两条：

```markdown
- **出图**：component 页在「Current architecture」顶部出 `​```mermaid` 架构图（入口/模块/依赖）；flow 页在「End-to-end path」顶部出数据流图（入口→阶段→出口）。据真实代码画、~5-15 节点、保持可读。图是文本 → git 可 diff、随历史演进。
- mermaid 语法保守用 `flowchart`/`sequenceDiagram`；label 里别塞裸 `"`/`<`（壳已转义但简洁优先）；坏语法不阻断页面但会丢图。
```

- [ ] **Step 4: 提交**

```bash
git add commands/sync.md
git commit -m "docs(sync): guide agent to emit mermaid arch/dataflow diagrams"
```

---

## Task 6: 端到端验证 + 全套绿

**Files:** 无（验证）

- [ ] **Step 1: 全套测试**

Run: `node --test`
Expected: PASS，0 fail（基线 165 + Task1 的 4 + Task3 的 mermaid 断言；约 169，0 fail）。

- [ ] **Step 2: 真实 dogfood 出图（可选，验证 sync 链路）**

跑 `/lore:sync`（或手动）让 agent 据新 `sync.md` 给 `component/lib.md` 写真实架构图 → finalize → serve → 眼验图渲染。确认零侵入：`git status` 仅 `.lore/` 改动。

- [ ] **Step 3: 不变量自查**
- [ ] 零依赖：无 `node_modules`、`package.json` 无 deps。
- [ ] 零侵入：仅 `site/`（引擎）+ `.lore/`（目标）改动。
- [ ] 向后兼容：无图旧页仍渲染；旧 `.lore` 无 mermaid.js → 图降级文本码块（手验：临时删 `.lore/site/mermaid.min.js` 后页面不报错）。

---

## Self-Review（plan 对照 spec）

- **Spec coverage**：① init 拷贝→Task 3；② 壳 fence→Task 1；③ index.html 加载+run→Task 4；④ sync 引导→Task 5；vendor 资产→Task 2；测试→Task 1/3/6。全覆盖。
- **Placeholder scan**：每改动步给了完整代码/命令；无 TBD。
- **Type/名一致**：`SHELL_FILES`、`mapMermaidTheme`、`<div class="mermaid">`、`mermaid.run({nodes})`、`securityLevel:'strict'` 跨任务一致。
- **顺序依赖**：Task 3 的 CLI 测试依赖 Task 2 的真实资产——已在 Task 3 Step 4 注明，故 Task 2 必须先于 Task 3。

