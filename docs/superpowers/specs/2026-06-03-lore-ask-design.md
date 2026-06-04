# /lore:ask — wiki 消费（§5，resident-mode payoff）

> 设计文档 · 2026-06-03 · 子项目 **/lore:ask v1** · 母 spec §5（消费：agent 从 wiki 答，不读 raw 代码）。前置：sync 产页 + manifest 全已合并。

## 0. 背景
闭合 capture→synthesize→**consume**。lore 的 payoff = agent 不用每次重头 grep/读代码，先查 wiki（合成页 token 远低于重读代码）。`/lore:ask` = 检索相关页 → agent 从 wiki 答。

## 1. 范围（用户拍板 A）
- `lib/ask.js`：`searchPages`（纯，manifest 关键词检索排序）+ CLI。
- `commands/lore-ask.md`：agent 编排（检索 → 读 top 页 → 从 wiki 答）。
- 复用 `.lore/wiki/.manifest.json`（sync 产的机读投影，含 axes/pages 的 id/title/summary/path）。
**推迟**：正文全文检索（v1 只 title+summary）· 语义/向量 · MCP 暴露 · 引擎自动读页（agent 读）。

## 2. 检索（纯，锁定）
`searchPages(manifest, query) -> [{axis, id, title, summary, path, score}]`：
- query `.toLowerCase().split(/\s+/)` 分词去空。
- 每页（跳 INDEX 轴）：`score` = query 词中作为 `title+summary`（小写）子串命中的数量。
- score>0 收；按 `score` 倒序、同分按 `path` 字典序。

## 3. CLI
`node lib/ask.js <loreDir> "<query>"`（query = argv 第 3 位起 join）：
- 读 `<loreDir>/wiki/.manifest.json`（缺 → stderr 提示先 `/lore:sync` + exit 1）。
- `searchPages` → 打印每候选 `<path>  [<axis>] <title> (score N)`；无匹配 → `no matching pages`。exit 0。

## 4. 命令 /lore:ask
`/lore:ask "<问题>"`：跑 `node "${CLAUDE_PLUGIN_ROOT}/lib/ask.js" "$(pwd)/.lore" "<问题>"` 取排序候选 → agent 读 top 页（`.lore/wiki/<path>`）→ **从 wiki 答**（合成页当前架构 + 决策历史）；wiki 不足才指向页里 `[[链接]]`/代码路径兜底。提示：**先读 wiki 别直接 grep 代码**（resident-mode payoff，省 token）。

## 5. 测试（确定性 node:test）
- `searchPages`：命中按 score 排序；大小写无关；多词；无匹配→[]；跳 INDEX 轴；不改入参；同分按 path。
- CLI：有 manifest + 命中 → 打印候选；无匹配 → `no matching pages` + exit 0；无 manifest → exit 1 + 提示。
- 集成：临时 repo → init → 写 component 页（title/summary 含关键词）→ sync finalize（产 manifest）→ `node lib/ask.js <lore> "<关键词>"` → 打印该页 path。

## 6. 验收
1. searchPages 按 title+summary 关键词命中排序。
2. CLI：候选/无匹配/无 manifest 三态正确，exit 码对。
3. 命令引导 agent 先读 wiki 答（resident-mode）。
4. 零依赖；复用 manifest。

## 7. 不在范围
正文全文/语义检索 · MCP · 引擎自动读页/答（agent 做）· 跨 repo。

## 8. 开放问题
- **排序质量**：v1 纯命中计数，无 TF-IDF/权重。够 v1（页少）；规模大再加权。
