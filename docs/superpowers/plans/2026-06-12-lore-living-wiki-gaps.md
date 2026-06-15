# 活 wiki 缺口修复（A 常驻 + C stale 动作化 + B 工单扩轴）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自动活 wiki 链路补三块：serve 默认 node + portal 开机自启（常驻）；壳 stale 徽标点击即排队（动作化）；runner 工单扩到 theme/flow/HOME（prose 全轴自动重写）。

**Architecture:** probeRuntime 默认翻转 + portal autostart 子命令（win32 Startup vbs）；qualityGate 哨兵按页分支（HOME=HOME_STATUS）；runAuto 工单 = 队列置顶 → component 指纹增量 → 非 component 按 manifest stale≥阈值降序；claudeBackend prompt 按 axis 四分支；buildMeta stale chip 带 action 数据，渲染层出 button 复用排队 POST。

**Tech Stack:** 零依赖 Node ESM，node:test。Spec: `docs/superpowers/specs/2026-06-12-lore-living-wiki-gaps-design.md`。

**纪律**：测试用 Write/Edit 绝不 heredoc；依赖 Edit 的 Bash 不并行发。

---

### Task 1: serve 默认 node（A1）

**Files:** Modify `lib/serve.js`、`test/serve.test.js`

- [ ] **Step 1: 改测试**（Edit `test/serve.test.js` 两个 python 优先断言，翻转语义）

原 `probeRuntime prefers python3 when available` 与 `falls back to python (Windows)` 两个 test 替换为：

```js
test('probeRuntime defaults to node even when python available', () => {
  const r = probeRuntime(cmd => cmd === 'python3');
  assert.equal(r.kind, 'node');
});

test('probeRuntime picks python only with explicit opt-in flag', () => {
  const r = probeRuntime(cmd => cmd === 'python3', { python: true });
  assert.equal(r.kind, 'python');
  const r2 = probeRuntime(() => false, { python: true });   // 无 python 可用 → 回 node
  assert.equal(r2.kind, 'node');
});
```

- [ ] **Step 2: Run** `node --test test/serve.test.js` → FAIL（默认仍 python）

- [ ] **Step 3: 实现**（Edit `lib/serve.js`）

probeRuntime 翻转：

```js
// 默认 node（控制 API + ticker + no-cache 都只有 node 有；serve.js 本身就在 node 里跑，
// python 兜底永远不该是隐式默认）。python 仅显式 --python opt-in（无 python 可用仍回 node）。
export function probeRuntime(canRun = defaultCanRun, { python = false } = {}) {
  if (python) {
    for (const cmd of ['python3', 'python']) {
      if (canRun(cmd)) {
        return {
          kind: 'python', cmd,
          buildArgs: (port, dir) =>
            ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', dir],
        };
      }
    }
  }
  return nodeRuntime();
}
```

start() 内调用处：原 `probeRuntime(..., { preferNode: preferNode || language.available.length > 1 })` 改为 `probeRuntime(canRun, { python: preferPython && language.available.length <= 1 })`；start 签名 `preferNode = false` 改 `preferPython = false`；CLI `--node` 保留为 no-op（不再读取），新增 `--python` → `preferPython: process.argv.includes('--python')`。

- [ ] **Step 4: Run** `node --test test/serve.test.js` → PASS
- [ ] **Step 5: Commit** `feat(serve): node by default — python demoted to explicit --python opt-in`

---

### Task 2: portal autostart（A2）

**Files:** Modify `lib/portal.js`、`commands/portal.md`；Test `test/portal.test.js` 追加

- [ ] **Step 1: 测试**（Edit `test/portal.test.js` 追加；import 行加 `autostart`，顶部确保有 `process.env` 注入手段）

```js
test('autostart: win32 写/删 Startup vbs，幂等，内容指向 portal.js 绝对路径', () => {
  const fakeAppData = mkdtempSync(join(tmpdir(), 'lore-appdata-'));
  try {
    const r1 = autostart('on', { appData: fakeAppData, platform: 'win32' });
    assert.equal(r1.status, 'installed');
    const vbs = join(fakeAppData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'lore-portal.vbs');
    assert.ok(existsSync(vbs));
    const text = readFileSync(vbs, 'utf8');
    assert.match(text, /portal\.js"" start/);
    assert.match(text, /, 0, False/);                      // 隐藏窗口
    assert.equal(autostart('on', { appData: fakeAppData, platform: 'win32' }).status, 'present');
    assert.equal(autostart('off', { appData: fakeAppData, platform: 'win32' }).status, 'removed');
    assert.equal(existsSync(vbs), false);
    assert.equal(autostart('off', { appData: fakeAppData, platform: 'win32' }).status, 'absent');
  } finally { rmSync(fakeAppData, { recursive: true, force: true }); }
});

test('autostart: 非 win32 → unsupported（打印手动指引，不写文件）', () => {
  assert.equal(autostart('on', { platform: 'linux' }).status, 'unsupported');
});
```

