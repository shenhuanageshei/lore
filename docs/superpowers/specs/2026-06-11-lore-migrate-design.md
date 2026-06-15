# lore 迁移机制设计 —— 期望态对齐器 + facts-only git 边界

> 2026-06-11 · brainstorm 定稿。问题来源：用户多机使用反馈。

## 问题

引擎升级后，**代码永远新**（命令走 `${CLAUDE_PLUGIN_ROOT}`，plugin.json 声明了 plugin 级 MCP 动态路径），但 **init 落进用户 repo 的资产停在 init 时的版本**，且没有任何机制告诉用户「该重跑 init」：

| repo 内资产 | 升级后 | 重跑 `/lore:init` 能自愈？ |
|---|---|---|
| `.lore/site/` 壳 3 文件 | 停老版——控制台/主题修复吃不到 | ✓ 无条件覆盖 |
| `config.yml` | 缺新配置块（docs 轴/deep/resident…）→ **新功能不可见** | ✗ 永不覆盖（保护用户编辑，设计如此） |
| `.git/hooks/post-commit` stub | 引擎绝对路径写死；stub 文案演进吃不到；换安装路径即静默死 | ✗ **含 lore MARKER 即跳过**（上轮 Windows git 弹窗久治不愈的根因） |
| `.mcp.json` | lore 条目路径写死 | ✓ merge 刷新 |
| `CLAUDE.md` resident 节 | 升级前 init 的 repo 根本没有 | ✓ 安装 |

附带痛点（同一轮反馈）：`.lore` 全量进库带来 git status/diff 噪音、多机 ndjson/wiki 合并冲突、生成物进库的洁癖问题。

## 决策（用户拍板 2026-06-11）

1. **config 迁移尺度 = append-only 补缺块**。已有行一个字不动；只补缺失块。弃「只提示不动文件」（用户要手抄）与「sidecar 对照文件」（留垃圾、靠用户勤快）。
2. **触发时机 = 运行时自动**（finalize 末尾）。弃「重跑 init 手动迁移」与「独立 /lore:migrate 命令」——两者都依赖用户记得跑，而本问题的根源恰是「没人告诉用户该跑」。init 重跑走同一套函数（手动迁移=自动迁移同一行为）。
3. **机构 = 期望态对齐器，无版本号**。每资产「算期望内容 → 比实际 → 不同才写」。弃「版本号驱动」（类 DB migration）：lore 版本号躺平 0.1.0 无人维护，忘 bump 即失效；dogfood 直改代码场景失灵。
4. **git 边界 = facts-only 进库**。动机三痛：status/diff 噪音、多机 pull/merge 冲突、生成物不该进库。弃「.lore 全 ignore」——journal 是不可再生事实源，丢了就真丢了。

## 架构

新文件 `lib/migrate.js`，核心导出：

```
alignAssets(repoRoot, loreDir) → [{asset, action}]   // 空数组 = 无事发生，幂等
```

**资产两类，语义不同**：

| 类型 | 资产 | 规则 |
|---|---|---|
| **收敛型**（无状态，每次比对） | 壳 3 文件、hook stub（含 MARKER 才动）、`.mcp.json` 已有 lore 条目、CLAUDE.md 已有节 refresh | 期望 ≠ 实际 → 写。永远收敛到当前引擎 |
| **一次性**（记录于 `.lore/.state/migrations.json`） | config 补缺块（`config:<block>`）、resident 首装（`resident:install`）、gitignore 行（`gitignore:<line>`）、gitattributes union 行（`gitattributes:journal-union`） | 三步判定：**目标已在 → skip；不在但 applied → skip（用户删除主权，不复活）；不在且未 applied → 补 + 记** |

`migrations.json` 形状 `{applied: [id…]}`；读坏/缺 → 空数组（best-effort，同 syncstate 风格）。state 目录 gitignored = per-machine；两机协作靠「目标已在 → skip」先看实际文件：A 机补块 commit 推上去，B 机检测到键已存在自然跳过。

**接线三处**：
1. `sync.js finalize` 末尾（现 `refreshResident` 调用点扩展为 `alignAssets`，整体 try/catch 不挡 finalize）→ 升级后下次 commit/sync 自动生效；
2. `init.js` 内部复用同一套（copyShell/installHook/mergeMcpConfig/installResident 的调用收敛进对齐器路径）；
3. CLI `node lib/migrate.js <repoRoot>` 手动触发（调试/立即对齐）。

**容错**：单资产失败（如 serve 正在读壳文件时 Windows EBUSY）→ 该资产记 `{asset, action:'error'}`，不挡其他资产。

## 收敛资产细节

- **壳**：`copyShell` 改逐文件 buffer 比对，不同才 `copyFileSync`；期望源 = 引擎 `site/`，清单 `SHELL_FILES` 驱动（新增壳文件自动纳入）。dogfood 顺带受益：本 repo `.lore/site/` 以前要手动刷，今后 finalize 自动同步。**声明：`.lore/site/` 是引擎领地，用户手改会被覆盖**（文档写明）。
- **hook stub**：`installHook` 重构——stub 存在且含 lore MARKER 时，渲染期望 stub（当前引擎 hook.js 路径）与实际比对，不同 → 重写 + chmod，返回值新增 `'refreshed'`。**foreign hook（无 MARKER）永不动**；`hookspath-set` / `no-git` 语义不变。
- **`.mcp.json`**：已有 lore 条目 → `mergeMcpConfig` 现有幂等逻辑纳入（路径过期即刷新，别家 server 不碰）；用户删 lore 条目且 `resident:install` applied → 不复活。
- **CLAUDE.md 节**：`refreshResident` 现有「有节才刷」语义纳入。config `resident:false` → 跳过 install；refresh 仍只对已有节生效（config 关了但节还在的矛盾态：按「节在就刷」处理，删节是用户的事）。

