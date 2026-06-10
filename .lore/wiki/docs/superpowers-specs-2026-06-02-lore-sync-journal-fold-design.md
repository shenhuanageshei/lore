---
title: sync 折叠 journal — 决策历史机械渲染 + token 注入
summary: > 设计文档 (spec) · 2026-06-02 · 子项目 **sync 折叠 journal（消费者侧）** · 状态: 已 brainstorm 收敛，待转实施计划 > > 母 spec: `docs/superpowers/specs/2026-05-31-lore-repo-wiki-design.md` §5（合成，line 200「决策历史段多为机械拼装」） > 前置: `...
source_path: docs/superpowers/specs/2026-06-02-lore-sync-journal-fold-design.md
last_updated: 2026-06-02
group: 设计与计划
paired_plan: superpowers-plans-2026-06-02-lore-sync-journal-fold
---
> 源文档：`docs/superpowers/specs/2026-06-02-lore-sync-journal-fold-design.md`

# sync 折叠 journal — 决策历史机械渲染 + token 注入

> 设计文档 (spec) · 2026-06-02 · 子项目 **sync 折叠 journal（消费者侧）** · 状态: 已 brainstorm 收敛，待转实施计划
>
> 母 spec: `docs/superpowers/specs/2026-05-31-lore-repo-wiki-design.md` §5（合成，line 200「决策历史段多为机械拼装」）
> 前置: `docs/superpowers/specs/2026-06-01-lore-journal-mine-design.md`（journal 基座 + mine，生产者侧）· `docs/superpowers/specs/2026-06-01-lore-sync-design.md`（sync v1，决策历史当时填占位）

---

## 0. 背景：闭合 capture → synthesize

数据流 `捕获 → journal → sync → wiki → serve`。`/lore:mine` 往 journal 写 commit 原子（生产者）；`/lore:sync` 产 component 页，但「决策历史」段一直是占位「暂无 journal 原子」。本 spec 让 **sync 消费 journal** —— 把原子机械渲染进每页的决策历史段，mine 的成果终于上 wiki。

母 spec §5 line 200：「决策历史段**多为机械拼装**（journal 已存原子，LLM 只写串联 + 按子专题分组）」。→ v1 走**纯机械渲染**（Node，无 LLM）；LLM 串联/子专题分组推迟。

## 0.5 依赖（关键 — 实施前置）

本功能消费 `lib/journal.js` 的 **`readAllAtoms(journalDir)`**，该模块由 journal+mine 活儿建（`docs/superpowers/plans/2026-06-01-lore-journal-mine.md` 的 Task 2-4）。**当前 journal+mine 只完成 Task 1（抽 `lib/config.js`）**；`lib/journal.js` / `lib/mine.js` 尚未实现。

→ **本 spec 的实施 BLOCKED**，直到 journal 基座（至少 `readAllAtoms`）存在。推荐顺序：先完成 journal+mine（Task 2-12）→ 再实施本 spec。两者同在分支 `lore-journal-mine`。端到端验收（mine → sync → 原子上页）也需 `lib/mine.js` 在场。

---

## 1. 范围

`finalizeSync` 读 journal、按 component facet 过滤原子、机械渲染决策历史段、token 注入页、盖**每页真计数**。新增纯函数 `renderDecisionHistory`。改 `lib/sync.js` + `commands/lore-sync.md` + 测试 + README 微调。

**推迟**：LLM 串联 / 子专题分组 · flow/theme 折叠 · note/incident 原子特化渲染（commit 通用渲染，未来 kind 复用）· 增量（仍全量重渲）。

**决策记录（brainstorm）**：
- *渲染归属*（用户拍板）：选 M「机械渲染（Node）」而非 A「agent 写」/ H「混合」。全确定性可测、agent 职责不变、合母 §5「机械拼装」。
- *注入机制*（用户拍板）：选 T「token 替换」而非 S「段落替换」。显式契约、不解析 markdown 结构、向后兼容（无 token 页不崩）。

**核心不变量**：仍只写 `.lore/wiki/`；只读 `.lore/journal/`；不碰业务源码；纯确定性。

---

## 2. 架构（文件）

```
lib/sync.js            # 改：+ renderDecisionHistory；finalizeSync 加 journal 折叠 + token 注入 + 每页真计数
commands/lore-sync.md  # 改：agent 写 {{LORE_JOURNAL}} 占位符；提示更新；删「journal 折叠推迟」
test/sync.test.js      # 改：+ renderDecisionHistory 单元 + finalize-with-journal + 向后兼容 + 集成
README.md              # 改：sync 段微调（决策历史现接 journal）
```

**复用（不改）**：`lib/journal.js` 的 `readAllAtoms`（新 import 进 sync.js）。`stampFrontmatter` 已参数化 `{atoms, commits}` —— 无需改签名，finalize 传每页真计数即可。

---

## 3. `renderDecisionHistory(atoms)` 契约（纯函数，锁定）

```
renderDecisionHistory(atoms) -> string
```
- **空数组** → `暂无 journal 原子（跑 /lore:mine 补全）。`
- **非空** → 按 `ts` **倒序**（新→旧）的 markdown bullet 列表，每条一行：
  - 有 why：`- **<title>** — <why 首行> (<short-sha>, <YYYY-MM-DD>)`
  - 无 why（空串）：`- **<title>** (<short-sha>, <YYYY-MM-DD>)`
  - `short-sha` = `atom.commit.slice(0, 7)`；`date` = `atom.ts.slice(0, 10)`；why 首行 = `atom.why.split('\n')[0].trim()`。
- 输入不变（不排序原数组 → 用 copy 排序）。纯输入→输出，node:test。

---

## 4. `finalizeSync` 改动

现状（sync v1）：每页 `stampFrontmatter(read(p), {codeSha, lastUpdated, commits:0, atoms:0})` → write；建 INDEX；emit manifest。

改为（在 stamp 循环内）：
- 函数顶部读一次：`const allAtoms = readAllAtoms(join(loreDir, 'journal'))`。
- 每页（`component = basename(f, '.md')`）：
  1. `const atomsFor = allAtoms.filter(a => a.facets?.component?.includes(component))`
  2. `const md = renderDecisionHistory(atomsFor); let text = readFileSync(p, 'utf8').replace('{{LORE_JOURNAL}}', () => md)`  ← token 注入（**函数式替换**，见 §5）
  3. `text = stampFrontmatter(text, { codeSha, lastUpdated, atoms: atomsFor.length, commits: atomsFor.filter(a => a.kind === 'commit').length })`  ← **每页真计数**（旧的共享 `fields` 拆成每页算）
  4. `writeFileSync(p, text)`
- 顺序：read → inject token（body 内替换）→ stamp（保 body）→ write。

返回值 `{ stamped, indexWritten, manifestPath }` 形状不变。

---

## 5. token 注入

- 占位符常量 `{{LORE_JOURNAL}}`（agent 写在「决策历史」段正文）。
- **函数式替换** `text.replace('{{LORE_JOURNAL}}', () => md)` 替**首个**出现。**必须用函数形式**（不是字符串 `replace(token, md)`）—— 渲染串 `md` 可能含 commit message 里的 `$&`/`$1`/`$$`，字符串替换会特殊解释它们、损坏输出；函数替换原样插入。
- 页**无** token（旧页 / agent 漏写）→ replace 无操作 → 仅盖计数、不注入、不崩（向后兼容）。

---

## 6. INDEX 计数

INDEX（机械 TOC）盖**全 journal 总数**：
```
atoms = allAtoms.length
commits = allAtoms.filter(a => a.kind === 'commit').length
```
反映「wiki 由 N 原子合成」。（component 页是各自过滤的子集计数。）

---

## 7. 命令改（`commands/lore-sync.md`）

- 顶部介绍行（line 7）：删「flow/theme/journal 折叠推迟」→「flow/theme 推迟」。
- 页模板「决策历史」段（合成步骤 2）改为：
  ```
  ## Decision history

  {{LORE_JOURNAL}}
  ```
- 给 agent 的提示：「决策历史」段写占位符 `{{LORE_JOURNAL}}` —— **finalize 自动**用 journal 原子机械填充（按 component facet 过滤、ts 倒序）。删旧「『决策历史』段本版填占位（journal 未接）」行。

---

## 8. 错误 / 边界

- 无 `.lore/journal/` → `readAllAtoms` 返 `[]` → 全页决策历史「暂无」占位 + 计数 0。优雅（无 mine 也能 sync）。
- component 无匹配原子 → 「暂无」占位 + 计数 0。
- 页无 token → 仅盖计数（不注入）。向后兼容旧 sync 产的页。
- 全量重建语义不变：每 sync 重渲决策历史（journal 是真相源；同 journal → 同渲染，结构幂等）。
- `atom.facets?.component` 用可选链防畸形原子（无 facets → 不匹配，不崩）。

---

## 9. 测试（全确定性 node:test）

- **`renderDecisionHistory`**：空→占位；含 why→bullet 带 why+sha+date；无 why→省略 why 段；多原子按 ts 倒序；不改入参数组。
- **`finalizeSync` with journal**：临时 git repo + `journalDir` 放两条 `facets.component:['lib']` 的 commit 原子（一条带 why、一条空 why）+ 写 `component/lib.md`（含 `{{LORE_JOURNAL}}` token）→ finalize → 页含渲染 bullet（token 消失、ts 倒序）、front-matter `atoms:2`/`commits:2`。另写个无匹配原子的 `component/other.md` → 「暂无」+ `atoms:0`。
- **向后兼容**：页**无** token（旧占位文案）→ finalize 不崩，盖计数（atoms 反映该组件原子数）。
- **集成**：真 git repo → `init`（config code_roots:[lib]）→ 写带 token 的 `component/lib.md` → `lib/mine.js`（填 journal）→ `lib/sync.js finalize` → 断言页决策历史含该 commit 的 title + manifest 该页 `synthesized_from.atoms > 0` + serve fetch 该页 200 含渲染内容。（此集成依赖 `lib/mine.js` 在场 —— 见 §0.5。）

---

## 10. 验收

1. finalize 用 journal 原子（component facet 过滤、ts 倒序）替 `{{LORE_JOURNAL}}`。
2. front-matter `atoms`/`commits` = 该组件折叠原子数 / commit 数；manifest `synthesized_from` 反映。
3. 无 journal / 无匹配 → 「暂无」占位，优雅。
4. 全确定性 node:test 覆盖（renderDecisionHistory + finalize-with-journal + 向后兼容）。
5. 端到端：mine → sync → 原子上 component 页 + serve 可见。
6. 向后兼容：无 token 页不崩，仍盖计数。

---

## 11. 不在范围 / 推迟

- LLM 串联 / 子专题分组（母 §5「LLM 只写串联+分组」）。
- flow/theme 折叠（需 flow/theme facet，依赖 mine 的层 2 + sync 的 flow/theme 页）。
- note/incident 原子特化渲染（v1 commit 通用渲染；future kind 复用同 bullet）。
- 增量重渲（仍全量；增量指纹推迟）。

---

## 12. 开放问题

- **why 多行/超长**：v1 只取首行。完整 why 留给点进原子/未来 LLM 串联。
- **同组件大量原子**：v1 全列（无分页/截断）。子专题分组 + 截断推迟。
- **INDEX 计数含全原子 vs 仅 component 折叠的**：选全 journal 总数（含未匹配任何 component 的原子，反映 journal 规模）。

---

*参考：母 spec §5 · 前置 journal+mine spec（§0.5 依赖）· sync v1 spec · 本 spec 经 brainstorming 收敛（渲染归属 M、注入机制 T 两处用户拍板）。*

