# 深度页模块消歧（deep source disambiguation）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** config 的 `deep.<root>` 条目可写 `<name>.<ext>`（如 `e2e_smoke.sh`）显式钉住源文件，消除同名不同扩展文件的歧义——页面不再静默冻结，lint 从「报歧义」升级为「报歧义 + 给出可操作钉法」。

**Architecture:** `lib/source.js` 新增纯语法判定 `parseDeepEntry(entry) → { id, explicit }`（页 id = 去代码扩展名的基名）；`resolveDeepSource` 双形态解析（显式精确命中 → ok；显式缺失 → missing + `expected`，**不回退裸名匹配**）；`resolveConfiguredDeep` 的 entries 增 `entry` 字段、`mod` 存规范化页 id，并加同 id 碰撞防呆（新 issue kind `deep-source-collision`，first-wins）。五个消费点（sync planSync / sync finalize staleScopes+componentOrder+pageGroups / lint legalIds / lint lintMissingMechanism）统一按基名归一化。`parseConfigDeep` 零改动（order 保留原文案）。

**Tech Stack:** Node.js ESM（node:test / assert/strict），零新依赖。

**Spec:** `docs/superpowers/specs/2026-08-03-deep-source-disambiguation-design.md`

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `lib/source.js` | `parseDeepEntry`（新）+ `resolveDeepSource` 显式分支 + `resolveConfiguredDeep` 归一化/碰撞 | Modify |
| `lib/lint.js` | `legalIds` / `lintMissingMechanism` 基名归一化；`lintDeepConfig` 消息可操作化 + 碰撞诊断 | Modify |
| `lib/sync.js` | `finalizeSync` 的 `componentOrder`/`pageGroups` 基名归一化（planSync 经 canonical mod 自动正确，不改） | Modify |
| `lib/init.js` | `renderDeepBlock` 注释补钉法提示 | Modify |
| `commands/sync.md` | 深度页段落补钉法语法说明 | Modify |
| `docs/DEFECT-deep-source-ambiguity.md` | 状态改为已设计 + 方案链接 | Modify |
| `test/source.test.js` | parseDeepEntry / 显式命中 / 显式缺失 / 碰撞 用例 | Modify |
| `test/lint.test.js` | 消息串更新 + 显式条目 legalIds / mechanism / 碰撞 用例 | Modify |
| `test/sync.test.js` | 显式钉住 planSync worklist / 缺失不回退 / finalize 排序与 group 基名 用例 | Modify |

测试命令（Git Bash，仓库根目录 `d:\workspace\lore` 下执行）：
- 单文件：`node --test test/source.test.js`
- 全量：`node --test test/*.test.js`（`serve.test.js` 全量并行下偶发 flake——已知坑，失败先重跑一次确认）

---

### Task 1: `lib/source.js` —— `parseDeepEntry` + `resolveDeepSource` 显式分支

**Files:**
- Modify: `lib/source.js:9-26`
- Test: `test/source.test.js`

- [ ] **Step 1: 写失败测试**（`test/source.test.js`）

把 import 行（第 6 行）改为：

```js
import { CODE_EXT, parseDeepEntry, resolveDeepSource } from '../lib/source.js';
```

在文件末尾（`resolveDeepSource reports sorted candidates...` 用例之后）追加 3 个用例：

