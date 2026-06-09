---
title: lore 壳呈现（mermaid 放大 + component 排序分组）Implementation Plan
summary: > **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [...
source_path: docs/superpowers/plans/2026-06-09-lore-shell-presentation.md
last_updated: 2026-06-09
---
> 源文档：`docs/superpowers/plans/2026-06-09-lore-shell-presentation.md`

# lore 壳呈现（mermaid 放大 + component 排序分组）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 壳里大 mermaid 图可点开放大（lightbox + 弹层内拖拽缩放），component 侧栏从字母序改为「鸟瞰置顶 + 流水线序 + 分组小标题」。

**Architecture:** `config.deep` 从 flat list 升级为分组 map（`捕获:[…]`/`合成:[…]`，保序），`parseConfigDeep` 返回 `{<root>:{order,groups}}`；`planSync`/`finalizeSync` 改用 `.order`；`finalizeSync` 构造 `componentOrder` + `pageGroups` 传给 `manifest`，component 页按 order 排 + 带 `group` 字段；壳 `index.html` 的 `route()` 给渲染后的 mermaid SVG 绑 lightbox、`buildSidebar()` 按 `group` 插小标题。

**Tech Stack:** Node.js（零依赖、ESM）、`node:test`、原生浏览器 JS + CSS transform（壳，无单测惯例 → 手动 serve 验证）、vendored mermaid（`securityLevel: strict` 不变）。

**Spec:** `docs/superpowers/specs/2026-06-09-lore-shell-presentation-design.md`（设计已批，S1 放大 C 组合 + S2 排序分组 A）。

---

## File Structure

修改：
- `lib/config.js` —— `parseConfigDeep` 升级：解析分组 map（嵌套），返回 `{<root>:{order:[…], groups:[{name,mods}]}}`；向后兼容旧 flat list（→ `{order:[…], groups:[]}`）。
- `lib/sync.js` —— `planSync` + `finalizeSync` 把 `Object.entries(deep)` 的消费从 `mods` 改为 `{order}`；`finalizeSync` 构造 `componentOrder` + `pageGroups` 传给 `runManifestCli`。
- `lib/manifest.js` —— `emitManifest`/`runManifestCli` 接收 `componentOrder` + `pageGroups`；component 轴按 `componentOrder` 排（不在序里的字母序垫后）；`pageEntry` 加 `group` 字段。
- `site/index.html` —— `route()` 给 mermaid SVG 绑 lightbox（S1）；`buildSidebar()` 按 `group` 插小标题（S2）；新增 lightbox CSS。
- `.lore/config.yml` —— dogfood：`deep` 改分组 map。
- `docs/ROADMAP.md` —— 壳呈现标记。

扩展测试：`test/config.test.js`、`test/sync.test.js`、`test/manifest.test.js`。

不动：`site/shell.mjs`（`buildNavModel` 透传 pages，group 在壳渲染层用，无需改）、其余 lib。

---

## Task 1: `config.js` —— `parseConfigDeep` 升级为分组 map

**Files:**
- Modify: `lib/config.js`
- Test: `test/config.test.js`

- [ ] **Step 1: 改失败测试**

`test/config.test.js` 里现有 4 个 `parseConfigDeep` 用例断言旧返回结构（`{lib:['sync',…]}`）。**全部替换**为新结构断言（在文件中找到这 4 个 `parseConfigDeep` 测试块，整体替换）：

```js
test('parseConfigDeep: flat list → {order, groups:[]} (向后兼容)', () => {
  const cfg = 'axes:\n  component:\n    code_roots: [lib]\n    deep:\n      lib: [sync, manifest, fingerprint]\n  flow:\n    values: []\n';
  assert.deepEqual(parseConfigDeep(cfg), { lib: { order: ['sync', 'manifest', 'fingerprint'], groups: [] } });
});

test('parseConfigDeep: 分组 map → order 展平 + groups 保序', () => {
  const cfg = 'axes:\n  component:\n    deep:\n      lib:\n        捕获: [hook, mine, fold]\n        合成: [sync, manifest, fingerprint]\n  theme:\n    values: []\n';
  assert.deepEqual(parseConfigDeep(cfg), {
    lib: {
      order: ['hook', 'mine', 'fold', 'sync', 'manifest', 'fingerprint'],
      groups: [
        { name: '捕获', mods: ['hook', 'mine', 'fold'] },
        { name: '合成', mods: ['sync', 'manifest', 'fingerprint'] },
      ],
    },
  });
});

test('parseConfigDeep: absent deep → {}', () => {
  assert.deepEqual(parseConfigDeep('axes:\n  component:\n    code_roots: [lib]\n'), {});
});

test('parseConfigDeep: 分组停在更浅 key（不漏到同级轴）', () => {
  const cfg = 'axes:\n  component:\n    deep:\n      lib:\n        捕获: [hook]\n  theme:\n    values:\n    - { id: q, match: [a] }\n';
  assert.deepEqual(parseConfigDeep(cfg), { lib: { order: ['hook'], groups: [{ name: '捕获', mods: ['hook'] }] } });
});

test('parseConfigDeep: dequotes + 空组忽略', () => {
  const cfg = '    deep:\n      lib:\n        捕获: ["hook", \'mine\']\n        空组: []\n';
  assert.deepEqual(parseConfigDeep(cfg), { lib: { order: ['hook', 'mine'], groups: [{ name: '捕获', mods: ['hook', 'mine'] }] } });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/config.test.js`
Expected: FAIL —— 旧 `parseConfigDeep` 返回 `{lib:[…]}`，新断言要 `{lib:{order,groups}}`，不匹配。

- [ ] **Step 3: 写实现**

在 `lib/config.js` 把现有 `parseConfigDeep` 整个函数替换为（解析两种形态：`root: [list]` flat、`root:` 后跟缩进 `<group>: [list]`）：

```js
// 解析 component.deep —— 支持两种形态：
//   flat:   lib: [a, b]            → { lib: { order:[a,b], groups:[] } }
//   分组:   lib:\n  捕获: [a,b]    → { lib: { order:[a,b,…], groups:[{name:'捕获',mods:[a,b]},…] } }
// 缺 deep → {}。遇到缩进 <= deep: 的行即出块（不泄漏同级轴）。
export function parseConfigDeep(configText) {
  const lines = configText.split(/\r?\n/);
  const list = raw => raw.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '').trim()).filter(Boolean);
  const deep = {};
  let inBlock = false, baseIndent = 0, curRoot = null, rootIndent = 0;
  for (const line of lines) {
    if (!inBlock) {
      const m = line.match(/^(\s*)deep:\s*(?:#.*)?$/);
      if (m) { inBlock = true; baseIndent = m[1].length; }
      continue;
    }
    if (line.trim() === '') continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= baseIndent) break;                          // 出 deep 块
    // 分组组行：在某 root 之下、且缩进更深、且形如 `<name>: [list]`
    if (curRoot && indent > rootIndent) {
      const gm = line.match(/^\s*([^:\s][^:]*):\s*\[([^\]]*)\]/);
      if (gm) {
        const mods = list(gm[2]);
        if (mods.length) { deep[curRoot].groups.push({ name: gm[1].trim(), mods }); deep[curRoot].order.push(...mods); }
      }
      continue;
    }
    // root 行（缩进回到 root 层）：flat `root: [list]` 或 group-head `root:`
    const flatM = line.match(/^\s*([A-Za-z0-9_.\/-]+):\s*\[([^\]]*)\]/);
    if (flatM) {
      const mods = list(flatM[2]);
      if (mods.length) deep[flatM[1].trim()] = { order: mods, groups: [] };
      curRoot = null;
    } else {
      const headM = line.match(/^\s*([A-Za-z0-9_.\/-]+):\s*(?:#.*)?$/);
      if (headM) { curRoot = headM[1].trim(); rootIndent = indent; deep[curRoot] = { order: [], groups: [] }; }
    }
  }
  return deep;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/config.test.js`
Expected: PASS（5 个新 `parseConfigDeep` 用例 + 原有非 deep 用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add lib/config.js test/config.test.js
git commit -m "feat(config): parseConfigDeep returns {order, groups} (grouped deep map + flat back-compat)"
```

---

## Task 2: `sync.js` —— `planSync` + `finalizeSync` 改用 `.order`

**Files:**
- Modify: `lib/sync.js`（`planSync` deep 循环 + `finalizeSync` staleScopes deep 循环）
- Test: `test/sync.test.js`（现有 deep 测试断言不变，只需仍绿）

- [ ] **Step 1: 跑现有 deep 测试确认现在失败**

Task 1 改了 `parseConfigDeep` 返回结构（`{lib:{order,groups}}`），`sync.js` 仍按旧 `[cr, mods]`（mods 现在是 `{order,groups}` 对象）消费 → `for (const mod of mods)` 遍历对象键、深度页工单错乱。

Run: `node --test --test-name-pattern="深度页" test/sync.test.js`
Expected: FAIL —— `planSync: deep 声明 → 列深度页工单` 等用例断言 `wl.length===2` 失败（mods 不再是数组）。

- [ ] **Step 2: 写实现**

在 `lib/sync.js` 的 `planSync` 里，深度页循环：

```js
  const deep = parseConfigDeep(configText);
  for (const [codeRoot, mods] of Object.entries(deep)) {
    for (const mod of mods) {
```

改为（解构 `.order`）：

```js
  const deep = parseConfigDeep(configText);
  for (const [codeRoot, { order }] of Object.entries(deep)) {
    for (const mod of order) {
```

在 `finalizeSync` 的 staleScopes 段，深度页循环：

```js
  const deep = parseConfigDeep(configText);
  for (const [cr, mods] of Object.entries(deep)) {
    for (const mod of mods) staleScopes[`component/${mod}.md`] = [`${cr}/${mod}.js`];
  }
```

改为：

```js
  const deep = parseConfigDeep(configText);
  for (const [cr, { order }] of Object.entries(deep)) {
    for (const mod of order) staleScopes[`component/${mod}.md`] = [`${cr}/${mod}.js`];
  }
```

- [ ] **Step 3: 跑测试确认通过**

Run: `node --test test/sync.test.js`
Expected: PASS —— 深度页工单/增量/staleScopes 用例全绿（`fzRepoDeep` 用的 flat list config 经 Task 1 向后兼容解析为 `{order:[…],groups:[]}`，`.order` 即原列表）。

- [ ] **Step 4: Commit**

```bash
git add lib/sync.js test/sync.test.js
git commit -m "refactor(sync): consume parseConfigDeep .order (grouped-deep schema)"
```

---

## Task 3: `manifest.js` —— component 按 order 排 + `group` 字段

**Files:**
- Modify: `lib/manifest.js`（`emitManifest` / `pageEntry` / `runManifestCli`）+ `lib/sync.js`（finalize 构造 `componentOrder`/`pageGroups`）
- Test: `test/manifest.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/manifest.test.js` 末尾追加：

```js
import { emitManifest as emitM2 } from '../lib/manifest.js';
import { mkdtempSync as mkO, rmSync as rmO, mkdirSync as mdO, writeFileSync as wfO } from 'node:fs';
import { tmpdir as tmpO } from 'node:os';
import { join as jO } from 'node:path';

test('emitManifest: component 按 componentOrder 排 + group 字段', () => {
  const wiki = mkO(jO(tmpO(), 'lore-ord-'));
  try {
    mdO(jO(wiki, 'component'), { recursive: true });
    const page = id => `---\ntitle: ${id}\ncode_sha: X\natoms: 0\ncommits: 0\n---\n# ${id}\n`;
    for (const id of ['lib', 'hook', 'sync', 'manifest']) wfO(jO(wiki, 'component', `${id}.md`), page(id));
    const m = emitM2({
      wikiDir: wiki, currentSha: 'X', countCommitsSince: () => 0, now: 't',
      componentOrder: ['lib', 'hook', 'sync', 'manifest'],
      pageGroups: { hook: '捕获', sync: '合成', manifest: '合成' },
    });
    const comp = m.axes.find(a => a.id === 'component');
    assert.deepEqual(comp.pages.map(p => p.id), ['lib', 'hook', 'sync', 'manifest']);   // 按 order，非字母序
    assert.equal(comp.pages.find(p => p.id === 'lib').group, '');                        // 鸟瞰不归组
    assert.equal(comp.pages.find(p => p.id === 'hook').group, '捕获');
    assert.equal(comp.pages.find(p => p.id === 'sync').group, '合成');
  } finally { rmO(wiki, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/manifest.test.js`
Expected: FAIL —— `emitManifest` 不认 `componentOrder`/`pageGroups`，pages 仍字母序（`hook,lib,manifest,sync`）且无 `group` 字段。

- [ ] **Step 3: 写实现 —— `manifest.js`**

把 `emitManifest` 签名（带默认值参数那段）：

```js
export function emitManifest({
  wikiDir,
  currentSha,
  countCommitsSince,
  now,
  axes,
  language = { default: 'en', available: ['en'] },
  preferences = {},
  staleScopes = {},
}) {
```

替换为（加两参）：

```js
export function emitManifest({
  wikiDir,
  currentSha,
  countCommitsSince,
  now,
  axes,
  language = { default: 'en', available: ['en'] },
  preferences = {},
  staleScopes = {},
  componentOrder = [],
  pageGroups = {},
}) {
```

在 `emitManifest` 里，普通轴取 `files` 后 `files.sort();` 那段：

```js
      files.sort();
      for (const f of files) {
        pages.push(pageEntry(wikiDir, ax.id, f.replace(/\.md$/, ''), currentSha, countCommitsSince, language, staleScopes));
      }
```

替换为（component 轴按 componentOrder 排，其余仍字母序；pageEntry 传 pageGroups）：

```js
      if (ax.id === 'component' && componentOrder.length) {
        const rank = id => { const i = componentOrder.indexOf(id); return i === -1 ? Infinity : i; };
        files.sort((a, b) => {
          const ra = rank(a.replace(/\.md$/, '')), rb = rank(b.replace(/\.md$/, ''));
          return ra !== rb ? ra - rb : a.localeCompare(b);     // 不在序里的字母序垫后
        });
      } else {
        files.sort();
      }
      for (const f of files) {
        pages.push(pageEntry(wikiDir, ax.id, f.replace(/\.md$/, ''), currentSha, countCommitsSince, language, staleScopes, pageGroups));
      }
```

把 `pageEntry` 定义签名：

```js
function pageEntry(wikiDir, axisId, id, currentSha, countCommitsSince, language, staleScopes = {}) {
```

替换为：

```js
function pageEntry(wikiDir, axisId, id, currentSha, countCommitsSince, language, staleScopes = {}, pageGroups = {}) {
```

在 `pageEntry` 的 `return { … }` 对象里，`synthesized_from` 那行后加一行 `group`：

```js
    synthesized_from: { atoms: data.atoms ?? 0, commits: data.commits ?? 0 },
```

替换为：

```js
    synthesized_from: { atoms: data.atoms ?? 0, commits: data.commits ?? 0 },
    group: pageGroups[id] ?? '',
```

把 `runManifestCli` 签名与 `emitManifest` 调用：

```js
export function runManifestCli(loreDir, nowIso, staleScopes = {}) {
```

替换为：

```js
export function runManifestCli(loreDir, nowIso, staleScopes = {}, componentOrder = [], pageGroups = {}) {
```

并在其内 `emitManifest({ … staleScopes, });` 调用里加 `componentOrder, pageGroups`：

```js
    preferences,
    staleScopes,
  });
```

替换为：

```js
    preferences,
    staleScopes,
    componentOrder,
    pageGroups,
  });
```

- [ ] **Step 4: 写实现 —— `sync.js` finalize 构造并传入**

在 `lib/sync.js` `finalizeSync` 里，构造 `staleScopes` 那段之后、`runManifestCli(...)` 调用之前，新增构造 `componentOrder` + `pageGroups`：

```js
  // component 排序 + 分组：鸟瞰（code_root）置顶 + 各 deep order 流水线序；group 来自 deep groups
  const componentOrder = [...codeRoots.map(cr => cr.split('/').pop())];
  const pageGroups = {};
  for (const [, { order, groups }] of Object.entries(deep)) {
    componentOrder.push(...order);
    for (const g of groups) for (const mod of g.mods) pageGroups[mod] = g.name;
  }
```

把 `runManifestCli` 调用：

```js
  const { manifestPath, manifest } = runManifestCli(loreDir, now, staleScopes);
```

替换为：

```js
  const { manifestPath, manifest } = runManifestCli(loreDir, now, staleScopes, componentOrder, pageGroups);
```

> `deep` 变量已在 staleScopes 段由 `parseConfigDeep(configText)` 取得（Task 2）；`codeRoots` 已在该段上方取得。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test test/manifest.test.js test/sync.test.js`
Expected: PASS —— 新 component 排序/group 用例 + 原有 manifest/sync 用例全绿（不传 `componentOrder` 时 `[]` → 退化字母序，向后兼容）。

- [ ] **Step 6: Commit**

```bash
git add lib/manifest.js lib/sync.js test/manifest.test.js
git commit -m "feat(manifest): component pages ordered by componentOrder + group field (pipeline order)"
```

---

## Task 4: 壳 S1 —— mermaid 放大（lightbox + pan/zoom）

> 壳是客户端 JS，lore 无壳单测惯例 → **手动 serve 验证**（无红绿循环）。

**Files:**
- Modify: `site/index.html`（lightbox CSS + `route()` 绑定 + 放大逻辑）

- [ ] **Step 1: 加 lightbox CSS**

在 `site/index.html` `<style>` 末尾（`::-webkit-scrollbar-track` 那条之后）加：

```css
  #content .mermaid { cursor: zoom-in; }
  #lb { position: fixed; inset: 0; z-index: 99; display: none; background: rgba(0,0,0,.78); }
  #lb.open { display: block; }
  #lb-stage { position: absolute; inset: 0; overflow: hidden; touch-action: none; }
  #lb-stage svg { position: absolute; top: 50%; left: 50%; transform-origin: 0 0; cursor: grab; max-width: none; }
  #lb-stage.dragging svg { cursor: grabbing; }
  #lb-bar { position: absolute; top: 14px; right: 16px; display: flex; gap: 8px; z-index: 1; }
  #lb-bar button { background: rgba(255,255,255,.12); color: #fff; border: 1px solid rgba(255,255,255,.35);
    width: 34px; height: 34px; border-radius: 8px; font-size: 16px; cursor: pointer; }
  #lb-bar button:hover { background: rgba(255,255,255,.25); }
```

- [ ] **Step 2: 加 lightbox DOM**

在 `site/index.html` `<div id="app">…</div>` **之后**、`<script>` 之前加：

```html
<div id="lb">
  <div id="lb-bar">
    <button id="lb-in" title="放大">＋</button>
    <button id="lb-out" title="缩小">−</button>
    <button id="lb-reset" title="复位">⟲</button>
    <button id="lb-close" title="关闭 (ESC)">✕</button>
  </div>
  <div id="lb-stage"></div>
</div>
```

- [ ] **Step 3: 加放大逻辑 + 绑定**

在 `<script type="module">` 里，`boot();` **之前**加 lightbox 控制器：

```js
const LB = (() => {
  const lb = document.getElementById('lb'), stage = document.getElementById('lb-stage');
  let svg = null, scale = 1, tx = 0, ty = 0, drag = null;
  const apply = () => { if (svg) svg.style.transform = `translate(-50%,-50%) translate(${tx}px,${ty}px) scale(${scale})`; };
  const open = src => {
    svg = src.cloneNode(true); svg.removeAttribute('id');
    stage.innerHTML = ''; stage.appendChild(svg);
    scale = 1; tx = 0; ty = 0; apply(); lb.classList.add('open');
  };
  const close = () => { lb.classList.remove('open'); stage.innerHTML = ''; svg = null; };
  const zoom = (f, cx, cy) => {                              // 以 (cx,cy) 为锚缩放
    const ns = Math.min(8, Math.max(0.2, scale * f));
    if (cx != null) { const r = stage.getBoundingClientRect(); const ox = cx - r.left - r.width / 2, oy = cy - r.top - r.height / 2;
      tx = ox - (ox - tx) * (ns / scale); ty = oy - (oy - ty) * (ns / scale); }
    scale = ns; apply();
  };
  document.getElementById('lb-in').onclick = () => zoom(1.25);
  document.getElementById('lb-out').onclick = () => zoom(0.8);
  document.getElementById('lb-reset').onclick = () => { scale = 1; tx = 0; ty = 0; apply(); };
  document.getElementById('lb-close').onclick = close;
  lb.onclick = e => { if (e.target === lb || e.target === stage) close(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && lb.classList.contains('open')) close(); });
  stage.addEventListener('wheel', e => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.12 : 0.89, e.clientX, e.clientY); }, { passive: false });
  stage.addEventListener('pointerdown', e => { drag = { x: e.clientX - tx, y: e.clientY - ty }; stage.classList.add('dragging'); stage.setPointerCapture(e.pointerId); });
  stage.addEventListener('pointermove', e => { if (drag) { tx = e.clientX - drag.x; ty = e.clientY - drag.y; apply(); } });
  stage.addEventListener('pointerup', e => { drag = null; stage.classList.remove('dragging'); stage.releasePointerCapture(e.pointerId); });
  return { open };
})();
```

在 `route()` 里，mermaid 渲染那段：

```js
  const mNodes = document.querySelectorAll('#content .mermaid');
  if (mNodes.length) {
    try { await ensureMermaid(); await window.mermaid.run({ nodes: mNodes }); }
    catch { /* missing asset or bad diagram: leave source text visible, page stays usable */ }
  }
```

替换为（渲染后给每个 .mermaid 的 svg 绑点击放大）：

```js
  const mNodes = document.querySelectorAll('#content .mermaid');
  if (mNodes.length) {
    try {
      await ensureMermaid(); await window.mermaid.run({ nodes: mNodes });
      mNodes.forEach(div => { const svg = div.querySelector('svg'); if (svg) div.onclick = () => LB.open(svg); });
    }
    catch { /* missing asset or bad diagram: leave source text visible, page stays usable */ }
  }
```

- [ ] **Step 4: 手动验证（serve）**

```bash
node lib/sync.js finalize .lore >/dev/null
node lib/serve.js start .lore
```

打开壳 URL → 进 `component/fingerprint`（或任意有图页）。检查：
- [ ] 点架构图 → 弹全屏 lightbox、图居中。
- [ ] lightbox 内：滚轮缩放（以光标为锚）、拖拽平移、＋/−/⟲ 按钮、✕/ESC/点遮罩关闭。
- [ ] **关键**：lightbox 打开时滚轮只缩放图、**不滚动正文**；关闭后正文滚动正常。
- [ ] 切暗/亮主题后图仍可点开放大。

- [ ] **Step 5: Commit**

```bash
git add site/index.html
git commit -m "feat(shell): click-to-zoom mermaid lightbox (pan + wheel-zoom, scoped to overlay)"
```

---

## Task 5: 壳 S2 —— component 侧栏分组小标题

> 同样壳改动，手动验证。

**Files:**
- Modify: `site/index.html`（`buildSidebar()` + 分组小标题 CSS）

- [ ] **Step 1: 加分组小标题 CSS**

在 `site/index.html` `<style>` 里 `.links a.hidden` 那条之后加：

```css
  .links .grp { padding: 6px 16px 2px 30px; font-size: 10px; letter-spacing: .5px;
    color: var(--fg-dim); text-transform: uppercase; }
```

- [ ] **Step 2: 改 `buildSidebar` 渲染分组**

把 `buildSidebar()` 里轴渲染的 `.links` 内容（`${ax.pages.map(p => …).join('')}`）替换为：component 轴按连续 `group` 插小标题，其它轴不变。整个 `buildSidebar` 替换为：

```js
function buildSidebar() {
  const nav = document.getElementById('sidebar');
  const linkHtml = (ax, p) => `<a href="#${ax.id}/${p.id}" data-key="${ax.id}/${p.id}"
     data-search="${(p.title + ' ' + (p.summary||'')).toLowerCase()}">
    ${p.title}${p.stale ? `<span class="stale">⚠${p.stale}</span>` : ''}${ax.id === 'docs' && p.last_updated ? `<span class="when">📅 ${p.last_updated}</span>` : ''}</a>`;
  const pagesHtml = (ax) => {
    if (ax.id !== 'component') return ax.pages.map(p => linkHtml(ax, p)).join('');
    let out = '', lastGroup = null;
    for (const p of ax.pages) {
      const g = p.group || '';
      if (g && g !== lastGroup) out += `<div class="grp">▸ ${g}</div>`;
      lastGroup = g;
      out += linkHtml(ax, p);
    }
    return out;
  };
  nav.innerHTML = buildNavModel(MANIFEST).map(ax => `
    <div class="axis" data-axis="${ax.id}">
      <div class="axis-h"><span class="dot ${ax.id}"></span>${ax.label}<span class="caret">▼</span></div>
      <div class="links">${pagesHtml(ax)}</div>
    </div>`).join('');
  nav.querySelectorAll('.axis-h').forEach(h =>
    h.onclick = () => h.parentElement.classList.toggle('collapsed'));
}
```

- [ ] **Step 3: 手动验证（serve）**

需 Task 6 的 dogfood config 先就位才看得到分组（否则 group 为空、退化无标题）。**本步在 Task 6 之后回看**；此处先确认「无分组时不崩」：当前 `.lore` 仍 flat config → component 页 `group:''` → 侧栏无小标题、顺序为 manifest 给的序。打开壳确认侧栏正常渲染、无多余小标题。

- [ ] **Step 4: Commit**

```bash
git add site/index.html
git commit -m "feat(shell): component sidebar group subheaders (▸ 捕获 / ▸ 合成)"
```

---

## Task 6: dogfood —— `config.deep` 改分组 map + 验证

**Files:**
- Modify: `.lore/config.yml`

- [ ] **Step 1: config.deep 改分组 map（流水线序）**

`.lore/config.yml` 的 `component.deep` 从：

```yaml
    deep:                      # 源文件级深度页（内容质量 C）：每个子模块一页 component/<mod>.md
      lib: [sync, manifest, fingerprint, hook, fold, mine]
```

改为：

```yaml
    deep:                      # 源文件级深度页；按流水线分组（捕获→合成）驱动侧栏排序
      lib:
        捕获: [hook, mine, fold]
        合成: [sync, manifest, fingerprint]
```

- [ ] **Step 2: finalize + 验证 manifest 排序 + group**

```bash
node lib/sync.js finalize .lore >/dev/null
node -e "const m=require('./.lore/wiki/.manifest.json');const c=m.axes.find(a=>a.id==='component');console.log(c.pages.map(p=>p.id+':'+(p.group||'-')).join('  '))"
```

Expected: `lib:-  hook:捕获  mine:捕获  fold:捕获  sync:合成  manifest:合成  fingerprint:合成`（lib 置顶不归组 + 流水线序 + group 字段）。

- [ ] **Step 3: 手动验证侧栏（serve）**

```bash
node lib/serve.js start .lore
```

打开壳：component 轴侧栏应是 `lib` 在最上，然后「▸ 捕获」小标题下 hook/mine/fold，「▸ 合成」小标题下 sync/manifest/fingerprint。回看 Task 5 的渲染在此生效。

- [ ] **Step 4: Commit**

```bash
git add .lore/config.yml .lore/wiki
git commit -m "dogfood(lore): deep grouped map (捕获/合成) → pipeline-ordered component sidebar"
```

---

## Task 7: ROADMAP + 全量验证

**Files:**
- Modify: `docs/ROADMAP.md`
- 验证：全测试

- [ ] **Step 1: ROADMAP 标记**

在 `docs/ROADMAP.md` 的「内容质量（…）✅ 已实现（C-内容）」节之后，新增：

```md
### 壳呈现（mermaid 放大 + component 排序分组）✅ 已实现（C-呈现 ①）
- 已实现：壳大 mermaid 图点击 → lightbox（弹层内拖拽 + 滚轮缩放，缩放圈在弹层内不扰正文）；`config.deep` 升级分组 map（捕获/合成），`manifest` component 页按流水线序排（lib 鸟瞰置顶）+ 带 `group` 字段，壳侧栏插分组小标题。设计见 `docs/superpowers/specs/2026-06-09-lore-shell-presentation-design.md`。余项（docs 轴重构、mermaid 语法校验+br 统一、server.js 根文件组件+决策史分流）各自另立。
```

- [ ] **Step 2: 全量测试全绿**

Run: `node --test`
Expected: PASS —— 0 failures。记录实际 `# tests` / `# pass` / `# fail`。

- [ ] **Step 3: Commit**

```bash
git add docs/ROADMAP.md
git commit -m "docs(roadmap): shell presentation (C-呈现①) done"
```

---

## Self-Review（计划自查，已执行）

**1. Spec 覆盖：** S1 放大 C（lightbox+pan/zoom，滚轮圈弹层内）→ Task 4。S2 排序 → Task 3（manifest componentOrder）+ Task 6（dogfood）。S2 分组 A → Task 5（壳小标题）+ Task 3（group 字段）。config.deep 分组 map + 向后兼容 → Task 1。planSync/finalize 用 order → Task 2。改动清单全覆盖；测试 1-3（config/sync/manifest）对应 Task 1/2/3，壳手动验证对应 Task 4/5 的 serve 清单。

**2. Placeholder 扫描：** 每代码步骤含完整代码或完整 old→new；命令带期望输出。Task 4/5 是壳（无单测惯例，spec 已声明）→ 给了 serve 手动验证清单（勾选项），非占位。

**3. 类型/签名一致性：** `parseConfigDeep → {<root>:{order,groups:[{name,mods}]}}`（T1）被 `planSync`/`finalize` 解构 `{order}`（T2）、被 finalize 构造 `componentOrder`/`pageGroups` 用 `{order,groups}`（T3）一致。`emitManifest({…,componentOrder,pageGroups})` / `pageEntry(…,pageGroups)` / `runManifestCli(loreDir,now,staleScopes,componentOrder,pageGroups)`（T3）签名与调用一致。page entry `group` 字段（T3 manifest）↔ 壳 `p.group`（T5）↔ dogfood 验证（T6）同名。lightbox `LB.open(svg)`（T4）单一入口。

**4. 风险点复核：** parseConfigDeep 向后兼容（flat→`{order,groups:[]}`）让 T2/现有测试不破。componentOrder 空 → 退化字母序（manifest 向后兼容）。壳改动无自动化测试（spec 已声明诚实缺口）→ 手动 serve 清单兜。Task 5 依赖 Task 6 才看得到分组 → Task 5 Step 3 标注「Task 6 后回看」+ 先验「无分组不崩」。