- [ ] **Step 2: Run** `node --test test/portal.test.js` → FAIL
- [ ] **Step 3: 实现**（Edit `lib/portal.js`，注意 import 补 `mkdirSync, rmSync` 等已有缺的）

```js
// 开机自启（win32）：Startup 文件夹放 vbs（wscript 隐藏窗口跑 node portal.js start；start 幂等）。
export function autostart(action, { appData = process.env.APPDATA, platform = process.platform } = {}) {
  if (platform !== 'win32') return { status: 'unsupported' };
  const dir = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const vbs = join(dir, 'lore-portal.vbs');
  if (action === 'off') {
    if (!existsSync(vbs)) return { status: 'absent' };
    rmSync(vbs);
    return { status: 'removed' };
  }
  if (existsSync(vbs)) return { status: 'present' };
  mkdirSync(dir, { recursive: true });
  const self = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  writeFileSync(vbs, `CreateObject("WScript.Shell").Run "node ""${self}"" start", 0, False\r\n`);
  return { status: 'installed' };
}
```

CLI 分支（`sub === 'autostart'`）：

```js
} else if (sub === 'autostart') {
  const r = autostart(process.argv[3] === 'off' ? 'off' : 'on');
  const msg = {
    installed: '✓ 开机自启已装（Startup/lore-portal.vbs，下次登录自动起 portal）',
    present: '✓ 已是开机自启', removed: '✓ 已移除开机自启', absent: '（本来就没装）',
    unsupported: '非 Windows：请手动加 cron/launchd 跑 node lib/portal.js start',
  }[r.status];
  console.log(msg);
}
```

usage 行加 `autostart [on|off]`。`commands/portal.md` 用法节补 `/lore:portal autostart` 一行。

- [ ] **Step 4: Run** `node --test test/portal.test.js` → PASS
- [ ] **Step 5: Commit** `feat(portal): autostart on|off — Startup vbs, survives reboot`

---

### Task 3: qualityGate 哨兵按页分支（B1，扩轴前置）

**Files:** Modify `lib/runner.js`；Test `test/runner.test.js` 追加

- [ ] **Step 1: 测试**（Edit `test/runner.test.js` 追加）

```js
test('qualityGate: HOME 页查 HOME_STATUS 哨兵；普通页仍查 JOURNAL；互不串味', () => {
  const home = '---\ntitle: H\nsummary: s\n---\n# HOME\n\n{{LORE_HOME_STATUS}}\n\n正文'.repeat(3);
  assert.equal(qualityGate(home, '', { path: 'HOME.md' }).ok, true);
  const homeLost = '---\ntitle: H\nsummary: s\n---\n# HOME\n\n正文没了哨兵'.repeat(3);
  assert.equal(qualityGate(homeLost, '', { path: 'HOME.md' }).reason, 'journal token/sentinel destroyed');
  // HOME 哨兵区物化形态也认
  const homeMat = home.replace('{{LORE_HOME_STATUS}}', '<!-- LORE_HOME_STATUS:START -->x<!-- LORE_HOME_STATUS:END -->');
  assert.equal(qualityGate(homeMat, '', { path: 'HOME.md' }).ok, true);
  // 普通页带 HOME 哨兵不算（仍要 JOURNAL）
  assert.equal(qualityGate(homeMat, '', { path: 'theme/x.md' }).ok, false);
});
```

- [ ] **Step 2: Run** → FAIL（qualityGate 不接受第三参/HOME 被 JOURNAL 检查拒）
- [ ] **Step 3: 实现**（Edit `lib/runner.js` qualityGate——JOURNAL 检查处按 page.path 分支）

```js
export function qualityGate(newText, oldText, page = {}) {
  ...（frontmatter 检查不动）
  const isHome = (page.path ?? '') === 'HOME.md' || (page.path ?? '').endsWith('/HOME.md');
  const sentinel = isHome ? 'LORE_HOME_STATUS' : 'LORE_JOURNAL';
  if (!newText.includes(`{{${sentinel}}}`) && !newText.includes(`${sentinel}:START`)) {
    return { ok: false, reason: 'journal token/sentinel destroyed' };
  }
  ...（mermaid/截断不动）
}
```

