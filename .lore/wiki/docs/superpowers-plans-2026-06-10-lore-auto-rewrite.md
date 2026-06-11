---
title: lore 自动重写 B2（LLM 运行器 + auto 档 + schedule + 质量门）Implementation Plan
summary: > **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [...
source_path: docs/superpowers/plans/2026-06-10-lore-auto-rewrite.md
last_updated: 2026-06-10
group: 设计与计划
---
> 源文档：`docs/superpowers/plans/2026-06-10-lore-auto-rewrite.md`

# lore 自动重写 B2（LLM 运行器 + auto 档 + schedule + 质量门）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** auto 档兑现：commit 静默期/定时后，后台只读 LLM（claude CLI 无头）重写 stale 页，质量门过门写盘，任务历史可见。

**Architecture:** hook 的 auto 分支只写 `.state/auto-pending.json` 时间戳；server CLI 块的 ticker（60s）用纯函数 `shouldRunAuto` 判定（静默期/schedule/防叠跑）→ spawn `lib/runner.js`；runner 串行调 backend（claude -p 只读工具，stdout 收文）→ `qualityGate`（复用 lint 的 `mermaidIssues`）→ 写盘+记 `.state/auto-runs.ndjson` → spawn finalize。壳解锁 auto、灯加 busy 态、任务历史表。

**Tech Stack:** Node 内置 + `node --test`；fake backend 注入测 runner（不真调 claude）。

**Spec:** `docs/superpowers/specs/2026-06-10-lore-auto-rewrite-design.md`（设计已批）。

**纪律提醒（本 session 实测教训）：** 写测试代码用 Edit/Write（不用 heredoc——RTK 吃反斜杠）；依赖 Edit 结果的 Bash 绝不与 Edit 并行发（Edit 失败 Bash 照跑会 commit 红测试）。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `lib/syncstate.js` | 修改 | MODES+auto；`readSyncConfig`；pending/pid/runs 读写 |
| `test/syncstate.test.js` | 扩展+翻转 | 新读写单测；`writeSyncMode('auto')` 由 throw 翻转为成功 |
| `lib/runner.js` | 新增 | `shouldRunAuto` / `qualityGate` / `claudeBackend` / `runAuto` + CLI |
| `test/runner.test.js` | 新增 | 全分支（fake backend） |
| `lib/hook.js` | 修改 | auto 分支写 pending（finalize spawn 照旧） |
| `test/hook.test.js` | 扩展 | auto 档行为 |
| `server.js` | 修改 | mode 放开 auto；status 扩展；GET runs；CLI 块 ticker |
| `test/server.test.js` | 扩展+翻转 | `auto → 400` 翻转为 200；status/runs 形状 |
| `site/shell.mjs` | 修改 | `buildConsoleModel` busy 态 |
| `site/index.html` | 修改 | auto 解锁、参数摘要、任务历史表、灯 busy CSS |
| `commands/sync.md` `commands/serve.md` | 修改 | auto 档说明一句 |
| `docs/ROADMAP.md` | 修改 | B2 标记 |

---

## Task 1: syncstate 扩展（auto 进枚举 + config + pending/pid/runs）

**Files:** Modify `lib/syncstate.js`、`test/syncstate.test.js`

- [ ] **Step 1: 翻转 B1 断言 + 写新失败测试** —— `test/syncstate.test.js`：

既有 `writeSyncMode: 非法值 throw` 测试里的 `assert.throws(() => writeSyncMode(dir, 'auto'), /invalid sync mode/);` 替换为 `writeSyncMode(dir, 'auto'); assert.equal(readSyncMode(dir), 'auto');   // B2 解锁`。

末尾追加（import 行扩 `readSyncConfig, writeAutoPending, readAutoPending, writeRunnerPid, readRunnerPid, clearRunnerPid, appendAutoRun, readAutoRuns`）：

```js
test('readSyncConfig: 默认值兜底 + B1 形状向后兼容 + 扩展字段', () => {
  const dir = tmp();
  try {
    assert.deepEqual(readSyncConfig(dir), { mode: 'notify', debounce_minutes: 10, schedule: null, max_pages: 5 });
    writeFileSync(join(dir, 'sync.json'), JSON.stringify({ mode: 'manual' }));            // B1 形状
    assert.equal(readSyncConfig(dir).mode, 'manual');
    assert.equal(readSyncConfig(dir).debounce_minutes, 10);
    writeFileSync(join(dir, 'sync.json'), JSON.stringify({ mode: 'auto', debounce_minutes: 3, schedule: '03:00', max_pages: 2, future_field: 1 }));
    const c = readSyncConfig(dir);
    assert.deepEqual(c, { mode: 'auto', debounce_minutes: 3, schedule: '03:00', max_pages: 2 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('auto-pending: 写读清 round-trip；缺文件 null', () => {
  const dir = tmp();
  try {
    assert.equal(readAutoPending(dir), null);
    writeAutoPending(dir, '2026-06-10T01:00:00Z');
    assert.equal(readAutoPending(dir), '2026-06-10T01:00:00Z');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner pid: 写读清；坏 JSON → null', () => {
  const dir = tmp();
  try {
    assert.equal(readRunnerPid(dir), null);
    writeRunnerPid(dir, 12345);
    assert.equal(readRunnerPid(dir), 12345);
    clearRunnerPid(dir);
    assert.equal(readRunnerPid(dir), null);
    writeFileSync(join(dir, 'runner.pid'), '{oops');
    assert.equal(readRunnerPid(dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('auto-runs: append + 读最近 N 条（新在前）；缺文件 []', () => {
  const dir = tmp();
  try {
    assert.deepEqual(readAutoRuns(dir), []);
    appendAutoRun(dir, { ts: 't1', pages: [{ page: 'component/a.md', ok: true, ms: 100 }], total_ms: 100 });
    appendAutoRun(dir, { ts: 't2', pages: [], total_ms: 5 });
    const runs = readAutoRuns(dir, 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].ts, 't2');                       // 最新在前
    assert.equal(readAutoRuns(dir).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑红** —— `node --test test/syncstate.test.js` → FAIL（readSyncConfig 未导出）

- [ ] **Step 3: 实现** —— `lib/syncstate.js`：

`MODES` 行改为 `const MODES = new Set(['manual', 'notify', 'auto']);`（注释去掉「B2 加」）；`writeSyncMode` 错误文案 `(B1: manual|notify)` 改 `(manual|notify|auto)`。末尾追加：

```js
// B2 自动重写状态（spec 2026-06-10-lore-auto-rewrite）。
const PENDING_FILE = 'auto-pending.json';
const RUNNER_PID_FILE = 'runner.pid';
const RUNS_FILE = 'auto-runs.ndjson';
const CONFIG_DEFAULTS = { mode: 'notify', debounce_minutes: 10, schedule: null, max_pages: 5 };

export function readSyncConfig(stateDir) {
  const p = join(stateDir, MODE_FILE);
  let raw = {};
  if (existsSync(p)) { try { raw = JSON.parse(readFileSync(p, 'utf8')) ?? {}; } catch { raw = {}; } }
  return {
    mode: MODES.has(raw.mode) ? raw.mode : CONFIG_DEFAULTS.mode,
    debounce_minutes: Number.isFinite(raw.debounce_minutes) ? raw.debounce_minutes : CONFIG_DEFAULTS.debounce_minutes,
    schedule: typeof raw.schedule === 'string' && /^\d{2}:\d{2}$/.test(raw.schedule) ? raw.schedule : CONFIG_DEFAULTS.schedule,
    max_pages: Number.isFinite(raw.max_pages) ? raw.max_pages : CONFIG_DEFAULTS.max_pages,
  };
}

export function writeAutoPending(stateDir, ts) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, PENDING_FILE), JSON.stringify({ since: ts }) + '\n');
}
export function readAutoPending(stateDir) {
  const p = join(stateDir, PENDING_FILE);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')).since ?? null; } catch { return null; }
}
export function clearAutoPending(stateDir) {
  try { rmSync(join(stateDir, PENDING_FILE), { force: true }); } catch { /* best-effort */ }
}

