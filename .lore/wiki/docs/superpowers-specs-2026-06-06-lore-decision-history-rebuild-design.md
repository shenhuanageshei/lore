---
title: lore 决策史 section 重建（foldJournal 哨兵化）—— 设计
summary: - 日期：2026-06-06 - 状态：设计已批，待写实施计划 - 前置：`docs/superpowers/specs/2026-06-06-lore-journal-fold-design.md`（原子层 fold，已实现）；`lib/home.js` `finalizeHomeText`（哨兵区间蓝本） - 北极星：人读友好 wiki（决策史去重，本轮收口页面层）
source_path: docs/superpowers/specs/2026-06-06-lore-decision-history-rebuild-design.md
last_updated: 2026-06-06
---
> 源文档：`docs/superpowers/specs/2026-06-06-lore-decision-history-rebuild-design.md`

# lore 决策史 section 重建（foldJournal 哨兵化）—— 设计

- 日期：2026-06-06
- 状态：设计已批，待写实施计划
- 前置：`docs/superpowers/specs/2026-06-06-lore-journal-fold-design.md`（原子层 fold，已实现）；`lib/home.js` `finalizeHomeText`（哨兵区间蓝本）
- 北极星：人读友好 wiki（决策史去重，本轮收口页面层）

## 背景 / 问题（v0.5 dogfood 实测）

原子层 fold（已实现）消除了 journal 孤儿，但 dogfood 暴露**页面层**才是决策史重复主因：

- `component/lib.md`：HEAD 已 **639 行 / 599 条决策史，仅 203 唯一**（重复 ~3.4x）。
- 跑一次 sync 反而 **+98 行**（639→737）——越 sync 越肿。

根因：`foldJournal` 是**一次性 token 替换**——`{{LORE_JOURNAL}}` 被换成决策史 md 后，md 永久留在页面；下次 sync 若页面又有 token（agent 重写 / 多 token）就再注入一份，累积如滚雪球。对比 `lib/home.js` `finalizeHomeText`：HOME status 用 `<!-- ...:START/END -->` **哨兵区间**幂等 swap，从不累积。决策史缺这个稳态锚点。

lib.md 边界实测：仅 3 个 H2（`## Current architecture`@11、`## Decision history`@39、`## Cross-links`@637），决策史区 598 行**纯 bullets、无内嵌 H2**，Cross-links 内容完整 → H2-section 边界干净可靠。

## 目标 / 非目标

**目标**：`foldJournal` 改为**幂等的 `## Decision history` section 重建**——既不再累积，又能**自愈**已肿页面（一次 sync 把 lib.md 738→~150），无需迁移代码 / 手工编辑。

**非目标（YAGNI）**：
- 截断决策史条数（用户选「全列」；`renderDecisionHistory` 不动）。
- 决策史标题本地化（锚点固定英文 `## Decision history`，当前模板统一英文）。
- 改 init / agent 页模板的 token（保留，首次 sync 被吞转哨兵）。
- 原子层 fold（已实现，独立）。

## 决策（已锁）

| 项 | 决策 |
|---|---|
| 机制 | **B′：H2-section 整段替换 + 哨兵稳态**（纯哨兵不自愈累积；纯 H2 重建后失锚点） |
| section 定位 | `## Decision history` 标题行 → 下个 `^## ` 或 EOF |
| fold 信号 | section 内含 `{{LORE_JOURNAL}}` 或 `<!--START-->` 才重建；否则 no-op |
| 稳态锚点 | 重建注入 `<!--LORE_JOURNAL:START/END-->` 哨兵包裹 md；首次靠 token、之后靠哨兵 |
| 自管保留 | 有标题但无 token/哨兵（纯手写）→ no-op（保留 foldJournal 原设计意图） |
| 无标题 | no-op（页面无决策史 section） |
| $-安全 | 字符串切片拼接，不用 `replace` 替换串 |
| 数据修复 | 不写迁移代码——改好机制后全量 sync 自愈，dogfood 提交 |
| 决策史内容 | 全列（`renderDecisionHistory` 不变） |

## 设计

### A · `foldJournal(text, md, { page, warn })` 重写（`lib/sync.js`）

