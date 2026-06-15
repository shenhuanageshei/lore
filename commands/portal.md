---
description: 启动/停止单机共享门户，一个端口聚合本机所有 lore 仓库
---

# /lore:portal

启动一个**常驻共享门户**（固定端口 `7842`，仅绑 `127.0.0.1`），在一个浏览器入口聚合本机所有已登记的 lore 仓库：顶层选 repo → 进该 repo 的多轴 wiki。与 per-repo 的 `/lore:serve` 共存（serve 仍各用各的稳定端口）。

## 用法

- `/lore:portal start` —— 启动门户（已在跑则幂等返回 URL）
- `/lore:portal stop` —— 停止门户
- `/lore:portal list` —— 列出本机已登记的 lore 仓库
- `/lore:portal autostart`（或 `autostart off`）—— 开机自启（Windows：Startup 文件夹 vbs，登录后台静默起 portal）

## 行为

本命令是 `lib/portal.js` 的薄封装，可在任意目录运行（门户读 `~/.lore/repos.json` 发现各仓库，与当前目录无关）。

**启动**：

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/portal.js" start
```

**停止**：

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/portal.js" stop
```

**列出仓库**：

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/portal.js" list
```

## 给 agent 的提示

- 仓库通过 `/lore:init` 自动登记到 `~/.lore/repos.json`；门户启动时读取该清单。新初始化仓库后，重启门户（`stop` 再 `start`）即可纳入。
- 门户 **MVP 只读**：不路由任何写接口（`/<repo>/api/…` 返回 404）。需要语言偏好持久化 / 翻译请求等写操作时，用 per-repo `/lore:serve`。
- 仅绑 `127.0.0.1`（绝不暴露到局域网）。把打印出的 URL（`http://127.0.0.1:7842/`）告诉用户；进程后台常驻，不阻塞会话。
- 顶层 `/` 是 repo 选择器；点某仓库进入 `/<name>/site/` 浏览其 wiki。
- 不要修改任何目标仓库源码；门户只读各仓库的 `.lore/`。