```js
test('resolveDeepSource: explicit pin resolves the exact file among same-base siblings', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'e2e_smoke.py'), 'DRIVER = 1\n');
    writeFileSync(join(root, 'scripts', 'e2e_smoke.sh'), 'exec python e2e_smoke.py\n');
    assert.deepEqual(resolveDeepSource(root, 'scripts', 'e2e_smoke.sh'), {
      status: 'ok', sourceFile: 'scripts/e2e_smoke.sh',
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveDeepSource: explicit pin missing → missing with expected path (no bare fallback)', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'e2e_smoke.py'), 'DRIVER = 1\n');
    assert.deepEqual(resolveDeepSource(root, 'scripts', 'e2e_smoke.sh'), {
      status: 'missing', candidates: [], expected: 'scripts/e2e_smoke.sh',
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('parseDeepEntry: bare → identity, explicit file → base id, edge cases', () => {
  assert.deepEqual(parseDeepEntry('e2e_smoke'), { id: 'e2e_smoke', explicit: false });
  assert.deepEqual(parseDeepEntry('e2e_smoke.sh'), { id: 'e2e_smoke', explicit: true });
  assert.deepEqual(parseDeepEntry('e2e_smoke.py'), { id: 'e2e_smoke', explicit: true });
  assert.deepEqual(parseDeepEntry('sync.tsx'), { id: 'sync', explicit: true });
  assert.deepEqual(parseDeepEntry('a.b.js'), { id: 'a.b', explicit: true });
  assert.deepEqual(parseDeepEntry('.py'), { id: '.py', explicit: false });   // 全扩展名 → extname('') → 裸名
  assert.deepEqual(parseDeepEntry('e2e_smoke.PY'), { id: 'e2e_smoke.PY', explicit: false });  // 大写扩展名不在 CODE_EXT
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/source.test.js`
Expected: FAIL —— `parseDeepEntry is not defined`（3 个新用例失败；既有 3 个用例仍过）。

- [ ] **Step 3: 实现**（`lib/source.js`）

在 `resolveDeepSource` 上方新增：

```js
// 深度页条目的「显式/裸名」判定 + 页 id 推导（纯语法，不碰 fs）。
// 显式 = 条目带 CODE_EXT 里的扩展名（如 e2e_smoke.sh）→ 页 id 为去扩展名的基名；
// 裸名 = 其余（含全扩展名 .py、大写扩展名）→ id 即条目原文。
export function parseDeepEntry(entry) {
  const ext = extname(entry);
  const explicit = ext !== '' && CODE_EXT.has(ext);
  return { id: explicit ? entry.slice(0, entry.length - ext.length) : entry, explicit };
}
```

把 `resolveDeepSource`（第 9-26 行）整体替换为（注意：filter 回调参数从 `entry` 改名 `e`，避免与函数参数 `entry` 遮蔽）：

```js
export function resolveDeepSource(repoRoot, deepRoot, entry) {
  const absRoot = join(repoRoot, deepRoot);
  let entries = [];
  try { entries = readdirSync(absRoot, { withFileTypes: true }); } catch {}
  const { id, explicit } = parseDeepEntry(entry);
  if (explicit) {
    const hit = entries.find(e => e.isFile() && e.name === entry);
    if (hit) return { status: 'ok', sourceFile: relative(repoRoot, join(absRoot, hit.name)).replaceAll('\\', '/') };
    return { status: 'missing', candidates: [], expected: `${deepRoot}/${entry}` };
  }
  const candidates = entries
    .filter(e => {
      const ext = extname(e.name);
      return e.isFile()
        && CODE_EXT.has(ext)
        && e.name.slice(0, e.name.length - ext.length) === id;
    })
    .map(e => relative(repoRoot, join(absRoot, e.name)).replaceAll('\\', '/'))
    .sort();

  if (candidates.length === 1) return { status: 'ok', sourceFile: candidates[0] };
  if (candidates.length === 0) return { status: 'missing', candidates: [] };
  return { status: 'ambiguous', candidates };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/source.test.js`
Expected: PASS —— 6 个用例全绿（3 新 + 3 既有回归锚一字未动）。

- [ ] **Step 5: 提交**

```bash
git add lib/source.js test/source.test.js
git commit -m "feat(source): parseDeepEntry + explicit-file pin resolution in deep entries"
```

---

### Task 2: `lib/source.js` —— `resolveConfiguredDeep` 归一化 + 碰撞防呆

**Files:**
- Modify: `lib/source.js:72-87`
- Test: `test/source.test.js`

- [ ] **Step 1: 写失败测试**（`test/source.test.js`）

把 import 行改为：

```js
import { CODE_EXT, parseDeepEntry, resolveConfiguredDeep, resolveDeepSource } from '../lib/source.js';
```

追加 3 个用例：

