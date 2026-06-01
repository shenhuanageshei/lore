# lore

面向 AI Agent 与开发者的代码仓库活文档 / 决策历史框架。设计文档见
`docs/superpowers/specs/`。

## `/lore:init`（已实现）

在目标仓库引导 lore：搭 `.lore/` 骨架、把浏览器壳拷进 `.lore/site/`、自动发现组件生成 `config.yml`。

```bash
node lib/init.js <目标仓库>          # 引导（打印发现的 code_roots）
```

自动发现组件（兜底顶层代码目录 + Python 包 + JS workspaces）写进 `.lore/config.yml`（已存在则保留）；
拷壳到 `.lore/site/`（覆盖刷新）；给目标仓库 `.gitignore` 追加 `.lore/.state/`。重跑安全：刷新壳、不毁已编辑的 config。
**本版不装 post-commit hook**（随后续 journal 子系统落地）。引导后跑 `/lore:sync` 才能 `/lore:serve` 浏览。

## `/lore:serve`（已实现）

在浏览器中浏览 wiki —— 无需 Obsidian。

```bash
node lib/serve.js start --lore <目标仓库>/.lore    # 启动（打印 URL）
node lib/serve.js stop  --lore <目标仓库>/.lore    # 停止
```

一个哑静态服务器（依次探测 `python3` → `python` → 内置 Node 兜底）伺服 `.lore/`；
`site/` 下的免构建壳在浏览器端渲染 wiki（侧栏导航、Markdown 渲染、`[[wikilink]]`
壳内跳转、全文搜索、鲜度元数据、多主题）。壳消费的 manifest 由
`node lib/manifest.js <目标仓库>/.lore` 生成（后续会作为 `/lore:sync` 的收尾步骤调用）。

服务器仅绑定 `127.0.0.1`，绝不暴露到局域网；serve 只读取 `.lore/`，从不修改目标仓库源码。

## 开发

```bash
node --test        # 运行全部测试（零外部依赖）
```
