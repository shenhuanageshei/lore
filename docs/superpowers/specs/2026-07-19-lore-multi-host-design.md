# lore 多宿主兼容 —— Codex + opencode 全面对齐

> 2026-07-19 · 来源：lore 引擎本体（journal/sync/serve/ask/mcp…）零依赖、宿主无关，但 5 个接线面全是 Claude Code 专属。目标：codex / opencode 用户获得与 Claude Code 基本相同的完整体验，且现有纯 Claude 用户零行为变化。

## 问题

lore 与 Claude Code 的耦合面共 5 处：

| # | 耦合面 | 现状 |
|---|---|---|
| 1 | 打包/命令 | `.claude-plugin/plugin.json` + `commands/*.md`（9 个 slash 命令，体内 `${CLAUDE_PLUGIN_ROOT}`） |
| 2 | resident 注入 | `lib/resident.js` 只写 `CLAUDE.md`；`lib/migrate.js` 对齐 `claude-md` + repo 级 `.mcp.json` |
| 3 | prompt-hook | `lib/lorehook.js` 写 `.claude/settings*.json` 的 `UserPromptSubmit`（中/强档） |
| 4 | auto 档 LLM 后端 | `lib/runner.js` 只有 `claudeBackend()`（`claude -p`） |
| 5 | 文档叙述 | README 等全按 Claude Code 写 |

已宿主无关、直接复用的部分：journal / mine / note / sync(plan+finalize) / serve / portal / ask / lint、post-commit git hook、`lib/mcp.js`（stdio server，按 `process.cwd()/.lore/wiki` 现读，三宿主起 server 时 cwd 都是各自项目根，天然逐 repo 生效）。

## 决策

**方案 A：宿主抽象层 + 适配器**（对比淘汰：B 旁挂双模块——命令模板三份漂移；C 最小接缝——sync.md 161 行核心编排三处手同步）。

### D1 宿主能力矩阵（`lib/host.js` 新增）

每宿主一个适配器对象，差异面全部声明在一处：

| 能力面 | claude | codex | opencode |
|---|---|---|---|
| instructionFiles | `CLAUDE.md` | `AGENTS.md` | `AGENTS.md` |
| MCP 注册 | repo `.mcp.json`（现状不动） | 全局 `~/.codex/config.toml` `[mcp_servers.lore]` | 全局 `~/.config/opencode/opencode.json` `mcp.lore` |
| 命令目录 | 插件 `commands/`（不生成） | 全局 `~/.codex/prompts/lore-*.md`（调 `/prompts:lore-*`） | 全局 `~/.config/opencode/commands/lore-*.md`（调 `/lore-*`） |
| prompt-hook | 三档全（现状） | 无机制 → 软档封顶 | 插件 `tui.prompt.append`（待 spike，见 D4） |
| runner 后端 | `claude -p`（现状） | `codex exec --sandbox read-only` | `opencode run` |
| detect | binary on PATH | binary + `codex login status` | binary + provider 已配置（子命令实现期以本机 CLI 为准） |

### D2 启用模型：机器层 + 仓库层分离

- **机器层**（一次性）：`node lib/host.js install codex opencode` → 写全局命令文件 + 全局 MCP 注册 + 记入 `~/.lore/hosts.json`（机器级启用清单）。另有 `uninstall` / `status`。
- **仓库层**（每 repo）：init/migrate/finalize 读机器启用清单 → 往对应 instructionFiles 注入 LORE_RESIDENT sentinel block。
- **零变化不变量**：默认启用集 = `{claude}`，现有纯 Claude 用户磁盘 diff 为零。
- **版本收敛**：全局命令文件内嵌 `lore:vX.Y.Z` 标记；finalize 的 alignAssets 顺带重新生成（与 repo 内资产 migrate 同一思路），引擎升级命令自动跟上。所有全局配置改动前写一次性 `*.lore.bak` 备份。

### D3 命令模板单一真源

源模板 = 现有 `commands/*.md`，**一行不改**。生成器（host.js 内）读源做三项变换：