常量：`HEADING='## Decision history'`、`START='<!-- LORE_JOURNAL:START -->'`、`END='<!-- LORE_JOURNAL:END -->'`、`TOKEN='{{LORE_JOURNAL}}'`。

```
1. const m = /^## Decision history[^\n]*\n/m.exec(text)
   若无 m → return text                          // 无 section，no-op
2. const start = m.index
   const afterHeading = m.index + m[0].length
   const rel = text.slice(afterHeading).search(/^## /m)
   const end = rel === -1 ? text.length : afterHeading + rel
   const section = text.slice(start, end)
3. const hasSignal = section.includes(TOKEN) || section.includes(START)
   若 !hasSignal → return text                   // 标题 + 手写自管，no-op
4. const tokenN = section.split(TOKEN).length - 1
   若 tokenN > 1 → warn(`${page}: ${tokenN} {{LORE_JOURNAL}} / 累积决策史，已整段重建去重`)
5. const block = `${HEADING}\n\n${START}\n${md}\n${END}\n`
   const tail = text.slice(end)                  // 下个 H2 起（或 ''）
   return text.slice(0, start) + block + (tail ? '\n' + tail : '')
```

- **首次**（token 信号）：吞 token + 任何累积 → 落哨兵区间。
- **之后**（哨兵信号）：整段 swap → 幂等，永不累积。
- `tail` 拼接保证 section 与下个 H2 间恰一空行；决策史为末段时文件尾恰一换行。

### B · 自愈（数据修复）

改好 A 后 `node lib/sync.js finalize .lore`：lib.md section 含 4 token → 步骤 3 命中信号 → 步骤 5 整段替换 start(39)→end(637) → 598 行累积 + 4 token 一次清除，注入哨兵区间 + 99 条去重 bullets → 738→~150，`## Cross-links` 原样保留。其他 repo 的任意受损页同理自愈。

### C · 不变量
- `renderDecisionHistory` / 原子层 `lib/fold.js` / journal 存储 不动。
- `finalizeSync` 调用点不变（仍 `foldJournal(readFileSync(p,'utf8'), md, {page, warn})`）。
- 零依赖；$-pattern 安全（切片拼接，不经 `replace` 替换串）。
- 向后兼容：token 页首次转哨兵；哨兵页 swap；手写页 no-op；无标题页 no-op。

## 测试

### `test/sync.test.js` — `foldJournal` 单测（重写旧 6 个 token 测试）
1. 标题 + token → 重建为哨兵区间、md 注入、token 消失。
2. 标题 + 哨兵区间（含旧 md）→ swap 为新 md（幂等），仍单一区间。
3. **累积自愈**：标题 + 多 token + 多份散落 bullets + 下游 `## Cross-links` → 重建后单区间单份 md，Cross-links 完整、无残留 bullets、无 token。
4. 无 `## Decision history` 标题 → 原文不变（no-op）。
5. 标题 + 纯手写（无 token/哨兵）→ 原文不变（自管保留）。
6. md 含 `$&` / `$$` / `$1` → 字面注入，无 corruption。
7. 决策史为最后一段（无下个 H2）→ 替换到 EOF，文件尾单换行。
8. 多 token → `warn` 一次（且仅一次）。

### `test/sync.test.js` — `finalizeSync` 集成
9. 仿现有 fixture：component 页用「标题 + token」，journal 两条 lib 原子（真实可达 sha，复用 `realSha`）→ finalize → 页面含哨兵区间 + 两条、无 token；**再 finalize 一次** → 仍单区间两条（幂等不累积）。

## 改动清单
- 改 `lib/sync.js` `foldJournal`（重写）+ 新增哨兵 / 标题常量。
- 改 `test/sync.test.js`：重写 `foldJournal` 单测（旧 token 语义 → 新 section/哨兵语义）+ 集成幂等用例。
- `renderDecisionHistory` / `lib/fold.js` / `lib/journal.js` / init 模板 不动。
- dogfood：`node lib/sync.js finalize .lore` 自愈 lib.md，`chore(lore)` 收口（含上轮搁置的 journal 尾巴）。
- CHANGELOG：发版补「修复：决策史 section 幂等重建，根治页面累积」。

