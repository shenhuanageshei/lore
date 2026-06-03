---
description: 合成 wiki —— 读 config 组件 + 源码，每个 code_root 产一页 component/<name>.md（LLM 写架构），建 INDEX + emit manifest
---

# /lore:sync

把代码合成进 wiki：每个 `config.yml` 的 `code_root` 产一页 `component/<name>.md`（「当前架构」段由你读源码写），再机械建 `INDEX.md` + `.manifest.json`。本版只产 component 页（flow/theme 推迟）。

## 用法

- `/lore:sync` —— 在当前仓库根目录合成 wiki

## 行为（O1 两阶段）

本命令编排 `lib/sync.js`：

1. **plan**（机械）：
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/lib/sync.js" plan "$(pwd)/.lore"
   ```
   输出 worklist JSON：`{ codeRoots, worklist:[{component, codeRoot, path, priorExists}] }`。
   worklist 空 → 提示先 `/lore:init`（或编辑 `.lore/config.yml` 填 `code_roots`），停止。

2. **合成**（你来，逐 worklist 项）：读该 `codeRoot` 的实际源码，写 `.lore/wiki/<path>`，格式：
   ```markdown
   ---
   title: <组件显示名>
   summary: <一行语义摘要>
   ---
   # component: <name>

   ## Current architecture

   <读源码写当前真实架构：入口、关键模块、数据流、职责。非泛词。>

   ## Decision history

   {{LORE_JOURNAL}}

   ## Cross-links

   - [[<相关 sibling 组件>]]
   ```

3. **finalize**（机械）：
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/lib/sync.js" finalize "$(pwd)/.lore"
   ```
   盖机械 front-matter（`code_sha`/`last_updated`/`atoms`/`commits`）+ 建 `INDEX.md` + 写 `.manifest.json`。

## 给 agent 的提示

- 只写 `title` + `summary` 半 front-matter；**别手写 `code_sha`/计数/日期** —— finalize 自动盖。
- 「当前架构」段读真实源码写，别套泛词。
- 「决策历史」段写占位符 `{{LORE_JOURNAL}}` —— finalize 自动用 journal 原子机械填充（按 component facet 过滤、ts 倒序）。先跑 `/lore:mine` 让 journal 有料。
- 「交叉链接」段用 worklist 的全组件列表，链相关 sibling。
- 跑完提示 `/lore:serve` 浏览。
- 零侵入：只写 `.lore/wiki/`，绝不改业务源码。