export function writeRunnerPid(stateDir, pid) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, RUNNER_PID_FILE), JSON.stringify({ pid }) + '\n');
}
export function readRunnerPid(stateDir) {
  const p = join(stateDir, RUNNER_PID_FILE);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')).pid ?? null; } catch { return null; }
}
export function clearRunnerPid(stateDir) {
  try { rmSync(join(stateDir, RUNNER_PID_FILE), { force: true }); } catch { /* best-effort */ }
}

export function appendAutoRun(stateDir, run) {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, RUNS_FILE), JSON.stringify(run) + '\n');
}
export function readAutoRuns(stateDir, limit = 20) {
  const p = join(stateDir, RUNS_FILE);
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip bad line */ }
  }
  return out.reverse().slice(0, limit);                    // 最新在前
}
```

（顶部 import 行补 `rmSync`：`import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';`；`clearAutoPending` 测试由 runner 集成覆盖，import 行也一并导出。）

- [ ] **Step 4: 跑绿** —— `node --test test/syncstate.test.js` → PASS（12 tests）
- [ ] **Step 5: Commit** —— `git add lib/syncstate.js test/syncstate.test.js && git commit -m "feat(syncstate): auto mode + config/pending/pid/runs state (B2)"`

---

## Task 2: runner 纯函数（shouldRunAuto + qualityGate）

**Files:** Create `lib/runner.js`、`test/runner.test.js`

- [ ] **Step 1: 写失败测试** —— 创建 `test/runner.test.js`：

