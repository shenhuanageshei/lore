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
init 现装 post-commit hook —— 每 commit 自动写 journal 骨架原子（已有 hook / core.hooksPath / 非 git 则跳过）。引导后跑 `/lore:sync` 才能 `/lore:serve` 浏览。

## `/lore:mine`（已实现）

bootstrap 回填 journal：挖 `git log` 历史 → 每个非 merge commit 一条 commit 原子（`title`/`why`/变更文件 + `component` facet 由路径→`code_roots` 机械推导），按 `commit:<sha>` 去重，写 `.lore/journal/YYYY/MM/*.ndjson`。纯确定性，零 LLM。本版只挖 commits。

```bash
node lib/mine.js <目标仓库>          # 回填（幂等，重跑只加新 commit）
```

捕获链：`/lore:mine` 填 journal（生产者）→ 未来 `/lore:sync` 折叠进「决策历史」段（消费者）。component 打标需先 `/lore:init` 生成 `config.yml`。

## `/lore:note`（已实现）

决策当下记一条 decision 原子：`/lore:note "选 X 弃 Y 因为 Z"` → agent 定 `title`/`why`/`component` 调 `lib/note.js` 追加 `kind:decision`、`source:agent` 原子进 `.lore/journal/`。下次 `/lore:sync` 折进对应组件页的「决策历史」段。捕获三源之一（hook 机械骨架 · mine 历史回填 · note 人工 why）。

## `/lore:sync`（已实现）

把代码合成进 wiki：每个 `config.yml` 的 `code_root` 产一页 `component/<name>.md`（「当前架构」段由 agent 读源码 LLM 写），机械建 `INDEX.md` + `.manifest.json`。本版只产 component 页（flow/theme/journal 折叠推迟）。

```bash
node lib/sync.js plan <.lore目录>       # 出 worklist（agent 据此逐页合成）
node lib/sync.js finalize <.lore目录>   # 盖 front-matter + INDEX + manifest
```

O1 两阶段：`plan`（Node 出 worklist）→ agent 读源码写页正文 → `finalize`（Node 盖机械 front-matter + INDEX + emit manifest，复用 `lib/manifest.js`）。引导链：`/lore:init` → `/lore:sync` → `/lore:serve` 浏览真内容。「决策历史」段现由 finalize 机械折叠 `.lore/journal/` 原子（按 component facet 过滤、ts 倒序）填充 —— 先跑 `/lore:mine` 让 journal 有料。

本版产 component + theme + flow 三轴页：theme 由 config `match:` 关键词自动给 commit 原子打标（mine/hook），sync 产 `theme/<id>.md` 折该主线原子。

flow 轴：config `flow.values` 用 `spans:[组件…]` 声明一条数据流跨哪些组件；原子的 component ∈ 某 flow 的 spans → 自动标该 flow；sync 产 `flow/<id>.md`。lore 三轴齐（component/theme/flow）。

## `/lore:lint`（已实现）

只读漂移报告：`node lib/lint.js <.lore目录>` → 报陈旧页（`code_sha` 落后 HEAD N commits）/ orphan（页无对应 code_root）/ missing（code_root 无页 → 提示 sync）。只报不改，exit 0（检测与修复分离：lint 报、sync 修）。stale 逻辑与 serve manifest 同源。

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

## `/lore:ask`（已实现）

从 wiki 答问：`node lib/ask.js <.lore目录> "<问题>"` → 按关键词命中 title+summary 排序的候选页 → agent 读 top 页从合成页（当前架构+决策历史）答，不重 grep 代码（resident-mode payoff，省 token）。只读，复用 sync 产的 `.manifest.json`。

## 开发

```bash
node --test        # 运行全部测试（零外部依赖）
```
