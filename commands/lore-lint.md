---
description: 只读漂移报告 —— 报陈旧页（落后 N commits）/ orphan / missing，不自动改
---

# /lore:lint

只读检查 wiki 与代码/config 的漂移：陈旧页（`code_sha` 落后当前 HEAD）、orphan（页无对应 `code_root`）、missing（`code_root` 无页）。**只报不改**（修复跑 `/lore:sync`）。

## 用法

- `/lore:lint` —— 报告当前 repo 的 wiki 漂移

## 行为

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/lint.js" "$(pwd)/.lore"
```

打印分组报告（stale / orphans / missing）或 `✓ clean`。exit 0（咨询，不阻断）。

## 给 agent 的提示

- 漂移 = wiki 落后代码。**stale 多 → 跑 `/lore:sync` 重合成**；**missing → 该 `code_root` 还没 sync**；**orphan → `code_root` 改名/删了，删页或改 config**。
- 只读：不改 wiki / 源码 / .lore。
- 本版三检（stale/orphan/missing）；未打标/矛盾检查随 flow/theme 落地。
