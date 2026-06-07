---
title: lore 单机共享门户（portal）—— 设计
summary: - 日期：2026-06-07 - 状态：设计已批，待写实施计划（**实现另起会话**） - 前置：#3 server 踏脚石（`lib/registry.js`、`stablePort`、`serve list/stop-all`）已并入 main；`server.js` `createServer`；`site/` 壳 - 北极星：人读友好 wiki —— 多 repo 聚合门户（roa...
source_path: docs/superpowers/specs/2026-06-07-lore-portal-design.md
last_updated: 2026-06-07
---
> 源文档：`docs/superpowers/specs/2026-06-07-lore-portal-design.md`

# lore 单机共享门户（portal）—— 设计

- 日期：2026-06-07
- 状态：设计已批，待写实施计划（**实现另起会话**）
- 前置：#3 server 踏脚石（`lib/registry.js`、`stablePort`、`serve list/stop-all`）已并入 main；`server.js` `createServer`；`site/` 壳
- 北极星：人读友好 wiki —— 多 repo 聚合门户（roadmap 中期「单机共享 wiki server」）

## 背景 / 问题

现状每 repo 独立 server（#3 给了 stablePort + `~/.lore/servers.json` registry + `serve list/stop-all`），但仍是「多 server、多端口」。目标：**单常驻 server 聚合本机所有 lore repo**，顶层选 repo → 进该 repo 的多轴 wiki。本设计是该目标的 **MVP**。

## 目标 / 非目标

**目标（MVP）**：单常驻 portal（固定 7842）+ `repos.json` 发现（init 登记）+ `/<name>/` 路由 + `/` repo 选择器 + **只读** + 安全白名单。

**非目标（后续迭代）**：
- 跨 repo 全局搜索
- write API（`/api/preferences`、`/api/translation-requests`）多路由
- 壳内「切 repo」下拉（MVP 只在 `/` 选）
- per-repo `serve` 自动迁移 / 端口回收
- namespace 高级冲突策略（MVP 用后缀兜底）

## 决策（已锁）

| 项 | 决策 |
|---|---|
| repo 发现 | `~/.lore/repos.json` = `[{name, loreDir}]`；`/lore:init` 自动登记；门户首次 serve 补登记 |
| 命令 | 新 `lore portal start/stop/list`；现有 `lore serve` **保留共存** |
| 路由标识 | repo 目录 basename；同名登记时加后缀（`lore`、`lore-2`） |
| 端口 | portal 固定 `7842`；`serve` 用 `stablePort`（各自错开） |
| 代码复用 | 把 `createServer` 的静态/穿越/MIME serve 逻辑提取成共享 `serveStatic(root, rel, res)` |
| 读写 | MVP **只读**：`/<name>/api/…` 写接口不路由（天然无 DNS-rebind 写面） |
| 顶层页 | `/` 由 portal 生成简单 repo 列表 HTML |
| 安全 | 只 serve `listRepos()` 白名单内 loreDir；每 root normalize 穿越防护；仅绑 127.0.0.1 |

## 设计

### A · repos registry（新 `lib/repos.js`，纯函数 + 路径注入，复用 registry.js 模式）

```
export function registerRepo(reposPath, { loreDir }) -> { name, loreDir }
export function listRepos(reposPath) -> [{ name, loreDir }]
```

- `~/.lore/repos.json` 形如 `[{ "name": "lore", "loreDir": "D:/workspace/lore/.lore" }]`。
- `registerRepo`：
  - 同 `loreDir` 已存在 -> 幂等返回原条目（不重复）。
  - name = `basename(dirname(loreDir))`（loreDir 的父目录名 = repo 根名）；若该 name 已被**别的 loreDir** 占用 -> 加后缀 `name-2`、`name-3`…
  - 写回 `repos.json`（原子写，复用 registry.js 写法）。
- `listRepos`：读 `repos.json`，过滤掉 loreDir 已不存在的条目（best-effort 自愈）。
- 路径注入（`reposPath` 参数）便于测试；CLI 默认 `~/.lore/repos.json`。

`lib/init.js`：scaffold 成功后调 `registerRepo(defaultReposPath(), { loreDir })` 登记本 repo（best-effort，失败不阻断 init）。

