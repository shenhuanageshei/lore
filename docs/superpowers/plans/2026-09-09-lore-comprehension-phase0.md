# 实施计划 · ⓪ 数据与证据地基

> 关联设计：`docs/superpowers/specs/2026-09-09-lore-human-comprehension-and-shell-design.md`（v2，已评审通过）
> 日期：2026-09-09 ｜ 范围：设计文档 §7 的 ⓪ 期（不含 ① 及以后）
> 硬约束：捕获与确认先于消费类功能；不变量 ①–⑧ 见设计文档 §2

## 0. 这一期要解决什么

三件事，缺一件后面全塌：

1. **数据能落盘**：六类原子的 schema 与校验器（现在只有 commit/decision 两种，且无校验）。
2. **写入不再掺假**：trailer-only 的 why 不再进库（实测 127 条）。
3. **"没记下来"能看见**：体检 + 捕获召回率 + 壳打开传感器——lore 最危险的失败是**安静地不工作**（hook 曾断流 3 个月、85 提交零原子）。

不做：理解层消费类功能（再入简报 / 答辩 / 检查）、壳的视觉重构（属 ①/② 期）。

## 1. 现状勘察（开工前事实）

- 无统一 CLI：`lib/*.js` 15 个独立入口（`ask/hook/host/init/lint/lorehook/manifest/migrate/mine/note/portal/runner/serve/sync/translate`），无 `bin`，无 `lore <verb>` 入口 → 不变量④（CLI 对等）当前**不成立**。
- 原子现状：490 条中 `kind:decision` 1 条；`why` 非空 272、仅 trailer 127；`refs.pitfall` 0 条；`status` 字段尚不存在。
- 死声明：`.lore/config.yml` 有 `mine: [commits, changelog, claude_md_pitfalls]`，但 `lib/mine.js:50` 只写 `kind:'commit'`、`:56` 硬编码 `pitfall:null`。
- `stripTrailers` 已在 `lib/fold.js:72`、`lib/mine.js:7`，仅在渲染侧生效。

## 2. 分阶段实施（7 阶段）

每阶段独立可验收；**任阶段自检失败两次即停**，不带着红灯往下走。

### S1 · 原子 schema 与校验器
- **目标**：定义六类原子（`decision|rejected|correction|question|evidence|pitfall`）的字段契约与校验/规范化函数；**不改变现有写入行为**（纯新增）。
- **文件**：`lib/atom.js`（新）、`test/atom.test.js`（新）
- **验收**：
  - 六类 kind 各有合法/非法用例；未知 kind 拒绝。
  - `status` 仅允许 `draft|confirmed|disputed|superseded`；`confirmed` 必须带 `confirmed_by`。
  - `pitfall` 缺 `problem|fix|prevention` 任一 → 非法。
  - 对现有 490 条原子全通过（向后兼容），未知字段保留不丢。
- **自检**：`node --test test/atom.test.js`

### S2 · 写入侧纪律（trailer-only 不落库）
- **目标**：`stripTrailers` 前移到写入侧；剥掉 trailer 后为空则不写 `why` 字段；补会红的回归测试。
- **文件**：`lib/fold.js`、`lib/hook.js`、`lib/mine.js`、`lib/note.js`、`test/fold.test.js`、`test/mine.test.js`、`test/hook.test.js`、`test/note.test.js`
- **验收**：
  - 新写入的原子 `why` 不含 `Co-Authored-By|Signed-off-by|Generated with`。
  - 剥后为空 → 不写 `why` 键（而非写空串）。
  - 渲染侧 `renderDecisionHistory` 行为不变（老原子仍防御性剥离）。
- **自检**：`node --test test/fold.test.js test/mine.test.js test/hook.test.js test/note.test.js`

### S3 · 踩坑入库（接线死声明）
- **目标**：`mine.js` 按 config `claude_md_pitfalls` 从 CLAUDE.md / AGENTS.md 抽「问题 / 修复 / 预防」→ `kind:pitfall` 原子（按内容 hash 去重，幂等）。
- **文件**：`lib/mine.js`、`test/mine.test.js`、`.lore/config.yml`（仅当决定不接线时改）
- **验收**：
  - 当前仓库 11 条踩坑能落成 11 条 `kind:pitfall` 原子，过 S1 校验。
  - 重复 mine 不新增（幂等）。
  - AGENTS.md 与 CLAUDE.md 同源去重（不因双份维护而写两份）。
- **自检**：`node --test test/mine.test.js`

