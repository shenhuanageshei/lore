---
description: bootstrap 回填 journal —— 挖 git commit 历史 → commit 原子（确定性，component facet 打标），幂等
---

# /lore:mine

把 git 历史挖进 journal：每个非 merge commit → 一条 commit 原子（`title`/`why`/变更文件/component facet），写进 `.lore/journal/YYYY/MM/*.ndjson`。一次性 bootstrap 回填，幂等可重跑。本版只挖 commits（changelog/pitfalls 推迟）。

## 用法

- `/lore:mine` —— 在当前仓库根目录回填 journal

## 行为

本命令是 `lib/mine.js` 的薄封装。在目标仓库根目录运行：

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/mine.js" "$(pwd)"
```

它会：读 `.lore/config.yml` 的 `code_roots`；`git log --no-merges` 全历史；每 commit → 原子（`facets.component` 由变更路径前缀匹配 `code_roots` 机械推导）；按 atom id（`commit:<sha>`）去重；append 到 `.lore/journal/`。

## 给 agent 的提示

- 一次性 bootstrap：把 hook 之前的历史回填进 journal。幂等 —— 重跑只加新 commit。
- component 打标需 `.lore/config.yml` 的 `code_roots` → 先跑 `/lore:init`（没 config 也能挖，但 component facet 为空）。
- 纯确定性零 LLM —— 不需要你写任何 prose。
- 下一步 `/lore:sync`（未来版本会把 journal 折叠进 wiki 的「决策历史」段）。
- 零侵入：只写 `.lore/journal/`，绝不改业务源码。
