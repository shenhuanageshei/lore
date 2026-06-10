---
title: lore docs 轴重构（分组置顶 + feature 配对 + 默认折叠）—— 设计
summary: - 日期：2026-06-10 - 状态：设计已批，待写实施计划 - 北极星：人读 + agent 双友好；本期专攻 **docs 轴可发现性**（54 页流水一锅烩 → 分组分流） - 痛点出处：用户 dogfood review 原话「DOCS 里的 changelog、roadmap、todo、踩坑记录应该单独挪出去，不然不好找到」 - 前置（已在 main）：docs 轴 v2（物化...
source_path: docs/superpowers/specs/2026-06-10-lore-docs-axis-regroup-design.md
last_updated: 2026-06-10
group: 设计与计划
paired_plan: superpowers-plans-2026-06-10-lore-docs-axis-regroup
---
> 源文档：`docs/superpowers/specs/2026-06-10-lore-docs-axis-regroup-design.md`

# lore docs 轴重构（分组置顶 + feature 配对 + 默认折叠）—— 设计

- 日期：2026-06-10
- 状态：设计已批，待写实施计划
- 北极星：人读 + agent 双友好；本期专攻 **docs 轴可发现性**（54 页流水一锅烩 → 分组分流）
- 痛点出处：用户 dogfood review 原话「DOCS 里的 changelog、roadmap、todo、踩坑记录应该单独挪出去，不然不好找到」
- 前置（已在 main）：docs 轴 v2（物化视图，`lib/docs.js` 三 extractor）、B 轮 manifest `group` 字段管道、C-呈现① 侧栏 `.grp` 分组小标题机制

## 背景 / 问题

dogfood docs 轴 54 页按 `last_updated` 降序一锅排：

- 50 页是 `superpowers/{specs,plans}/` 流水，同 feature 的 spec 与 plan title 几乎一样（「…—— 设计」vs「…Implementation Plan」）交错混排；
- changelog 淹没在时间流中段，ROADMAP 因无日期垫底——**高频入口最难找**；
- 侧栏一屏放不下，找一个 feature 的设计资料要肉眼扫两遍。

## 决策（已锁，mockup 已确认）

| 项 | 决策 |
|---|---|
| 分流形态 | **docs 轴内分组置顶**（不拆新轴——轴是重概念；不只靠 HOME 链接——治标）。复用 component 轴的 `.grp` 小标题机制 |
| 组织方式 | **B+C 组合**（三选项 mockup 用户选定）：feature 配对行 + 长组默认折叠 |
| 分组规则 | **硬编码启发式，不加 config**（YAGNI）：`docs/superpowers/specs/**`、`docs/superpowers/plans/**` → 「设计与计划」；`docs/superpowers/notes/**` → 「notes」；其余（docs 根级文件 + changelog/pitfalls 折叠页）→ 「**项目状态**」置顶。无 superpowers 结构的 repo 全落「项目状态」单组 = 行为同现状，零破坏 |
| 配对规则 | superpowers 命名约定机械识别：`specs/<date>-<slug>-design.md` ↔ `plans/<date>-<slug>.md`（同 date+slug）。spec 页 entry 加 `paired_plan: <plan页id>`；**被配对的 plan 不单独占行**（仍是独立页：可直链、可搜索、graph 不变）。孤 spec / 孤 plan / notes 正常单行 |
| 配对行显示名 | spec title 机械剥固定模板尾巴（`—— 设计` / ` Implementation Plan`，含全半角空格变体）。不剥「lore 」前缀（别的 repo 没有，规则不通用） |
| 排序 | 组间固定序：项目状态 → 设计与计划 → notes；组内保持现有时间降序（`last_updated` desc，无日期垫底） |
| 折叠 | 「项目状态」默认展开；「设计与计划」「notes」**默认折叠**，组头 `▶ 📐 设计与计划 (26)` 可点 toggle；展开状态存 localStorage（key `lore-docs-groups`，同主题记忆模式） |
| 搜索穿透 | 搜索词命中折叠组成员 → 该组临时自动展开（只显命中行）；清空搜索 → 回 localStorage 记忆态。**折叠不藏内容** |
| group 落点 | `docs.js` 物化时写进页 frontmatter（`group:` / `paired_plan:`），manifest `pageEntry` 透传（`group` 字段管道 B 轮已有；`paired_plan` 新增透传） |
| 主题硬约束 | 新 CSS（plan 徽标、折叠组头）全部主题变量，禁止硬编码色值（延续 B1 约束） |

## 设计

### A · 数据层（`lib/docs.js`）

```
docGroup(sourcePath) -> '设计与计划' | 'notes' | '项目状态'
  // 'docs/superpowers/specs/...' | 'docs/superpowers/plans/...' → 设计与计划
  // 'docs/superpowers/notes/...' → notes
  // 其余（含折叠页 changelog/pitfalls，sourcePath 为 CHANGELOG.md / CLAUDE.md）→ 项目状态

pairDocs(entries) -> entries（就地标注）
  // specs/<date>-<slug>-design ↔ plans/<date>-<slug> 同 date+slug：
  //   spec entry 加 paired_plan: <plan 的页 id>
  // date 取 extractDate(rel)；slug = 文件名去 date 前缀去 -design 后缀
```

