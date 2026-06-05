---
title: theme 轴端到端（§4 层2 + sync 多轴）
summary: > 设计文档 · 2026-06-03 · 子项目 **theme 轴 v1** · brainstorm 收敛 > 母 spec §4（facet 层2：config match 关键词）+ §5（多轴合成）。前置：mine/hook/note + sync 折叠 + config + manifest（已支持任意轴 AXIS_ORDER）全合并。flow 轴 = 下一循环。
source_path: docs/superpowers/specs/2026-06-03-lore-theme-design.md
last_updated: 2026-06-03
---
> 源文档：`docs/superpowers/specs/2026-06-03-lore-theme-design.md`

# theme 轴端到端（§4 层2 + sync 多轴）

> 设计文档 · 2026-06-03 · 子项目 **theme 轴 v1** · brainstorm 收敛
> 母 spec §4（facet 层2：config match 关键词）+ §5（多轴合成）。前置：mine/hook/note + sync 折叠 + config + manifest（已支持任意轴 AXIS_ORDER）全合并。flow 轴 = 下一循环。

## 0. 背景
component 轴（代码结构）已端到端。theme 轴 = **横切主线**（质量/性能/时效…），靠 config `match:` 关键词自动给 commit 原子打标，sync 产 theme 页。补 lore 多轴第二轴。

## 1. 范围（用户拍板 A + match=子串）
- 扩 `lib/config.js`：`parseConfigThemes`（读 config theme values 的 id+match）。
- 扩 `lib/mine.js`：`tagThemes`（纯，关键词子串）+ `commitAtom` 加 `themes` 参 → `facets.theme`。`mineCommits` 读 config themes 传入。
- 扩 `lib/hook.js`：`captureHead` 读 config themes 传 commitAtom。
- 扩 `lib/sync.js`：`planSync` 加 theme worklist；`finalizeSync`+`buildIndex` 从 component-only **泛化为按轴循环**（component+theme）。
- 改 `commands/lore-sync.md`：agent 也写 theme 页。
**推迟**：flow 轴 · regex match · theme `desc` 渲染 · note 自动 theme 推断（agent 手标）。

## 2. config theme 解析
`parseConfigThemes(configText) -> [{id, match:[...]}]`：逐行扫，`trim().startsWith('- {')` 且含 `match:` → theme 项（flow 项用 `spans` 区分）；正则抽 `id:\s*([\w-]+)` + `match:\s*\[([^\]]*)\]`（字段序无关）；match 逗号分割去引号去空。**注释行（`#` 开头）跳过** → init 默认（示例注释掉）→ `[]`。

## 3. theme 打标（层2，纯）
`tagThemes(text, themes) -> string[]`：`const lower=text.toLowerCase()`；某 theme 任一 `match` 关键词（lowercased）是 lower 的子串 → 收该 `theme.id`；去重排序。

## 4. producer 打标
`commitAtom(raw, codeRoots, source='miner:commits', themes=[])` 加第 4 参 → `facets.theme = tagThemes(raw.subject + ' ' + raw.body, themes)`（其余不变；默认 themes=[] → theme:[] 同现在，旧调用+测试不回归）。
- `mineCommits(repoRoot, codeRoots)`：读 `<repoRoot>/.lore/config.yml` 的 themes（`parseConfigThemes`），传 `commitAtom(raw, codeRoots, 'miner:commits', themes)`。
- `captureHead`：同读 config themes 传 `commitAtom(..., 'hook', themes)`。

## 5. sync 多轴泛化（核心）
- **`planSync(loreDir) -> {codeRoots, themes, worklist}`**：worklist 每项加 `axis`。component 项 `{axis:'component', id, codeRoot, path:'component/<id>.md', priorExists}`（保留 `component` 别名=id 兼容）；theme 项（每 config theme.id）`{axis:'theme', id, path:'theme/<id>.md', priorExists}`。
- **`finalizeSync`**：`const AXES=['component','theme']`。按轴循环：每 `wiki/<axis>/*.md`（无该 dir → skip 该轴）→ `id=basename`，`atomsFor=allAtoms.filter(a=>a.facets?.[axis]?.includes(id))`，render→注入 token→盖（per-page atoms/commits 计数）。收集 `axisPages[axis]=[{id,title}]`。
- **`buildIndex(axisPages)`**：签名从 flat array 改 **对象**（axis→pages）；按 `['component','theme','flow']` 出非空轴的 `## <Heading>` 段 + `[[id]]`。INDEX 仍盖 grand totals。
- manifest/serve 已支持 flow/theme 轴（`AXIS_ORDER` 含）→ theme 页自动被收 + serve 侧栏显。

## 6. 命令改（`commands/lore-sync.md`）
合成步骤：agent 除 component 页，对每个 theme worklist 项写 `theme/<id>.md`（读该 theme 标的原子 + 写该主线叙事 `## Current state`/`## Decision history`=`{{LORE_JOURNAL}}`/`## Cross-links`）。提示：theme 页讲「这条横切主线怎么演进」，决策历史 token 自动折该 theme 原子。

## 7. 测试（确定性 node:test）
- `parseConfigThemes`：注释示例→[]；取消注释/多项→[{id,match}]；字段序无关；flow 项（spans 无 match）不误收。
- `tagThemes`：含关键词→标；大小写无关；多 theme；无匹配→[]；不改入参。
- `commitAtom`：themes 参 → facets.theme（默认[]）；旧 2/3 参调用不回归。
- `mineCommits`/`captureHead`：临时 repo + config 有 theme + commit 含关键词 → 原子 facets.theme 含该 id。
- `planSync`：component+theme worklist（axis 字段）。
- `finalizeSync` 多轴：写 component/ + theme/ token 页 + journal 有 component/theme 标的原子 → 两轴页都折对 + 计数；INDEX 含 `## Component` + `## Theme`。
- `buildIndex`：对象签名 → 多轴段。
- 集成：init→config 填 theme→commit 含关键词→`mine`→sync finalize（手放 theme token 页）→theme 页含该 commit + manifest theme 轴有页。
- 全套绿（component-only 老测试随 buildIndex/finalize 签名改而更新，不回归行为）。

## 8. 验收
1. config theme 关键词 → commit 原子 `facets.theme` 自动打标（mine+hook）。
2. sync 产 `theme/<id>.md` 页，折该 theme 标的原子；INDEX/manifest/serve 含 theme 轴。
3. 多轴泛化：component + theme 同机制（`facets[axis]`），flow 以后加轴名即可。
4. 零依赖；component 轴不回归。

## 9. 不在范围
flow 轴 · regex match · theme desc 渲染 · note 自动 theme · 增量。

## 10. 开放问题
- **theme 页无原子**：某 config theme 无任何标中原子 → 页决策历史「暂无」（同 component 空页）。worklist 仍列（提示该主线还没料）。
- **buildIndex 签名变**：破 flat-array 调用 → 同步改 finalizeSync 调用 + 测试（本 spec 内）。