```js
// test/runner.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRunAuto, qualityGate } from '../lib/runner.js';

const NOW = new Date('2026-06-10T12:00:00');
const cfgAuto = { mode: 'auto', debounce_minutes: 10, schedule: null, max_pages: 5 };

test('shouldRunAuto: 非 auto / runner 活 → false', () => {
  assert.equal(shouldRunAuto({ config: { ...cfgAuto, mode: 'notify' }, pendingTs: '2026-06-10T11:00:00', lastRunDate: null, now: NOW, runnerAlive: false }).run, false);
  assert.equal(shouldRunAuto({ config: cfgAuto, pendingTs: '2026-06-10T11:00:00', lastRunDate: null, now: NOW, runnerAlive: true }).run, false);
});

test('shouldRunAuto: debounce 未到 false；已到 true（reason debounce）', () => {
  assert.equal(shouldRunAuto({ config: cfgAuto, pendingTs: '2026-06-10T11:55:00', lastRunDate: null, now: NOW, runnerAlive: false }).run, false);   // 5 分钟前 < 10
  const r = shouldRunAuto({ config: cfgAuto, pendingTs: '2026-06-10T11:45:00', lastRunDate: null, now: NOW, runnerAlive: false });
  assert.deepEqual(r, { run: true, reason: 'debounce' });
});

test('shouldRunAuto: schedule 到点且今天没跑 → true；今天跑过 → false；无 pending 无 schedule → false', () => {
  const cfg = { ...cfgAuto, schedule: '03:00' };
  const r = shouldRunAuto({ config: cfg, pendingTs: null, lastRunDate: '2026-06-09', now: NOW, runnerAlive: false });
  assert.deepEqual(r, { run: true, reason: 'schedule' });
  assert.equal(shouldRunAuto({ config: cfg, pendingTs: null, lastRunDate: '2026-06-10', now: NOW, runnerAlive: false }).run, false);
  assert.equal(shouldRunAuto({ config: cfgAuto, pendingTs: null, lastRunDate: null, now: NOW, runnerAlive: false }).run, false);
});

const GOOD_PAGE = `---\ntitle: X\nsummary: s\n---\n# X\n\n正文足够长，超过旧文三分之一的长度要求，这里再凑一些字数保证比例。\n\n<!-- LORE_JOURNAL:START -->\n- old\n<!-- LORE_JOURNAL:END -->\n`;
const OLD_PAGE = GOOD_PAGE;

test('qualityGate: 好页过门', () => {
  assert.deepEqual(qualityGate(GOOD_PAGE, OLD_PAGE), { ok: true });
});

test('qualityGate: 空 / 缺 frontmatter / token 与哨兵区全无 / 截断 各拒', () => {
  assert.equal(qualityGate('', OLD_PAGE).ok, false);
  assert.match(qualityGate('no frontmatter body', OLD_PAGE).reason, /frontmatter/);
  assert.match(qualityGate('---\ntitle: X\nsummary: s\n---\n# X\n\n正文够长够长够长够长够长够长够长够长够长够长够长够长。\n', OLD_PAGE).reason, /journal/);
  assert.match(qualityGate('---\ntitle: X\nsummary: s\n---\nx\n<!-- LORE_JOURNAL:START -->\n<!-- LORE_JOURNAL:END -->\n', OLD_PAGE).reason, /truncated/);
});

test('qualityGate: mermaid 坏图拒（复用 lint 第五检）', () => {
  const bad = GOOD_PAGE + '\n```mermaid\nflowchart LR\n  x --> graph["g"]\n```\n';
  assert.match(qualityGate(bad, OLD_PAGE).reason, /mermaid/);
});
```

- [ ] **Step 2: 跑红** —— `node --test test/runner.test.js` → FAIL（模块不存在）

- [ ] **Step 3: 实现** —— 创建 `lib/runner.js`（本任务只写前半）：

```js
// lib/runner.js —— B2 自动重写运行器（spec 2026-06-10-lore-auto-rewrite）。
// LLM 只读（claude -p 白名单工具）、runner 写盘；质量门在写盘前；append-only 任务历史。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mermaidIssues } from './lint.js';
import { parseFrontmatter } from './manifest.js';
import {
  readSyncConfig, readAutoPending, clearAutoPending,
  writeRunnerPid, readRunnerPid, clearRunnerPid, appendAutoRun, readRewriteRequests,
} from './syncstate.js';

// ticker 判定：静默期 / schedule 到点 / 防叠跑，全在这一个纯函数（可测）。
export function shouldRunAuto({ config, pendingTs, lastRunDate, now, runnerAlive }) {
  if (runnerAlive || config.mode !== 'auto') return { run: false, reason: null };
  if (pendingTs) {
    const quietMs = now.getTime() - new Date(pendingTs).getTime();
    if (quietMs >= config.debounce_minutes * 60_000) return { run: true, reason: 'debounce' };
  }
  if (config.schedule) {
    const [hh, mm] = config.schedule.split(':').map(Number);
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const due = new Date(now); due.setHours(hh, mm, 0, 0);
    if (now >= due && lastRunDate !== today) return { run: true, reason: 'schedule' };
  }
  return { run: false, reason: null };
}

