---
description: 合成 wiki —— 读 config 组件 + 源码，每个 code_root 产一页 component/<name>.md（LLM 写架构），建 INDEX + emit manifest
---

# /lore:sync

把代码合成进 wiki：每个 `config.yml` 的 `code_root` 产一页 `component/<name>.md`（「当前架构」段由你读源码写），再机械建 `INDEX.md` + `.manifest.json`。本版产 component + theme + flow 三轴页。

## 用法

- `/lore:sync` —— 在当前仓库根目录合成 wiki

## 行为（O1 两阶段）

本命令编排 `lib/sync.js`：

1. **plan**（机械，增量）：
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/lib/sync.js" plan "$(pwd)/.lore"
   ```
   输出 worklist JSON：`{ codeRoots, worklist:[{component, codeRoot, path, priorExists, stale, reason}] }`。
   worklist 空 → 提示先 `/lore:init`（或编辑 `.lore/config.yml` 填 `code_roots`），停止。

   > 增量：`plan` 默认只列「代码动过」的 component 页（据 `.state/fingerprints.json` 指纹，`reason: new|code-changed`）；HOME/theme/flow 仍全列。要强制全量（首跑 / 大改后 / 兜底）：`node "${CLAUDE_PLUGIN_ROOT}/lib/sync.js" plan "$(pwd)/.lore" --all`。
   > 提交即刷新：装了 post-commit hook 的 repo，每次 commit 会后台自动跑机械 `finalize`（决策史 / docs / 状态 / `stale` 准实时、零 LLM、不挡 commit）；架构 prose 仍按 `plan` 增量、由 agent 重写。

## 用户排队的重写请求（B1 控制台）

plan 之前先读 `<loreDir>/.state/rewrite-requests.ndjson`（每行 `{ts, page, instruction?}`；缺文件 = 无请求）：

1. 队列里的页**优先**进 worklist——即使指纹判 fresh 也入（`reason: "user-requested"`）：用户点名 = 显式意图，高于机械判定。
   - 该条目带 **`instruction`**（重写/改进语义）→ **按用户指令重写**该页（如「精简概览段」「加调用例子」「换叙述角度」），在保持两档页面标准前提下满足；无 instruction（排队/同步语义）→ 通用重写（读最新代码追上）。
2. 每重写完一页，从队列移除该条目：读全文件 → 过滤掉该 page 的行 → 整体重写文件（队列小、无并发，覆盖写可接受）。
3. 全部消化后若文件空，删除或留空文件皆可（readRewriteRequests 都按空处理）。
4. auto 档下该队列由后台 runner 自动消化（质量门把关）；会话内消化仍然有效（先到先得）。

> 写机制档「⑤ 边界 / 坑」时：源自设计决策的条目，勾稽 spec 出处——格式 `←（决策见 docs 轴 <spec-slug>）`，agent 能从 component 页一跳到决策原文。

2. **合成**（你来，逐 worklist 项）：读该 `codeRoot` 的实际源码，写 `.lore/wiki/<path>`，格式：
   ```markdown
   ---
   title: <组件显示名>
   summary: <一行语义摘要>
   ---
   # component: <name>

   ## Current architecture

   <先放一张 mermaid 架构图（flowchart：入口 / 关键模块 / 依赖方向，~5-15 节点），再写架构 prose：入口、关键模块、数据流、职责。非泛词。>

   ## Decision history

   {{LORE_JOURNAL}}

   ## Cross-links

   - [[<相关 sibling 组件>]]
   ```

对每个 `axis:'theme'` 的 worklist 项，写 `.lore/wiki/theme/<id>.md` —— 同 component 页结构，但讲「这条横切主线怎么演进」：

   ```markdown
   ---
   title: <主线显示名>
   summary: <一行摘要>
   ---
   # theme: <id>

   ## Current state

   <这条主线的当前状态/约束/为什么重要>

   ## Decision history

   {{LORE_JOURNAL}}

   ## Cross-links

   - [[<相关组件或主题>]]
   ```

   finalize 会把标了该 theme 的 journal 原子自动折进 `{{LORE_JOURNAL}}`（按 `facets.theme` 过滤）。

对每个 `axis:'flow'` 的 worklist 项，写 `.lore/wiki/flow/<id>.md` —— 讲「这条数据流端到端怎么跑」（入口 → 各阶段经过哪些组件 → 出口）：

   ```markdown
   ---
   title: <数据流显示名>
   summary: <一行摘要>
   ---
   # flow: <id>

   ## End-to-end path

   <先放一张 mermaid 数据流图（flowchart LR：入口 → 各阶段(组件) → 出口），再写 prose：关键转换/约束>

   ## Decision history

   {{LORE_JOURNAL}}

   ## Cross-links

   - [[<spans 里的组件>]]
   ```

   finalize 折标了该 flow 的原子（原子的 component ∈ flow 的 spans → 自动标）。

对 `axis:'HOME'` 的 worklist 项，写 `.lore/wiki/HOME.md` —— 全仓库的人读「认知入口」（不是目录；目录仍是 `INDEX`）。

   ### HOME page

   When the worklist contains `{ "axis": "HOME", "id": "HOME" }`, write `.lore/wiki/HOME.md` in this order:

   1. One-sentence repository positioning.
   2. `{{LORE_HOME_STATUS}}` on its own line.
   3. A `## Knowledge flow` section with a Mermaid diagram.
   4. A `## Understand the project` section with wikilinks.
   5. A `## Debug a problem` section with wikilinks.
   6. A `## Decisions and timeline` section with wikilinks.

   Do not write mechanical status values by hand; finalize replaces the `{{LORE_HOME_STATUS}}` token and refreshes it in place on every re-sync via a sentinel region.