### S4 · per-human 存储与统一 CLI
- **目标**：`.lore/human/*.jsonl`（visits / read / blackbox / checks）+ 统一入口 `node lib/cli.js <verb>`（`visit|read|blackbox|human export`）+ 边界（不进 git）。
- **文件**：`lib/human.js`（新）、`lib/cli.js`（新）、`test/human.test.js`（新）、`lib/migrate.js`（把 `.lore/human/` 追加进 .gitignore）、`.gitignore`
- **验收**：
  - 四个 verb 可读写且幂等；坏行跳过不崩。
  - `lore human export` 产出可移植 JSON（含 schema 版本号）。
  - 新 init 的仓库自动 ignore `.lore/human/`（不变量⑥）。
  - 未 `init` 过的目录调用 verb → 明确报错而非静默写散文件。
- **自检**：`node --test test/human.test.js`

### S5 · 体检 + 捕获召回率（"没记下来"要能看见）
- **目标**：`node lib/cli.js doctor` 报告：hook 指向是否有效、上次成功捕获时间、断流天数、决策捕获率（`kind:decision` ÷ 提交数）、trailer-only 计数、`refs.pitfall` 计数；支持 `--json`。
- **文件**：`lib/doctor.js`（新）、`lib/cli.js`、`test/doctor.test.js`（新）
- **验收**：
  - 对本仓库输出真实数字（原子 490 / decision 1 / trailer-only 127）。
  - 非 git 目录降级不崩，字段标 `unknown` 而非 0。
  - `--json` 输出可被程序消费（字段稳定）。
- **自检**：`node --test test/doctor.test.js`

### S6 · 成本账本 + 预算闸
- **目标**：每次 LLM 调用追加 `.lore/.state/cost.ndjson`（`{ts,page,backend,ms,ok,tokens?}`）；每版本 token 预算，超限时 auto 不启动并给出原因。
- **文件**：`lib/cost.js`（新）、`lib/runner.js`、`lib/backend.js`、`lib/syncstate.js`、`test/cost.test.js`（新）
- **验收**：
  - 成功/失败/超时都记账；坏行跳过。
  - `tokens` 拿不到时留空（不伪造 0）——CLI 后端目前不回报 token 数。
  - 预算超限 → `shouldRunAuto` 返回 `{run:false, reason:'budget'}`，且不产生副作用。
  - 预算未配置 → 行为与今天一致（不阻断）。
- **自检**：`node --test test/cost.test.js test/runner.test.js`

### S7 · 壳打开传感器
- **目标**：壳打开页面时调用 `visit`（本地、失败静默），为 ② 期的再入简报与健康度提供数据。
- **文件**：`site/shell.mjs`、`test/shell.test.js`
- **验收**：
  - 打开页写入一条 visit；同一页短时间内重复打开可去重（窗口可配）。
  - CLI 不可用 / 无 .lore → 静默降级，不影响阅读。
  - 不引入任何宿主依赖（浏览器内不调用外部网络）。
- **自检**：`node --test test/shell.test.js`

## 3. 全局验收（本期完成判据）

| 项 | 判据 |
|---|---|
| 六类原子 | schema + 校验器落地，现有原子全兼容 |
| trailer-only | 新写入为 0；lint/测试会红 |
| 踩坑 | 11 条入库且幂等；`claude_md_pitfalls` 不再是死声明 |
| CLI 对等 | `visit/read/blackbox/human export/doctor` 全部有一等 CLI |
| per-human 边界 | `.lore/human/` 不进 git，可导出 |
| 可见性 | `doctor` 能报出断流天数与决策捕获率 |
| 成本 | 每次调用有账，预算可闸 |
| 全量回归 | `node --test` 全绿（含现有 587 项） |

## 4. 明确不做（防范围蔓延）

- 理解层消费功能（再入简报 / 答辩 / 检查）——属 ①–④ 期。
- 壳的视觉重构（浅色工作台那套 tokens）——属壳实现期。
- docs 轴索引化、翻译层删除、graph 接消费者——属 ③ 期或独立任务。
- 历史 127 条 trailer-only 的 LLM 回填——设计文档 §3.4 明令禁止。

## 5. 风险与回退

| 风险 | 回退 |
|---|---|
| 新增 `lib/cli.js` 与现有 `lib/*.js` 入口语义冲突 | 新入口只做分发，不改旧入口；旧入口保持可直接调用 |
| 写入侧剥离影响既有 hook 行为 | S2 只动 why 字段；提交骨架的 title/refs 不变，回归测试覆盖 |
| `.lore/human/` 误入 git | migrate 自动追加 ignore + 全局验收项 |
| 预算闸误伤日常使用 | 默认不配置 = 不阻断；仅在显式配置后生效 |
