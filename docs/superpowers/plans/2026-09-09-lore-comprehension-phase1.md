# 实施计划 · ① 证据清洗与确认

> 关联设计：`docs/superpowers/specs/2026-09-09-lore-human-comprehension-and-shell-design.md` §7 ①（v2，已评审通过）
> 前序：⓪ 期（S1–S8）已交付，见 `docs/superpowers/plans/2026-09-09-lore-comprehension-phase0.md`
> 日期：2026-09-09 ｜ 硬约束：捕获与确认先于消费类功能；不变量 ①–⑧

## 0. 这一期要解决什么

⓪ 期把**地基**打好了（schema / 纪律 / 踩坑入库 / 体检 / 成本 / 传感器 / 代捕获约定），但两件事没做：

1. **schema 还是惰性的**——`normalizeAtom` 只被测试调用，真实写入路径（hook/mine/note）不经过校验器（代码评审 🔵#8；计划 S1 当时明示"纯新增"）。
2. **"可信"与"噪音"没有区分**——516 条原子里 127 条 why 仅剩 trailer，模板文本与重复摘要无人识别；owner 也没有任何"确认"动作，`status` 永远停在 draft/空。

本期目标：**让写入受契约约束，让噪音可见可降权，让 owner 的确认成为一等数据。**

## 1. 现状勘察

- 写入入口：`lib/hook.js`（commit 骨架）、`lib/mine.js`（commit / pitfall）、`lib/note.js`（agent 决策草稿）→ 全部经 `lib/journal.js` 落盘。
- `lib/atom.js` 的 `validateAtom` / `normalizeAtom` 已就绪，但**零生产调用方**（grep 仅测试）。
- 噪音现状（实测，**时点 2026-09-09 ⓪ 交付后**）：why 非空 272、仅 trailer 127；`kind:decision` 2 条（其中 1 条是 ⓪ 期自测写入的 draft）。**计数口径**：设计附录 B 的 490 是撰写时点；⓪ 交付后为 516 且随提交增长，S1 回放验收按「当时全量」执行，不钉死数字。
- 确认现状：`status` 字段在真实数据里几乎不存在；无 `lore confirm`。
- per-human 存储（`lib/human.js`）已具备 visits/read/blackbox/checks 四类，read 记录可直接复用。

## 2. 分阶段实施（4 阶段）

每阶段独立可验收；**任阶段自检失败两次即停**。

### S1 · 写入路径接线（schema 生效）
- **目标**：所有原子写入经 `normalizeAtom` 校验/规范化后再落盘；非法原子**拒绝写入并给出可读错误**（不静默写坏数据）；合法路径行为不变。
- **文件**：`lib/journal.js`、`lib/hook.js`、`lib/mine.js`、`lib/note.js`、`test/journal.test.js`、`test/hook.test.js`、`test/mine.test.js`、`test/note.test.js`
- **验收**：
  - 缺 `ts` / 未知 kind / pitfall 缺三字段 → 写入被拒且错误可读。
  - 机器来源缺 status → 落盘为 `draft`（不变量⑦）。
  - **历史回放**：对「当时全量」原子逐条重放全部通过（向后兼容；用运行时读到的条数断言，不钉死数字）。
  - **写入侧 trailer 闭合**（评审 🟡#4）：断言经校验器落盘的 why 已剥 trailer（⓪ S2 已接线，此处补显式回归断言防回退）。
  - **机器来源判定**（评审 🔵#5）：以 `source` 前缀判定（`owner*` 之外即机器来源），三入口共用同一函数。
  - append-only 不变：拒绝路径不产生半行。
- **自检**：`node --test test/journal.test.js test/hook.test.js test/mine.test.js test/note.test.js`

### S2 · 噪音分类器
- **目标**：新增 `lib/noise.js`，对原子分类并降权：trailer-only / 模板文本（如 "Generated with …"）/ 重复摘要（同 title 或 why 高度相似）。输出 `{level: none|low|high, reasons: []}`；供 `doctor` 与后续章节 digest 消费。
- **文件**：`lib/noise.js`（新）、`lib/doctor.js`、`test/noise.test.js`（新）、`test/doctor.test.js`
- **验收**：
  - 实测 127 条 trailer-only 全部标 `high`（不删除、不回填——设计 §3.4 禁止）。
  - 模板/重复样例被标；干净原子 `none`。
  - `doctor` 输出噪音分布（high/low/none 计数），`--json` 只增键。
  - 纯函数、无 I/O、确定性（同输入同输出，不读挂钟）。
