---
description: 记一条决策原子 —— 决策当下记「选 X 弃 Y 因为 Z」（why + 语义 facets），写进 journal
---

# /lore:note

在决策当下把「为什么这么选」记成一条 journal decision 原子（`why` + 你据意图标的 component/flow/theme facet）。补齐捕获三源里的「人工 why」。

## 用法

- `/lore:note "<决策一句话>"` —— 例：`/lore:note "选 ZSET 弃 SET 因为要 O(logN) 范围查"`

## 行为

你（agent）解析这条决策 → 定 `title`（决策摘要）/`why`（理由）/`component`（这是哪个组件的决策，必标）/可选 `flow`/`theme`/`files`，再调：

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/note.js" "$(pwd)" --title "<摘要>" --why "<理由>" --component "<组件>" [--flow "<flow>"] [--theme "<theme>"] [--files "a.py,b.py"]
```

它把一条 `kind:decision`、`source:agent` 的原子追加进 `.lore/journal/`。下次 `/lore:sync` 会把它折进对应 component 页的「决策历史」段。

## 给 agent 的提示

- **决策当下即记**，别攒到收尾——上下文会被压缩，记晚了 why 就丢了。
- `--component` 必标（否则该原子不进任何组件页）。多个用逗号。
- `--title` 是决策摘要（一句话），`--why` 是理由（可长）。
- 零侵入：只写 `.lore/journal/`，绝不改业务源码。
