# lore 迁移机制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引擎升级后用户 repo 内资产自动收敛到当前引擎（壳/hook stub/.mcp.json/CLAUDE.md 节/config 补缺块），并把 git 边界改为 facts-only（wiki/site 出库，journal/config 进库）。

**Architecture:** 新建 `lib/migrate.js` 期望态对齐器：收敛型资产「算期望→比实际→不同才写」（无状态）；一次性迁移（config 补缺/resident 首装/gitignore 行/gitattributes）记录于 `.lore/.state/migrations.json`，applied 后用户删除不复活。三入口：finalize 末尾（best-effort）、init 内部复用、CLI。

**Tech Stack:** 零依赖 Node.js ESM，node:test + assert/strict。Spec: `docs/superpowers/specs/2026-06-11-lore-migrate-design.md`。

**纪律**：测试文件用 Write/Edit 写，绝不 bash heredoc（RTK 钩子吃反斜杠）；依赖 Edit 结果的 Bash 不并行发。

**File Structure:**
- Create: `lib/migrate.js` —— 对齐器全部逻辑 + CLI（migrations 读写、SHELL_FILES/alignShell、HOOK_MARKER/renderHookStub/alignHookStub、CONFIG_BLOCKS/alignConfig、alignGitignore/alignGitattributes、alignResidentAssets、alignAssets）
- Create: `test/migrate.test.js`
- Modify: `lib/init.js` —— copyShell/installHook/ensureGitignore 变 thin wrapper（re-export 兼容既有测试）；renderConfigYaml 用 CONFIG_BLOCKS 拼装；init() 调 alignAssets
- Modify: `lib/sync.js` —— finalize 末尾 refreshResident → alignAssets，返回值加 `migrate`
- Modify: `lib/resident.js` —— residentSection 文案补 fresh-clone 引导
- Modify: `lib/mcp.js` —— lore_ask 空 manifest 引导
- Modify: `test/init.test.js`（gitignore 三行断言）、`.gitignore`/`.gitattributes`（T8 dogfood）

---

### Task 1: migrate.js 骨架 —— migrations 读写 + 壳对齐 + alignAssets 雏形 + CLI

**Files:**
- Create: `lib/migrate.js`
- Create: `test/migrate.test.js`

- [ ] **Step 1: Write the failing test**（用 Write 工具创建 `test/migrate.test.js`）

```js
// test/migrate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMigrations, appendMigration, alignShell, SHELL_FILES } from '../lib/migrate.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-mig-')); }

test('migrations: 缺文件/坏 JSON → 空 Set；append → 读回；幂等', () => {
  const st = tmp();
  try {
    assert.equal(readMigrations(st).size, 0);
    writeFileSync(join(st, 'migrations.json'), '{broken');
    assert.equal(readMigrations(st).size, 0);
    appendMigration(st, 'config:axes.docs');
    appendMigration(st, 'config:axes.docs');           // 重复 append 幂等
    appendMigration(st, 'resident:install');
    const s = readMigrations(st);
    assert.deepEqual([...s].sort(), ['config:axes.docs', 'resident:install']);
  } finally { rmSync(st, { recursive: true, force: true }); }
});

test('alignShell: 目标缺 → installed；内容同 → 零动作；stale → refreshed；引擎缺文件 → 跳过', () => {
  const eng = tmp(); const lore = tmp();
  try {
    writeFileSync(join(eng, 'index.html'), '<html>v2</html>');
    writeFileSync(join(eng, 'shell.mjs'), 'export const v = 2;');
    // mermaid.min.js 故意不建 → 跳过不抛
    const a1 = alignShell(eng, lore);
    assert.deepEqual(a1.map(x => x.action), ['installed', 'installed']);
    assert.equal(readFileSync(join(lore, 'site', 'shell.mjs'), 'utf8'), 'export const v = 2;');
    assert.deepEqual(alignShell(eng, lore), []);        // 幂等
    writeFileSync(join(lore, 'site', 'shell.mjs'), 'export const v = 1;');   // stale
    const a2 = alignShell(eng, lore);
    assert.deepEqual(a2, [{ asset: 'shell:shell.mjs', action: 'refreshed' }]);
    assert.equal(readFileSync(join(lore, 'site', 'shell.mjs'), 'utf8'), 'export const v = 2;');
  } finally { rmSync(eng, { recursive: true, force: true }); rmSync(lore, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/migrate.test.js`
Expected: FAIL —— `Cannot find module '.../lib/migrate.js'`

- [ ] **Step 3: Write minimal implementation**（用 Write 工具创建 `lib/migrate.js`）

```js
// lib/migrate.js —— 期望态对齐器（spec 2026-06-11-lore-migrate-design）。
// 引擎升级后 repo 内资产自动收敛：收敛型「算期望→比实际→不同才写」；
// 一次性迁移记 .state/migrations.json（applied 后用户删除不复活——用户主权）。
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- 一次性迁移记录（best-effort：读坏 → 空，同 syncstate 风格） ----------
export function readMigrations(stateDir) {
  try {
    const j = JSON.parse(readFileSync(join(stateDir, 'migrations.json'), 'utf8'));
    return new Set(Array.isArray(j.applied) ? j.applied : []);
  } catch { return new Set(); }
}

export function appendMigration(stateDir, id) {
  const s = readMigrations(stateDir);
  s.add(id);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'migrations.json'), JSON.stringify({ applied: [...s] }, null, 2) + '\n');
}

// ---------- 壳（收敛型）：引擎 site/ 是期望源；.lore/site/ 是引擎领地，手改会被覆盖 ----------
export const SHELL_FILES = ['index.html', 'shell.mjs', 'mermaid.min.js'];

export function alignShell(engineSiteDir, loreDir) {
  const dest = join(loreDir, 'site');
  mkdirSync(dest, { recursive: true });
  const actions = [];
  for (const f of SHELL_FILES) {
    const src = join(engineSiteDir, f);
    if (!existsSync(src)) continue;                    // 引擎缺该文件（如测试夹具）→ 跳过
    const dst = join(dest, f);
    const want = readFileSync(src);
    const had = existsSync(dst);
    if (had && want.equals(readFileSync(dst))) continue;
    copyFileSync(src, dst);
    actions.push({ asset: `shell:${f}`, action: had ? 'refreshed' : 'installed' });
  }
  return actions;
}

// ---------- 总入口（后续任务逐个挂资产；单资产失败不挡其他） ----------
export function alignAssets(repoRoot, loreDir, opts = {}) {
  const engineSiteDir = opts.engineSiteDir ?? join(HERE, '..', 'site');
  const actions = [];
  const guard = (name, fn) => {
    try { actions.push(...fn()); }
    catch { actions.push({ asset: name, action: 'error' }); }
  };
  guard('shell', () => alignShell(engineSiteDir, loreDir));
  return actions;
}

export function formatActions(actions) {
  return actions.map(a => `${a.asset}:${a.action}`).join(', ');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(process.argv[2] ?? process.cwd());
  const loreDir = join(repoRoot, '.lore');
  if (!existsSync(loreDir)) {
    console.error(`no .lore at ${repoRoot} — run /lore:init first`);
    process.exit(1);
  }
  const actions = alignAssets(repoRoot, loreDir);
  if (actions.length) console.log('migrate: ' + formatActions(actions));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/migrate.test.js`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add lib/migrate.js test/migrate.test.js