runAuto 调用处 `qualityGate(newText, oldText)` → `qualityGate(newText, oldText, p)`（p 为当页工单项）。

- [ ] **Step 4: Run** `node --test test/runner.test.js` → PASS（既有 gate 测试回归）
- [ ] **Step 5: Commit** `feat(runner): per-page sentinel in quality gate — HOME uses HOME_STATUS`

---

### Task 4: config stale_threshold（B2 前置）

**Files:** Modify `lib/syncstate.js`；Test `test/syncstate.test.js` 追加

- [ ] **Step 1: 测试**（Edit `test/syncstate.test.js` 追加）

```js
test('readSyncConfig: stale_threshold 缺省 15，非法回默认；writeSyncConfig 校验范围', () => {
  const st = mkdtempSync(join(tmpdir(), 'lore-cfg-'));
  try {
    assert.equal(readSyncConfig(st).stale_threshold, 15);
    writeSyncConfig(st, { mode: 'notify', stale_threshold: 30 });
    assert.equal(readSyncConfig(st).stale_threshold, 30);
    writeFileSync(join(st, 'sync.json'), JSON.stringify({ mode: 'notify', stale_threshold: 'lots' }));
    assert.equal(readSyncConfig(st).stale_threshold, 15);
    assert.throws(() => writeSyncConfig(st, { mode: 'notify', stale_threshold: 0 }), /stale_threshold/);
  } finally { rmSync(st, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: 实现**（Edit `lib/syncstate.js`）：CONFIG_DEFAULTS 加 `stale_threshold: 15`；readSyncConfig 加 `stale_threshold: Number.isFinite(raw.stale_threshold) ? raw.stale_threshold : CONFIG_DEFAULTS.stale_threshold`；writeSyncConfig 校验 `1-500` 否则 throw `invalid stale_threshold (1-500)`（仿 debounce 行文）。
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat(syncstate): auto.stale_threshold config (default 15)`

---

### Task 5: runAuto 工单扩轴 + prompt 按 axis 分支（B2+B3）

**Files:** Modify `lib/runner.js`；Test `test/runner.test.js` 追加

- [ ] **Step 1: 测试**（Edit `test/runner.test.js` 追加——fake backend 收集 prompt；最小 harness：config.yml + wiki 页 + manifest 注入 stale）

