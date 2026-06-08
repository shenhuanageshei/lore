# lore 内容质量（两档好页 + 源文件级深度页）—— 设计

- 日期：2026-06-08
- 状态：设计已批，待写实施计划
- 北极星：人读 + agent 双友好的活文档；本期专攻**内容质量 / 完整性**（粒度太粗、深度不足、概览预设黑话）
- 前置（已在 main）：**A 低摩擦合成**（`fingerprint.js` 指纹 / 增量 `planSync` / 提交即机械 `finalize`）、`graph.js` + `mcp.js`（agent 端 graph + `lore_ask/page/neighbors` 已就绪）、`sync.js` / `manifest.js` / `config.js`
- 拆解出处：`docs/superpowers/specs/2026-06-07-lore-portal-design.md` 之后的 A/B/C 拆分。A=低摩擦合成（已合并）、B=控制台/档位/自动 LLM（未做）、C=内容质量。**本文 = C，且聚焦 C-内容**（粒度 + 深度 + prose 标准）；壳 UX（C-呈现）另起一期
- 标杆样例：`docs/superpowers/notes/2026-06-08-lore-golden-page-sync.html`（+ `.md`）—— 本设计所有「好页」标准的具象，以 `sync` 组件为例

## 背景 / 问题

dogfood（lore 自己的 wiki）实测，内容质量有五个症结：

1. **粒度太粗** —— `config.yml` 的 `code_roots: [lib]` 一个 code_root = 一页，整个 `lib/`（22 模块）挤进唯一的 `component/lib.md`，每模块只剩**一句话**。最复杂的 `sync.js`（plan/finalize/指纹/staleScopes）只得到「三步走 + 一句话」。
2. **深度不足** —— 人读想深入 `sync` 内部？没有。agent 用 `lore_page` 取 `"lib"` 拿到的是鸟瞰，要懂 `sync` 还得**回去 grep 源码** → 违背 lore「不用 grep 读文档」的北极星。graph 里整个引擎只有 `page:component/lib` **一个节点**，遍历不到模块级。
3. **决策史全堆一页** —— 114 条原子全在唯一的 component 页（无横切轴分流），列表 100+ 行。
4. **prose 指引偏机械格式** —— `sync.md` 现有指引只说「别泛词 / 出图 / 5-15 节点」，缺系统的「一页好内容该含什么、人读 vs agent 各要什么」标准。
5. **概览预设黑话** —— 即便正文写得不差，概览段若直接抛 `finalize` / `frontmatter` / `prose_sha` 等术语，第一次接触的人云里雾里。

**根因**：内容模型「一个 code_root = 一页」对「引擎型大目录」粒度太粗；且缺一套「好页」内容标准。

## 目标 / 非目标

**目标（C-内容，本期）**：

1. **定义并固化「好 wiki 页」内容标准** —— 两档（概览档 + 机制档）、概览零黑话、机制档 9 节、锚点锚符号。
2. **两层粒度** —— 鸟瞰页 + 源文件级深度页；config 显式声明哪些模块值得深度页。
3. **让 sync 每次自动产出这种页** —— A（prompt 标准）+ B（粒度配置）。

**非目标（留后）**：

- 壳「深度切换 toggle」、mermaid 放大、门户导航 / 排版 → **壳 UX 期（C-呈现）**。本期机制档用 markdown 原生 `<details>` 折叠即可。
- 产出校验（lint 查页完整性，即 brainstorm 中的「C 方案」）→ 等 A+B 跑一阵、若「质量不稳」真成痛点再加（YAGNI；机械只能查「结构在不在」，查不了「写得实不实」，过早做易形式主义）。
- prose 自动重生成、前端控制台、档位、内置 LLM 客户端 → **B（另一期）**。
- 决策史按主题分流（需 theme/flow 轴在 dogfood 落地）→ 关联但非本期核心；深度页可部分缓解（决策史本就按 component facet 过滤，深度页未来若带文件级 facet 可进一步分流）。

## 决策（已锁）