git commit -m "feat(migrate): expected-state aligner skeleton — migrations record + shell align + CLI

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: hook stub 对齐（含 MARKER 才动；foreign 永不碰）

`installHook` 的 git 查询/MARKER 逻辑整体挪进 migrate.js（避免 init→migrate 循环依赖：migrate 不 import init）；`init.js` 的 `installHook` 变 thin wrapper 保持旧返回值字串，既有 init.test 不破。

**Files:**
- Modify: `lib/migrate.js`（加 HOOK_MARKER/renderHookStub/alignHookStub；alignAssets 挂上）
- Modify: `lib/init.js`（installHook 改 wrapper，删除原实现）
- Test: `test/migrate.test.js` 追加

- [ ] **Step 1: Write the failing test**（Edit 追加到 `test/migrate.test.js`；import 行加 `alignHookStub, renderHookStub, HOOK_MARKER`，并加 `import { execFileSync } from 'node:child_process';`）

```js
test('alignHookStub: absent → installed；老内容含 MARKER → refreshed；一致 → present；foreign → foreign 不碰', () => {
  const root = tmp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const r1 = alignHookStub(root, 'D:/engine/lib/hook.js', 'journal:\n  hook: true\n');
    assert.equal(r1.status, 'installed');
    const hookPath = join(root, '.git', 'hooks', 'post-commit');
    assert.match(readFileSync(hookPath, 'utf8'), /D:\/engine\/lib\/hook\.js/);
    assert.equal(alignHookStub(root, 'D:/engine/lib/hook.js', '').status, 'present');     // 幂等
    const r2 = alignHookStub(root, 'D:/engine2/lib/hook.js', '');                          // 引擎挪位置
    assert.equal(r2.status, 'refreshed');
    assert.match(readFileSync(hookPath, 'utf8'), /D:\/engine2\/lib\/hook\.js/);
    writeFileSync(hookPath, '#!/bin/sh\necho mine\n');                                     // foreign
    assert.equal(alignHookStub(root, 'D:/engine/lib/hook.js', '').status, 'foreign');
    assert.match(readFileSync(hookPath, 'utf8'), /echo mine/);                             // 未被碰
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('alignHookStub: journal hook:false → disabled 不装；非 git 目录 → no-git', () => {
  const root = tmp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    assert.equal(alignHookStub(root, 'D:/e/hook.js', 'journal:\n  hook: false\n').status, 'disabled');
    assert.equal(existsSync(join(root, '.git', 'hooks', 'post-commit')), false);
    const plain = tmp();
    try { assert.equal(alignHookStub(plain, 'D:/e/hook.js', '').status, 'no-git'); }
    finally { rmSync(plain, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/migrate.test.js`
Expected: FAIL —— `alignHookStub is not a function`（SyntaxError: 命名导出不存在）

- [ ] **Step 3: Write minimal implementation**（Edit `lib/migrate.js`，加在 alignShell 之后；alignAssets 里 shell 之后挂一段）

```js
// ---------- hook stub（收敛型）：含 lore MARKER 才动；foreign 永不碰 ----------
export const HOOK_MARKER = '# lore:post-commit';

export function renderHookStub(hookJsPath) {
  const p = hookJsPath.replace(/\\/g, '/');            // forward-slash: sh-safe on Windows
  return `#!/bin/sh\n${HOOK_MARKER} (auto-generated by /lore:init)\nnode "${p}" "$(git rev-parse --show-toplevel)" >/dev/null 2>&1 || true\n`;
}

// 返回 {status}: installed|refreshed|present|foreign|hookspath-set|no-git|disabled
export function alignHookStub(repoRoot, hookJsPath, configText = '') {
  if (/^\s*hook:\s*false\b/m.test(configText)) return { status: 'disabled' };
  let gitCommonDir = '';
  try {
    gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot, windowsHide: true })
      .toString().trim();
  } catch { return { status: 'no-git' }; }
  let hooksPath = '';
  try {
    hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: repoRoot, windowsHide: true })
      .toString().trim();
  } catch { /* unset → empty */ }
  const defaultHooks = resolve(resolve(repoRoot, gitCommonDir), 'hooks');
  if (hooksPath && resolve(repoRoot, hooksPath) !== defaultHooks) return { status: 'hookspath-set' };
  const hookPath = join(defaultHooks, 'post-commit');
  const want = renderHookStub(hookJsPath);
  if (existsSync(hookPath)) {
    const cur = readFileSync(hookPath, 'utf8');
    if (!cur.includes(HOOK_MARKER)) return { status: 'foreign' };
    if (cur === want) return { status: 'present' };
    writeFileSync(hookPath, want);
    try { chmodSync(hookPath, 0o755); } catch { /* Windows ignores */ }
    return { status: 'refreshed' };
  }
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, want);
  try { chmodSync(hookPath, 0o755); } catch { /* Windows ignores */ }
  return { status: 'installed' };
}
```

alignAssets 的 guard('shell', ...) 之后加：

```js
  const hookJsPath = opts.hookJsPath ?? join(HERE, 'hook.js');
  const cfgPath = join(loreDir, 'config.yml');
  const cfgText = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
  guard('hook-stub', () => {
    const { status } = alignHookStub(repoRoot, hookJsPath, cfgText);
    return (status === 'installed' || status === 'refreshed') ? [{ asset: 'hook-stub', action: status }] : [];
  });