```js
test('runAuto 扩轴: 非 component 页按 manifest stale≥阈值入单且 stale 降序；prompt 按轴分支', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-runax-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const lore = join(root, '.lore');
    for (const d of ['journal', '.state', 'wiki/component', 'wiki/theme', 'wiki/flow']) mkdirSync(join(lore, d), { recursive: true });
    writeFileSync(join(lore, 'config.yml'), 'axes:\n  component:\n    code_roots: [lib]\n  theme:\n    values:\n    - { id: ioc, desc: d, match: [x] }\n  flow:\n    values:\n    - { id: pipe, spans: [lib] }\n');
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'a.js'), 'export const x = 1;');
    const PAGE = (t, sent) => `---\ntitle: ${t}\nsummary: s\n---\n# ${t}\n\n${sent}\n\n正文足够长一点免截断检查`.repeat(2);
    writeFileSync(join(lore, 'wiki', 'HOME.md'), PAGE('HOME', '{{LORE_HOME_STATUS}}'));
    writeFileSync(join(lore, 'wiki', 'theme', 'ioc.md'), PAGE('ioc', '{{LORE_JOURNAL}}'));
    writeFileSync(join(lore, 'wiki', 'flow', 'pipe.md'), PAGE('pipe', '{{LORE_JOURNAL}}'));
    // manifest 注入 stale：theme/ioc=40、flow/pipe=20、HOME=5（阈值 15 → ioc、pipe 入单，HOME 不入）
    writeFileSync(join(lore, 'wiki', '.manifest.json'), JSON.stringify({
      generated: 'x', axes: [
        { id: 'HOME', pages: [{ id: 'HOME', path: 'HOME.md', stale: 5 }] },
        { id: 'theme', pages: [{ id: 'ioc', path: 'theme/ioc.md', stale: 40 }] },
        { id: 'flow', pages: [{ id: 'pipe', path: 'flow/pipe.md', stale: 20 }] },
      ],
    }));
    const backend = { rewritePage({ page }) { return Promise.resolve(readFileSync(join(lore, 'wiki', page.path), 'utf8')); } };
    const r = await runAuto(lore, { backend, maxPages: 9, spawnFn: () => ({ unref() {} }) });
    const order = r.pages.map(x => x.page);
    assert.ok(order.includes('theme/ioc.md') && order.includes('flow/pipe.md'));
    assert.ok(!order.includes('HOME.md'));                                  // 5 < 15
    assert.ok(order.indexOf('theme/ioc.md') < order.indexOf('flow/pipe.md'));  // stale 降序
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('axisPrompt: 四轴 prompt 关键词正确', () => {
  assert.match(axisPrompt({ axis: 'component', path: 'component/a.md' }), /两档页面标准/);
  assert.match(axisPrompt({ axis: 'theme', path: 'theme/x.md' }), /横切主线/);
  assert.match(axisPrompt({ axis: 'flow', path: 'flow/x.md' }), /端到端/);
  assert.match(axisPrompt({ axis: 'HOME', path: 'HOME.md' }), /LORE_HOME_STATUS/);
});
```

（fake backend 原样回吐旧页 → 质量门必过、写盘无实质变化——测的是工单组装与顺序。）

- [ ] **Step 2: Run** → FAIL（HOME/theme/flow 不入单；axisPrompt 不存在）
- [ ] **Step 3: 实现**（Edit `lib/runner.js`）

新导出 `axisPrompt(page)`（claudeBackend 内 prompt 改为调用它）：

```js
// 各轴重写指引（B3）：哨兵原位保留是共同硬约束；只输出整页 markdown。
export function axisPrompt(page) {
  const COMMON = [
    '你是 lore 的页面重写器。仓库根在当前目录。',
    `读现有页 .lore/wiki/${page.path} 与相关源码，重写整页。`,
  ];
  const TAIL = [
    '要求：保留 frontmatter 的 title/summary 结构；只输出完整 markdown 页面，不要任何解释或代码围栏。',
  ];
  const byAxis = {
    component: [
      `源码入口：${page.codeRoot ?? page.sourceFile ?? '相关模块'}。`,
      '按 lore 的两档页面标准（概览档零黑话 + 机制档 <details> 折叠 + 锚点锚符号）重写。',
      '{{LORE_JOURNAL}} token 或已折叠的 LORE_JOURNAL 哨兵区原位保留。',
    ],
    theme: [
      '这是横切主线页：重写「Current state」——这条主线的当前状态/约束/为什么重要，据真实源码与近期演进写，非泛词。',
      '{{LORE_JOURNAL}} token 或 LORE_JOURNAL 哨兵区原位保留。',
    ],
    flow: [
      '这是数据流页：重写「End-to-end path」——顶部 mermaid 数据流图（入口 → 各阶段(组件) → 出口），prose 讲关键转换/约束。',
      '{{LORE_JOURNAL}} token 或 LORE_JOURNAL 哨兵区原位保留。',
    ],
    HOME: [
      '这是全仓认知入口页：一句话定位 → {{LORE_HOME_STATUS}} token 或 LORE_HOME_STATUS 哨兵区原位保留 → Knowledge flow mermaid → 「理解项目/排查问题/决策与时间线」三个 wikilink 导航节。',
    ],
  };
  return [...COMMON, ...(byAxis[page.axis] ?? byAxis.component), ...TAIL].join('\n');
}
```

claudeBackend.rewritePage 的 prompt 行替换为 `const prompt = axisPrompt(page);`。

runAuto 工单组装（原 `const comp = worklist.filter(...)` 段扩展）：

```js
    const { worklist } = planSync(loreDir, {});
    const queued = readRewriteRequests(stateDir);
    const comp = worklist.filter(w => w.axis === 'component');
    // 非 component（HOME/theme/flow）：planSync 恒全列且无指纹——用 manifest stale≥阈值过滤（B2）
    let rest = [];
    try {
      const manifest = JSON.parse(readFileSync(join(loreDir, 'wiki', '.manifest.json'), 'utf8'));
      const staleByPath = new Map();
      for (const ax of manifest.axes ?? []) for (const pg of ax.pages ?? []) staleByPath.set(pg.path, pg.stale ?? 0);
      rest = worklist
        .filter(w => w.axis !== 'component' && (staleByPath.get(w.path) ?? 0) >= config.stale_threshold)
        .sort((a, b) => (staleByPath.get(b.path) ?? 0) - (staleByPath.get(a.path) ?? 0));
    } catch { /* 无 manifest（未 finalize 过）→ 非 component 不入单 */ }
    const queuedPages = queued.map(q => ({ path: q.page, axis: pathAxis(q.page), reason: 'user-requested' }));
    const seen = new Set();
    const jobs = [];
    for (const p of [...queuedPages, ...comp, ...rest]) {
      if (seen.has(p.path)) continue;
      seen.add(p.path);
      jobs.push(p);
      if (jobs.length >= limit) break;
    }