```js
test('resolveConfiguredDeep: explicit pin → canonical mod + entry field, no issues', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'e2e_smoke.py'), 'DRIVER = 1\n');
    writeFileSync(join(root, 'scripts', 'e2e_smoke.sh'), 'exec python e2e_smoke.py\n');
    assert.deepEqual(resolveConfiguredDeep(root, ['scripts'], {
      scripts: { order: ['e2e_smoke.sh'], groups: [] },
    }), {
      entries: [{ deepRoot: 'scripts', entry: 'e2e_smoke.sh', mod: 'e2e_smoke', sourceFile: 'scripts/e2e_smoke.sh' }],
      issues: [],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveConfiguredDeep: bare + explicit same base file → collision issue, first wins', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'e2e_smoke.py'), 'DRIVER = 1\n');   // 只有这一个文件
    assert.deepEqual(resolveConfiguredDeep(root, ['scripts'], {
      scripts: { order: ['e2e_smoke', 'e2e_smoke.py'], groups: [] },
    }), {
      entries: [{ deepRoot: 'scripts', entry: 'e2e_smoke', mod: 'e2e_smoke', sourceFile: 'scripts/e2e_smoke.py' }],
      issues: [{ kind: 'deep-source-collision', deepRoot: 'scripts', mod: 'e2e_smoke', entry: 'e2e_smoke', conflictEntry: 'e2e_smoke.py' }],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveConfiguredDeep: two explicit pins same base → collision preserves both raw entries', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'e2e_smoke.py'), 'DRIVER = 1\n');
    writeFileSync(join(root, 'scripts', 'e2e_smoke.sh'), 'exec python e2e_smoke.py\n');
    assert.deepEqual(resolveConfiguredDeep(root, ['scripts'], {
      scripts: { order: ['e2e_smoke.py', 'e2e_smoke.sh'], groups: [] },
    }), {
      entries: [{ deepRoot: 'scripts', entry: 'e2e_smoke.py', mod: 'e2e_smoke', sourceFile: 'scripts/e2e_smoke.py' }],
      issues: [{ kind: 'deep-source-collision', deepRoot: 'scripts', mod: 'e2e_smoke', entry: 'e2e_smoke.py', conflictEntry: 'e2e_smoke.sh' }],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveConfiguredDeep: explicit missing → issue with explicit flag + expected', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'e2e_smoke.py'), 'DRIVER = 1\n');
    assert.deepEqual(resolveConfiguredDeep(root, ['scripts'], {
      scripts: { order: ['e2e_smoke.sh'], groups: [] },
    }), {
      entries: [],
      issues: [{ kind: 'deep-source-missing', deepRoot: 'scripts', mod: 'e2e_smoke.sh', explicit: true, expected: 'scripts/e2e_smoke.sh' }],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/source.test.js`
Expected: FAIL —— 3 个新用例断言不匹配（entries 缺 `entry` 字段 / mod 不是基名 / 无 collision kind）。

- [ ] **Step 3: 实现**（`lib/source.js:72-87`，`resolveConfiguredDeep` 整体替换）

```js
export function resolveConfiguredDeep(repoRoot, codeRoots, deep) {
  const entries = [], issues = [];
  for (const [deepRoot, { order = [] }] of Object.entries(deep)) {
    if (!validDeepRoot(repoRoot, deepRoot, codeRoots)) {
      issues.push({ kind: 'deep-root-invalid', deepRoot });
      continue;
    }
    const seen = new Map();                  // id → winner raw entry（碰撞时回填 winner 原文）
    for (const entry of order) {
      const { id } = parseDeepEntry(entry);
      const result = resolveDeepSource(repoRoot, deepRoot, entry);
      if (result.status === 'ok') {
        if (seen.has(id)) {
          issues.push({ kind: 'deep-source-collision', deepRoot, mod: id, entry: seen.get(id), conflictEntry: entry });
          continue;
        }
        seen.set(id, entry);
        entries.push({ deepRoot, entry, mod: id, sourceFile: result.sourceFile });
      } else if (result.status === 'missing') {
        if (result.expected) issues.push({ kind: 'deep-source-missing', deepRoot, mod: entry, explicit: true, expected: result.expected });
        else issues.push({ kind: 'deep-source-missing', deepRoot, mod: entry, expectedBase: `${deepRoot}/${entry}` });
      } else {
        issues.push({ kind: 'deep-source-ambiguous', deepRoot, mod: entry, candidates: result.candidates });
      }
    }
  }
  return { entries, issues };
}
```