3. **finalize**（机械）：
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/lib/sync.js" finalize "$(pwd)/.lore"
   ```
   盖机械 front-matter（`code_sha`/`last_updated`/`atoms`/`commits`）+ 建 `INDEX.md` + 写 `.manifest.json`。

## 给 agent 的提示

- 只写 `title` + `summary` 半 front-matter；**别手写 `code_sha`/计数/日期** —— finalize 自动盖。
- 「当前架构」段读真实源码写，别套泛词。
- 「决策历史」段写占位符 `{{LORE_JOURNAL}}` —— finalize 自动用 journal 原子机械填充（按 component facet 过滤、ts 倒序）。标题推荐写 `## Decision history`；也兼容 `## 决策史`、`## 决策历史`、`## 决策历史 (Decision history)`，finalize 后统一为英文 canonical 标题。先跑 `/lore:mine` 让 journal 有料。
- 「交叉链接」段用 worklist 的全组件列表，链相关 sibling。
- 跑完提示 `/lore:serve` 浏览。
- theme 页讲横切主线（质量/性能/时效…）的演进，决策历史 token 自动折该 theme 的原子；先确保 config 的 `theme.values` 填了 + 跑过 `/lore:mine` 让原子带 theme facet。
- flow 页讲一条数据流端到端怎么跑（入口→阶段→出口）；先在 config 的 `flow.values` 用 `spans:[组件…]` 声明、跑过 `/lore:mine` 让原子带 flow facet。
- **theme / flow 排版**：单档页（`Current state` / `End-to-end path`）易写成一大段密集文字——用 `###` 小标题切 3-6 段，枚举/对照/规则用列表或表格承载，单段控制 ~150 字内（component 两档不受此限）。
- **docs 轴**（若 config 声明 `axes.docs`）由 finalize **机械生成**（读当前 `docs/**/*.md` + `CHANGELOG.md` + `CLAUDE.md` 踩坑 → `wiki/docs/<id>.md`，nuke-rebuild）。你（agent）**不用**写 docs 页。
- **出图**：component 页「Current architecture」顶部放一张 mermaid 架构图（入口/关键模块/依赖），flow 页「End-to-end path」顶部放数据流图（入口→各阶段(组件)→出口）。据真实代码画、~5-15 节点、保持可读；图是文本 → git 可 diff、随历史演进。坏语法不阻断页面但会丢该图；label 避免裸 `"`/`<`（壳已转义，简洁优先）。
- 零侵入：只写 `.lore/wiki/`，绝不改业务源码。

**出图速记**（component=架构图，flow=数据流图，各放该页首段顶部）：

```mermaid
flowchart TD
  A[入口] --> B[关键模块] --> C[出口]
```

## 内容质量标准（两档好页 + 深度页）

每页正文按**两档**写，范例见 `docs/superpowers/notes/2026-06-08-lore-golden-page-sync.html`：

- **概览档**（默认展示，目标「30 秒读懂」）：一句话定位 + 类比 · 主干 mermaid 图 · 用**场景**串讲核心机制 · 讲「为什么这么设计」。**零黑话**：内部术语（如 `prose_sha`）首次出现就地用大白话锚定，别预设读者懂。
- **机制档**（`<details>` 折叠，给查 BUG / 改代码的人和 agent）：⓪ 调用入口&I/O（读写哪些文件）· ① 接口签名 · ② 模块内数据流 · ③ 数据契约 schema · ④ 状态机 · ⑤ 边界/坑 · ⑥ 故障地图（症状→定位）· ⑦ 测试锚点 · ⑧ 不变量。
- **枚举型事实出表，宁全勿略**：入口全景（功能从哪几条路进来）、途径/分发 dispatch 表、跳过/拒绝原因全集——散在多个文件的同主题清单恰是 wiki 相对源码的最高价值内容（对照实验实证：这类问题读源码要 40+ 次工具调用，读 wiki 一张表就够——前提是表在）。
- **锚点锚符号**：写 `resolveProseSha @ lib/sync.js`，**绝不写行号**（行号一改代码就 stale）。

**两层粒度**：
- **鸟瞰页**（`component/<code_root>`，如 `lib`）：只要**概览档** —— 系统定位 + 模块间架构图 + 模块清单（每条 `[[深度页]]` cross-link）。不要求 9 节机制档。
- **深度页**（`component/<子模块>`，如 `sync`）：**完整两档**。由 config `axes.component.deep.<root>: [子模块…]` 声明、`plan` 列出（`kind:'deep'`）。**深度页不放 `## Decision history` token**（决策史汇总在鸟瞰页；文件级分流见 ROADMAP 未来项）。深度页条目可写 `<name>.<ext>`（如 `e2e_smoke.sh`）钉住具体文件，消解同名不同扩展（`.py`+`.sh`、`.ts`+`.js`）的歧义——页 id 恒为基名（`component/e2e_smoke.md`），裸名条目行为不变；钉住的文件缺失时 lint 报 `missing-source (pinned file)`，不静默回退。