| 项 | 决策 |
|---|---|
| 页结构 | **两档**：概览档（默认展开）+ 机制档（`<details>` 折叠）|
| 概览档 | **零黑话**（术语就地用大白话锚定）· 一句话定位+类比 · 主干图（mermaid）· 场景串讲 · 为什么。目标「30 秒进入」|
| 机制档 | **9 节**：⓪ 调用入口&I/O · ① 接口签名 · ② 模块内数据流 · ③ 数据契约 schema · ④ 状态机 · ⑤ 边界/坑 · ⑥ 故障地图（症状→定位）· ⑦ 测试锚点 · ⑧ 不变量 |
| 锚点 | 锚**符号**（`符号 @ 文件`），**绝不锚行号**（行号一改代码就 stale —— 那正是 lore 要治的病）|
| 粒度 | **两层**：鸟瞰页（code_root 级）+ 深度页（源文件级）。鸟瞰页**只要概览档** + 模块清单（链深度页）；深度页要**完整两档** |
| 深度页声明 | config `component.deep.<code_root>: [子模块…]` **显式声明**；未声明的文件共享鸟瞰页（不强制每个文件都深度页）|
| 深度页路径 | **扁平** `component/<子模块>.md`（模块名在 code_root 内唯一）；鸟瞰页保留，cross-link 表父子。**不用** `component/lib/sync.md` 子目录（破坏现有扁平轴 + serve/manifest 假设）|
| 深度页 stale | 按其**源文件** pathspec 精确算（`staleScopes` 深度页 → `[源文件]`，复用 A 的 scoped staleness）|
| 实现范围 | **A+B**（prompt 标准 + 粒度配置）；C 校验留观察 |

## 设计

### A · prompt 标准（`commands/sync.md`，零引擎改动）

把锁定的 5 条标准 + golden page 链接（当范例）写进 sync 的写页指引。**核心：区分两种页的要求**：

- **鸟瞰页**（`component/lib`）：只要**概览档** —— 系统定位 + 模块间架构图 + 模块清单（每条 cross-link 到深度页）。**不要求** 9 节机制档。
- **深度页**（`component/sync`）：**完整两档** —— 概览档 + 9 节机制档 + 符号锚点。
- flow / theme / HOME：沿用现结构，但套用「概览档去黑话」原则（术语就地解释）。

概览去黑话、锚点锚符号作为硬规则写入。golden page 作为 agent「照着写」的范例。

### B · 粒度配置（源文件级深度页）

**config 语法** —— `component` 下新增 `deep`：

```yaml
axes:
  component:
    discover: auto
    code_roots: [lib]
    deep:
      lib: [sync, manifest, fingerprint, hook, fold, mine]   # 这些源文件各出一张深度页
```

- `deep.<code_root>: [子模块…]`，子模块名 = 源文件名去 `.js`。每个生成 `component/<子模块>.md` 深度页，锚定源文件 `<code_root>/<子模块>.js`。
- 未在 `deep` 声明的文件 → 仍归鸟瞰页（不强制全文件深度页）。

**引擎改动**：

- `config.js`：解析 `deep`（零依赖 YAML 子集，复用现有 `parseConfig*` 写法）→ 返回 `{ codeRoot → [子模块…] }` 或等价结构。
- `sync.js planSync`：除 code_root 鸟瞰页工单外，为每个 `deep` 子模块列**深度页工单**（`{ axis:'component', id:<子模块>, sourceFile:'<code_root>/<子模块>.js', kind:'deep' }`）；增量按**源文件** git 变更算 stale（深度页指纹的 prose_sha 对比其 sourceFile pathspec）。
- `sync.js finalizeSync` + `manifest.js`：深度页是**普通 component 页**，自动进 manifest；`staleScopes` 深度页 → `[sourceFile]`（component 鸟瞰页仍 → `[code_root]`）。
- `graph.js`：深度页自动多出 `page:component/<子模块>` **模块级节点** → agent 能遍历到模块级（北极星 agent 端直接受益），无需改 graph 逻辑（页节点从 manifest axes 派生）。

> 鸟瞰页与深度页都在 `component` 轴、物理扁平；父子关系靠 cross-link wikilink 表达。导航里把深度页缩进显示在鸟瞰页下 = 呈现细节，实施计划里定（可由 INDEX/壳按 `kind:'deep'` + sourceFile 归组）。

### 标杆样例（golden page）

`docs/superpowers/notes/2026-06-08-lore-golden-page-sync.html` 是本设计的具象，已示范：两档结构、概览去黑话、机制档 ⓪–⑧ 九节、符号锚点、`<details>` 折叠切换、鸟瞰/深度两层粒度。实施时 agent 以它为范例产出深度页。

## 测试

可测部分（lib，TDD）：

1. `config.js`：解析 `deep` —— `deep: { lib: [sync, manifest] }` → 正确结构；无 `deep` → 空（向后兼容）。
2. `planSync`：有 `deep` 声明 → 列出深度页工单（带 `sourceFile` + `kind:'deep'`）；增量：动过 `lib/sync.js` → `sync` 深度页入 worklist、未动的深度页跳过；`--all` 全量。
3. `staleScopes`：深度页 → `[sourceFile]`（如 `component/sync.md` → `[lib/sync.js]`），鸟瞰页仍 → `[code_root]`。
4. `manifest` / `graph`：深度页进 manifest（普通 page entry）；graph 多出 `page:component/sync` 节点。
5. **回归**：无 `deep` 声明时，planSync / finalize / manifest / graph 行为与今天完全一致（向后兼容）。

