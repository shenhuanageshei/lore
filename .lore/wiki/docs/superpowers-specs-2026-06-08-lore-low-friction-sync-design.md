---
title: lore 低摩擦合成（增量 sync + 提交即机械刷新）—— 设计
summary: - 日期：2026-06-08 - 状态：设计已批，待写实施计划 - 北极星：人读 + agent 双友好的活文档；本期专攻**运维负担**（不实时、得手动盯） - 前置（已在 main）：`sync.js`（plan/finalize）、`manifest.js`（stale）、`hook.js`（post-commit）、`journal.js`/`fold.js`、`i18n.js`（...
source_path: docs/superpowers/specs/2026-06-08-lore-low-friction-sync-design.md
last_updated: 2026-06-08
---
> 源文档：`docs/superpowers/specs/2026-06-08-lore-low-friction-sync-design.md`

# lore 低摩擦合成（增量 sync + 提交即机械刷新）—— 设计

- 日期：2026-06-08
- 状态：设计已批，待写实施计划
- 北极星：人读 + agent 双友好的活文档；本期专攻**运维负担**（不实时、得手动盯）
- 前置（已在 main）：`sync.js`（plan/finalize）、`manifest.js`（stale）、`hook.js`（post-commit）、`journal.js`/`fold.js`、`i18n.js`（`translationSourceHash`）
- 拆解出处：`docs/superpowers/specs/2026-06-07-lore-portal-design.md` 之后的 A/B/C 拆分；本文 = **A（地基）**

## 背景 / 问题

lore 现在是「快照模型」：wiki = 上次 `/lore:sync` 那一刻。实测三个痛点（用户首要顾虑）：

1. **不实时** —— 代码改了 wiki 不动，得记得手动 sync。
2. **staleness 信号被抹平** —— `finalizeSync` 给**每页**盖 `code_sha = 当前 HEAD`（`sync.js` 第 157/180 行），而 `manifest.js` 算 `stale = countCommitsSince(page.code_sha)`（第 92 行）。结果：任何一次 finalize 后，全页 `stale = 0`，**哪怕架构正文是旧的**。实测 lib 页 `code_sha = c8f0721 = current_code_sha → stale 0`。
3. **无增量** —— `planSync` 列**全部**页，重合成又慢又贵（每页都重写 prose）。

## 目标 / 非目标

**目标（A）**：

1. **prose 新鲜度与机械 finalize 解耦** → `stale` 诚实反映「距架构正文上次重写」的 commit 数。
2. **增量 plan** —— 只挑「代码动过」的 component 页给 agent 重写。
3. **提交即机械刷新** —— post-commit hook 后台 detached 跑 `finalize`（决策史 / docs 轴 / 状态块 / manifest / stale 准实时、零 LLM、不卡 commit）。

**非目标（留给 B / C，本期不做）**：

- 前端控制台、档位配置（手动 / 提交全自动 #1 / 定时 #3）、控制 API、内置 LLM 客户端 → **B**。
- prose 可读性 prompt、壳 UX（门户导航 / mermaid 放大 / 排版）、**内容完整性**（人读关注什么 vs agent 关注什么）→ **C**（C 另起一期头脑风暴）。
- prose 自动重生成（#1 全自动）、定时器（#3）→ **B**。A 只做「默认 #2」所需的地基：机械部分自动新鲜 + prose 增量按需。

## 决策（已锁）

