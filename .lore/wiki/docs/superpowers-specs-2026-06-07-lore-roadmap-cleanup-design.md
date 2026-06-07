---
title: lore roadmap 收尾（#3 server 踏脚石 + #4/#5/#6 known issues）—— 设计
summary: - 日期：2026-06-07 - 状态：设计已批，待写实施计划 - 前置：fold + graph + MCP 已并入 main - 北极星：消费纪律 + 质量收尾（清 roadmap「待修复」+ server 运维踏脚石）
source_path: docs/superpowers/specs/2026-06-07-lore-roadmap-cleanup-design.md
last_updated: 2026-06-07
---
> 源文档：`docs/superpowers/specs/2026-06-07-lore-roadmap-cleanup-design.md`

# lore roadmap 收尾（#3 server 踏脚石 + #4/#5/#6 known issues）—— 设计

- 日期：2026-06-07
- 状态：设计已批，待写实施计划
- 前置：fold + graph + MCP 已并入 main
- 北极星：消费纪律 + 质量收尾（清 roadmap「待修复」+ server 运维踏脚石）

## 背景

roadmap 当前迭代收尾：3 个 known issue（#4/#5/#6）+ server 运维踏脚石（#3）。4 项各自独立、单文件量级，打包一个 spec/plan、一次 TDD、一次合并。

## 决策（已锁）

| # | 项 | 决策 |
|---|---|---|
| 3 | 稳定端口 | `stablePort(loreDir) = 7000 + parseInt(sha1(loreDir)[:6],16) % 1000`（node:crypto，零依赖） |
| 3 | 跨 repo 发现 | 中央 registry `~/.lore/servers.json`（新 `lib/registry.js`，registryPath 可注入） |
| 3 | CLI | `serve list`（活的 + 清死条目）、`serve stop-all`（逐个 kill+注销） |
| 4 | 翻译 hash | `translationSourceHash` 剔除哨兵区间 `<!-- LORE_*:START -->…<!-- LORE_*:END -->` 后再 hash |
| 5 | 空段 | `defaultHomePage` 空段**省略整段**（去掉 `[[INDEX]]` fallback） |
| 6 | docs chips | `pageEntry` 带 `axis`；`buildMeta` 对 `axis==='docs'` 显示 `📄 <last_updated>`，不显 atoms/code_sha |

## 设计

### #3 server 踏脚石（`lib/serve.js` + 新 `lib/registry.js`）

**`lib/registry.js`（新，IO 注入可测）**：
```
registryPath(home?) → <home>/.lore/servers.json
registerServer({loreDir,pid,port,started}, path) // 读数组、按 loreDir 去重替换、写
unregisterServer(loreDir, path)                  // filter 掉 loreDir、写
listServers(path) → [{loreDir,pid,port,started}] // 读（缺/坏 → []）
```

**`lib/serve.js`**：
- 新 `stablePort(loreDir)`：`7000 + parseInt(createHash('sha1').update(loreDir).digest('hex').slice(0,6),16) % 1000`。
- `start`：preferred 默认从 `7842` 改 `stablePort(loreDir)`；成功后 `registerServer({loreDir,pid:child.pid,port:chosen,started:now})`。
- `stop`：成功后 `unregisterServer(loreDir)`。
- CLI 新 sub：
  - `list`：`listServers()` → 对每条 `isAlive(pid)`：活 → 打印 `<port> <loreDir> (pid)`；死 → `unregisterServer`（顺带清理）。
  - `stop-all`：`listServers()` → 每条 `killPid(pid,platform)` + `unregisterServer`。

### #4 HOME 翻译 stale（`lib/i18n.js`）
`translationSourceHash(text)`：取 body 后，先用正则删除哨兵区间，再 `trimEnd` + sha256：
```
const SENTINEL = /<!--\s*LORE_[A-Z_]+:START\s*-->[\s\S]*?<!--\s*LORE_[A-Z_]+:END\s*-->/g;
const body = parseFrontmatter(text).body.replace(/\r\n/g,'\n').replace(SENTINEL,'').trimEnd();
```
→ HOME 机械状态块（`<!-- LORE_HOME_STATUS:START/END -->`）每 sync 变不再让翻译 stale。其它页无哨兵 → 行为不变。

### #5 defaultHomePage 空段（`lib/home.js`）
去掉 `bullets` 的 `['INDEX']` fallback；段改条件渲染——内容为空则连标题一起省：
```
const bullets = arr => arr.map(id => `- [[${id}]]`).join('\n');
const section = (title, ids) => ids.length ? `\n\n## ${title}\n\n${bullets(ids)}` : '';
const understand = ids('component').slice(0, 3);
const debug = ['pitfalls','ROADMAP','troubleshooting'].filter(id => docs.includes(id));
const decisions = docs.includes('changelog') ? ['changelog'] : [];
// 返回：FM + 引言 + HOME_STATUS_TOKEN + 知识流 mermaid
//   + section('Understand the project', understand)
//   + section('Debug a problem', debug)
//   + section('Decisions and timeline', decisions) + '\n'
```
知识流 mermaid 图 + `HOME_STATUS_TOKEN` 保留不动。

### #6 docs 页 chips（`lib/manifest.js` + `site/shell.mjs`）
- `manifest.js pageEntry`：返回对象加 `axis: axisId`（函数已有 `axisId` 参数）。
- `site/shell.mjs buildMeta(page)`：
  ```
  if (page.axis === 'docs') {
    return { chips: [{ icon: '📄', text: page.last_updated ?? '', kind: 'plain' }] };
  }
  // 其它轴：现状（atoms·commits + code_sha）
  ```

## 测试

- **`test/registry.test.js`（新）**：注入临时 registryPath — register 去重替换、unregister 删除、listServers 缺文件→[]、坏 JSON→[]。
- **`test/serve.test.js`（加）**：`stablePort` 确定性（同 loreDir 同端口）+ 范围 7000–7999；不同 loreDir 大概率不同。
- **`test/i18n.test.js`（加）**：含哨兵区间的 text，区间内容变化 → `translationSourceHash` 不变；区间外 body 变化 → hash 变。
- **`test/home.test.js`（加，若无则新建）**：`defaultHomePage`（axisPages 仅 component、无 docs）→ 含 `## Understand the project`，**不含** `## Debug a problem` / `## Decisions and timeline`；有 pitfalls/changelog docs → 含对应段。
- **`test/manifest.test.js`（加）**：`pageEntry`/manifest pages 含 `axis` 字段。
- **shell buildMeta 测试**（`test/shell*.test.js`，若无则新建）：docs page（`axis:'docs'`）→ chips 不含 `atoms`/`code_sha`、含 last_updated；component page → 含 atoms/code_sha（现状）。

## 改动清单
- 新增 `lib/registry.js` + `test/registry.test.js`
- 改 `lib/serve.js`（stablePort + registry 接入 + list/stop-all CLI）+ `test/serve.test.js`
- 改 `lib/i18n.js`（哨兵剔除）+ `test/i18n.test.js`
- 改 `lib/home.js`（空段省略）+ `test/home.test.js`
- 改 `lib/manifest.js`（pageEntry 加 axis）+ `test/manifest.test.js`
- 改 `site/shell.mjs`（buildMeta docs 分支）+ shell 测试