不可测部分（A）：prompt 标准是文档 + agent 行为，非可测 lib —— 靠 golden page 对照 + 人审 + dogfood 实跑验证。

## 改动清单

- 改 `commands/sync.md`（A：5 条标准 + golden page 范例 + 鸟瞰/深度页区分 + 去黑话/符号锚点硬规则）
- 改 `lib/config.js`（解析 `deep`）
- 改 `lib/sync.js`（`planSync` 深度页工单 + 增量按源文件；`finalizeSync` 深度页 `staleScopes`）
- 改 `lib/manifest.js`（确认深度页 `staleScopes` 透传 —— A 期已支持 `staleScopes`，大概率仅需 sync 侧构造）
- `lib/graph.js`（深度页节点自动派生，预期**无需改**，测试确认）
- 新增（已建）`docs/superpowers/notes/2026-06-08-lore-golden-page-sync.{html,md}`（标准标杆）
- 扩展 `test/{config,sync,manifest}.test.js`
- **dogfood 验证**：`.lore/config.yml` 加 `deep`；重写 `lib` 鸟瞰页 + 产出 6 张深度页（sync/manifest/fingerprint/hook/fold/mine），实跑验证标准
- 改 `docs/ROADMAP.md`（C-内容标记进行 / 完成）

## 不变量 / 风险

- **零依赖**不破（纯 Node 内置 + 复用现有解析/指纹/manifest 机制）。
- **向后兼容**：无 `deep` 声明 → 行为完全同今天。深度页是**普通 component 页** → 复用现有 finalize/manifest/graph/指纹全链路，**最小新机制**。
- **风险 1（质量）**：A 无强制，prose 质量靠 AI 照标准写（C 校验留后兜底）。
- **风险 2（粒度）**：深度页靠人工 `deep` 声明（非自动启发式）—— 显式可控，代价是手动维护。
- **风险 3（锚点 stale）**：符号锚点远比行号稳，但符号改名仍会失效；「锚点不 stale」是未来 C 校验 / 工具化话题，本期不解。

## 讨论轨迹 / 决策演变（记录「为什么这么定」）

1. **为什么先 C 不先 B**：B 最重的部分（prose 自动重生成）的产出质量 100% 由「prose 标准 + 内容完整性」决定 —— 先自动化一个没定义好「什么是好页」的产物 = 高速生产平庸内容。**C 是 B2 的输入**，故先行。
2. **agent 端不是空白**：核实发现 `graph.js` + `mcp.js`（`lore_ask/page/neighbors`）**已实现**，ROADMAP「agent 端仍是 0」是陈旧记述。故 A 之后是干净的 B vs C，选了 C。（ROADMAP 这条已 stale，待订正。）
3. **切分轴修正：不是「人 / agent」，而是「概览 / 深挖」**。关键洞察（来自用户）：人也会读代码、查 BUG —— **查 BUG 的人 ≈ 遍历代码的 agent**，要的都是精确完整机制；**想了解的人 ≈ 建上下文的 agent**。读者类型不是维度，**意图才是**。这让「同源分层」更干净：一份内容、两档深度、所有读者按意图取档。
4. **概览必须零黑话**：初版概览的场景串讲直接用 `finalize/frontmatter/prose_sha`，对 onboarding 的人云里雾里。定为硬规则：术语首次出现就地用大白话锚定，内部名（prose_sha 等）推迟到机制档。
5. **机制档从 5 节扩到 9 节**：以「真要 debug」视角自检，原 5 节（接口/数据流/契约/状态机/边界）只够「理解结构」，不够「从症状 debug + 安全改代码」。补 **⓪ 调用入口&I/O**（读写副作用清单）、**⑥ 故障地图**（症状→定位反向索引）、**⑦ 测试锚点**（改了跑什么）、**⑧ 不变量**（debug 标尺，违反即 bug）。
6. **锚点行号 → 符号**：纯行号锚点（`sync.js:187`）代码一改就错 —— 这正是 lore 要治的 stale 病，不能在标准里复发。改锚「符号 @ 文件」（抗漂移）。
7. **实现选 A+B、C 校验留观察**：A 解决「质量浅」、B 解决「粒度粗」，正好盖住两个 dogfood 痛点；C（机械校验）查不了「写得实不实」，易形式主义，YAGNI 到痛点显现再加。

## 实现节奏

spec → writing-plans → plan → TDD → dogfood 验证 → 合并。壳 UX（C-呈现）、C 产出校验各自另起 spec。