- `buildDocsAxis` 物化每页时 frontmatter 增写 `group:`，spec 页有配对时增写 `paired_plan:`。
- changelog / pitfalls 折叠页同样写 `group: 项目状态`。

### B · manifest（`lib/manifest.js`）

- `pageEntry` 的 `group` 现状仅来自 pageGroups map（component 用）→ 改为 **frontmatter 优先、map 兜底**（`data.group ?? pageGroups[id] ?? ''`，一行；component 页 frontmatter 无 group，行为不变）。`paired_plan` 同样从 frontmatter 透传。
- docs 轴排序：组间固定序（项目状态 0 → 设计与计划 1 → notes 2 → 其他值 3 垫底防御），同组内保持现有时间降序。**排序单一来源在 manifest**——壳不重排。

### C · 壳纯函数（`site/shell.mjs`）

```
buildDocsRows(pages) -> [
  { group: '项目状态', collapsed: false, rows: [{ page, planPage: null, displayTitle }] },
  { group: '设计与计划', collapsed: true,  rows: [{ page: specPage, planPage, displayTitle }] },
  { group: 'notes',     collapsed: true,  rows: [...] },
]
```

- **按 manifest 给定顺序消费**（排序单一来源在 manifest），按 group 值连续分段（同 component 侧栏的 lastGroup 逻辑）；配对（paired_plan → 找 planPage，找不到则当孤页）、被配对 plan 从行列表剔除、显示名剥尾。
- `collapsed` 默认值：「项目状态」false，其余组 true；壳层与 localStorage 合成最终态。组头计数 N = rows.length（配对行算 1）。

### D · 壳渲染（`site/index.html`）

- `buildSidebar` docs 分支改用 `buildDocsRows`：
  - 组头：`<div class="grp grp-toggle" data-group="...">▸/▶ 📌 项目状态 (N)</div>`（可点组头仅 docs 轴；component 轴组头保持现状不可点）
  - 配对行：`<a href="#docs/<spec-id>">displayTitle<span class="when">📅 date</span></a><a class="plan-badge" href="#docs/<plan-id>">plan</a>`
  - 折叠组的行加 `.grp-hidden`（CSS display:none）
- toggle：点组头翻转该组 → 写 localStorage `lore-docs-groups`（JSON：`{"设计与计划": true}` = 用户展开过）
- 搜索穿透：`wireSearch` 里命中行若在折叠组 → 临时移除 `.grp-hidden`（搜索态标记）；清空时按记忆态恢复
- CSS：`.plan-badge`（描边胶囊，主题变量）、`.grp-toggle`（cursor:pointer + caret 旋转）、`.grp-hidden`
- 轮询 `buildSidebar` 重建后折叠态自然从 localStorage 恢复（与 B1 的 active/搜索恢复并列）

### 不动

- graph / ask / lint / 翻译（docs 页本体与 id 不变，只加 frontmatter 字段与侧栏呈现）
- portal / python serve（纯静态数据 + 壳渲染，三形态通用）

## 测试

### `test/docs.test.js`（扩展）
1. `docGroup`：specs/plans → 设计与计划；notes → notes；根级/折叠页 → 项目状态。
2. `pairDocs`：同 date+slug 配对（spec 得 paired_plan）；date 同 slug 异不配；孤 spec/孤 plan 不标。
3. `buildDocsAxis` 物化页 frontmatter 含 `group:`；配对 spec 含 `paired_plan:`。

### `test/manifest.test.js`（扩展）
4. docs 轴排序：组间固定序 + 组内时间降序；`paired_plan` 透传进 page entry。

### `test/shell.test.js`（扩展）
5. `buildDocsRows`：归组/配对行（planPage 解析）/被配对 plan 剔除/孤页保留/显示名剥尾（两种模板尾巴）/组序行序/未知组兜底。

### dogfood 手动清单
6. 侧栏：54 行 → 约「项目状态 3 + 设计与计划 ~26（默认折叠）+ notes 2（默认折叠）」；changelog/ROADMAP 置顶可见。
7. 展开「设计与计划」→ 配对行 + plan 徽标点击直达 plan 页；刷新后展开态保持（localStorage）。
8. 搜索「console」→ 折叠组自动展开显示命中行；清空 → 恢复折叠。
9. 三主题切换徽标/组头配色跟随。

## 改动清单

- `lib/docs.js`（docGroup + pairDocs + frontmatter 增写）
- `lib/manifest.js`（docs 组排序 + paired_plan 透传）
- `site/shell.mjs`（buildDocsRows）
- `site/index.html`（docs 分支渲染 + 折叠 toggle + 搜索穿透 + CSS）
- `test/{docs,manifest,shell}.test.js` 扩展
- dogfood：finalize 重建 + `.lore/site/` 同步（index.html + shell.mjs）+ 手动清单
- `docs/ROADMAP.md`（标记完成）

## 不变量 / 风险

- 零依赖不破；docs 页 id/路径不变（链接/graph/翻译稳定）。
- 无 superpowers 结构 repo：单「项目状态」组、无配对、无折叠 → 视觉同现状。
- 配对启发式只认 superpowers 命名——错配风险低（date+slug 双键）；错配后果轻（只是侧栏行合并，两页本体完好）。
- localStorage 不可用（隐身）→ 默认折叠态，功能不损。

## 实现节奏

spec → writing-plans → plan → TDD → 审查 → 合并。