### B · portal server（`server.js` 重构 + 新 `createPortalServer`）

1. **提取** `serveStatic(root, rel, res)`：把现有 `createServer` 里「rel -> full、normalize 穿越 guard、dir->index.html、stream + MIME」那段抽成函数。`createServer` 改为调用它（行为不变 -> 现有 serve 测试不回归）。
2. **新** `createPortalServer(repoMap)`（`repoMap`: `{ name -> loreDir }`）：
   - `/`（或空）-> 生成 repo 列表 HTML（每个 name 链到 `/<name>/site/`）。
   - `/<name>/<rest>` -> `name ∈ repoMap` ? `serveStatic(repoMap[name], rest, res)` : 404。
   - `/<name>`（无尾斜杠）-> 302 到 `/<name>/site/`。
   - **MVP 只读**：`<rest>` 命中 `api/` 一律 404（不路由写接口）。
   - 仅绑 127.0.0.1。

### C · portal CLI（新 `lib/portal.js`）

- `lore portal start`：`createPortalServer(toMap(listRepos()))`，listen 7842/127.0.0.1，detached 常驻，pid -> `~/.lore/portal.pid`；已在跑（pid alive）则打印 URL 幂等返回。
- `lore portal stop`：读 `portal.pid` -> kill（复用 serve.js 的跨平台 kill）。
- `lore portal list`：打印 `listRepos()`。
- 与 `serve` 共存：serve 仍 per-repo（stablePort），portal 固定 7842。

### D · 壳改造（`site/index.html` + `site/shell.mjs`）

- **base 前缀感知**：壳从 `location.pathname` 推断 `/<repo>/site/` 的 base，所有 fetch 由写死 `../wiki/…` 改为 `<base>../wiki/…`（per-repo serve 下 base 为空、行为不变；portal 下带 `/<name>/` 前缀）。
- 顶层 `/` 列表页由 portal 端生成（不依赖壳）；壳内「切 repo」下拉列为后续。

### E · 安全 / 不变量

- 白名单：未注册 name -> 404（不碰磁盘任意路径）。
- 每 root 复用 `serveStatic` 的 normalize 穿越防护（`full` 必须在 root 内）。
- 仅绑 `127.0.0.1`；MVP 只读 -> 无 write/DNS-rebind 面。
- 零依赖；`serve` 行为与测试不回归（靠 `serveStatic` 提取后跑原测试验证）。

## 测试

### `test/repos.test.js`（纯函数）
1. `registerRepo`：basename 取名；同 loreDir 幂等；同名不同 loreDir -> 后缀 `-2`。
2. `listRepos`：读取；过滤掉 loreDir 不存在的条目。

### `test/portal.test.js`（集成，spawn 或 createPortalServer + fetch）
3. `createPortalServer({lore: loreA, ti: loreB})`：`GET /lore/wiki/.manifest.json` -> 200 命中 A；`GET /ti/wiki/.manifest.json` -> 200 命中 B。
4. `GET /` -> 200，HTML 含 `lore`、`ti` 两个链接。
5. `GET /unknown/wiki/x.md` -> 404；`GET /lore/../../etc` 穿越 -> 403/404。
6. `GET /lore/api/preferences` -> 404（MVP 只读不路由写）。

### `test/serve.test.js`（回归）
7. `serveStatic` 提取后，现有 serve 集成测试全绿（行为不变）。

## 改动清单
- 新增 `lib/repos.js`、`lib/portal.js`、`test/repos.test.js`、`test/portal.test.js`、`commands/portal.md`
- 改 `server.js`（提取 `serveStatic` + 新 `createPortalServer`）
- 改 `lib/init.js`（init 末尾 `registerRepo`）
- 改 `site/index.html` / `site/shell.mjs`（base 前缀感知）
- `lib/registry.js`（servers.json）不动；`lib/serve.js` 不动（共存）

## 实现节奏
本 spec 定稿入 main。实现（writing-plans -> plan -> TDD -> 合并）**另起新会话**：新会话基于 main 开 `claude/portal` 分支，从 writing-plans 起步。

