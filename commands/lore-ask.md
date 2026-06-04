---
description: 从 wiki 答问 —— 检索相关合成页，先读 wiki 别重 grep 代码（resident-mode payoff）
---

# /lore:ask

带着问题查 lore wiki：检索相关 component/theme/flow 页 → 从合成页（当前架构 + 决策历史）答，而非重头读代码。

## 用法

- `/lore:ask "<问题>"` —— 例：`/lore:ask "M3 的准确率为什么这么调"`

## 行为

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/ask.js" "$(pwd)/.lore" "<问题>"
```

打印按关键词命中排序的候选页（`path [axis] title (score N)`）。然后你读 top 几页（`.lore/wiki/<path>`）从 wiki 答。

## 给 agent 的提示

- **先读 wiki 别直接 grep/读源码** —— 合成页 token 远低于重读代码（resident-mode payoff）。
- 读检索出的 top 页：当前架构段答「是什么/怎么连」，决策历史段答「为什么这么定」。
- wiki 不足才兜底：页里 `[[链接]]` 跳相关页、或指向代码路径再看源码。
- 无候选 / `.manifest.json` 缺 → 先跑 `/lore:sync` 合成 wiki。
- 只读：不改任何东西。