```

辅助 `pathAxis(path)`：`path === 'HOME.md' ? 'HOME' : path.split('/')[0]`（队列项只有 path——给 prompt 分支用）。原循环体遍历 jobs（原变量名沿用，确保 `qualityGate(newText, old, p)` 传页）。

- [ ] **Step 4: Run** `node --test test/runner.test.js` → PASS（既有 runAuto 测试回归——若有「工单只含 component」旧断言按新语义更新）
- [ ] **Step 5: Commit** `feat(runner): all-axis worklist (manifest stale≥threshold) + per-axis rewrite prompts — theme/flow/HOME no longer dead-end`

---

### Task 6: 壳 stale 徽标动作化（C）

**Files:** Modify `site/shell.mjs`（buildMeta）、`site/index.html`（renderMeta + 绑定）；Test `test/shell.test.js` 追加

- [ ] **Step 1: 测试**（Edit `test/shell.test.js` 追加）

```js
test('buildMeta: stale chip 带排队 action 与 path；fresh 无 action', () => {
  const m = buildMeta({ stale: 12, path: 'theme/ioc.md', last_updated: 'x', code_sha: 'y' });
  const stale = m.chips.find(c => c.kind === 'stale');
  assert.equal(stale.action, 'queue');
  assert.equal(stale.path, 'theme/ioc.md');
  assert.match(stale.text, /点击排队重写/);
  const f = buildMeta({ stale: 0, path: 'a.md' });
  assert.equal(f.chips.find(c => c.kind === 'fresh').action, undefined);
});
```

- [ ] **Step 2: Run** `node --test test/shell.test.js` → FAIL
- [ ] **Step 3: 实现**

（Edit `site/shell.mjs` buildMeta 的 stale chip）：

```js
  chips.push(page.stale > 0
    ? { icon: '⚠', text: `落后 ${page.stale} commits · 点击排队重写`, kind: 'stale', action: 'queue', path: page.path }
    : { icon: '✓', text: '最新', kind: 'fresh' });
```

（Edit `site/index.html` renderMeta：action chip 出 button；并在页面渲染后绑定——找到调用 renderMeta 之后统一绑事件处，加一段）：

```js
function renderMeta(page) {
  const cls = { plain: 'chip', stale: 'chip stale', fresh: 'chip fresh' };
  return buildMeta(page).chips.map(c => c.action === 'queue'
    ? `<button class="${cls[c.kind]}" data-queue-page="${c.path}">${c.icon} ${c.text}</button>`
    : `<span class="${cls[c.kind]}">${c.icon} ${c.text}</span>`).join('');
}
```

绑定（与现有 `button[data-queue]` 同款语义，插在同一事件绑定区）：

```js
  document.querySelectorAll('#content button[data-queue-page]').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = '排队中…';
    try {
      await fetch(BASE + 'api/sync/rewrite-requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page: b.dataset.queuePage }) });
      b.textContent = '已排队 ✍（auto 档后台消化；或会话跑 /lore:sync）';
    } catch { b.textContent = '⚠ 排队不可用（静态服务）'; }
  });
```

注意绑定代码所在函数必须在每次页面渲染后执行（与 translate-page 按钮同一时机——Grep `translate-page` 的绑定位置，把新绑定放同函数内）。

- [ ] **Step 4: Run** `node --test test/shell.test.js` → PASS
- [ ] **Step 5: Commit** `feat(shell): stale chip is now an action — click to queue rewrite, no more "run sync" misdirection`

---

### Task 7: 验收 + 文档 + 回归

- [ ] **Step 1**: 全量回归 `node --test test/` → 全绿
- [ ] **Step 2**: 实机验收——`node lib/portal.js autostart on`（真装 Startup vbs）；threat-intel 切 auto：`node -e "import('./lib/syncstate.js').then(m => { m.writeSyncMode('D:/workspace/threat-intel/.lore/.state', 'auto'); console.log(m.readSyncConfig('D:/workspace/threat-intel/.lore/.state')); })"`；curl portal `/threat-intel/api/sync/status` 确认 mode=auto。
- [ ] **Step 3**: ROADMAP——A/B/C 标 ✅（带本轮诊断根因一句话）；D（存量页标准升级工单）/E（ask-miss 质量环）记为下轮议题。CHANGELOG v0.8.0 段补三条。
- [ ] **Step 4**: Commit `feat: living-wiki gaps A+C+B — resident portal, actionable stale, all-axis auto rewrite`（push 按用户指令）
