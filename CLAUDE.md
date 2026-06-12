<!-- LORE_RESIDENT:START -->
## lore wiki（本仓库的活文档）

本 repo 由 lore 维护多轴 wiki（74 页 · 8 个组件深度页 · 最后更新 2026-06-12）。
**理解架构、查找模块职责、查决策原因时，先查 wiki 再 grep 源码**：
- MCP 工具：`lore_ask`（关键词检索，返回命中节）→ `lore_page`（取单页/单节，`view=agent` 省 40% token）→ `lore_neighbors`（图谱扩展）
- 无 MCP 时：读 `.lore/wiki/INDEX.md` 定位 → 读目标页
- wiki 缺失（fresh clone：wiki 不进库）→ 先跑 `/lore:sync` 合成
- 决策史/踩坑/「为什么不那样做」只有 wiki 有——源码注释和 git log 都查不动这类问题。
<!-- LORE_RESIDENT:END -->
