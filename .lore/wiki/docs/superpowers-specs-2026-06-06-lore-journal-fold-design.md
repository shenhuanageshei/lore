---
title: lore journal 折叠层（fold layer）—— 设计
summary: - 日期：2026-06-06 - 状态：设计已批，待写实施计划 - 前置：v0.1 journal 基座（`lib/journal.js`）、`lib/sync.js` `finalizeSync` 决策史折叠 - 北极星：人读友好 wiki（决策史去重，本轮）；为 agent 端 graph 的决策边铺干净数据（间接） - roadmap 对应：「待修复」⭐ journal fold-b...
source_path: docs/superpowers/specs/2026-06-06-lore-journal-fold-design.md
last_updated: 2026-06-06
group: 设计与计划
paired_plan: superpowers-plans-2026-06-06-lore-journal-fold
---
> 源文档：`docs/superpowers/specs/2026-06-06-lore-journal-fold-design.md`

# lore journal 折叠层（fold layer）—— 设计

- 日期：2026-06-06
- 状态：设计已批，待写实施计划
- 前置：v0.1 journal 基座（`lib/journal.js`）、`lib/sync.js` `finalizeSync` 决策史折叠
- 北极星：人读友好 wiki（决策史去重，本轮）；为 agent 端 graph 的决策边铺干净数据（间接）
- roadmap 对应：「待修复」⭐ journal fold-by-id；「note enrich 骨架 + journal fold-by-id」

## 背景 / 问题（v0.5 dogfood 实测）

决策史（component/theme/flow 页「决策历史」段）出现重复条目。dogfood lore 自身 148 条原子分析：

- **同 `atom.id` 重复：0 组**
- **同标题重复：8 组**，每组 2 条，全为 `source:hook`、**不同 sha / 不同 id**、`component:[lib]`

根因：`git commit --amend` / rebase 改变 commit sha → post-commit hook（`captureHead`）对新 sha 写一条 `commit:<newsha>` 原子；旧 `commit:<oldsha>` 原子因 journal append-only 不删而残留为**孤儿**（指向 git 历史中已不可达的 sha）。`finalizeSync` 按 component 捞原子渲染（sync.js:153），孤儿与重生同 title → 同一逻辑 commit 渲染两次。

**关键纠偏**：roadmap 原写「按 `atom.id` 折叠取最新即修」，但孤儿与重生 **id 不同**（不同 sha），按 id 折叠对这 8 组**一条都消不掉**。真正的折叠键是「git 可达性」（孤儿 = 不可达），不是 `atom.id`。

note enrich 的「同 `commit:<hash>` append 补 why」是另一场景——**同 id**，目前 0 例（enrich 未实现）。本折叠层同时覆盖此场景，为其打底。

## 目标 / 非目标

**目标**：通用折叠层 `foldAtoms`，消费端折叠 journal 原子供决策史渲染：
1. 丢弃 amend/rebase 孤儿 commit 原子（治当前 biting）。
2. 同 `atom.id` 多条合并成一条（为未来 note enrich 打底）。

**非目标（YAGNI）**：
- 改 journal 存储 / 删孤儿行 —— append-only 神圣，孤儿留 ndjson 供审计。
- note enrich 命令本身（`/lore:note --enrich`，单独迭代）；本层只保证它产出的同 id 行能被正确合并。
- 跨轴决策折叠、per-facet confidence（独立 roadmap 项）。
- `ask`/`lint` 改动（走 manifest，自动受益）。

## 决策（已锁）

| 项 | 决策 |
|---|---|
| scope | **B 通用折叠层**：丢孤儿 + fold-by-id 合并，一个管线 |
| 孤儿识别 | **git 可达性**（`git rev-list --all` → 可达 sha 集合；`kind:commit` 且 sha 不在集合 = 孤儿）；非 title 启发式 |
| 可达范围 | **`--all`**（任何 branch/tag 可达即保留；被 tag/分支钉住的不算孤儿） |
| 合并基底 | 组内 **ts 最早**那条 → 决策史时间线位置不随 enrich 改变 |
| why 合并 | **追加不覆盖**（基底 why ＋ 后续 `enriched` 原子的 why，ts 升序、去空去重）→ 留 skeleton→enriched 演化痕迹 |
| 其他字段 | `refs.files`/`refs.related` **并集**；`refs.pitfall` 最后非空；`enriched` **任一 true**；`title`/`facets`/`confidence`/`what_changed` 基底优先、空则后续补 |
| 纯函数边界 | `foldAtoms` **纯函数**，git I/O（可达集合）作参数注入；`reachableShas` 缺省 → 跳过丢孤儿、仅 id 合并（优雅退化） |
| 接入点 | 仅 `sync.js` `finalizeSync`（`readAllAtoms` 后折一次）；`journal.js` 不动（`existingIds` 去重需全量原始原子） |