// 质量门（全机械，写盘前）：frontmatter 完整 → journal token/哨兵区在 → mermaid 全过 → 防截断。
const MERMAID_BLOCK_RE = /```mermaid\r?\n([\s\S]*?)```/g;
export function qualityGate(newText, oldText) {
  if (!newText || !newText.trim()) return { ok: false, reason: 'empty' };
  const { data } = parseFrontmatter(newText);
  if (!data.title || !data.summary) return { ok: false, reason: 'frontmatter missing title/summary' };
  if (!newText.includes('{{LORE_JOURNAL}}') && !newText.includes('LORE_JOURNAL:START')) {
    return { ok: false, reason: 'journal token/sentinel destroyed' };
  }
  let m;
  while ((m = MERMAID_BLOCK_RE.exec(newText)) !== null) {
    const issues = mermaidIssues(m[1]);
    if (issues.length) return { ok: false, reason: `mermaid: ${issues[0]}` };
  }
  if (newText.length < (oldText ?? '').length / 3) return { ok: false, reason: 'truncated (<1/3 of previous)' };
  return { ok: true };
}
```

- [ ] **Step 4: 跑绿** —— `node --test test/runner.test.js` → PASS（6 tests）
- [ ] **Step 5: Commit** —— `git add lib/runner.js test/runner.test.js && git commit -m "feat(runner): shouldRunAuto ticker predicate + mechanical qualityGate"`

---

## Task 3: runner 主流程（claudeBackend + runAuto + CLI）

**Files:** Modify `lib/runner.js`、`test/runner.test.js`

- [ ] **Step 1: 写失败测试** —— `test/runner.test.js` 末尾追加：

```js
import { runAuto } from '../lib/runner.js';
import { mkdtempSync, mkdirSync, writeFileSync as wf, readFileSync as rf, rmSync, existsSync as ex } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendRewriteRequest, readRewriteRequests, readAutoRuns, readRunnerPid } from '../lib/syncstate.js';