1. `${CLAUDE_PLUGIN_ROOT}` → 引擎绝对路径（正斜杠；与 `.mcp.json` 烘焙策略一致：挪位置重跑 install）。
2. frontmatter：opencode 保留 `description`（原生支持）；codex 剥掉（prompts 无此概念）。
3. 命名映射：`sync.md` → `/lore:sync`（claude 现状）→ `lore-sync.md`（opencode `/lore-sync`；codex `/prompts:lore-sync`）。

参数：opencode 原生 `$ARGUMENTS`（与 claude 同语法，零变换）；codex 无可靠参数机制 → 生成时把 `$ARGUMENTS` 替换为一行「用户在命令后输入的内容即参数」，agent 自取（实现期 spike 验证后微调）。

**防漂移断言**（测试）：三份输出的指令正文（去占位符差异）逐字相同。

### D4 prompt-hook 宿主落差

| 档 | claude | codex | opencode |
|---|---|---|---|
| 软（resident） | ✓ | ✓ | ✓ |
| 中/强 | ✓ `UserPromptSubmit` | ✗ 无机制，软档封顶 | 插件 `tui.prompt.append`，待 spike |

- opencode 方案：生成全局插件 `~/.config/opencode/plugins/lore.js`，钩子里 shell 调 `node <engine>/lib/lorehook.js run --level=<lvl>`（子进程 ~200ms，远低于 hook 超时）——**复用 lorehook.js 全部既有逻辑**（门控/关键词/检索/文案），零重复；三档切换仍走 `lorehook.js install/uninstall`，仅写出的资产从 `.claude/settings.json` 换成插件文件。
- **回落**：若 spike 证明 `tui.prompt.append` 不能注入文本（或仅限 TUI 交互），opencode 同样软档封顶。两种结局不影响其余设计。

### D5 resident + MCP 细节

- resident.js 三个函数（install/refresh/remove）目标从单一 `CLAUDE.md` 改为「启用宿主的 instructionFiles 列表」；sentinel 机制原样（幂等、只动标记节、用户删掉不复活）。block 文案仅 `/lore:sync` 一句按宿主参数化（适配器 `syncHint`：claude→`/lore:sync`、opencode→`/lore-sync`、codex→`/prompts:lore-sync`），其余宿主无关不动。
- MCP：claude 的 repo 级 `.mcp.json` merge 现状不动。codex 往 `config.toml` 追加/替换 `[mcp_servers.lore]` 整节——零依赖不引 TOML 解析器，按节标题正则定位的纯文本手术（该节 lore 全权管理，不碰他节）。opencode 往全局 `opencode.json` merge `mcp.lore = {type:'local', command:['node','<abs>/lib/mcp.js']}`；`.jsonc` 用自包含去注释状态机解析合并，失败兜底打印手动片段。
- `lib/mcp.js` 零改动。

### D6 runner 多后端（`lib/backend.js` 从 runner.js 拆出）

契约不动：`rewritePage({page, repoRoot, timeoutMs}) → Promise<string>`（stdout 出全文，写盘权在 runner，质量门把关）。

- `claudeBackend()`：现状原样搬迁。
- `codexBackend()`：`codex exec "<prompt>" -C <repoRoot> --sandbox read-only --output-last-message <.state/tmp 文件>`——`--sandbox read-only` 内核级强制只读（比工具白名单更硬）；`--output-last-message` 直接拿最终消息，比解 stdout 干净，读完即删。错误分类对齐现状：ENOENT→`codex-cli-missing`、killed→`timeout`、其余带 stderr 截 300。
- `opencodeBackend()`：`opencode run "<prompt>"`（cwd=repoRoot）。只读双保险：① `OPENCODE_CONFIG` 指向 lore 自带 runner 配置（`permission: {edit:deny, write:deny, bash:deny}`，合并语义实现期 spike）；② prompt TAIL「绝不调用写盘工具」原样保留。stdout 取首个 frontmatter `---` 起（同 claude 提取法）。最坏情况（LLM 违规写盘）与 claude 后端加 `--disallowedTools` 前同级，质量门语义不变。
- **选择**（配置优先 + 探测兜底）：`.state/sync.json` 增 `backend: auto|claude|codex|opencode`，默认 `auto`；控制台加下拉 + 显示当前生效后端。`auto` 按 `claude→codex→opencode` 探测（claude 无廉价 auth 探针只验 binary；codex 验 `login status`；opencode 验 provider 已配置），探测全 best-effort 永不抛。
- **运行时 failover**：仅「后端不可用类」错误（cli-missing/auth/provider）当页换下一个可用后端重试一次；timeout/质量门失败不 failover。每页实际后端记入 `auto-runs.ndjson`，控制台可见。

