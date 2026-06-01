---
description: 启动/停止本地 Web 服务器，在浏览器中浏览 lore wiki
---

# /lore:serve

为 `.lore/wiki/` 启动一个本地静态服务器 + 浏览器壳，或停止正在运行的服务器。

## 用法

- `/lore:serve` —— 启动（默认端口 7842，被占用则自动改用空闲端口）
- `/lore:serve --port 9000` —— 在指定端口启动
- `/lore:serve --stop` —— 停止正在运行的服务器

## 行为

本命令是 `lib/serve.js` 的薄封装。在目标仓库根目录（即包含 `.lore/` 的目录）下运行。

**启动**，执行：

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/serve.js" start --lore "$(pwd)/.lore"
```

（用户给了端口就追加 `--port N`）

**停止**，执行：

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/serve.js" stop --lore "$(pwd)/.lore"
```

## 给 agent 的提示

- 前置条件：`.lore/wiki/.manifest.json` 必须存在。若命令提示 "run /lore:sync first"，告诉用户先运行 `/lore:sync` 再启动服务。
- 服务器仅绑定 `127.0.0.1`（本地浏览，绝不暴露到局域网）。
- 把打印出的 URL 告诉用户；进程在后台运行，不阻塞会话。提醒用户可用 `/lore:serve --stop` 停止。
- 不要修改目标仓库的任何源码；serve 只读取 `.lore/`。