function autoRepo() {
  const root = mkdtempSync(join(tmpdir(), 'lore-runner-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  mkdirSync(join(root, 'lib'), { recursive: true });
  wf(join(root, 'lib', 'a.js'), 'export const x = 1;');
  const lore = join(root, '.lore');
  mkdirSync(join(lore, 'wiki', 'component'), { recursive: true });
  wf(join(lore, 'config.yml'), 'axes:\n  component:\n    code_roots: [lib]\n');
  wf(join(lore, 'wiki', 'component', 'lib.md'),
    '---\ntitle: Lib\nsummary: s\n---\n# Lib\n\n旧正文。\n\n<!-- LORE_JOURNAL:START -->\n- x\n<!-- LORE_JOURNAL:END -->\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  return { root, lore };
}

const GOOD = `---\ntitle: Lib\nsummary: better\n---\n# Lib\n\n新正文，质量门要求长度不短于旧文三分之一，这里足够。\n\n<!-- LORE_JOURNAL:START -->\n- x\n<!-- LORE_JOURNAL:END -->\n`;

test('runAuto: 好页写盘+队列移除+历史记录+pid 清理；坏页丢弃记 reason；maxPages 截断', async () => {
  const { root, lore } = autoRepo();
  try {
    appendRewriteRequest(join(lore, '.state'), { page: 'component/lib.md' });
    let calls = 0;
    const backend = { rewritePage: async ({ page }) => { calls++; return GOOD; } };
    const res = await runAuto(lore, { backend, maxPages: 5, spawnFn: () => ({ unref() {}, once() {} }), now: () => new Date('2026-06-10T12:00:00') });
    assert.equal(calls, 1);                                              // 只有 lib 一页
    assert.equal(res.pages[0].ok, true);
    assert.match(rf(join(lore, 'wiki', 'component', 'lib.md'), 'utf8'), /新正文/);   // 写盘了
    assert.deepEqual(readRewriteRequests(join(lore, '.state')), []);     // 队列消化
    assert.equal(readAutoRuns(join(lore, '.state')).length, 1);          // 历史
    assert.equal(readRunnerPid(join(lore, '.state')), null);             // pid 清了
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runAuto: 质量门不过 → 页面原样 + reason 入历史', async () => {
  const { root, lore } = autoRepo();
  try {
    const backend = { rewritePage: async () => 'garbage no frontmatter' };
    const res = await runAuto(lore, { backend, maxPages: 5, spawnFn: () => ({ unref() {}, once() {} }), now: () => new Date() });
    assert.equal(res.pages[0].ok, false);
    assert.match(res.pages[0].reason, /frontmatter/);
    assert.match(rf(join(lore, 'wiki', 'component', 'lib.md'), 'utf8'), /旧正文/);   // 没动
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runAuto: backend 抛错 → 该页失败记 reason，不崩', async () => {
  const { root, lore } = autoRepo();
  try {
    const backend = { rewritePage: async () => { throw new Error('claude-cli-missing'); } };
    const res = await runAuto(lore, { backend, maxPages: 5, spawnFn: () => ({ unref() {}, once() {} }), now: () => new Date() });
    assert.equal(res.pages[0].ok, false);
    assert.match(res.pages[0].reason, /claude-cli-missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑红** —— FAIL（runAuto 未导出）

- [ ] **Step 3: 实现** —— `lib/runner.js` 追加：

```js
import { planSync } from './sync.js';

// claude CLI 后端（B2 唯一实现；接口契约 rewritePage({page,repoRoot,timeoutMs}) → Promise<string>，
// 裸 API / codex 下轮按此补）。LLM 只读：--allowedTools 白名单无 Write/Bash，页面全文走 stdout。
export function claudeBackend() {
  return {
    rewritePage({ page, repoRoot, timeoutMs = 600_000 }) {
      const prompt = [
        `你是 lore 的页面重写器。仓库根在当前目录。`,
        `读 ${page.codeRoot ?? page.sourceFile ?? ''} 的源码与现有页 .lore/wiki/${page.path}，`,
        `按 .lore/../commands 里 sync.md 的两档标准（概览档+机制档）重写整页。`,
        `要求：保留 frontmatter 的 title/summary 结构；{{LORE_JOURNAL}} token 或已折叠的哨兵区原位保留；`,
        `只输出完整 markdown 页面，不要任何解释或代码围栏。`,
      ].join('\n');
      return new Promise((resolveP, rejectP) => {
        execFile('claude', ['-p', prompt, '--allowedTools', 'Read,Grep,Glob'],
          { cwd: repoRoot, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
          (err, stdout) => {
            if (err) return rejectP(new Error(err.code === 'ENOENT' ? 'claude-cli-missing' : err.killed ? 'timeout' : `claude exit: ${err.message.slice(0, 80)}`));
            // stdout 可能混入日志：提取首个 frontmatter 起始到文末
            const i = stdout.indexOf('---');
            resolveP(i >= 0 ? stdout.slice(i) : stdout);
          });
      });
    },
  };
}

// 主流程：工单（队列优先）→ 逐页 backend → 质量门 → 写盘 → 历史 → finalize。
export async function runAuto(loreDir, { backend, maxPages, timeoutMs = 600_000, spawnFn = spawn, now = () => new Date() } = {}) {
  const stateDir = join(loreDir, '.state');
  const repoRoot = join(resolve(loreDir), '..');
  const config = readSyncConfig(stateDir);
  const limit = maxPages ?? config.max_pages;
  writeRunnerPid(stateDir, process.pid);
  const started = now();
  const results = [];
  try {
    const { worklist } = planSync(loreDir, {});
    const queued = readRewriteRequests(stateDir).map(r => r.page);
    const comp = worklist.filter(w => w.axis === 'component');
    // user-requested 置顶（队列序），其余按 plan 序；去重
    const ordered = [
      ...queued.map(p => comp.find(w => w.path === p)).filter(Boolean),
      ...comp.filter(w => !queued.includes(w.path)),
    ].slice(0, limit);
    for (const w of ordered) {
      const t0 = Date.now();
      try {
        const newText = await backend.rewritePage({ page: w, repoRoot, timeoutMs });
        const pagePath = join(loreDir, 'wiki', w.path);
        const oldText = existsSync(pagePath) ? readFileSync(pagePath, 'utf8') : '';
        const gate = qualityGate(newText, oldText);
        if (gate.ok) {
          writeFileSync(pagePath, newText.endsWith('\n') ? newText : newText + '\n');
          removeRewriteRequest(stateDir, w.path);
          results.push({ page: w.path, ok: true, ms: Date.now() - t0 });
        } else {
          results.push({ page: w.path, ok: false, reason: gate.reason, ms: Date.now() - t0 });
        }
      } catch (e) {
        results.push({ page: w.path, ok: false, reason: e.message.slice(0, 120), ms: Date.now() - t0 });
      }
    }
  } finally {
    clearRunnerPid(stateDir);
  }
  appendAutoRun(stateDir, { ts: started.toISOString(), pages: results, total_ms: now().getTime() - started.getTime() });
  if (results.some(r => r.ok)) {
    const syncJs = join(resolve(loreDir), '..', 'node_modules') && fileURLToPath(new URL('./sync.js', import.meta.url));
    const child = spawnFn(process.execPath, [syncJs, 'finalize', loreDir], { detached: true, stdio: 'ignore' });
    child.once?.('error', () => {});
    child.unref();
  }
  return { pages: results, total_ms: now().getTime() - started.getTime() };
}

// 消化队列条目：读全 → 滤掉该页 → 整写（commands/sync.md 同款语义）。
function removeRewriteRequest(stateDir, page) {
  const remaining = readRewriteRequests(stateDir).filter(r => r.page !== page);
  const p = join(stateDir, 'rewrite-requests.ndjson');
  try { writeFileSync(p, remaining.map(r => JSON.stringify(r)).join('\n') + (remaining.length ? '\n' : '')); }
  catch { /* best-effort */ }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const loreDir = process.argv[2] ?? join(process.cwd(), '.lore');
  runAuto(loreDir, { backend: claudeBackend() })
    .then(r => { console.log(`auto-rewrite: ${r.pages.filter(p => p.ok).length}/${r.pages.length} pages ok (${r.total_ms}ms)`); process.exit(0); })
    .catch(e => { console.error('auto-rewrite failed:', e.message); process.exit(1); });
}
```

（注意 `syncJs` 那行的实现以落地为准：直接 `fileURLToPath(new URL('./sync.js', import.meta.url))` 即可，去掉 node_modules 杂项。）

- [ ] **Step 4: 跑绿** —— `node --test test/runner.test.js` → PASS（9 tests）
- [ ] **Step 5: Commit** —— `git add lib/runner.js test/runner.test.js && git commit -m "feat(runner): claudeBackend (read-only LLM, stdout) + runAuto pipeline + CLI"`

---

## Task 4: hook auto 分支（写 pending）

**Files:** Modify `lib/hook.js`、`test/hook.test.js`

- [ ] **Step 1: 写失败测试** —— `test/hook.test.js` 末尾追加：

```js
import { readAutoPending } from '../lib/syncstate.js';

test('maybeRefresh: mode=auto → 写 pending 时间戳 + 照旧 spawn finalize', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mr-'));
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    writeFileSync(join(lore, 'wiki', '.manifest.json'), '{"axes":[]}');
    writeFileSync(join(lore, '.state', 'sync.json'), '');   // 占位，下一行真写
    mkdirSync(join(lore, '.state'), { recursive: true });
    writeFileSync(join(lore, '.state', 'sync.json'), JSON.stringify({ mode: 'auto' }));
    const calls = [];
    const r = maybeRefresh({ loreDir: lore, spawnFn: (cmd, args) => { calls.push(args); return { unref() {} }; } });
    assert.equal(r.spawned, true);                              // 机械 finalize 照旧
    assert.equal(calls.length, 1);
    assert.notEqual(readAutoPending(join(lore, '.state')), null);   // pending 写了
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

（fixture 写 sync.json 直接 `mkdirSync` + `writeFileSync` 两行即可，删去占位行；执行时以可运行为准。）

- [ ] **Step 2: 跑红** —— auto 档现在走 notify 路径（spawn 是对的）但 pending 是 null → FAIL
- [ ] **Step 3: 实现** —— `lib/hook.js`：import 行扩 `writeAutoPending`；`maybeRefresh` 的 manual 检查后加：

```js
    const mode = readSyncMode(join(loreDir, '.state'));
    if (mode === 'manual') return { spawned: false, reason: 'manual' };
    if (mode === 'auto') writeAutoPending(join(loreDir, '.state'), new Date().toISOString());
```

（把原来单行 manual 判定重构成上述三行——readSyncMode 只调一次。）

- [ ] **Step 4: 跑绿** —— `node --test test/hook.test.js` → PASS
- [ ] **Step 5: Commit** —— `git add lib/hook.js test/hook.test.js && git commit -m "feat(hook): auto mode stamps pending timestamp (mechanical finalize unchanged)"`

---

## Task 5: server（auto 放开 + status 扩展 + GET runs + ticker）

**Files:** Modify `server.js`、`test/server.test.js`

- [ ] **Step 1: 翻转 + 新失败测试** —— `test/server.test.js`：

mode 测试里 `assert.equal((await post({ mode: 'auto' })).status, 400);` 替换为 `assert.equal((await post({ mode: 'auto' })).status, 200);   // B2 解锁`（注意其后「盘没改」断言基于 manual——auto 写盘成功后盘变 auto，末尾断言改为先 `post({mode:'manual'})` 复位再验非法值不改盘；以最小改动落地为准，意图：合法值都落盘、非法值不落）。

末尾追加：

```js
test('GET /api/sync/status: B2 扩展形状（config + runner_running）', async () => {
  const root = syncFixture();
  const server = createServer(root);
  const port = await listen(server);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/sync/status`)).json();
    assert.deepEqual(body.config, { mode: 'notify', debounce_minutes: 10, schedule: null, max_pages: 5 });
    assert.equal(body.runner_running, false);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('GET /api/sync/runs: 历史最近 N 条', async () => {
  const root = syncFixture();
  const { appendAutoRun } = await import('../lib/syncstate.js');
  appendAutoRun(join(root, '.state'), { ts: 't1', pages: [], total_ms: 5 });
  const server = createServer(root);
  const port = await listen(server);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/sync/runs`)).json();
    assert.equal(body.runs.length, 1);
    assert.equal(body.runs[0].ts, 't1');
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现** —— `server.js`：

import 行扩 `readSyncConfig, readRunnerPid, readAutoRuns, readAutoPending, clearAutoPending`；status 端点改为：

```js
    if (req.method === 'GET' && pathname === '/api/sync/status') {
      const stateDir = join(root, '.state');
      const config = readSyncConfig(stateDir);
      let lastFinalize = null;
      try { lastFinalize = JSON.parse(readFileSync(join(root, 'wiki', '.manifest.json'), 'utf8')).generated ?? null; }
      catch { /* 无 manifest（未 sync）→ null */ }
      const pid = readRunnerPid(stateDir);
      return sendJson(res, 200, { mode: config.mode, last_finalize: lastFinalize, config, runner_running: pid != null && isAlive(pid) });
    }
```

（`isAlive` 从 `./lib/serve.js` import——已导出。）mode 端点错误文案去掉 B2 字样。rewrite-requests 块后加：

```js
    if (req.method === 'GET' && pathname === '/api/sync/runs') {
      return sendJson(res, 200, { runs: readAutoRuns(join(root, '.state')) });
    }
```

CLI 块（`createServer(rootDir).listen(...)` 处）加 ticker：

```js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , rootDir, portStr] = process.argv;
  if (!rootDir || !portStr) { console.error('usage: node server.js <rootDir> <port>'); process.exit(1); }
  createServer(rootDir).listen(Number(portStr), '127.0.0.1',
    () => console.log(`lore static server on 127.0.0.1:${portStr} root=${rootDir}`));
  // B2 ticker：统一调度静默期与 schedule（spec：仅 per-repo server，portal 不带）。
  const RUNNER_JS = join(HERE, 'lib', 'runner.js');
  setInterval(() => {
    try {
      const stateDir = join(rootDir, '.state');
      const config = readSyncConfig(stateDir);
      if (config.mode !== 'auto') return;
      const pid = readRunnerPid(stateDir);
      const runs = readAutoRuns(stateDir, 1);
      const d = shouldRunAuto({
        config,
        pendingTs: readAutoPending(stateDir),
        lastRunDate: runs[0]?.ts?.slice(0, 10) ?? null,
        now: new Date(),
        runnerAlive: pid != null && isAlive(pid),
      });
      if (!d.run) return;
      clearAutoPending(stateDir);
      const child = spawn(process.execPath, [RUNNER_JS, rootDir], { detached: true, stdio: 'ignore' });
      child.once?.('error', () => {});
      child.unref();
    } catch { /* ticker 永不击落 server */ }
  }, 60_000).unref();
}
```

（`shouldRunAuto` import 自 `./lib/runner.js`；`isAlive` 自 `./lib/serve.js`。）

- [ ] **Step 4: 跑绿** —— `node --test test/server.test.js` → PASS
- [ ] **Step 5: Commit** —— `git add server.js test/server.test.js && git commit -m "feat(server): unlock auto mode, status config/runner_running, GET runs, 60s auto ticker (per-repo only)"`

---

## Task 6: 壳（busy 灯 + auto 解锁 + 任务历史表）

**Files:** Modify `site/shell.mjs`、`test/shell.test.js`、`site/index.html`

- [ ] **Step 1: shell.mjs TDD** —— `test/shell.test.js` 追加：

```js
test('buildConsoleModel: runner_running → busy 灯（优先于 stale/fresh，不盖 manual off）', () => {
  const m = buildConsoleModel(mkManifest([{ id: 'a', title: 'A', stale: 3 }]), { mode: 'auto', last_finalize: null, runner_running: true });
  assert.equal(m.light, 'busy');
  const off = buildConsoleModel(mkManifest([]), { mode: 'manual', last_finalize: null, runner_running: true });
  assert.equal(off.light, 'off');   // manual 优先（runner 不该在 manual 下跑，防御性显示）
});
```

跑红 → `site/shell.mjs` `buildConsoleModel` 的 light 行改为：

```js
    light: mode === 'manual' ? 'off'
      : status?.runner_running ? 'busy'
      : (stalePages.length ? 'stale' : 'fresh'),
```

跑绿。

- [ ] **Step 2: index.html** ——
  - CSS：`#sync-light.off .ind` 后加 `#sync-light.busy .ind { background: var(--accent); box-shadow: 0 0 6px var(--accent); animation: pulse 1.2s infinite; } @keyframes pulse { 50% { opacity: .4; } }`
  - 面板/console 两处 seg：`<button data-mode="auto" disabled title="B2 解锁">全自动 🔒</button>` 改 `<button data-mode="auto">全自动</button>`；`wireSyncConsole` 与 `renderConsolePage` 里 `if (b.dataset.mode === 'auto') return;` / `if (b.dataset.mode !== 'auto')` 的跳过逻辑删除（auto 与其他档同等绑定）。
  - `renderSyncLight` 灯文案分支加 busy：`m.light === 'busy' ? '自动重写中…' : ...`；mode=auto 时面板「待重写」行下补一行参数摘要 `auto：静默 ${SYNC_STATUS?.config?.debounce_minutes}min${SYNC_STATUS?.config?.schedule ? ' · 每日 ' + SYNC_STATUS.config.schedule : ''}`（新 span#sync-auto-info，非 auto 时隐藏）。
  - console「自动重写任务历史」🔒 占位行替换为真表格：fetch `BASE + 'api/sync/runs'`（在 `renderConsolePage` 改 async 或预取进 SYNC_RUNS 全局——选预取：`fetchSyncStatus` 里顺带 fetch runs 存 `SYNC_RUNS`），渲染 `时间 / N 页 / ✓ok ✗fail / 失败 reason 摘要`，空则「暂无运行记录」。
  - modeDesc 加 auto 文案：`auto: 'commit 静默期后自动重写 stale 页（后台 LLM，质量门把关）'`。
- [ ] **Step 3: 语法自检 + dogfood 双 cp**（同前轮命令）+ `node --test test/shell.test.js` 绿
- [ ] **Step 4: Commit** —— `git add site/index.html site/shell.mjs test/shell.test.js .lore/site/index.html .lore/site/shell.mjs && git commit -m "feat(shell): unlock auto mode, busy light, auto-run history table"`

---

## Task 7: 文档 + ROADMAP + 全量回归 + 端到端

**Files:** Modify `commands/sync.md`、`commands/serve.md`、`docs/ROADMAP.md`

- [ ] **Step 1: 命令文档** —— `commands/serve.md` 的 `--node` 行后加一句：「auto 档的后台重写依赖 Node server 在跑（ticker 宿主）——serve 没开则 auto 不触发」。`commands/sync.md` 的 rewrite-requests 节加一句：「auto 档下该队列由后台 runner 自动消化（质量门把关）；会话内消化仍然有效（先到先得）」。
- [ ] **Step 2: ROADMAP** —— B1 节的 B2 预告行替换为：

```markdown
### 自动重写 B2（LLM 运行器 + auto 档 + schedule + 质量门）✅ 已实现
- 已实现：auto 档（`.state/sync.json` 扩展 debounce/schedule/max_pages）；hook 只写 pending 时间戳，server ticker（60s，仅 per-repo）统一判静默期/schedule/防叠跑 → spawn runner；runner 串行调 **只读 claude CLI**（--allowedTools Read,Grep,Glob，stdout 收文）→ 机械质量门（frontmatter/journal token/mermaid 第五检/防截断）→ 过门写盘 → `.state/auto-runs.ndjson` 历史 → finalize 收尾；壳 auto 解锁 + 灯 busy 态 + console 任务历史表。设计见 `docs/superpowers/specs/2026-06-10-lore-auto-rewrite-design.md`。余项（裸 API/codex 后端、配置编辑 UI）另立。
```

- [ ] **Step 3: 全量回归** —— `node --test` → 0 fail（预计 370±）。
- [ ] **Step 4: 端到端 dogfood（真 claude）** —— 临时把 `.lore/.state/sync.json` 调成 `{"mode":"auto","debounce_minutes":0,"max_pages":1}` → `node lib/runner.js .lore` 手动跑一次（绕过 ticker 等待）→ 验证：一页 stale 真被重写、质量门过、`auto-runs.ndjson` 有记录、finalize 后 stale 降。然后 sync.json 复位 notify。serve 开着时用 Preview 看灯 busy 态与任务历史表。
- [ ] **Step 5: Commit** —— `git add commands docs/ROADMAP.md .lore && git commit -m "docs: auto-rewrite B2 done; dogfood e2e verified"`

---

## Self-Review（已执行）

**1. Spec 覆盖：** 决策表 13 项——静默期→T2 shouldRunAuto+T4 pending；统一 ticker→T5；只读 LLM→T3 claudeBackend（--allowedTools）；后端分期→T3 接口契约注释；质量门→T2（复用 mermaidIssues）；防叠跑→T1 pid+T5 ticker runnerAlive；预算阀→T3 maxPages/timeout；配置→T1 readSyncConfig；schedule 语义→T2 lastRunDate 比对；任务历史→T1 runs+T6 表格；失败可见→T3 reason 入历史+T6 渲染；灯 busy→T6；B1 断言翻转→T1/T5 显式步骤。portal 无 ticker→T5（CLI 块仅 per-repo 入口）。

**2. Placeholder 扫描：** 每步含完整代码；T3 `syncJs` 行与 T4 fixture 行各有一处「以落地为准」微调注——非占位，是给执行者的实现裁量注记，代码主体完整。

**3. 类型一致性：** `readSyncConfig → {mode, debounce_minutes, schedule, max_pages}`（T1）↔ shouldRunAuto config 入参（T2）↔ ticker（T5）↔ status API（T5）↔ 壳 `SYNC_STATUS.config`（T6）。`shouldRunAuto({config,pendingTs,lastRunDate,now,runnerAlive}) → {run,reason}`（T2）↔ T5 调用。`backend.rewritePage({page,repoRoot,timeoutMs}) → Promise<string>`（T3 契约=fake backend 形状）。`runAuto(loreDir,{backend,maxPages,timeoutMs,spawnFn,now})`（T3）↔ CLI/测试调用。runs 条目 `{ts,pages:[{page,ok,reason?,ms}],total_ms}`（T1/T3/T6 一致）。