**要点**：
- entries：`mod` = 规范化页 id（基名）；`entry` = config 原文案；`sourceFile` 不变。
- issues：裸名 missing 保持 `{kind, deepRoot, mod, expectedBase}` 原样（**sync.test.js 既有 3 处 configIssues 断言不破**）；显式 missing 用 `explicit: true` + `expected` 区分；ambiguous 形状不变；碰撞是新 kind。
- 碰撞只在「两条目都解析 ok 且同基名」时触发（如只有 `e2e_smoke.py` 时裸名+显式同列）——first-wins，第二条进 issues。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `node --test test/source.test.js`
Expected: PASS —— 9 个用例全绿。

Run: `node --test test/sync.test.js`
Expected: PASS —— 既有 planSync/finalize 深度页用例（含 3 处 configIssues 形状断言）不破。

- [ ] **Step 5: 提交**

```bash
git add lib/source.js test/source.test.js
git commit -m "feat(source): canonical deep mod ids + collision guard in resolveConfiguredDeep"
```

---

### Task 3: `lib/lint.js` —— legalIds / lintMissingMechanism 归一化 + 诊断可操作化

**Files:**
- Modify: `lib/lint.js:7,14-31,43-59,170-180`
- Test: `test/lint.test.js`

- [ ] **Step 1: 更新既有消息断言 + 写新失败测试**（`test/lint.test.js`）

**测试走 lint.js 的既有导出，`test/lint.test.js` 的 import 行（第 8 行）不需要改。**

更新 `lintDeepConfig: reports missing and ambiguous direct sources` 用例（现有 ~279-289 行）为：

