# 决策史 section 重建（foldJournal 哨兵化）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `foldJournal` 从「一次性 token 替换」改成「`## Decision history` section 整段重建 + 哨兵稳态」，根治页面决策史累积、并自愈已肿的 lib.md。

**Architecture:** `foldJournal` 定位 `## Decision history` 标题到下一个 `## `（或 EOF）的整段；section 内有 `{{LORE_JOURNAL}}` token 或哨兵才重建（整段替换为哨兵包裹的决策史 md，吞掉历史累积），否则 no-op。首次靠 token 落哨兵、之后靠哨兵 swap → 幂等。字符串切片拼接 → `$`-pattern 安全。`finalizeSync` 调用点与 `renderDecisionHistory` 不变。

**Tech Stack:** Node.js (ESM) · `node:test` + `node:assert/strict` · 纯字符串处理（正则定位 + slice）· 零依赖。

**前置 spec:** `docs/superpowers/specs/2026-06-06-lore-decision-history-rebuild-design.md`

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `lib/sync.js` | `foldJournal` 重写（91-114）+ 决策史常量；删死代码 `countOccurrences` | 改 |
| `test/sync.test.js` | 删旧 token 语义的 foldJournal 测试组，加 section/哨兵新测试 + 幂等集成 | 改 |
| `lib/lint.js` / `renderDecisionHistory` / `lib/fold.js` / init 模板 | — | **不动** |

**新 foldJournal 契约**（签名不变）：`foldJournal(text, md, { page, warn }) → string`。常量 `DH_HEADING='## Decision history'`、`DH_START='<!-- LORE_JOURNAL:START -->'`、`DH_END='<!-- LORE_JOURNAL:END -->'`、`JOURNAL_TOKEN='{{LORE_JOURNAL}}'`。

---

## Task 1: foldJournal 改为 section 重建 + 哨兵

**Files:**
- Modify: `lib/sync.js`（91-114：`JOURNAL_TOKEN` + `countOccurrences` + `foldJournal`）
- Test: `test/sync.test.js`

- [ ] **Step 1: 重写测试**

在 `test/sync.test.js` 中**删除**以下旧测试（它们测的是已废弃的 token-替换语义）：
- 4 个 foldJournal 单测：`foldJournal: single token folds...`、`foldJournal: zero tokens...`、`foldJournal: multiple tokens → folds into LAST...`、`foldJournal: multi-token path inserts md literally...`
- `twoTokenPage` helper 函数
- 集成测试 `finalizeSync: duplicate {{LORE_JOURNAL}} tokens fold into the last...`

**保留** `tokenPage`、`agentPage` helper（被其它测试使用）。

然后在文件**末尾追加**这组新测试：

```js
// --- foldJournal: H2-section rebuild + sentinel ---
const DH = '## Decision history';
const DH_START = '<!-- LORE_JOURNAL:START -->';
const DH_END = '<!-- LORE_JOURNAL:END -->';

test('foldJournal: heading + token → rebuild into sentinel region, token gone', () => {
  const text = `# C\n\n${DH}\n\n{{LORE_JOURNAL}}\n\n## Cross-links\n\n- [[x]]\n`;
  const out = foldJournal(text, '- **a** (2026-06-01)', { page: 'c.md', warn: () => {} });
  assert.match(out, /- \*\*a\*\* \(2026-06-01\)/);
  assert.doesNotMatch(out, /\{\{LORE_JOURNAL\}\}/);
  assert.match(out, /<!-- LORE_JOURNAL:START -->[\s\S]*<!-- LORE_JOURNAL:END -->/);
  assert.match(out, /## Cross-links/);                                  // 下游 section 保留
});

test('foldJournal: heading + sentinel region → swap in place (idempotent)', () => {
  const text = `# C\n\n${DH}\n\n${DH_START}\n- **old** (2026-05-01)\n${DH_END}\n\n## Cross-links\n`;
  const out = foldJournal(text, '- **new** (2026-06-01)', { page: 'c.md', warn: () => {} });
  assert.match(out, /- \*\*new\*\* \(2026-06-01\)/);
  assert.doesNotMatch(out, /old/);                                      // 旧内容被换掉
  assert.equal((out.match(/LORE_JOURNAL:START/g) || []).length, 1);     // 仍单区间
});