| 项 | 决策 |
|---|---|
| 新鲜度追踪 | **方案 1：内容指纹**。`<loreDir>/.state/fingerprints.json` 存每页 `{ prose_hash, prose_sha }` |
| prose_hash | 复用 `i18n.js` 的 `translationSourceHash`（排除决策史哨兵区 / HOME 状态块 / frontmatter，只 hash agent 写的正文）|
| prose_sha 推进 | finalize **只在 prose_hash 变了**才把 prose_sha 推到当前 HEAD；否则保持旧值 |
| frontmatter code_sha | finalize 改盖 **prose_sha**（不再盖 current）→ manifest `stale` 自然诚实 |
| stale 范围 | component = 该 `code_root`；flow = `spans` 各组件 code_root 并集；theme / HOME = 全仓；INDEX / docs = 机械、不参与 staleness |
| 增量 plan | component 页：动过其 code_root（或无指纹）才入 worklist；HOME/theme/flow 默认仍入（cross-cutting、便宜）；`--all` 旗标强制全量 |
| 提交即刷新 | hook 在 `captureHead` 后 **detached spawn** `finalize`；仅当已 sync 过（`.manifest.json` 存在）触发；`exit 0`、绝不挡 commit |
| 指纹 GC | finalize 清掉「页文件已不存在」的指纹条目（孤儿）|
| seed | 首跑 / 新页：`prose_sha = current`（从现在起算新鲜度，不回溯）|
| 存储 | `.state/`（gitignored、本地缓存、可重建）；每 repo 一份；零跨 repo 耦合 |

## 设计

### A · 指纹层（新 `lib/fingerprint.js`，纯函数 + 路径注入）

```
readFingerprints(stateDir) -> { "<axis>/<id>.md": { prose_hash, prose_sha } }
writeFingerprints(stateDir, map) -> void   // 原子写，复用 registry.js 写法
proseHash(pageText) -> "sha256:…"          // = translationSourceHash(pageText)
```

- `proseHash` 直接调 `i18n.translationSourceHash`：它已排除决策史哨兵区 + HOME 状态块 + frontmatter，剩下正是 agent 写的架构正文。改决策史 / 状态块 → hash 不变；改架构正文 → hash 变。
- 缺文件 → 返回 `{}`；坏 JSON → `{}`（best-effort，同 registry.js）。

### B · finalize 改造（`sync.js`）

`finalizeSync` 处理每页时（第 174–190 行那段）：

1. `h = proseHash(pageText)`。
2. 查 `fp = fingerprints[rel]`：
   - 无 `fp`（新页 / 首跑）→ `prose_sha = currentSha`，记 `{ prose_hash: h, prose_sha }`（**seed**）。
   - `h === fp.prose_hash`（正文没变，只机械刷新）→ `prose_sha = fp.prose_sha`（**保持**）。
   - `h !== fp.prose_hash`（agent 重写了正文）→ `prose_sha = currentSha`，记 `{ prose_hash: h, prose_sha }`（**推进**）。
3. `stampFrontmatter(..., codeSha: prose_sha)`（不再用 currentSha）。

收尾：写回 fingerprints；**GC** 掉本轮没遇到、且页文件已不存在的条目。决策史 / docs 轴 / HOME 状态 / manifest / graph 的机械重建逻辑**不变**（仍每次全量、零 LLM）。

> 注：HOME 页正文半稳定，也走同一指纹逻辑（全仓 stale）；INDEX 纯机械，不进指纹。

### C · stale 精确化（`manifest.js`）

- `makeCountCommitsSince(repoRoot)` 增加可选 `pathspec`：`git rev-list --count <sha>..HEAD -- <path…>`；无 pathspec 时退化为现在的全仓行为（向后兼容）。
- `finalizeSync` 据 config 构造 **page→pathspec** 映射（`staleScopes`）：component→`[code_root]`、flow→`spans` 各 code_root、theme/HOME→`undefined`（全仓），经 `runManifestCli` → `emitManifest` → `pageEntry` 传入。
- `pageEntry` 算 `stale` 时按该页 pathspec 计数。
  - 选择「finalize 供映射」而非「manifest 读 config」：保持 config 解析集中在 sync 侧，manifest 不新增对 code_roots/flows 的依赖。

### D · 增量 plan（`sync.js` `planSync`）

- `planSync` 读 fingerprints + config + `countCommitsSince`。
- component 页：`countCommitsSince(fp.prose_sha, code_root) > 0` 或无 `fp` → 入 worklist（`stale: N`, `reason: 'code-changed' | 'new'`）；否则**跳过**（标 `fresh`）。
- HOME / theme / flow：默认仍入 worklist（cross-cutting、便宜）。
- 输出每项带 `stale` + `reason`，供 agent / 未来 B 显示。
- `--all` 旗标：忽略指纹、全量列出（首跑 / 兜底 / 大改后）。