```js
test('lintDeepConfig: reports missing and ambiguous direct sources', () => {
  const root = tmpDir();
  try {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'entry.py'), '');
    writeFileSync(join(root, 'pkg', 'entry.js'), '');
    assert.deepEqual(lintDeepConfig(root, ['pkg'], {
      pkg: { order: ['absent', 'entry', 'missing.sh'], groups: [] },
    }), [
      { kind: 'missing-source', deepRoot: 'pkg', mod: 'absent', message: 'no supported source file found for pkg/absent' },
      { kind: 'ambiguous-source', deepRoot: 'pkg', mod: 'entry', candidates: ['pkg/entry.js', 'pkg/entry.py'], message: 'multiple supported source files found for pkg/entry — pin one: entry.js / entry.py' },
      { kind: 'missing-source', deepRoot: 'pkg', mod: 'missing.sh', expected: 'pkg/missing.sh', message: 'no supported source file found for pkg/missing.sh (pinned file)' },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

在 `valid deep roots keep configured module ids legal when source resolution fails` 用例之后追加 4 个用例：

```js
test('legalIds normalizes explicit file entries to base ids', () => {
  const root = tmpDir();
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'e2e_smoke.py'), '');
    writeFileSync(join(root, 'scripts', 'e2e_smoke.sh'), '');
    const deep = { scripts: { order: ['e2e_smoke.sh'], groups: [] } };
    assert.deepEqual(lintOrphans(['e2e_smoke'], ['scripts'], deep, root), []);   // 页 id 是基名 → 不孤儿
    assert.deepEqual(lintMissing(['scripts', 'e2e_smoke'], ['scripts'], deep, root), []);   // 基名页 + code_root 页都在 → 不报缺
    assert.deepEqual(lintMissing(['scripts'], ['scripts'], deep, root), ['e2e_smoke']);   // 页真缺时按基名报
    // 纯配置分支（无 repoRoot，不碰 fs）
    assert.deepEqual(lintOrphans(['e2e_smoke'], ['scripts'], deep), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lintDeepConfig: two explicit pins same base → collision-source diagnostic renders both raw entries', () => {
  const root = tmpDir();
  try {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'entry.py'), '');
    writeFileSync(join(root, 'pkg', 'entry.sh'), '');
    assert.deepEqual(lintDeepConfig(root, ['pkg'], {
      pkg: { order: ['entry.py', 'entry.sh'], groups: [] },
    }), [
      { kind: 'collision-source', deepRoot: 'pkg', mod: 'entry', conflictEntry: 'entry.sh', message: '"entry.py" and "entry.sh" resolve to same page id — keep one' },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lintMissingMechanism checks the base-id page for explicit entries', () => {
  const root = tmpDir();
  try {
    mkdirSync(join(root, 'wiki', 'component'), { recursive: true });
    const deep = { scripts: { order: ['e2e_smoke.sh'], groups: [] } };
    writeFileSync(join(root, 'wiki', 'component', 'e2e_smoke.md'),
      '---\ntitle: e2e_smoke\nsummary: s\n---\n# component: e2e_smoke\n\n## 机制详解\n\nok\n');
    assert.deepEqual(lintMissingMechanism(join(root, 'wiki'), deep), []);
    writeFileSync(join(root, 'wiki', 'component', 'e2e_smoke.md'),
      '---\ntitle: e2e_smoke\nsummary: s\n---\n# component: e2e_smoke\n\nprose\n');
    assert.deepEqual(lintMissingMechanism(join(root, 'wiki'), deep), ['component/e2e_smoke.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/lint.test.js`
Expected: FAIL —— 消息断言不匹配（ambiguous 无 pin 提示、显式 missing 无 (pinned file)）；legalIds 用例：`lintOrphans(['e2e_smoke'], ...)` 返回 `['e2e_smoke']`（当前把 `e2e_smoke.sh` 当合法 id）而非 `[]`；collision 用例：当前返回 `[]`；mechanism 用例：当前对显式条目静默跳过（读 `component/e2e_smoke.sh.md` 抛错被 catch）。

- [ ] **Step 3: 实现**（`lib/lint.js` 四处）

**3a.** 第 7 行 import 改为：

```js
import { resolveConfiguredDeep, parseDeepEntry } from './source.js';
```

**3b.** `legalIds`（14-31 行）两处 `names.add(mod)` 改为 `names.add(parseDeepEntry(mod).id)`：

```js
function legalIds(codeRoots, deep = {}, repoRoot = null) {
  const names = new Set(codeRoots.map(rootName));
  if (repoRoot) {
    const invalidRoots = new Set(resolveConfiguredDeep(repoRoot, codeRoots, deep).issues
      .filter(issue => issue.kind === 'deep-root-invalid')
      .map(issue => issue.deepRoot));
    for (const [deepRoot, { order }] of Object.entries(deep)) {
      if (!invalidRoots.has(deepRoot)) for (const mod of order ?? []) names.add(parseDeepEntry(mod).id);
    }
  } else {
    for (const [deepRoot, { order }] of Object.entries(deep)) {
      if (codeRoots.some(cr => deepRoot === cr || deepRoot.startsWith(`${cr}/`))) {
        for (const mod of order ?? []) names.add(parseDeepEntry(mod).id);
      }
    }
  }
  return names;
}
```

**3c.** `lintDeepConfig`（43-59 行）整体替换为：

```js
export function lintDeepConfig(repoRoot, codeRoots, deep = {}) {
  return resolveConfiguredDeep(repoRoot, codeRoots, deep).issues.map(issue => {
    if (issue.kind === 'deep-root-invalid') return {
      kind: 'invalid-root', deepRoot: issue.deepRoot,
      message: 'deep root must equal a code_root or be its child',
    };
    if (issue.kind === 'deep-source-missing') {
      if (issue.explicit) return {
        kind: 'missing-source', deepRoot: issue.deepRoot, mod: issue.mod, expected: issue.expected,
        message: `no supported source file found for ${issue.expected} (pinned file)`,
      };
      return {
        kind: 'missing-source', deepRoot: issue.deepRoot, mod: issue.mod,
        message: `no supported source file found for ${issue.deepRoot}/${issue.mod}`,
      };
    }
    if (issue.kind === 'deep-source-ambiguous') return {
      kind: 'ambiguous-source', deepRoot: issue.deepRoot, mod: issue.mod,
      candidates: issue.candidates,
      message: `multiple supported source files found for ${issue.deepRoot}/${issue.mod} — pin one: ${issue.candidates.map(c => c.split('/').pop()).join(' / ')}`,
    };
    return {
      kind: 'collision-source', deepRoot: issue.deepRoot, mod: issue.mod,
      conflictEntry: issue.conflictEntry,
      message: `deep ${issue.deepRoot}: "${issue.entry}" and "${issue.conflictEntry}" resolve to same page id — keep one`,
    };
  });
}
```

**3d.** `lintMissingMechanism`（170-180 行）读页路径用基名：

```js
export function lintMissingMechanism(wikiDir, deep = {}) {
  const out = [];
  for (const cr of Object.keys(deep)) {
    for (const mod of deep[cr].order ?? []) {
      try {
        if (!/^##\s+机制详解/m.test(readFileSync(join(wikiDir, 'component', `${parseDeepEntry(mod).id}.md`), 'utf8'))) out.push(`component/${parseDeepEntry(mod).id}.md`);
      } catch { /* 页缺失 → lintMissing 已管 */ }
    }
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/lint.test.js`
Expected: PASS —— 全绿（含既有 legalIds/deepConfig/mechanism 用例）。

- [ ] **Step 5: 提交**

```bash
git add lib/lint.js test/lint.test.js
git commit -m "feat(lint): base-id deep entry ids + actionable disambiguation diagnostics"
```

---

### Task 4: `lib/sync.js` —— finalize 的 componentOrder / pageGroups 基名归一化

**Files:**
- Modify: `lib/sync.js:15,310-315`
- Test: `test/sync.test.js`

> planSync（52-65 行）**不需要改**：它遍历 `resolvedDeep.entries`，Task 2 后 `mod` 已是规范化基名，worklist 的 `id/path` 自动正确。别动它。

- [ ] **Step 1: 写失败测试**（`test/sync.test.js`）

在 `fzRepoDeepPython` 函数（~866-881 行）之后追加 helper 与 3 个用例：

```js
// 同名不同扩展的真实案例：scripts/e2e_smoke.py + e2e_smoke.sh（钉 .sh），scripts/abc.py（裸名唯一）
function fzRepoDeepPin() {
  const root = mkN(jN(tmpN(), 'lore-deep-pin-'));
  const git = (...a) => exN2('git', a, { cwd: root, stdio: 'pipe' }).toString().trim();
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  mdN(jN(root, 'scripts'), { recursive: true });
  wfN(jN(root, 'scripts', 'e2e_smoke.py'), 'DRIVER = 1\n');
  wfN(jN(root, 'scripts', 'e2e_smoke.sh'), 'exec python e2e_smoke.py\n');
  wfN(jN(root, 'scripts', 'abc.py'), 'ABC = 1\n');
  const lore = jN(root, '.lore');
  mdN(jN(lore, 'wiki', 'component'), { recursive: true });
  mdN(jN(lore, 'journal'), { recursive: true });
  mdN(jN(lore, '.state'), { recursive: true });
  wfN(jN(lore, 'config.yml'),
    'axes:\n  component:\n    code_roots: [scripts]\n    deep:\n      scripts: [e2e_smoke.sh, abc]\n');
  exN2('git', ['add', '-A'], { cwd: root, stdio: 'pipe' });
  exN2('git', ['commit', '-q', '-m', 'init'], { cwd: root, stdio: 'pipe' });
  return { root, loreDir: lore, git, sha: () => git('rev-parse', '--short', 'HEAD') };
}

test('planSync: explicit pin → worklist id is base name, sourceFile pinned', () => {
  const r = fzRepoDeepPin();
  try {
    const plan = pl(r.loreDir, { all: true });
    const e2e = plan.worklist.find(w => w.kind === 'deep' && w.id === 'e2e_smoke');
    const abc = plan.worklist.find(w => w.kind === 'deep' && w.id === 'abc');
    assert.deepEqual([e2e.sourceFile, e2e.path], ['scripts/e2e_smoke.sh', 'component/e2e_smoke.md']);
    assert.deepEqual([abc.sourceFile, abc.codeRoot], ['scripts/abc.py', 'scripts']);   // 裸名回归
    assert.deepEqual(plan.configIssues, []);
  } finally { rmN(r.root, { recursive: true, force: true }); }
});

test('planSync: explicit pin missing → issue with expected, no worklist item, no bare fallback', () => {
  const r = fzRepoDeepPin();
  try {
    rmN(jN(r.root, 'scripts', 'e2e_smoke.sh'), { force: true });
    const plan = pl(r.loreDir, { all: true });
    assert.equal(plan.worklist.some(w => w.kind === 'deep' && w.id === 'e2e_smoke'), false);
    assert.ok(plan.worklist.some(w => w.kind === 'deep' && w.id === 'abc'));   // 其余条目不受影响
    assert.deepEqual(plan.configIssues, [{
      kind: 'deep-source-missing', deepRoot: 'scripts', mod: 'e2e_smoke.sh',
      explicit: true, expected: 'scripts/e2e_smoke.sh',
    }]);
  } finally { rmN(r.root, { recursive: true, force: true }); }
});

test('finalizeSync: pinned deep entries → component order by base id (not raw entry)', () => {
  const r = fzRepoDeepPin();
  try {
    for (const id of ['scripts', 'e2e_smoke', 'abc']) {
      wfN(jN(r.loreDir, 'wiki', 'component', `${id}.md`),
        `---\ntitle: ${id}\nsummary: s\n---\n# component: ${id}\n\n## Current architecture\n\nv1\n`);
    }
    fz(r.loreDir, '2026-08-03T00:00:00Z');
    const manifest = JSON.parse(rdN(jN(r.loreDir, 'wiki', '.manifest.json'), 'utf8'));
    const ids = manifest.axes.find(a => a.id === 'component').pages.map(p => p.id);
    // config order: [e2e_smoke.sh, abc] → 基名序 [scripts(鸟瞰), e2e_smoke, abc]；
    // 未归一化时 e2e_smoke 排不到 order 里会退字母序 → ['scripts', 'abc', 'e2e_smoke']
    assert.deepEqual(ids, ['scripts', 'e2e_smoke', 'abc']);
  } finally { rmN(r.root, { recursive: true, force: true }); }
});

test('finalizeSync: explicit pin inside a group → pageGroups keyed by base id', () => {
  const r = fzRepoDeepPin();
  try {
    wfN(jN(r.loreDir, 'config.yml'),
      'axes:\n  component:\n    code_roots: [scripts]\n    deep:\n      scripts:\n        入口: [e2e_smoke.sh]\n');
    wfN(jN(r.loreDir, 'wiki', 'component', 'e2e_smoke.md'),
      '---\ntitle: e2e_smoke\nsummary: s\n---\n# component: e2e_smoke\n\n## Current architecture\n\nv1\n');
    fz(r.loreDir, '2026-08-03T00:00:00Z');
    const manifest = JSON.parse(rdN(jN(r.loreDir, 'wiki', '.manifest.json'), 'utf8'));
    const page = manifest.axes.find(a => a.id === 'component').pages.find(p => p.id === 'e2e_smoke');
    assert.equal(page.group, '入口');
  } finally { rmN(r.root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/sync.test.js`
Expected: FAIL —— 前两个用例（planSync worklist/configIssues）在 Task 2 后应已过；`finalizeSync: pinned deep entries → component order` 失败（当前 componentOrder 含 `e2e_smoke.sh` → e2e_smoke 页 rank Infinity → 退字母序 `['scripts', 'abc', 'e2e_smoke']`）；group 用例失败（`pageGroups['e2e_smoke.sh']` 不匹配 `pageGroups['e2e_smoke']` → `page.group === ''`）。

- [ ] **Step 3: 实现**（`lib/sync.js` 两处）

**3a.** 第 15 行 import 改为：

```js
import { resolveConfiguredDeep, parseDeepEntry } from './source.js';
```

**3b.** `finalizeSync` 的 componentOrder/pageGroups 段（310-315 行）替换为：

```js
  // component 排序 + 分组：鸟瞰（code_root）置顶 + 各 deep order 流水线序（条目可能是
  // 显式文件如 e2e_smoke.sh → 归一化为基名页 id）；group 来自 deep groups
  const componentOrder = [...codeRoots.map(cr => cr.split('/').pop())];
  const pageGroups = {};
  for (const [, { order, groups }] of Object.entries(deep)) {
    componentOrder.push(...order.map(m => parseDeepEntry(m).id));
    for (const g of groups) for (const mod of g.mods) pageGroups[parseDeepEntry(mod).id] = g.name;
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/sync.test.js`
Expected: PASS —— 全绿（既有 50+ 用例 + 4 个新用例；staleScopes 段用 `resolvedDeep.entries` 的 canonical mod，无需改）。

- [ ] **Step 5: 提交**

```bash
git add lib/sync.js test/sync.test.js
git commit -m "fix(sync): base-id component order + page groups for pinned deep entries"
```

---

### Task 5: 文档 —— 钉法语法 + 缺陷状态

**Files:**
- Modify: `commands/sync.md:161`
- Modify: `lib/init.js:256,258`
- Modify: `docs/DEFECT-deep-source-ambiguity.md:3`

- [ ] **Step 1: `commands/sync.md` 深度页段落补钉法说明**

在 161 行「**深度页**（`component/<子模块>`，如 `sync`）：**完整两档**。…」段落末尾追加一句：

```markdown
深度页条目可写 `<name>.<ext>`（如 `e2e_smoke.sh`）钉住具体文件，消解同名不同扩展（`.py`+`.sh`、`.ts`+`.js`）的歧义——页 id 恒为基名（`component/e2e_smoke.md`），裸名条目行为不变；钉住的文件缺失时 lint 报 `missing-source (pinned file)`，不静默回退。
```

- [ ] **Step 2: `lib/init.js` `renderDeepBlock` 注释补钉法提示**

两处注释（256 行空发现分支 + 258 行头部注释）改为：

```js
    return `    deep:                      # 源文件级深度页（init 自动扫描的顶层模块，按需删减/分组）\n      # <code_root>: [mod1, mod2, ...]（条目可写 <name>.<ext> 钉住文件，如 e2e_smoke.sh）\n`;
```

```js
  const lines = ['    deep:                      # 源文件级深度页（init 自动扫描的顶层模块，按需删减/分组；条目可写 <name>.<ext> 钉住文件）'];
```

- [ ] **Step 3: `docs/DEFECT-deep-source-ambiguity.md` 状态更新**

第 3 行改为：

```markdown
> 状态：已设计（2026-08-03），方案见 docs/superpowers/specs/2026-08-03-deep-source-disambiguation-design.md，实施见 docs/superpowers/plans/2026-08-03-deep-source-disambiguation.md
```

- [ ] **Step 4: 验证**

Run: `node --test test/sync.test.js test/lint.test.js`
Expected: PASS（`commands/sync.md documents two-tier page standard + deep pages` 用例检查文档关键词，新增句子不破坏它）。

Run: `node --test test/*.test.js`
Expected: 全绿。若 `serve.test.js` 在并行下偶发失败（已知 flake，见 CLAUDE.md 踩坑）——重跑一次确认；仍失败且单跑 `node --test test/serve.test.js` 稳定则如实记录，不掩盖。

- [ ] **Step 5: 提交**

```bash
git add commands/sync.md lib/init.js docs/DEFECT-deep-source-ambiguity.md
git commit -m "docs: deep entry pin syntax (sync.md, init scaffold, defect status)"
```

---

## 验收（对照 spec 与缺陷文档）

1. `deep.scripts: [e2e_smoke.sh]` → `resolveDeepSource` 唯一解析到 `scripts/e2e_smoke.sh`；`planSync` worklist 出现 `component/e2e_smoke.md`（`sourceFile: scripts/e2e_smoke.sh`）；`lintDeepConfig` 不再报 ambiguous。—— Task 1/2/4 用例覆盖。
2. 裸名唯一匹配行为与之前完全一致（`test/source.test.js` 既有 3 用例一字未动 + `test/sync.test.js` 既有深度页用例全绿）。—— Task 1/2 回归锚。
3. 缺文件报 `missing-source`（显式带 `(pinned file)` + 精确路径）、未消歧仍报 `ambiguous`（附 `pin one: ...` 候选）。—— Task 3 用例覆盖。
4. 碰撞（裸名+显式同基名）→ `collision-source` 诊断 + first-wins。—— Task 2/3 用例覆盖。
5. finalize 排序/分组/增量按基名工作（componentOrder / pageGroups / staleScopes）。—— Task 4 用例覆盖。