## 设计

### A · `lib/fold.js`（新）—— 纯折叠函数

```
export function foldAtoms(atoms, { reachableShas } = {}) → Atom[]
```

两阶段：

1. **dropOrphans**：`reachableShas` 为 Set 时，过滤掉 `a.kind === 'commit' && a.commit && !reachableShas.has(a.commit)`。`reachableShas` 为 null/undefined → 不过滤。`decision` 原子（`commit:null`）恒保留。
2. **mergeById**：按 `a.id` 分组（保持首次出现顺序）；单条原样；多条 → `mergeGroup`：
   - 组内按 ts 升序；基底 = 第一条（ts 最早）。
   - `why`：以基底 why 起头，依次追加后续 `enriched && why` 且与已收集不同的 why，`\n\n` 连接。
   - `refs.files` / `refs.related`：并集去重（保序）；`refs.pitfall`：最后一个非 null。
   - `enriched`：`atoms.some(a => a.enriched)`。
   - `title`/`commit`/`ts`/`facets`/`confidence`/`what_changed`：基底值；基底为空/缺则取后续首个非空。

返回顺序：按基底首次出现顺序（稳定，便于测试）。`renderDecisionHistory` 自身再按 ts 倒序，故对最终渲染顺序不敏感。

### B · `lib/sync.js`（改）—— 可达集合 + 接入

新增 local helper（紧邻现有 `headShortSha`）：

```
function reachableShaSet(repoRoot) {
  try {
    const out = execFileSync('git', ['rev-list', '--all'],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }).toString();
    return new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
  } catch { return null; }   // best-effort：非 git / git 不可用 → 退化为仅 id 合并
}
```

`finalizeSync`（`readAllAtoms` 之后）：

```
const allAtoms = readAllAtoms(join(loreDir, 'journal'));
const folded   = foldAtoms(allAtoms, { reachableShas: reachableShaSet(repoRoot) });
```

将下游决策史折叠（sync.js:153 `allAtoms.filter(...)`）改为 `folded.filter(...)`。`import` 加 `foldAtoms`。

### C · 不变量

- **append-only 神圣**：`foldAtoms` 纯读，ndjson 不动 → 孤儿/skeleton/enriched 全历史仍可审计。
- **零依赖**：`git rev-list` 是进程调用（同 hook/mine），非 node_modules。
- **best-effort**：`reachableShaSet` 失败不崩 sync。
- **向后兼容**：无同 id 且全可达时，`folded` 等价于原子集 → 现有行为不变。

## 测试

### `test/fold.test.js`（纯函数，无 git）
1. 空 / 单原子 / 无重复 → 幂等。
2. 孤儿丢弃：sha ∉ reachable → 丢；∈ → 留。
3. `reachableShas` null/省略 → 一条不丢。
4. `decision` 原子（commit:null）→ 不被可达过滤误伤。
5. 同 id 合并：ts=最早、why 追加、files/related 并集、pitfall 最后非空、enriched=OR。
6. **核心 biting**：孤儿(oldSha ∉ reachable) ＋ 重生(newSha ∈ reachable)、同 title 不同 id → 输出仅重生一条。
7. enrich 模拟：skeleton(enr=false,why=body) ＋ 同 id enriched(enr=true,why=补) → 一条，why 含两者、ts=skeleton、enriched=true。
8. tag 钉住：sha ∈ reachable（即便"看似旧"）→ 保留。

### `test/sync.test.js`（集成，临时 git repo）
9. 仿现有 fixture（mkdtemp + git init + commit + mine + finalize，参 267-277 行）：commit 一个 lib 改动 → mine（写 `commit:<oldSha>`，旧 message）→ `git commit --amend`（改 message → 新 sha）→ mine（写 `commit:<newSha>`；旧原子 append-only 残留）→ finalize → 读 `wiki/component/lib.md` 决策史：断言**新 message 标题出现一次、旧 message 标题不出现**。因 amend 改了 message、新旧 title 不同，本用例恰好验证去重靠 **git 可达性**而非 title 匹配。

## 改动清单
- 新增 `lib/fold.js`、`test/fold.test.js`
- 改 `lib/sync.js`（import + `reachableShaSet` + `finalizeSync` 接入）、`test/sync.test.js`（集成用例 9）
- `lib/journal.js` 不动
- CHANGELOG：发版时补「修复：决策史去重（amend 孤儿过滤）+ fold-by-id 合并基础」