### E · 提交即机械刷新（`hook.js`）

- `captureHead` 之后：仅当 `<loreDir>/wiki/.manifest.json` 存在（已 sync 过的 repo）才触发；否则跳过（不给没 sync 的 repo 乱建）。
- `spawn(process.execPath, [SYNC_JS, 'finalize', loreDir], { detached: true, stdio: 'ignore' }).unref()` —— commit 立刻返回，finalize 后台跑完刷机械部分。
- 全程在现有 `try/catch + process.exit(0)` 内，后台失败绝不挡 commit。
- 边角：极快连续 commit 可能两个 finalize 叠跑；finalize 幂等全量重建、最后写赢、无损坏 → **不加锁（YAGNI）**。

### 与 B 的接口（A 留缝、不实现 B）

- **诚实的 `stale`** 已在 manifest → B 前端读 manifest 即可显示「N 页待重写」。
- **增量 `plan`（JSON）** 列出待重写页 → B 排队 / 显示；会话 agent 消费同一份。
- **`finalize` 可 spawn** → B 控制 API 直接调它做「立即机械刷新」。
- 档位（手动 / 全自动 / 定时）是 B 的事；A 把「提交即机械 finalize」做成默认行为、不写死，B 以后加「读 `sync_mode` 决定要不要顺带触发 prose 重生成」即可。

## 测试

### `test/fingerprint.test.js`
1. `writeFingerprints` → `readFingerprints` round-trip；缺文件 → `{}`；坏 JSON → `{}`。
2. `proseHash`：改决策史哨兵区内容 → hash 不变；改架构正文 → hash 变。

### `test/sync.test.js`（扩展）
3. finalize：正文不变 + 新 commit → `prose_sha` 保持、frontmatter `code_sha` 保持旧值。
4. finalize：正文改了 → `prose_sha` 推进到 current、`code_sha` = current。
5. finalize：seed（无指纹）→ `prose_sha = current`。
6. finalize：删页后再 finalize → 孤儿指纹被 GC。
7. `planSync` 增量：动过 A 的 code_root → A 入 worklist、未动的 B component 跳过；`--all` 全量。

### `test/manifest.test.js`（扩展）
8. scoped `countCommitsSince`：仅数动过指定 pathspec 的 commit。
9. `pageEntry`：动 A 的 code_root → A 页 `stale > 0`、B 页 `stale = 0`。

### `test/hook.test.js`（扩展）
10. hook 在有 manifest 时 detached spawn finalize（注入 `spawnFn` 断言被调 + 参数）；无 manifest 时不 spawn；spawn 抛错不影响 `exit 0`。

### 回归
11. 现有 sync / manifest / hook 测试：按新语义（`code_sha = prose_sha`）更新断言，意图不变；其余全绿。

## 改动清单

- 新增 `lib/fingerprint.js`、`test/fingerprint.test.js`
- 改 `lib/sync.js`（finalize 指纹化 + stamp `prose_sha` + GC；`planSync` 增量 + `--all`；构造 `staleScopes`）
- 改 `lib/manifest.js`（`makeCountCommitsSince` 加 pathspec；`emitManifest`/`pageEntry` 接收并用 `staleScopes`）
- 改 `lib/hook.js`（`captureHead` 后 detached `finalize`，有 manifest 才触发）
- 改 `commands/sync.md`（说明增量 + `--all`）、`docs/ROADMAP.md`（增量 sync 标完成）
- 扩展 `test/{sync,manifest,hook}.test.js`

## 不变量 / 风险

- **零依赖**不破（纯 Node 内置 + 复用现有 `translationSourceHash`）。
- **hook 永不挡 commit**（detached + try/catch + exit 0）。
- **指纹是缓存**：删了 `.state/fingerprints.json` 顶多下次全部 seed 成「现在新鲜」，不损坏 wiki。
- prose 仍由会话 agent 写（LLM gated 不变）；A 不引入自动 LLM。

## 实现节奏

spec → writing-plans → plan → TDD → 合并。B、C 各自另起 spec。