## git 边界（facts-only）

| 路径 | 处置 | 理由 |
|---|---|---|
| `.lore/wiki/` | **ignore** | 生成物（journal+源码可再生）；auto 重写多机冲突源 |
| `.lore/site/` | **ignore** | 引擎拷贝；对齐器兜住 clone 后没壳（finalize/init 自动再生） |
| `.lore/.state/` | ignore（已有） | per-machine 状态 |
| `.lore/journal/` | **进库** | 事实源不可再生 |
| `.lore/config.yml` | **进库** | 共享配置；迁移两机协作的前提 |

- `ensureGitignore` 升级为**多行补缺**（`.lore/wiki/`、`.lore/site/`、`.lore/.state/`），每行独立一次性 ID——用户故意删行（如想 track wiki 做展示）不复活。
- 新增 `.gitattributes` 行：`.lore/journal/**/*.ndjson merge=union`（append-only 行集合用 union merge，两机各自追加自动合并）。同为一次性。
- **本 repo dogfood 自迁移**（实施时一次性操作）：`git rm -r --cached .lore/wiki .lore/site` + 两文件更新。GitHub 样例 wiki 展示消失——可接受，以后用导出/截图解决。
- **连带**：fresh clone 无 wiki → CLAUDE.md resident 节文案补一句「wiki 缺失时先跑 `/lore:sync`」；`lore_ask` 空 manifest 时返回同样引导。
- journal 残留噪音诚实声明：status 仍会有 journal ndjson 几行追加的尾巴（保留决策史的代价），但 wiki/.manifest/.graph 那一大坨消失，量级大降。

## config 补缺块

模板 `renderConfigYaml` 拆为块定义：

```
CONFIG_BLOCKS = [{id, detect, insert, template}]
```

- **检测**：行正则扫描键存在性（顶层 `^language:`；axes 二级 = `axes:` 块内 `^  docs:`），与现有手写 parser 同风格。
- **插入两种**：顶层块缺失（`language:`、`journal:`、resident 注释块）→ 文件**末尾 append**（带注释的模板原文，前导空行）；axes 二级块缺失（`docs`/`flow`/`theme`）→ **锚定插入**到 `axes:` 块末尾（最后一个属于该块的缩进行之后，缩进 2）。**已有行永不改一个字**。
- `axes.component` 不列入补缺（没有它说明根本没 init 过，不是迁移场景）。
- 边界：`axes:` 顶层锚不存在 → 二级块全部 skip 且**不记 applied**（非正常 init 产物，不强行修；下次对齐若锚出现再补）。
- 模板新增一行注释块 `# resident: true`（CLAUDE.md 注入开关的可发现性——目前用户不知道有 `resident:false`）。
- 块清单：`config:language`、`config:axes.docs`、`config:axes.flow`、`config:axes.theme`、`config:journal`、`config:resident-note`。

## 可见性

- CLI 跑 finalize/init 时打印一行：`migrate: shell ×3, hook stub, config +axes.docs`；**零动作零输出**；hook 后台跑保持静默（现状 `>/dev/null`）。

## 测试计划

`test/migrate.test.js` + 既有回归：

- 壳：旧内容 → 刷新；再跑 → 空动作（幂等）。
- hook stub：老路径含 MARKER → 重写为当前路径；foreign 无 MARKER → 永不动。
- `.mcp.json`：lore 条目老路径 → 刷新；删条目且 applied → 不复活。
- config：缺顶层块/缺 axes 二级块 → 插入位置正确 + **已有行逐字节比对不变** + migrations 记录；删块且 applied → 不复活；fresh 模板 → 零动作。
- gitignore/gitattributes：补缺行 + 一次性语义（删行不复活）。
- 集成：init 走同一套；finalize 末尾 best-effort（migrate 抛错不挡 finalize）。
- 既有 `init.test` 的 `installHook` 返回值语义更新（新增 `refreshed`）。

## 不做（YAGNI / 明确弃案）

- 版本号驱动迁移、版本化迁移脚本编排。
- config 三方 merge、修改/删除已有行。
- 独立 `/lore:migrate` 命令（CLI 入口 `node lib/migrate.js` 已够调试用）。
- wiki 内容迁移（wiki 已出库，无意义）。
- 壳文件用户自定义保护（site/ 声明为引擎领地）。

## 实施顺序提示（给 plan）

T1 migrate.js 骨架 + 壳对齐 → T2 hook stub 刷新 → T3 .mcp.json/CLAUDE.md 节纳入 + `resident:install` 一次性 → T4 config 补缺块 → T5 gitignore/gitattributes → T6 接线（finalize/init/CLI）→ T7 resident 文案 + lore_ask 空引导 → T8 dogfood 自迁移（`git rm --cached`）+ 全量回归。
