# lore prompt-hook —— agent 消费三档（软/中/强）可选配置

> 2026-06-13 · 来源：benchmark 问题 2「agent 不自动用」的硬杠杆。CLAUDE.md 软注入是 session 级、会被长对话稀释；Claude Code 的 `UserPromptSubmit` hook 由 harness 每轮执行、agent 绕不过，是更硬的注入面。

## 问题

resident-mode（CLAUDE.md 注入）是 session 级软提示——长对话稀释、agent 可忽略。要把「agent 默认用 wiki」从概率事件推向机制保证，需要每轮触发的注入面。Claude Code `UserPromptSubmit` hook 正是：stdin 带用户 `prompt`，stdout `hookSpecificOutput.additionalContext` 注入 context（已 claude-code-guide 确认协议）。

## 决策

**三档可选，软档默认不变**（不强加任何 hook）：

| 档 | 机制 | 注入内容 | 装哪 |
|---|---|---|---|
| **软**（默认） | CLAUDE.md resident（现状） | session 开头一次 | 已有，不动 |
| **中** `notice` | `UserPromptSubmit` hook | 每轮注入精简提示「本 repo 有 wiki，理解代码先 lore_ask 建框架 + 锚点下钻；查为什么用 section=Decision history」 | `.claude/settings.local.json` |
| **强** `inject` | `UserPromptSubmit` hook | 每轮**门控**：问题像「理解/查找代码」才跑 `lore_ask <关键词>` 注入命中节切片（轻量 top 2）；闲聊不注入 | 同上 |

- **opt-in**：软档零配置；中/强档用户显式 `node lib/lorehook.js install notice|inject` 才装。默认写 `.claude/settings.local.json`（本机、gitignored——档位是「这台机器怎么干活」的偏好，同 sync mode 一贯设计，不强加协作者）；`--project` 旗标可写 `.claude/settings.json`（团队共享、进 git）。
- **强档门控**：避免每轮糊 context（讽刺地违背刚做的省 token 优化）——问题含代码理解信号词才注入，且只注 top 2 节切片、截断。
- 不做 `PreToolUse` block grep（过激、严重误伤合理 grep）。

## 架构

新文件 `lib/lorehook.js`，四个职责：

### 纯函数（可测核心）

```
gateEnrich(prompt, { level, search }) → { inject: boolean, context: string }
```
- `level='notice'`：恒 `inject:true`，context = 固定精简提示（混合范式三句）。
- `level='inject'`：门控——`looksLikeCodeQuestion(prompt)` 真才 inject；context = `search(keywords(prompt))` 的命中节切片（注入 search 便于测，CLI 用 searchPages+formatHits）。轻量：top 2、每节截 ~800 字符。
- `looksLikeCodeQuestion(prompt)`：关键词启发式——含「怎么/为什么/哪里/如何/架构/实现/模块/函数/查/找/理解/在哪/怎么做」或英文 how/why/where/architecture/implement/module/function/find/understand；纯闲聊（你好/谢谢/继续/push…）→ false。
- `keywords(prompt)`：取 prompt 里的实词（去停用词），喂 lore_ask。

```
buildSettingsHooks(level, lorehookCmd) → { UserPromptSubmit: [...] }
```
生成 settings.json hooks 片段，command = `node <abs>/lib/lorehook.js run --level=<level>`，带 lore 标记便于幂等识别/卸载。

### 副作用（薄封装）

- `installHook(repoRoot, level, { project=false })`：读/写 `.claude/settings.local.json`（或 `--project` 的 `settings.json`），merge `hooks.UserPromptSubmit`——保留用户其他 hook，仅替换/插入 lore 标记的条目。幂等。
- `uninstallHook(repoRoot, { project })`：删 lore 标记的 hook 条目，留其他。
- CLI `run` 模式：读 stdin JSON（`{prompt}`）→ `gateEnrich` → stdout `{hookSpecificOutput:{hookEventName:'UserPromptSubmit', additionalContext}}`（inject=false 时输出空 → 不注入）。永不抛（hook 失败不能挡用户 prompt）。

### CLI

```
node lib/lorehook.js install notice|inject [--project]   # 装/切档
node lib/lorehook.js uninstall [--project]               # 卸载
node lib/lorehook.js status                              # 当前装了哪档
node lib/lorehook.js run --level=<lvl>                   # hook 入口（读 stdin）
```

## 测试要点

- `gateEnrich`：notice 恒注入提示（含「锚点」「lore_ask」）；inject 对代码问题注入切片、对闲聊不注入；切片轻量截断。
- `looksLikeCodeQuestion`：代码问题 true、闲聊 false。
- `buildSettingsHooks`：JSON 结构正确（event/matcher/command 含 --level + 绝对路径）。
- `installHook`：写 settings.local.json、merge 保留既有 hook、幂等、`--project` 写 settings.json；`uninstallHook` 删 lore 条目留其他。
- `run`：stdin prompt → stdout 含 additionalContext（注入）/ 空（不注入）；坏 stdin → 不抛、空输出。

## dogfood + 文档

- lore 自己可选装 inject 档自测（手动验证 hook 真注入）。
- README 优势区补一句：中/强档 hook 可选（`lore hook install`）把「自动使用」从软提示升到每轮机制注入。
- `.claude/settings.local.json` 确认在 .gitignore（本机偏好不进库）。

## 不做（YAGNI）

- PreToolUse block（过激）。
- 强档的 LLM 门控（关键词启发式够，省一次 LLM 调用）。
- 壳控制台切档 UI（先 CLI；档位面板下轮可加）。
- SessionStart hook（和 CLAUDE.md resident 重复，无增量）。

## 实施顺序（给 plan）

T1 `gateEnrich` + `looksLikeCodeQuestion` + `keywords`（纯函数）→ T2 `buildSettingsHooks` + install/uninstall（settings.json merge）→ T3 CLI run 入口（stdin→stdout 协议）+ status → T4 README + .gitignore + dogfood 自测 + 全量回归。
