# HOME 图改造：从工具流程图 → 本仓库架构总览

date: 2026-06-16

## 问题

`.lore/wiki/HOME.md` 顶部那张「Knowledge flow」mermaid 图画的是 lore 工具自身的知识流水线
（`repo → capture → journal → sync → wiki → human/agent`），对**每个**被管理的仓库都印同一张。
在业务仓库（如 mal-analyze-cli）上，这张图与仓库内容无关，让人误以为「主页的图串了」。

图来自两处硬编码：

- `lib/home.js` 的 `defaultHomePage`：首次脚手架硬编码该 mermaid 块。
- `lib/runner.js` 的 HOME 轴 `axisPrompt`（`byAxis.HOME`）：重写 prompt 写死「→ Knowledge flow mermaid →」，
  所以即便 HOME 被 LLM 重写，图仍是这张工具流程图（实测 mal-analyze-cli 6-15 那次 HOME 重写 `ok`、图却没变即此因）。

附带发现：`lib/sync.js` 首次脚手架调用 `defaultHomePage({ title: 'lore' })` 标题写死 `'lore'`——
任何新仓库首次 finalize（未经 LLM 重写）时 HOME 标题会错显为「lore」。

## 目标

- HOME 图改为「本仓库架构/数据流总览」：LLM 综合 component + flow 轴，画出本仓库由哪几块组成、怎么协作。
- 自适应任意仓库（含 lore 自己——画 lore 的代码架构）。
- 顺带修正脚手架标题写死 `'lore'` 的 bug。

## 非目标（YAGNI）

- **不**为 lore 仓库保留知识流图，不引入 per-repo 配置分支。知识流图的工具介绍价值由 README 承担。
- **不**做机械兜底拼图（manifest→mermaid）。语法质量门已能拦坏图、保留旧页。
- **不**强制 HOME 必须含 mermaid。

## 方案（落地方式 A：纯 prompt 替换、全仓库统一）

### 1. runner.js HOME 重写 prompt（核心）

`axisPrompt` 的 `byAxis.HOME`，把「Knowledge flow mermaid」一句替换为「本仓库总览」指引，语义大致：

> 一张『本仓库总览』mermaid：读 `.lore/wiki/component/` 各页与 `.lore/wiki/flow/` 各页综合，
> 把仓库的主要组件/包当节点、按真实依赖或端到端数据流连边，让人一眼看懂这个项目由哪几块组成、怎么协作。
> 节点用仓库里的真实名字。**不要**画 lore 工具自身的 capture/journal/sync 流程。

HOME 页其余结构不变：一句话定位 → 状态节只输出单行 `{{LORE_HOME_STATUS}}` → 本仓库总览图 → 「理解项目 / 排查问题 / 决策与时间线」三个 wikilink 导航节。

### 2. home.js defaultHomePage 脚手架

删掉硬编码的 Knowledge flow mermaid 块，换成占位节：

```
## 架构总览

> 本仓库的架构/数据流总览图将在首次 sync（重写）后由 LLM 生成。
```

脚手架仅在「全新仓库、HOME 从未被 LLM 重写」的短窗口出现，低频，占位提示足够。

### 3. 质量门（runner.js qualityGate）

**不**新增「HOME 必须含 mermaid」的硬门，避免 LLM 偶尔没画图就整页被拒、连正文一起丢。
现有 mermaid 语法门（`mermaidIssues`）保留——画了就得合法。

### 4. 附带修正：脚手架标题（sync.js）

`sync.js` 读 `package.json` 取 `version` 处（`lib/sync.js:261-263`），顺带取 `name`；
`defaultHomePage({ title })` 的 title 来源改为：`package.json.name` → fallback `repoRoot` 目录名（`path.basename(repoRoot)`）。
去掉写死的 `'lore'`。config.yml 无项目名字段，故 package.json name → 目录名是最佳来源。

## 影响范围

所有被 lore 管理的仓库，含 lore 自己（HOME 图从知识流图变为 lore 代码架构图）。

## 生效方式（务必告知用户）

改 prompt 只影响**未来**的 HOME 重写。已存在的 `HOME.md`（如 mal-analyze-cli）需**触发一次 HOME 重写**才换图：
切 auto 档（壳控制台）让 ticker 消化重写队列，或手动 `node lib/runner.js <loreDir>`。

## 测试

- `test/home.test.js`：`defaultHomePage` 输出不再含 `repo-->capture` 等工具流程 mermaid；含「架构总览」占位；
  `title` 参数生效（标题随传入值，非写死 lore）。
- `test/runner.test.js`：HOME `axisPrompt` 含「本仓库总览」措辞、不含「Knowledge flow」；
  `qualityGate` 对一份**无 mermaid** 的合法 HOME 文本返回 `{ ok: true }`（仅缺 mermaid 不判失败）。
- `test/sync.test.js`：无现有 HOME 时，脚手架标题取 `package.json.name`（缺失时取仓库目录名），不再是写死的 `lore`。