## 架构

```
lib/host.js      新增 —— 宿主能力矩阵 + 启用清单读写 + 命令生成器 + 全局 MCP 安装 + CLI（install/uninstall/status）
lib/backend.js   新增 —— 三后端工厂 + detectBackend + failover 包装（从 runner.js 拆）
lib/runner.js    改 —— claudeBackend 搬出；runAuto 接 backend 选择/failover；CLI 入口走 auto 选择
lib/resident.js  改 —— 三函数遍历启用宿主 instructionFiles；syncHint 参数化
lib/migrate.js   改 —— alignAssets 的 claude-md 资产泛化为多 instructionFiles；finalize 顺带重生成全局命令
lib/init.js      改 —— resident 判定跟启用清单走
lib/lorehook.js  改 —— install/uninstall 按启用宿主写 claude settings 和/或 opencode 插件文件
lib/syncstate.js 改 —— sync.json 增 backend 字段
server.js        改 —— 控制台 API：backend 下拉 + 当前生效后端显示
commands/*.md    不动（单一真源）
lib/mcp.js       不动
```

## 测试要点

新增 `test/host.test.js` + `test/backend.test.js`（注入 fs/exec 假实现，零外部依赖）：

- **host**：detect 优先级与 provider 检查（binary 缺 / provider 挂 → 跳过）；启用清单默认值 = `{claude}`（零变化不变量显式守）。
- **命令生成器**：三宿主占位符替换正确；指令正文三份逐字相同（防漂移）；幂等重生成；版本标记更新。
- **backend**：三后端 argv 形状（codex 必含 `--sandbox read-only`）；stdout/last-message 提取；错误分类（ENOENT/killed/stderr 截 300）；failover 只在不可用类触发、每后端试一次。
- **resident**：多文件 install/refresh/remove；用户删 AGENTS.md 不复活；`resident:false` 全灭。
- **MCP 合并**：TOML 节追加/替换/他节不动；JSON merge 不覆盖他 server；JSONC 去注释 + 失败兜底；bak 只写一次。
- **回归**：既有 420+ 测试全绿为硬门槛；`runAuto` 现有测试的 `claudeBackend` 注入点改 `backendFor('claude')`，语义不变。

## dogfood + 文档

- 本 repo 机器层 `install codex opencode` 自测（若 CLI 在场）；至少走完 install→status→uninstall 全环。
- README：快速上手分宿主、命令表加「三宿主调用形态」列、`lib/` 清单加 host/backend、auto 档行改为多后端。
- 本 repo CLAUDE.md lore 段同步；ROADMAP 勾掉「codex 后端」相关项。

## 不做（YAGNI）

- 裸 API 后端（ROADMAP 后续独立项）。
- opencode 项目级命令 / codex 项目级任何东西（codex 无项目级 prompt 机制；全局已选定）。
- codex 中/强档（无机制，物理不可移植）。
- per-repo 后端覆盖（机器级 sync.json 已够；真要多后端并存再议）。
- opencode 原生工具注册（插件 `tool:` 可代替 MCP，但 MCP 三宿主通吃，不引入第二机制）。

## 实施顺序（给 plan）

T1 `lib/host.js` 能力矩阵 + 启用清单 + CLI 骨架 → T2 命令生成器（三宿主渲染 + 防漂移测试）→ T3 resident/migrate 多文件泛化 + MCP 全局合并（TOML/JSON/JSONC + bak）→ T4 `lib/backend.js` 三后端 + detect + failover + runner 接线 + syncstate/控制台 → T5 lorehook opencode 插件（先 spike `tui.prompt.append`，失败则软档封顶落定文档）→ T6 文档 + dogfood + 全量回归。