```

`lib/init.js`：删除 `installHook` 原实现与 `HOOK_MARKER` 常量，改为（顶部加 `import { alignHookStub } from './migrate.js';`）：

```js
// hook 安装/刷新逻辑在 migrate.js（期望态对齐器）；这里保旧返回值字串兼容。
export function installHook(repoRoot) {
  const here = dirname(fileURLToPath(import.meta.url));
  const cfgPath = join(repoRoot, '.lore', 'config.yml');
  const cfgText = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
  const { status } = alignHookStub(repoRoot, join(here, 'hook.js'), cfgText);
  return { foreign: 'exists-foreign' }[status] ?? status;
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/migrate.test.js test/init.test.js`
Expected: PASS（migrate 4 tests；init.test 的 installHook 系列全绿——absent→installed、二跑→present、foreign→exists-foreign、hookspath/no-git 语义不变）

- [ ] **Step 5: Commit**

```bash
git add lib/migrate.js lib/init.js test/migrate.test.js
git commit -m "feat(migrate): hook stub align (MARKER-gated refresh) — fixes stale-stub-never-updates

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: resident 资产纳入 —— CLAUDE.md 节 + .mcp.json（收敛 refresh + `resident:install` 一次性）

**Files:**
- Modify: `lib/migrate.js`（alignResidentAssets；alignAssets 挂上）
- Test: `test/migrate.test.js` 追加

- [ ] **Step 1: Write the failing test**（Edit 追加；import 行加 `alignResidentAssets`）

```js
test('alignResidentAssets: 首装两资产+记 resident:install；删除后 applied → 不复活；老路径条目 → refreshed', () => {
  const root = tmp();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, '.state'), { recursive: true });
    const applied = new Set();
    const rec = id => applied.add(id);
    // 首装：CLAUDE.md 节 + .mcp.json lore 条目都缺 → 都装 + 记
    const a1 = alignResidentAssets(root, lore, 'D:/engine/lib/mcp.js', applied, rec);
    assert.ok(a1.some(x => x.asset === 'claude-md' && x.action === 'installed'));
    assert.ok(a1.some(x => x.asset === 'mcp-json' && x.action === 'installed'));
    assert.ok(applied.has('resident:install'));
    assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /LORE_RESIDENT:START/);
    // 幂等：再跑零动作（节在 → refresh 无内容变化；条目在且路径同 → 不动）
    assert.deepEqual(alignResidentAssets(root, lore, 'D:/engine/lib/mcp.js', applied, rec), []);
    // 引擎挪位置 → mcp-json refreshed
    const a2 = alignResidentAssets(root, lore, 'D:/engine2/lib/mcp.js', applied, rec);
    assert.deepEqual(a2, [{ asset: 'mcp-json', action: 'refreshed' }]);
    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    assert.deepEqual(mcp.mcpServers.lore.args, ['D:/engine2/lib/mcp.js']);
    // 用户删节 + 删条目，applied 已记 → 不复活
    rmSync(join(root, 'CLAUDE.md'));
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    assert.deepEqual(alignResidentAssets(root, lore, 'D:/engine2/lib/mcp.js', applied, rec), []);
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('alignResidentAssets: CLAUDE.md 节文案/stats 过期 → refreshed（节在就刷）', () => {
  const root = tmp();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    const applied = new Set(['resident:install']);
    writeFileSync(join(root, 'CLAUDE.md'),
      '<!-- LORE_RESIDENT:START -->\nold body\n<!-- LORE_RESIDENT:END -->\n');
    const a = alignResidentAssets(root, lore, 'D:/e/mcp.js', applied, () => {});
    assert.ok(a.some(x => x.asset === 'claude-md' && x.action === 'refreshed'));
    assert.doesNotMatch(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /old body/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/migrate.test.js`
Expected: FAIL —— `alignResidentAssets is not a function`

- [ ] **Step 3: Write minimal implementation**（Edit `lib/migrate.js`；顶部加 `import { installResident, refreshResident, residentStats, mergeMcpConfig } from './resident.js';` 与 `import { parseConfigResident } from './config.js';`）

```js
// ---------- resident 资产：CLAUDE.md 节 + .mcp.json lore 条目 ----------
// 已存在 → 收敛 refresh；缺失 → resident:install 一次性首装（applied 后用户删除不复活）。
export function alignResidentAssets(repoRoot, loreDir, mcpJsPath, applied, recordFn) {
  const actions = [];
  const stats = residentStats(loreDir);
  const claudePath = join(repoRoot, 'CLAUDE.md');
  const mcpPath = join(repoRoot, '.mcp.json');
  const hasSection = existsSync(claudePath) && /<!--\s*LORE_RESIDENT:START\s*-->/.test(readFileSync(claudePath, 'utf8'));
  let mcpCfg = null;
  if (existsSync(mcpPath)) { try { mcpCfg = JSON.parse(readFileSync(mcpPath, 'utf8')); } catch { mcpCfg = null; } }
  const loreEntry = mcpCfg?.mcpServers?.lore;
  const firstInstall = (!hasSection || !loreEntry) && !applied.has('resident:install');

  // CLAUDE.md 节：在 → 刷（变了才报）；缺且首装 → install
  if (hasSection) {
    const before = readFileSync(claudePath, 'utf8');
    refreshResident(repoRoot, stats);
    if (readFileSync(claudePath, 'utf8') !== before) actions.push({ asset: 'claude-md', action: 'refreshed' });
  } else if (firstInstall) {
    installResident(repoRoot, stats);
    actions.push({ asset: 'claude-md', action: 'installed' });
  }

  // .mcp.json lore 条目：在 → 路径过期才刷；缺且首装 → 创建
  const wantEntry = { command: 'node', args: [mcpJsPath] };
  if (loreEntry) {
    if (JSON.stringify(loreEntry) !== JSON.stringify(wantEntry)) {
      mergeMcpConfig(repoRoot, mcpJsPath);
      actions.push({ asset: 'mcp-json', action: 'refreshed' });
    }
  } else if (firstInstall) {
    mergeMcpConfig(repoRoot, mcpJsPath);
    actions.push({ asset: 'mcp-json', action: 'installed' });
  }

  if (firstInstall) recordFn('resident:install');
  return actions;
}
```

alignAssets 里 hook-stub 段之后挂（`stateDir`、`applied`、`record` 在函数开头一并定义）：

```js
  const stateDir = join(loreDir, '.state');
  const applied = readMigrations(stateDir);
  const record = id => { appendMigration(stateDir, id); applied.add(id); };
  const mcpJsPath = opts.mcpJsPath ?? join(HERE, 'mcp.js');
  if (parseConfigResident(cfgText)) {
    guard('resident', () => alignResidentAssets(repoRoot, loreDir, mcpJsPath, applied, record));
  }
```

（注意 `stateDir/applied/record` 放 alignAssets 顶部，cfgText 已在 T2 定义——后续任务共用。）

- [ ] **Step 4: Run tests**

Run: `node --test test/migrate.test.js test/resident.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/migrate.js test/migrate.test.js
git commit -m "feat(migrate): resident assets — converge refresh + one-shot resident:install

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: config 补缺块（CONFIG_BLOCKS + 锚定插入 + renderConfigYaml 拼装）

模板单一真源：CONFIG_BLOCKS 在 migrate.js，`renderConfigYaml` 从块拼装（init→migrate 单向依赖）。

**Files:**
- Modify: `lib/migrate.js`（CONFIG_BLOCKS、sliceAxesBlock、alignConfig；alignAssets 挂上）
- Modify: `lib/init.js`（renderConfigYaml 拼装）
- Test: `test/migrate.test.js` 追加

- [ ] **Step 1: Write the failing test**（Edit 追加；import 行加 `alignConfig, CONFIG_BLOCKS`，并 `import { renderConfigYaml } from '../lib/init.js';`）

```js
const OLD_CONFIG = `# old config
axes:
  component:
    discover: auto
    code_roots: [src]
`;

test('alignConfig: 老 config 补全缺失块 —— 顶层 append + axes 二级锚定插入；已有行逐字节不变', () => {
  const lore = tmp();
  try {
    writeFileSync(join(lore, 'config.yml'), OLD_CONFIG);
    const applied = new Set(); const rec = id => applied.add(id);
    const actions = alignConfig(lore, applied, rec);
    const text = readFileSync(join(lore, 'config.yml'), 'utf8');
    assert.ok(text.startsWith(OLD_CONFIG.trimEnd()));                  // 已有行原样开头
    assert.match(text, /^language:/m);                                  // 顶层补上
    assert.match(text, /^journal:/m);
    assert.match(text, /^# resident: true/m);                           // 可发现性注释块
    assert.match(text, /^  docs:/m);                                    // axes 二级补上
    assert.match(text, /^  flow:/m);
    assert.match(text, /^  theme:/m);
    // 二级块插在 axes 块内（component 之后、下一个顶层键之前）
    assert.ok(text.indexOf('  docs:') > text.indexOf('  component:'));
    assert.ok(applied.has('config:axes.docs') && applied.has('config:language'));
    assert.ok(actions.length >= 6);
    // 幂等：再跑零动作
    assert.deepEqual(alignConfig(lore, applied, rec), []);
  } finally { rmSync(lore, { recursive: true, force: true }); }
});

test('alignConfig: 删块且 applied → 不复活；fresh 模板 → 零动作；axes 锚缺 → 二级 skip 不记；无 config → 零动作', () => {
  const lore = tmp();
  try {
    // fresh 模板零动作（renderConfigYaml 含全部块）
    writeFileSync(join(lore, 'config.yml'), renderConfigYaml(['lib']));
    assert.deepEqual(alignConfig(lore, new Set(), () => {}), []);
    // 删块 + applied → 不复活
    writeFileSync(join(lore, 'config.yml'), OLD_CONFIG);
    const applied = new Set(CONFIG_BLOCKS.map(b => b.id));
    assert.deepEqual(alignConfig(lore, applied, () => {}), []);
    assert.doesNotMatch(readFileSync(join(lore, 'config.yml'), 'utf8'), /^language:/m);
    // axes 锚缺 → 二级 skip 且不记 applied
    writeFileSync(join(lore, 'config.yml'), '# bare\n');
    const ap2 = new Set(); const recd = [];
    alignConfig(lore, ap2, id => { ap2.add(id); recd.push(id); });
    assert.ok(!recd.includes('config:axes.docs'));                      // 二级没记
    assert.ok(recd.includes('config:language'));                        // 顶层照补
    // 无 config.yml → 不是迁移场景
    const lore2 = tmp();
    try { assert.deepEqual(alignConfig(lore2, new Set(), () => {}), []); }
    finally { rmSync(lore2, { recursive: true, force: true }); }
  } finally { rmSync(lore, { recursive: true, force: true }); }
});

test('alignConfig: CRLF config 保持行尾风格，已有行不变', () => {
  const lore = tmp();
  try {
    const crlf = OLD_CONFIG.replace(/\n/g, '\r\n');
    writeFileSync(join(lore, 'config.yml'), crlf);
    alignConfig(lore, new Set(), () => {});
    const text = readFileSync(join(lore, 'config.yml'), 'utf8');
    assert.ok(text.startsWith(crlf.trimEnd()));
    assert.equal(text.split('\r\n').length > 10, true);                 // 新增行也是 CRLF
    assert.doesNotMatch(text, /[^\r]\n  docs:/);                        // 无孤 LF 行
  } finally { rmSync(lore, { recursive: true, force: true }); }
});

test('renderConfigYaml: 从 CONFIG_BLOCKS 拼装 —— 含全部块 + 动态 code_roots/sample', () => {
  const yaml = renderConfigYaml(['m1', 'm2']);
  assert.match(yaml, /code_roots: \[m1, m2\]/);
  assert.match(yaml, /spans: \[m1\]/);                                  // sample 注入 flow 示例
  for (const b of CONFIG_BLOCKS) {
    const probe = b.key ? new RegExp(`^(#\\s*)?\\s*${b.key}:`, 'm') : /^# resident: true/m;
    assert.match(yaml, probe, `block ${b.id} missing from template`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/migrate.test.js`
Expected: FAIL —— `alignConfig is not a function`

- [ ] **Step 3: Write implementation**

（Edit `lib/migrate.js`，加在 alignResidentAssets 之后。）

```js
// ---------- config 补缺块（一次性 per block）：已有行永不改一个字 ----------
// template 中 <component> 为示例组件占位，插入/拼装时替换。
export const CONFIG_BLOCKS = [
  {
    id: 'config:language', level: 'top', key: 'language',
    detectRe: /^language:/m,
    template: `language:                    # wiki 语言（人读首页 + 双语 sidecar）
  default: en                # repo 主语言（改成 zh 则中文为主）
  available: [en]            # 已就绪语言；加 zh 启用中英双语翻译页`,
  },
  {
    id: 'config:axes.flow', level: 'axes', key: 'flow',
    detectRe: /^\s*flow:/m,
    template: `  flow:                      # 声明轴 — "数据怎么端到端跑"（示例，按需填）
    values: []
    # - { id: article-pipeline, spans: [<component>] }`,
  },
  {
    id: 'config:axes.theme', level: 'axes', key: 'theme',
    detectRe: /^\s*theme:/m,
    template: `  theme:                     # 自定义横切轴 — "这条长期主线怎么演进"（示例，按需填）
    values: []
    # - { id: quality, desc: "质量保证", match: [质量, accuracy, 误报] }`,
  },
  {
    id: 'config:axes.docs', level: 'axes', key: 'docs',
    detectRe: /^\s*docs:/m,
    template: `  docs:                      # 文档轴 — 把 docs/ + CHANGELOG + CLAUDE.md 收进 wiki（机械、物化视图、零 LLM）
    # sources: [docs, changelog, claude_md_pitfalls]
    # docs_glob: docs/**/*.md`,
  },
  {
    id: 'config:journal', level: 'top', key: 'journal',
    detectRe: /^journal:/m,
    template: `journal:
  hook: true                 # post-commit hook 已装（每 commit 写 journal 骨架原子）
  mine: [commits, changelog, claude_md_pitfalls]`,
  },
  {
    id: 'config:resident-note', level: 'top', key: null,
    detectRe: /^#?\s*resident:/m,
    template: `# resident: true             # CLAUDE.md 注入 + .mcp.json 注册开关（false 关；详见 README agent 常驻）`,
  },
];

// axes: 块的范围：标题行 + 之后连续的「空行/缩进行」；0 缩进非空行（含注释）为界。
function sliceAxesBlock(lines) {
  const start = lines.findIndex(l => /^axes:\s*(#.*)?$/.test(l));
  if (start < 0) return null;
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;              // 块中空行：跳过但不收尾
    if (/^\s/.test(lines[i])) { end = i; continue; }
    break;
  }
  return { start, end };
}

export function alignConfig(loreDir, applied, recordFn) {
  const p = join(loreDir, 'config.yml');
  if (!existsSync(p)) return [];                       // 没 init 过 ≠ 迁移场景
  let text = readFileSync(p, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const sample = (parseConfigCodeRoots(text)[0] ?? 'module');
  const fill = t => t.replace('<component>', sample);
  const actions = [];

  for (const b of CONFIG_BLOCKS.filter(x => x.level === 'top')) {
    if (b.detectRe.test(text)) continue;
    if (applied.has(b.id)) continue;
    const sep = text.endsWith('\n') ? '' : eol;        // 不动已有尾部，只按需补换行
    text = text + sep + eol + fill(b.template).replace(/\n/g, eol) + eol;
    recordFn(b.id);
    actions.push({ asset: `config:+${b.key ?? 'resident-note'}`, action: 'appended' });
  }

  for (const b of CONFIG_BLOCKS.filter(x => x.level === 'axes')) {
    const lines = text.split(eol);
    const ax = sliceAxesBlock(lines);
    if (!ax) break;                                    // 锚缺 → 二级全 skip 且不记
    const body = lines.slice(ax.start + 1, ax.end + 1).join('\n');
    if (b.detectRe.test(body)) continue;
    if (applied.has(b.id)) continue;
    lines.splice(ax.end + 1, 0, ...fill(b.template).split('\n'));
    text = lines.join(eol);
    recordFn(b.id);
    actions.push({ asset: `config:+axes.${b.key}`, action: 'inserted' });
  }

  if (actions.length) writeFileSync(p, text);
  return actions;
}
```

migrate.js 顶部 import 加 `import { parseConfigResident, parseConfigCodeRoots } from './config.js';`（T3 已引 parseConfigResident，合并为一行）。

alignAssets 里 resident 段**之前**挂（config 先补，后续读 cfgText 的逻辑用新文本——注意：`cfgText` 在 T2 已读，config 补块后需重读一次给 resident gate 用；实际上 resident-note 是注释不影响 parseConfigResident 结果，但保持正确性重读）：

```js
  guard('config', () => alignConfig(loreDir, applied, record));
```

（放在 `const applied = ...` 之后、hook-stub 之前；hook-stub 与 resident 用的 `cfgText` 改为在 config 对齐后读取。）

（Edit `lib/init.js`：`renderConfigYaml` 改拼装，顶部 import 行并入 `CONFIG_BLOCKS`。）

```js
import { alignHookStub, alignAssets, CONFIG_BLOCKS } from './migrate.js';

const cfgBlock = id => CONFIG_BLOCKS.find(b => b.id === id).template;

export function renderConfigYaml(codeRoots) {
  const fmt = r => /^[A-Za-z0-9_./-]+$/.test(r) ? r : `'${r.replace(/'/g, "''")}'`;
  const roots = `[${codeRoots.map(fmt).join(', ')}]`;
  const sample = codeRoots[0] ?? 'module';
  const fill = t => t.replace('<component>', sample);
  return `# .lore/config.yml —— lore 引擎配置（唯一存放本 repo 特定信息处）
# component 由 /lore:init 自动发现。请按需改：重命名 / 分组 / 删 / 增。
${cfgBlock('config:language')}

axes:
  component:                 # 内置轴 + 自动发现
    discover: auto
    code_roots: ${roots}
${fill(cfgBlock('config:axes.flow'))}
${fill(cfgBlock('config:axes.theme'))}
${cfgBlock('config:axes.docs')}
${cfgBlock('config:journal')}
${cfgBlock('config:resident-note')}
`;
}
```

（alignAssets 的 import 此时尚未在 init.js 使用——T6 接线；先一并引入无害。）

- [ ] **Step 4: Run tests**

Run: `node --test test/migrate.test.js test/init.test.js`
Expected: PASS（init.test 的 renderConfigYaml 测试断言 `code_roots: [m1, m2]` 与 flow/theme 注释——拼装后内容兼容；若有逐字断言失配，按新模板更新该断言）

- [ ] **Step 5: Commit**

```bash
git add lib/migrate.js lib/init.js test/migrate.test.js
git commit -m "feat(migrate): config gap-fill — CONFIG_BLOCKS single source, anchored insert, byte-safe

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: gitignore 多行补缺 + gitattributes union（一次性，facts-only 边界）

**Files:**
- Modify: `lib/migrate.js`（GITIGNORE_LINES/alignGitignore/alignGitattributes；alignAssets 挂上）
- Modify: `lib/init.js`（ensureGitignore 变 wrapper）
- Modify: `test/init.test.js`（gitignore 断言扩为三行）
- Test: `test/migrate.test.js` 追加

- [ ] **Step 1: Write the failing test**（Edit 追加；import 行加 `alignGitignore, alignGitattributes, GITIGNORE_LINES`）

```js
test('alignGitignore: 三行补缺 + 已有行保留 + 幂等 + 删行 applied 不复活', () => {
  const root = tmp();
  try {
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.lore/.state/\n');
    const applied = new Set(); const rec = id => applied.add(id);
    const a1 = alignGitignore(root, applied, rec);
    assert.equal(a1.length, 2);                                          // wiki + site（.state 已在）
    const txt = readFileSync(join(root, '.gitignore'), 'utf8');
    assert.match(txt, /^node_modules\/$/m);                              // 已有行保留
    for (const l of GITIGNORE_LINES) assert.ok(txt.split(/\r?\n/).some(x => x.trim() === l));
    assert.deepEqual(alignGitignore(root, applied, rec), []);            // 幂等
    // 用户删 wiki 行 → applied → 不复活
    writeFileSync(join(root, '.gitignore'), txt.split('\n').filter(l => l !== '.lore/wiki/').join('\n'));
    assert.deepEqual(alignGitignore(root, applied, rec), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('alignGitattributes: 缺文件创建 / 已有追加 / 幂等 / 删行 applied 不复活', () => {
  const root = tmp();
  try {
    const applied = new Set(); const rec = id => applied.add(id);
    const a1 = alignGitattributes(root, applied, rec);
    assert.deepEqual(a1, [{ asset: 'gitattributes', action: 'appended' }]);
    assert.match(readFileSync(join(root, '.gitattributes'), 'utf8'), /journal\/\*\*\/\*\.ndjson merge=union/);
    assert.deepEqual(alignGitattributes(root, applied, rec), []);
    writeFileSync(join(root, '.gitattributes'), '# emptied\n');
    assert.deepEqual(alignGitattributes(root, applied, rec), []);        // 不复活
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/migrate.test.js`
Expected: FAIL —— `alignGitignore is not a function`

- [ ] **Step 3: Write implementation**（Edit `lib/migrate.js`）

```js
// ---------- git 边界（facts-only）：wiki/site 出库，journal/config 进库 ----------
export const GITIGNORE_LINES = ['.lore/.state/', '.lore/wiki/', '.lore/site/'];
const GITATTR_LINE = '.lore/journal/**/*.ndjson merge=union';

function appendLines(filePath, missing) {
  const exists = existsSync(filePath);
  const cur = exists ? readFileSync(filePath, 'utf8') : '';
  const sep = cur === '' || cur.endsWith('\n') ? '' : '\n';
  writeFileSync(filePath, cur + sep + missing.join('\n') + '\n');
}

export function alignGitignore(repoRoot, applied, recordFn) {
  const p = join(repoRoot, '.gitignore');
  const have = existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).map(l => l.trim()) : [];
  const todo = GITIGNORE_LINES.filter(l => !have.includes(l) && !applied.has(`gitignore:${l}`));
  if (!todo.length) return [];
  appendLines(p, todo);
  for (const l of todo) recordFn(`gitignore:${l}`);
  return todo.map(l => ({ asset: `gitignore:${l}`, action: 'appended' }));
}

export function alignGitattributes(repoRoot, applied, recordFn) {
  const id = 'gitattributes:journal-union';
  const p = join(repoRoot, '.gitattributes');
  const have = existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).map(l => l.trim()) : [];
  if (have.includes(GITATTR_LINE) || applied.has(id)) return [];
  appendLines(p, [GITATTR_LINE]);
  recordFn(id);
  return [{ asset: 'gitattributes', action: 'appended' }];
}
```

alignAssets 里 config 段之后挂：

```js
  guard('gitignore', () => alignGitignore(repoRoot, applied, record));
  guard('gitattributes', () => alignGitattributes(repoRoot, applied, record));
```

（Edit `lib/init.js`：删除 ensureGitignore 原实现与 IGNORE_LINE，改 wrapper——既有 import 处加 `alignGitignore`）

```js
// gitignore 多行补缺在 migrate.js；保旧返回值字串兼容（created/appended/present）。
export function ensureGitignore(repoRoot) {
  const p = join(repoRoot, '.gitignore');
  const had = existsSync(p);
  const acted = alignGitignore(repoRoot, new Set(), () => {}).length > 0;
  return !had ? 'created' : acted ? 'appended' : 'present';
}
```

注意：init 路径走 ensureGitignore（传空 Set——init 场景无既往记录，行为=全补）；alignAssets 路径走带 applied 的 alignGitignore。两者幂等可叠加。

（Edit `test/init.test.js` gitignore 断言：原「单行 `.lore/.state/`」断言改为三行齐备 + 幂等不重复；具体把 `assert.match(..., /^\.lore\/\.state\/$/m)` 类断言改成循环三行 `['.lore/.state/', '.lore/wiki/', '.lore/site/']` 逐行 `assert.ok(txt.split(/\r?\n/).some(x => x.trim() === l))`，重复检测断言同步改。）

- [ ] **Step 4: Run tests**

Run: `node --test test/migrate.test.js test/init.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/migrate.js lib/init.js test/init.test.js test/migrate.test.js
git commit -m "feat(migrate): facts-only git boundary — 3-line gitignore + journal merge=union, one-shot

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 接线 —— alignAssets 全资产集成 + finalize/init 入口

**Files:**
- Modify: `lib/migrate.js`（alignAssets 最终形态核对）
- Modify: `lib/sync.js`（finalize 末尾）
- Modify: `lib/init.js`（init() 用 alignAssets，copyShell 变 wrapper）
- Test: `test/migrate.test.js` 追加

- [ ] **Step 1: Write the failing test**（Edit 追加；import 加 `alignAssets`；顶部加 `import { finalizeSync } from '../lib/sync.js';` 与 `import { init } from '../lib/init.js';`——resident.test 已有 init 集成先例）

```js
test('alignAssets 集成: 全新 git repo 一把对齐全部资产；再跑零动作', () => {
  const root = tmp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const eng = tmp();
    try {
      writeFileSync(join(eng, 'index.html'), '<html/>');
      writeFileSync(join(eng, 'shell.mjs'), 'export const v = 1;');
      writeFileSync(join(eng, 'mermaid.min.js'), '// m');
      const lore = join(root, '.lore');
      mkdirSync(lore, { recursive: true });
      writeFileSync(join(lore, 'config.yml'), OLD_CONFIG);            // 老 config
      const a1 = alignAssets(root, lore, { engineSiteDir: eng, hookJsPath: 'D:/e/hook.js', mcpJsPath: 'D:/e/mcp.js' });
      const assets = a1.map(x => x.asset);
      assert.ok(assets.some(x => x.startsWith('shell:')));
      assert.ok(assets.includes('hook-stub'));
      assert.ok(assets.some(x => x.startsWith('config:+')));
      assert.ok(assets.some(x => x.startsWith('gitignore:')));
      assert.ok(assets.includes('gitattributes'));
      assert.ok(assets.includes('claude-md') && assets.includes('mcp-json'));
      assert.ok(!a1.some(x => x.action === 'error'));
      assert.deepEqual(alignAssets(root, lore, { engineSiteDir: eng, hookJsPath: 'D:/e/hook.js', mcpJsPath: 'D:/e/mcp.js' }), []);
    } finally { rmSync(eng, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('alignAssets: resident:false config → 不装 CLAUDE.md/.mcp.json，其余照常', () => {
  const root = tmp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    writeFileSync(join(lore, 'config.yml'), 'resident: false\n' + OLD_CONFIG);
    const eng = tmp();
    try {
      writeFileSync(join(eng, 'index.html'), '<html/>');
      const a = alignAssets(root, lore, { engineSiteDir: eng, hookJsPath: 'D:/e/hook.js', mcpJsPath: 'D:/e/mcp.js' });
      assert.ok(!a.some(x => x.asset === 'claude-md' || x.asset === 'mcp-json'));
      assert.equal(existsSync(join(root, 'CLAUDE.md')), false);
      assert.ok(a.some(x => x.asset.startsWith('gitignore:')));
    } finally { rmSync(eng, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('finalizeSync: 返回 migrate 动作数组，migrate 异常不挡 finalize', () => {
  const root = tmp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const lore = join(root, '.lore');
    for (const d of ['journal', 'wiki', '.state']) mkdirSync(join(lore, d), { recursive: true });
    writeFileSync(join(lore, 'config.yml'), renderConfigYaml(['lib']));
    const r = finalizeSync(lore, '2026-06-11T00:00:00Z');
    assert.ok(Array.isArray(r.migrate));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/migrate.test.js`
Expected: FAIL —— finalizeSync 返回值无 `migrate` 字段（`r.migrate` undefined）；alignAssets 集成项若 T2-T5 挂载顺序有遗漏在此暴露

- [ ] **Step 3: Wire up**

（Edit `lib/migrate.js`——核对 alignAssets 最终形态为下面的完整函数，T2-T5 的散段统一成这个；cfgText 在 config 对齐后重读）

```js
export function alignAssets(repoRoot, loreDir, opts = {}) {
  const engineSiteDir = opts.engineSiteDir ?? join(HERE, '..', 'site');
  const hookJsPath = opts.hookJsPath ?? join(HERE, 'hook.js');
  const mcpJsPath = opts.mcpJsPath ?? join(HERE, 'mcp.js');
  const stateDir = join(loreDir, '.state');
  const applied = readMigrations(stateDir);
  const record = id => { appendMigration(stateDir, id); applied.add(id); };
  const actions = [];
  const guard = (name, fn) => {
    try { actions.push(...fn()); }
    catch { actions.push({ asset: name, action: 'error' }); }
  };

  guard('config', () => alignConfig(loreDir, applied, record));
  const cfgPath = join(loreDir, 'config.yml');
  const cfgText = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';

  guard('gitignore', () => alignGitignore(repoRoot, applied, record));
  guard('gitattributes', () => alignGitattributes(repoRoot, applied, record));
  guard('shell', () => alignShell(engineSiteDir, loreDir));
  guard('hook-stub', () => {
    const { status } = alignHookStub(repoRoot, hookJsPath, cfgText);
    return (status === 'installed' || status === 'refreshed') ? [{ asset: 'hook-stub', action: status }] : [];
  });
  if (parseConfigResident(cfgText)) {
    guard('resident', () => alignResidentAssets(repoRoot, loreDir, mcpJsPath, applied, record));
  }
  return actions;
}
```

（Edit `lib/sync.js`：finalize 尾部替换——import 行去掉 refreshResident/residentStats，改 `import { alignAssets } from './migrate.js';`）

```js
  // 期望态对齐：引擎升级后资产自动收敛（壳/hook stub/config 补缺/resident）。best-effort 不挡 finalize。
  let migrate = [];
  try { migrate = alignAssets(join(resolve(loreDir), '..'), resolve(loreDir)); } catch { /* 不挡 finalize */ }
  return { stamped, indexWritten: true, manifestPath, migrate };
```

CLI finalize 分支打印（`console.log('  manifest: ...')` 之后加）：

```js
    if (r.migrate.length) console.log('  migrate: ' + r.migrate.map(a => `${a.asset}:${a.action}`).join(', '));
```

（Edit `lib/init.js`：init() 重构——scaffold + config 首生成保留，其余资产全部走 alignAssets；copyShell 变 wrapper 保兼容）

```js
export function copyShell(srcSiteDir, loreDir) {
  alignShell(srcSiteDir, loreDir);
  return [...SHELL_FILES];
}

export function init({ repoRoot, srcSiteDir }) {
  const loreDir = join(repoRoot, '.lore');
  scaffold(loreDir);
  const codeRoots = discoverComponents(repoRoot);
  const configPath = join(loreDir, 'config.yml');
  let configWritten = false;
  if (!existsSync(configPath)) {
    writeFileSync(configPath, renderConfigYaml(codeRoots));
    configWritten = true;
  }
  const actions = alignAssets(repoRoot, loreDir, { engineSiteDir: srcSiteDir });
  const cfgText = readFileSync(configPath, 'utf8');
  return {
    loreDir, codeRoots, configWritten,
    copied: [...SHELL_FILES],
    gitignore: actions.some(a => a.asset.startsWith('gitignore:')) ? 'appended' : 'present',
    hook: actions.find(a => a.asset === 'hook-stub')?.action ?? 'present',
    resident: parseConfigResident(cfgText) && actions.some(a => a.asset === 'claude-md' || a.asset === 'mcp-json'),
    actions,
  };
}
```

init.js 的 import 收束为：`import { alignAssets, alignShell, alignHookStub, alignGitignore, SHELL_FILES, CONFIG_BLOCKS } from './migrate.js';`（installResident/mergeMcpConfig/residentStats 的直接调用已不需要，从 import 中移除；parseConfigResident 保留）。

- [ ] **Step 4: Run full suite**

Run: `node --test test/`
Expected: 全绿。重点回归：`test/init.test.js`（copyShell 返回值/installHook/gitignore）、`test/resident.test.js`（init 集成两案：默认装、resident:false 跳过——init 改走 alignAssets 后行为不变）、`test/sync.test.js`（finalizeSync 返回值多了 migrate 字段，既有断言不受影响）。

- [ ] **Step 5: Commit**

```bash
git add lib/migrate.js lib/sync.js lib/init.js test/migrate.test.js
git commit -m "feat(migrate): wire aligner into finalize + init + CLI — auto-migrate on every finalize

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: fresh-clone 引导 —— resident 节文案 + lore_ask 空 manifest 提示

**Files:**
- Modify: `lib/resident.js`（residentSection 补一行）
- Modify: `lib/mcp.js`（lore_ask handler 开头）
- Test: `test/resident.test.js`、`test/mcp.test.js` 各追加断言

- [ ] **Step 1: Write the failing tests**

（Edit `test/resident.test.js`——`residentSection` 测试加一行断言）

```js
  assert.match(s, /lore:sync/);          // fresh-clone 引导（wiki 不进库）
```

（Edit `test/mcp.test.js`——用文件内既有 `rpc(root, messages)` helper 追加）

```js
test('mcp: lore_ask 无 manifest（fresh clone）→ 返回 /lore:sync 引导', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-mcpempty-'));
  try {
    mkdirSync(join(root, '.lore', 'wiki'), { recursive: true });        // 有 wiki 目录、无 manifest
    const replies = await rpc(root, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lore_ask', arguments: { query: 'anything' } } },
    ]);
    const payload = JSON.parse(replies.find(r => r.id === 1).result.content[0].text);
    assert.match(payload.notice, /lore:sync/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run to verify fails**

Run: `node --test test/resident.test.js test/mcp.test.js`
Expected: FAIL（两处）

- [ ] **Step 3: Implement**

（Edit `lib/resident.js` residentSection——「无 MCP 时」行后插一行）

```
- wiki 缺失（fresh clone：wiki 不进库）→ 先跑 \`/lore:sync\` 合成
```

（Edit `lib/mcp.js`——`callTool` 的 `lore_ask` 分支开头加 manifest 存在性检查；`existsSync`/`join`/`wikiDir` 均已在 scope，返回的对象会走既有 `JSON.stringify(payload)` 封装）

```js
  if (name === 'lore_ask') {
    if (!existsSync(join(wikiDir, '.manifest.json'))) {
      return { notice: 'wiki 未构建（fresh clone 下 wiki 不进库）：先跑 /lore:sync 合成 wiki，再用本工具。' };
    }
```

- [ ] **Step 4: Run tests**

Run: `node --test test/resident.test.js test/mcp.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/resident.js lib/mcp.js test/resident.test.js test/mcp.test.js
git commit -m "feat(resident,mcp): fresh-clone guidance — wiki not in git, run /lore:sync first

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: dogfood 自迁移 + 文档 + 全量回归

**Files:**
- Modify: `.gitignore`、`.gitattributes`（由对齐器生成）、`docs/ROADMAP.md`、`CHANGELOG.md`
- 一次性: `git rm -r --cached .lore/wiki .lore/site`

- [ ] **Step 1: 本 repo 跑对齐器**

Run: `node lib/migrate.js .`
Expected: 输出含 `gitignore:.lore/wiki/`、`gitignore:.lore/site/`、`gitattributes`、`config:+resident-note` 四类动作（按本 repo 现状，已有项各自跳过）；壳/hook/resident 已是最新 → 无对应动作。再跑一次 → 零输出（幂等验证）。

- [ ] **Step 2: untrack 生成物**

```bash
git rm -r -q --cached .lore/wiki .lore/site
git status --short | head -20
```
Expected: `.lore/wiki/*`、`.lore/site/*` 全部 `D`（索引删除，工作区文件保留）；`.gitignore`/`.gitattributes`/`.lore/config.yml` 为 `M`/`A`。`git status` 不再出现 wiki 未跟踪噪音。

- [ ] **Step 3: 全量回归**

Run: `node --test test/`
Expected: 全绿（基线 394 + 本轮新增 ≈ 410+）。

- [ ] **Step 4: ROADMAP + CHANGELOG**

`docs/ROADMAP.md` 加（紧随 resident-mode 段落之后）：

```markdown
- ~~迁移机制~~ ✅ 已实现（2026-06-11，期望态对齐器）：`lib/migrate.js`——收敛型资产（壳/hook stub/.mcp.json/CLAUDE.md 节）每次 finalize「算期望→比实际→不同才写」；一次性迁移（config 补缺块/resident 首装/gitignore/gitattributes）记 `.state/migrations.json`，用户删除不复活。git 边界改 facts-only：wiki/site 出库（可再生），journal/config 进库（事实源），journal ndjson `merge=union` 终结多机冲突。设计见 docs/superpowers/specs/2026-06-11-lore-migrate-design.md。
```

`CHANGELOG.md` 加 v0.8.0 段：

```markdown
## v0.8.0 — 2026-06-11

- **自动迁移**：引擎升级后 repo 内资产随下次 finalize 自动收敛（壳/hook stub/.mcp.json/CLAUDE.md 节/config 补缺块），无需重跑 init；`node lib/migrate.js <repo>` 可手动触发。
- **facts-only git 边界**：`.lore/wiki/`、`.lore/site/` 不再进库（生成物，clone 后 `/lore:sync` 再生）；journal/config 保留进库；journal ndjson 启用 `merge=union`，多机各自 commit 不再冲突。
- hook stub 不再「装过就永不更新」——引擎路径/stub 文案变更自动刷新（含 lore 标记才动，foreign hook 永不碰）。
```

- [ ] **Step 5: Commit + push 按用户指令**

```bash
git add -A
git commit -m "chore(dogfood): self-migrate — untrack wiki/site, facts-only boundary live

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review 备忘（写完后已核）

- Spec 覆盖：收敛 4 资产（T1 壳/T2 stub/T3 resident 两件）、一次性 4 类（T4 config/T5 gitignore+gitattributes/T3 resident:install）、三入口（T1 CLI/T6 finalize+init）、fresh-clone 引导（T7）、dogfood 自迁移（T8）——spec 全节有任务对应。
- 类型一致：alignAssets 签名 `(repoRoot, loreDir, opts)`、opts 键 `engineSiteDir/hookJsPath/mcpJsPath` 全文统一；action 词表 `installed/refreshed/appended/inserted/error`。
- 既有测试回归点已逐文件列出（init.test 三处、resident.test、sync.test、mcp.test）。