- **自检**：`node --test test/noise.test.js test/doctor.test.js`

### S3 · `lore confirm` + 已阅 @ 版本
- **目标**：owner 的确认成为一等数据。`lore confirm <atom-id> [--why "…"]` 以**追加**方式记录确认（不改原行）；`lore read <page> --at <sha>` 记录「已阅 @ 版本」（复用 `lib/human.js` 的 read 记录）。
- **文件**：`lib/confirm.js`（新）、`lib/human.js`、`lib/cli.js`、`test/confirm.test.js`（新）、`test/cli.test.js`
- **验收**：
  - **存储定案**（评审 🟡#2）：确认记录落在 journal 内、独立 `kind:'confirmation'`（同源、天然 append-only、可审计）。
  - **有效状态 = 派生视图**（评审 🟡#1）：原子内联 status 不被改写；有效状态由「最新 confirmation 记录覆盖内联 status」派生（多条取最新；disputed 由 confirmation 的 verdict 字段产生）；派生规则同步写进设计 §3.2。
  - 确认后原原子**字节不变**（append-only 验证），新增一条确认记录（含 `confirmed_by` / `confirmed_at` / 目标 atom id）。
  - 重复确认幂等；确认不存在的 atom id → 明确报错 exit 1。
  - `doctor` 能报出「已确认决策数 / 待确认数」。
  - 机器重写（runner）不会改动确认记录（不变量③）。
- **自检**：`node --test test/confirm.test.js test/cli.test.js`

### S4 · 证据账本
- **目标**：`lore evidence [--json]` 为每条面向人的结论列账：来源 / 定位（`refs.anchors`）/ 时间 / 置信 / 确认人；**无锚点的结论显式标「未验证」**（不变量⑧），不渲染成确定事实。
- **文件**：`lib/evidence.js`（新）、`lib/cli.js`、`test/evidence.test.js`（新）
- **验收**：
  - 每条 `kind:decision|rejected|correction` 在账本中有一行；缺 `refs.anchors` 标「未验证」。
  - `--json` 字段稳定；只读，不写 `.lore`。
  - 与 `doctor` 的噪音分布交叉：high 噪音的原子在账本里标「低置信」。
  - （评审 🔵#8）`--json` 不含 `.lore/human/` 四类 per-human 存储内容；journal 内的 `confirmed_by` 属记录层、保留。
- **自检**：`node --test test/evidence.test.js`

## 3. 全局验收（本期完成判据）

| 项 | 判据 |
|---|---|
| schema 生效 | 写入路径全部经校验器；坏原子被拒；516 条历史回放通过 |
| 噪音可见 | 127 条 trailer-only 标 high；doctor 报分布；不删不改不 LLM 回填 |
| 确认一等 | `lore confirm` 可追加确认、幂等、原原子字节不变；`lore read` 记录已阅 |
| 证据账本 | 每条结论有账；无锚点标「未验证」 |
| 不变量 | ③（人的写入不可删改）、⑦（来源诚实）、⑧（证据锚定）在本期首次被真正执行 |
| 全量回归 | `node --test` 全绿 |

## 4. 明确不做（防范围蔓延）

- 再入简报 / 答辩 / 理解检查（②④期）。
- 壳的视觉重构（壳实现期）。
- docs 轴索引化、翻译层删除、graph 接消费者（③期或独立任务）。
- 历史 127 条 trailer-only 的 LLM 回填（设计 §3.4 明令禁止）——本期只降权、不修复。
- 章节 digest 与版本切分（③期）。

## 5. 风险与回退

| 风险 | 回退 |
|---|---|
| 接线后历史原子被拒（兼容性回归） | S1 验收含 516 条回放；不合规的字段用 normalize 补而非拒绝 |
| 噪音分类误伤真原子 | 分类只标级不删；阈值可配；先跑全库看分布再定闸 |
| 确认记录污染 journal | 确认是独立 `kind`（或独立文件），append-only，与原子同源可审计 |
| 证据账本泄露敏感信息 | 只读、本机渲染；`--json` 不含 per-human 内容 |
