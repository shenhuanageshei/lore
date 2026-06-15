# lore agent 消费优化 —— 决策史按需 + 混合范式固化 + 定位

> 2026-06-13 · 来源：三轮冷启动 benchmark（`docs/superpowers/notes/2026-06-13-lore-agent-consumption-benchmark.md`）直接产出。

## 问题

1. **读厚页烧决策史物化区**（R1：wiki 102k > source 83k）：① wiki 组用 `ask.js` 找到页 → `Read` 整页，决策史 + 概览档全烧；② 即便走 `view=agent`，`agentView` 现在只剥「概览档」、**不剥决策史物化区**（页底折叠的 journal 原子是最长块）。
2. **agent 不自动用 + 价值主张不清**：靠 CLAUDE.md 软提示偶尔想起；lore 真正优势是「带 `func @ file` 锚点的导航层」（wiki 建框架 + 精准下钻），但没固化成 agent 默认流程，README 也没讲清「何时用 / 凭什么装」。

## 决策（用户认同方向 2026-06-13）

- `agentView` 剥决策史物化区——决策史从「读页默认带」变「问为什么才按需取」。
- `ask.js` CLI 返回节切片内容（不再只给路径，根治「找到页就 Read 整页」）。
- resident 文案固化「wiki 建框架 → 锚点下钻源码」混合范式 + 决策史按需 + 省 token 链路。
- README 加「何时用 lore / 优势区」定位：大型多模块 repo 导航层，不是替代源码。
- 不做强制使用（LLM 自主性是软约束天花板）；不做组合工具（节切片已带锚点，YAGNI）。

## 设计

### 1a `agentView` 剥决策史（lib/section.js）

`agentView` 当前剥「## 概览」→「## 机制详解」之间。扩展为**再剥** `## Decision history` 段（标题到下一 `## ` 或文末，含哨兵物化区），替换为单行指针：

```
## Decision history

> 决策史按需取：lore_page id=<page> section="Decision history"（或 ask "<主题> 为什么"）。
```

- 两档页：剥概览 + 剥决策史 → 只留「机制详解」骨架。
- 非两档页（鸟瞰/theme/flow，无「概览/机制详解」对）：仍剥决策史段（统一「view=agent 不带决策史」语义）。
- 无决策史段的页：原样返回。

### 1b `ask.js` CLI 节切片（lib/ask.js）

CLI 默认输出从「只列 `path#section`」改为「`path#section` 标题行 + 节切片内容」（复用 `sliceSection`，top N 默认 5，每条分隔线）。命中决策史节时切片即决策史片段（兑现「为什么只有 wiki 有」）。

- 加 `--paths` 旗标保留旧的「只列路径」行为（脚本/管道用）。
- 切片长度上限（每节 ~1500 字符截断 + 省略号），防单节过长。

### 1c + 2a resident 文案（lib/resident.js）

`residentSection` 文案升级（动态 stats 不变）：

```
**理解架构/查模块/查决策时，先查 wiki 再下钻源码——别一上来全文 grep。**
- 建框架：lore_ask "<关键词>"（返回命中节切片）→ lore_page view=agent（跳概览+决策史，只看机制骨架）。
- 精准下钻：wiki 页内锚点写作 `func @ file`——顺锚点直接 Read 那个函数/文件，不要全文 grep。
- 查「为什么/决策史/踩坑」：lore_page section="Decision history"（决策史只有 wiki 有，源码注释和 git log 查不动）。
- wiki 缺失（fresh clone 不进库）→ 先 /lore:sync。
```

`lore_page` 工具描述更新：`view=agent` 说明改为「跳人读概览档 + 决策史物化区，只留机制骨架（省约 60% token）」。

### 2b README 定位（README.md）

「是什么 / 为什么」段后加「## 何时用 lore（优势区）」小节：
- **强优势**：大型多模块 repo 的 agent 冷启动（跨文件建框架）、散在多文件的清单型事实（入口全景/dispatch 表/过滤全集——wiki 一张表 vs 源码十几次 grep）、决策史/「为什么不那样做」。
- **定位**：lore 是**带 `func @ file` 锚点的导航层**，不是源码替代——agent 用 wiki 30 秒建框架 + 精准下钻，省冷启动盲目 grep。
- **弱优势**：小 repo（几个文件）装了优势不明显——源码本身就一眼看完。
- 引脱敏 benchmark（3 轮冷启动：清单型问题 wiki 省 55% token / 1-3 工具调用 vs 源码 17-21 次）。

## 测试要点

- `agentView`：两档页剥概览+决策史、非两档页剥决策史、无决策史页原样、决策史指针行存在。
- `ask.js` CLI：默认输出含节切片内容；`--paths` 只列路径；长节截断。
- `residentSection`：含「锚点」「下钻」「section=」「为什么 grep」关键词。
- `lore_page` 描述含「决策史」。
- 既有回归：`mcp.test` 的 view=agent 断言更新（现在也剥决策史）。

## 实施顺序（给 plan）

T1 `agentView` 剥决策史 + mcp 描述 → T2 `ask.js` CLI 节切片 + `--paths` → T3 resident 文案（混合范式）→ T4 README 定位 + dogfood（lore 自己刷新 resident + 全量回归）。