test('foldJournal: accumulated bullets + multiple tokens → single region, no residue (self-heal)', () => {
  const text = `# C\n\n${DH}\n\n` +
    `- **a** (aaaaaaa, 2026-06-01)\n- **a** (aaaaaaa, 2026-06-01)\n{{LORE_JOURNAL}}\n` +
    `- **b** (bbbbbbb, 2026-05-01)\n{{LORE_JOURNAL}}\n\n## Cross-links\n\n- [[x]]\n`;
  const out = foldJournal(text, '- **fresh** (2026-06-02)', { page: 'c.md', warn: () => {} });
  assert.equal((out.match(/^- \*\*/gm) || []).length, 1);              // 只剩注入的一条
  assert.match(out, /- \*\*fresh\*\*/);
  assert.doesNotMatch(out, /\{\{LORE_JOURNAL\}\}/);
  assert.equal((out.match(/LORE_JOURNAL:START/g) || []).length, 1);
  assert.match(out, /## Cross-links\n\n- \[\[x\]\]/);                   // 下游完整
});

test('foldJournal: no "## Decision history" heading → no-op', () => {
  const text = '# C\n\n## Current architecture\n\nprose\n';
  assert.equal(foldJournal(text, '- **a**', { page: 'c.md', warn: () => {} }), text);
});

test('foldJournal: heading + hand-written (no token/sentinel) → no-op (self-managed)', () => {
  const text = `# C\n\n${DH}\n\n手写决策，sync 不要碰。\n\n## Cross-links\n`;
  assert.equal(foldJournal(text, '- **a**', { page: 'c.md', warn: () => {} }), text);
});

test('foldJournal: md with $-patterns injected literally', () => {
  const text = `# C\n\n${DH}\n\n{{LORE_JOURNAL}}\n`;
  const out = foldJournal(text, '- **fix $& and $$ and $1**', { page: 'c.md', warn: () => {} });
  assert.match(out, /- \*\*fix \$& and \$\$ and \$1\*\*/);
});

test('foldJournal: decision history is last section (no next H2) → replace to EOF, single trailing newline', () => {
  const text = `# C\n\n${DH}\n\n{{LORE_JOURNAL}}\n`;
  const out = foldJournal(text, '- **a** (2026-06-01)', { page: 'c.md', warn: () => {} });
  assert.match(out, /- \*\*a\*\* \(2026-06-01\)\n<!-- LORE_JOURNAL:END -->\n$/);   // 末尾单换行
});

test('foldJournal: multiple tokens → warn once', () => {
  const warnings = [];
  const text = `# C\n\n${DH}\n\n{{LORE_JOURNAL}}\n{{LORE_JOURNAL}}\n\n## Cross-links\n`;
  foldJournal(text, '- **a**', { page: 'component/c.md', warn: m => warnings.push(m) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /component\/c\.md/);
});

test('finalizeSync: decision-history rebuild is idempotent across re-syncs (no accumulation)', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    const compDir = join(lore, 'wiki', 'component');
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, 'lib.md'), tokenPage('Lib', 'core'));
    const journalDir = join(lore, 'journal');
    const shaA = realSha(root, 'alpha');
    const shaB = realSha(root, 'bravo');
    const mk = (sha, title, ts) => ({
      id: `commit:${sha}`, ts, kind: 'commit', commit: sha, title, why: '', what_changed: '',
      facets: { component: ['lib'], flow: [], theme: [] },
      refs: { files: ['lib/x.js'], pitfall: null, related: [] },
      source: 'hook', enriched: false, confidence: 'EXTRACTED',
    });
    appendAtom(journalDir, mk(shaA, 'commit alpha', '2026-06-01T00:00:00Z'));
    appendAtom(journalDir, mk(shaB, 'commit bravo', '2026-06-02T00:00:00Z'));

    finalizeSync(lore, '2026-06-03T00:00:00Z', { warn() {} });
    let page = readFileSync(join(compDir, 'lib.md'), 'utf8');
    assert.doesNotMatch(page, /\{\{LORE_JOURNAL\}\}/);                              // token 被吞
    assert.match(page, /<!-- LORE_JOURNAL:START -->/);                             // 落了哨兵
    assert.equal((page.match(/commit alpha/g) || []).length, 1);
    assert.equal((page.match(/commit bravo/g) || []).length, 1);

    finalizeSync(lore, '2026-06-04T00:00:00Z', { warn() {} });                     // 再 sync
    page = readFileSync(join(compDir, 'lib.md'), 'utf8');
    assert.equal((page.match(/commit alpha/g) || []).length, 1);                  // 幂等：仍各一条
    assert.equal((page.match(/commit bravo/g) || []).length, 1);
    assert.equal((page.match(/LORE_JOURNAL:START/g) || []).length, 1);            // 仍单区间
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/sync.test.js`
Expected: FAIL —— 旧 `foldJournal` 仍是 token 替换，以下新测试失败：`heading + token`（无哨兵区间）、`sentinel swap`、`self-heal`（旧只 blank earlier、不整段清累积）、`last section EOF`（无哨兵）、`idempotent 集成`（无哨兵 + 二次累积）。（`no-op` / `hand-written` / `$-pattern` 这三个旧实现恰好也满足、会 PASS——属正常。）

- [ ] **Step 3: 重写 foldJournal**

在 `lib/sync.js` 中，把现有的 `JOURNAL_TOKEN` 常量、`countOccurrences` 函数、整个 `foldJournal` 函数（连同其上方注释，约 91-114 行）整体替换为：

```js
const JOURNAL_TOKEN = '{{LORE_JOURNAL}}';
const DH_HEADING = '## Decision history';
const DH_START = '<!-- LORE_JOURNAL:START -->';
const DH_END = '<!-- LORE_JOURNAL:END -->';

// Rebuild the `## Decision history` section idempotently.
// 定位标题 → 下个 H2 / EOF 的整段；section 内有 token 或哨兵才重建（整段替换为
// 哨兵包裹的决策史 md，吞掉历史累积 + 多余 token → 自愈已肿页面）。
// 无标题 → no-op；有标题但无 token/哨兵（页面自管）→ no-op。
// 字符串切片拼接，$-pattern 安全（不经 replace 替换串）。
export function foldJournal(text, md, { page = '(page)', warn = (m) => console.error(m) } = {}) {
  const m = /^## Decision history[^\n]*\n/m.exec(text);
  if (!m) return text;                                       // 无决策史 section
  const start = m.index;
  const afterHeading = m.index + m[0].length;
  const rel = text.slice(afterHeading).search(/^## /m);
  const end = rel === -1 ? text.length : afterHeading + rel;
  const section = text.slice(start, end);

  if (!section.includes(JOURNAL_TOKEN) && !section.includes(DH_START)) {
    return text;                                            // 标题 + 手写自管 → 不碰
  }
  const tokenN = section.split(JOURNAL_TOKEN).length - 1;
  if (tokenN > 1) {
    warn(`lore sync: ${page} — ${tokenN} ${JOURNAL_TOKEN} / accumulated decision history, rebuilt + deduped`);
  }
  const block = `${DH_HEADING}\n\n${DH_START}\n${md}\n${DH_END}\n`;
  const tail = text.slice(end);
  return text.slice(0, start) + block + (tail ? `\n${tail}` : '');
}
```

（`countOccurrences` 已仅被旧 foldJournal 使用，一并删除。`lib/lint.js` 自带独立的 `JOURNAL_TOKEN`，不受影响。）

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `node --test test/sync.test.js`
Expected: PASS（新 9 个测试全过）。

Run: `node --test`
Expected: 全量 PASS, 0 fail。重点确认现有 `finalizeSync` 集成测试（用 `tokenPage`/`agentPage` 的 211/244/290/422/530 那些）仍过——新 foldJournal 对「标题+单 token」页正常重建、对「标题+无 token 手写」（agentPage 的 `暂无 journal 原子`）走 no-op 自管路径。

- [ ] **Step 5: Commit**

```bash
git add lib/sync.js test/sync.test.js
git commit -m "fix(sync): rebuild decision-history section idempotently (sentinel region)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: dogfood 自愈 lib.md + 收口 .lore

**Files:**
- Modify: `.lore/**`（sync 自愈产物 + journal 尾巴）

- [ ] **Step 1: 跑真实 sync 自愈**

```bash
node lib/mine.js .
node lib/sync.js finalize .lore
```
Expected: `✓ sync finalized: ...`。可能打印一条 `… accumulated decision history, rebuilt + deduped`（lib.md 被整段重建）。

- [ ] **Step 2: 验证 lib.md 收敛**

```bash
wc -l < .lore/wiki/component/lib.md
grep -c "^- \*\*" .lore/wiki/component/lib.md
grep -c "LORE_JOURNAL:START" .lore/wiki/component/lib.md
grep -c "{{LORE_JOURNAL}}" .lore/wiki/component/lib.md
grep -c "^## Cross-links" .lore/wiki/component/lib.md
```
Expected: 行数从 639 → ~150；决策史条目数 ≈ 99（= frontmatter `commits`，无重复）；哨兵 `LORE_JOURNAL:START` 恰 1；裸 token `{{LORE_JOURNAL}}` 为 0；`## Cross-links` 恰 1（下游保留）。
再人工 `git diff .lore/wiki/component/lib.md | head -40` 确认是「删累积、留单份」而非内容损坏。

- [ ] **Step 3: 全量测试再确认绿**

Run: `node --test`
Expected: 全量 PASS。

- [ ] **Step 4: 收口提交 .lore**

```bash
git add .lore
git commit -m "chore(lore): dogfood resync — decision history deduped (lib.md 639->~150)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

（这一步同时收口上一轮搁置的 journal hook 尾巴。注意：本次 commit 又会触发 hook 写一条新原子，留一条未提交尾巴属预期，下次 resync 带上。）

---

## Spec 覆盖核对（self-review 映射）

| spec 决策 | 落地于 |
|---|---|
| B′ H2-section 整段替换 + 哨兵稳态 | Task 1 Step 3 `foldJournal` |
| section 定位（标题→下个 `## `/EOF） | Step 3 正则 + `search(/^## /m)` + slice |
| fold 信号 = token 或哨兵 | Step 3 `if (!section.includes(TOKEN) && !includes(START))` |
| 哨兵包裹、首次 token 后续哨兵 | Step 3 `block` + 测试 1/2 |
| 自管保留（无信号 no-op）、无标题 no-op | Step 3 两个 early-return + 测试 4/5 |
| 自愈累积 | 测试 3 + Task 2（lib.md 实测收敛） |
| $-安全（切片拼接） | Step 3 + 测试 6 |
| EOF 末段 | Step 3 `rel===-1` 分支 + 测试 7 |
| 多 token warn | Step 3 `tokenN>1` + 测试 8 |
| 幂等不累积 | 测试 9（finalize 两次） |
| renderDecisionHistory 不动 / 模板 token 不改 | 本 plan 不触及二者 |
