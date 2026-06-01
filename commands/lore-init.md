---
description: 初始化目标仓库的 lore（脚手架 .lore/ + 拷贝浏览器壳 + 自动发现组件生成 config.yml）
---

# /lore:init

在目标仓库引导 lore：搭 `.lore/` 骨架、把浏览器壳拷进 `.lore/site/`、扫描仓库自动发现组件并生成 `.lore/config.yml`。

## 用法

- `/lore:init` —— 在当前仓库根目录引导 lore

## 行为

本命令是 `lib/init.js` 的薄封装。在目标仓库根目录（含/将含 `.lore/` 处）运行：

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/init.js" "$(pwd)"
```

它会：
1. 建 `.lore/{journal,wiki,site,.state}/`
2. 把插件 `site/index.html` + `site/shell.mjs` 拷进 `.lore/site/`（覆盖刷新 → 壳随引擎升级）
3. 扫描仓库自动发现组件（兜底顶层代码目录 + Python 包 + JS workspaces），写进 `.lore/config.yml`（已存在则保留不覆盖）
4. 确保 `.gitignore` 忽略 `.lore/.state/`

## 给 agent 的提示

- 跑完把发现的 `code_roots` 摆给用户：这是**自动提议**，邀请用户编辑 `.lore/config.yml`（重命名 / 分组 / 删 / 增）。
- 下一步：`/lore:sync` 合成 wiki（之后才能 `/lore:serve` 浏览）。
- 重跑 `/lore:init` 安全：刷新壳、保留用户已编辑的 `config.yml`。
- 零侵入：只写 `.lore/` + 给 `.gitignore` 追加一行，绝不改业务源码。本版**不安装 post-commit hook**（hook 随后续 journal 子系统落地）。
