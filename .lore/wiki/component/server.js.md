---
title: server.js —— 本地 Web 门面
summary: 一个零依赖 http server 同时干三件事：静态伺服壳与 wiki、本机写 API（语言/翻译/同步控制）、多 repo 聚合门户（只读）
last_updated: 2026-06-11
code_sha: eef82cd
atoms: 0
commits: 0
---
# component: server.js

## 概览

**一句话**：`server.js` 是 lore 的**本地 Web 门面**——浏览器里看到的一切（壳、wiki 页、控制台按钮背后的接口）都从这里出去，且永远只听 `127.0.0.1`。

**它在流水线的位置**：

```mermaid
flowchart LR
  wiki[".lore/wiki + site/<br/>（sync 的产物）"] --> srv["server.js<br/>createServer"]
  srv -->|"GET 静态"| shell["浏览器壳<br/>（人读）"]
  shell -->|"POST /api/*<br/>仅本机"| state[".state/<br/>偏好·翻译队列·档位·重写队列"]
  registry["~/.lore/repos<br/>多 repo 登记"] --> portal["createPortalServer<br/>只读聚合"]
  portal -->|"/repo名/…"| shell
```

**为什么一个文件三种角色**：静态伺服（壳+wiki）、写 API（本机控制）、聚合门户（多 repo）共享同一套路径安全逻辑（`serveStatic` 防穿越）。拆三个文件会复制安全代码；合在一起，**门户复用 per-repo 的静态语义但砍掉全部写面**——只读由结构保证，不靠运行时判断。

**一个场景看懂「为什么浏览器能改档位」**：

> 你在壳里点「手动档」→ 壳 `POST /api/sync/mode`。server 先查 **Host 头是不是本机**
> （`localHost`，防恶意网页用 DNS 重绑定假冒 127.0.0.1）→ 校验枚举 → 写 `.state/sync.json`。
> 下次 commit 时 hook 读同一个文件决定要不要自动刷新——**浏览器点击真的改变了 git hook 的行为**，
> 而这条链路从头到尾出不了你这台机器。

想查 BUG 或加端点？展开机制档 👇

## 机制详解

<details>
<summary><b>① 接口 / 能力面</b> —— 导出与签名</summary>

| 导出 | 签名 | 干什么 | 锚点 |
|---|---|---|---|
| `createServer` | `(rootDir, {spawnFn}) → http.Server` | per-repo：静态 + 全部写 API | `createServer @ server.js` |
| `createPortalServer` | `(repoMap) → http.Server` | 聚合门户：`/<name>/…` 路由，**零写面** | `createPortalServer @ server.js` |
| `serveStatic` | `(rootDir, rel, res) → void` | 共享静态语义：穿越防护 + dir→index + MIME | `serveStatic @ server.js` |
| CLI | `node server.js <rootDir> <port>` | 被 `lib/serve.js` spawn 为常驻进程 | 文件尾 |

</details>

<details>
<summary><b>② 请求路由</b> —— 一个请求进来怎么走</summary>

`createServer` 的判定顺序（`createServer @ server.js`）：

1. **POST /api/\* 总闸**：`!localHost(req)` → 403（任何写 API 之前）
2. `POST /api/preferences` → 写 `.state/preferences.json`（语言偏好）
3. `POST /api/translation-requests` → append `.state/translation-requests.ndjson`（翻译排队）
4. `GET /api/sync/status` → 档位 + manifest.generated（B1 控制台灯）
5. `POST /api/sync/mode` → 枚举校验写 `.state/sync.json`（auto 拒绝留 B2）
6. `POST /api/sync/finalize` → detached spawn `lib/sync.js finalize`（不 gate 档位——手动刷新正是 manual 档的用法）
7. `GET/POST /api/sync/rewrite-requests` → 重写排队（`safeWikiPage` 防越狱）
8. 其余 → `serveStatic`（壳 / wiki / mermaid.min.js）

门户（`createPortalServer`）：`/` 出 repo 列表页；`/<name>/api/…` **一律 404**（只读铁律）；`/<name>/<rel>` → 该 repo 的 `serveStatic`。

</details>

<details>
<summary><b>③ 安全模型</b> —— 三道闸</summary>

- **绑定面**：CLI 只 `listen(port, '127.0.0.1')` —— 外网根本连不上。
- **Host 闸**（`localHost @ server.js`）：写 API 校验 Host 头 ∈ {127.0.0.1, localhost, [::1]} —— 拦 DNS 重绑定（远端网页把自己域名解析到 127.0.0.1 来 POST）。403 测试用 `node:http` 注入伪 Host 钉死（fetch 的 host 是 forbidden header，测不到这个闸）。
- **路径闸**：`serveStatic` 的 normalize+startsWith 防目录穿越；`safeWikiPage` 双层（白名单正则 + normalize 越狱检查）守 rewrite 排队的 page 参数。

</details>

<details>
<summary><b>④ 边界 / 坑</b> —— 查 BUG 必看</summary>

- **spawn 的异步 error 必须吞**（`child.once('error', ...)` @ finalize 端点）：EMFILE 类异步失败走 ChildProcess 事件而非 try/catch，不接住会击落常驻 server。
- **finalize 端点刻意不 gate 档位**——manual 关的是「自动」，手动 ⟳ 正是 manual 档的用法。别给它补 mode 检查（端点注释有同款警告）。
- **python 退化形态**：单语 repo 默认 python 静态 server（`lib/serve.js` probe）→ 本文件不在场、全部 API 404 → 壳降级只读。`/lore:serve --node` 强制启用本文件。
- **portal 安全靠结构**：`hasOwnProperty` 查 repoMap（防 `__proto__` 假命中）+ api 前缀整段 404。给门户加写功能前先想清楚跨 repo 写意味着什么。

</details>

## 依赖 / 邻居

- **依赖**：`lib/i18n.js`（translationSourceHash）· `lib/syncstate.js`（档位/重写队列）· Node 内置 http/fs/path
- **被调**：`lib/serve.js`（spawn 为常驻进程，双语或 `--node` 时选中）· `lib/portal.js`（聚合门户入口）
- **相关页**：[[lib]]（引擎鸟瞰）· [[sync]]（finalize 被本文件 spawn）· [[hook]]（读同一个 sync.json）

## Cross-links

- [[lib]] · [[sync]] · [[hook]] · [[manifest]]

## Decision history

<!-- LORE_JOURNAL:START -->
暂无 journal 原子（跑 /lore:mine 补全）。
<!-- LORE_JOURNAL:END -->
