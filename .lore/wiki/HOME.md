---
title: 首页
summary: 仓库人读导航首页 —— 一句话定位 + 状态 + 知识流 + 入口
last_updated: 2026-06-09
code_sha: 7de5966
atoms: 244
commits: 243
---
# lore

把代码仓库变成「活文档」：代码、文档、决策、数据流都折叠进**人和 agent 都能用**的 wiki 页。第一次打开从这里读起。

<!-- LORE_HOME_STATUS:START -->
## Status

- Version: `0.6.0`
- Code: `71d9f4a`
- Updated: `2026-06-09`
- Axes: `component 7 · docs 52`
- Language: `zh` default · `zh, en` available
- Translations: `0 ready` · `0 stale` · `59 missing`
<!-- LORE_HOME_STATUS:END -->

## 知识流

```mermaid
flowchart LR
  repo["仓库 代码/文档"] --> capture["捕获 hook/mine/note"]
  capture --> journal[".lore/journal 原子"]
  journal --> sync["合成 sync"]
  sync --> wiki[".lore/wiki 物化视图"]
  wiki --> human["人读"]
  wiki --> agent["agent 检索"]
```

## 理解项目

- [[lib]] —— 引擎核心：捕获 → journal → 合成 → 消费 + lint 全流程

## 排查问题

- [[ROADMAP]] —— 路线图与已知缺口

## 决策与时间线

- [[changelog]] —— 版本变更史（最新在上）
