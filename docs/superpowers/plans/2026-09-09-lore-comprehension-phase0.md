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
- 原子现状（**口径统一**：撰写时 490 条 = 489 `commit` + 1 `decision`；实施后实测 509 条 = 新增 11 条 `pitfall` + 8 条 hook 原子）：`kind:decision` 1 条；`why` 非空 272、仅 trailer 127；`refs.pitfall` 0 条；`status` 字段尚不存在。
- 死声明：`.lore/config.yml` 有 `mine: [commits, changelog, claude_md_pitfalls]`，但 `lib/mine.js:50` 只写 `kind:'commit'`、`:56` 硬编码 `pitfall:null`。
- `stripTrailers` 已在 `lib/fold.js:72`、`lib/mine.js:7`，仅在渲染侧生效。

## 2. 分阶段实施（8 阶段）

每阶段独立可验收；**任阶段自检失败两次即停**，不带着红灯往下走。

### S1 · 原子 schema 与校验器
- **目标**：定义六类原子（`decision|rejected|correction|question|evidence|pitfall`）的字段契约与校验/规范化函数；**不改变现有写入行为**（纯新增）。
- **文件**：`lib/atom.js`（新）、`test/atom.test.js`（新）
- **验收**：
  - 六类 kind 各有合法/非法用例；**未知 kind 拒绝，但 `commit` 作为 legacy 合法 kind 显式保留**——历史 489 条都是它，不保留就与「现有原子全通过」自相矛盾（评审 🔴#3）。
  - 公共字段逐个枚举、各有合法/非法用例：`title` / `why` / `refs{supersedes,evidence,files,anchors}` / `source` / `status` / `confirmed_by` / `confirmed_at`（不变量⑦⑧ 的数据基础，评审 🟡#6）。
  - `status` 仅允许 `draft|confirmed|disputed|superseded`；`confirmed` 必须带 `confirmed_by`。
  - **机器来源（agent / miner / hook）写入 ⇒ `status` 只能是 `draft`**（§3.2「只有 owner 的直接动作能产生 confirmed」，评审 🟡#5）。
    - **口径落在 `normalizeAtom`（审计 D6）**：只对机器来源（`source` 取 `:` 前那段 ∈ agent|miner|hook）缺 `status` 的原子补 `draft`；**人工/历史来源缺 `status` 就保持无 `status`**——无差别补 `draft` 会把 owner 手写的 decision 标成机器草稿（违反不变量③/§3.2）。显式 `status` 永不被覆盖。
  - `pitfall` 缺 `problem|fix|prevention` 任一 → 非法。
  - 对现有全部原子（实测 509 条）通过校验，未知字段保留不丢。
- **自检**：`node --test test/atom.test.js`

### S2 · 写入侧纪律（trailer-only 不落库）
- **目标**：`stripTrailers` 前移到写入侧；剥掉 trailer 后为空则不写 `why` 字段；补会红的回归测试。
- **文件**：`lib/fold.js`、`lib/hook.js`、`lib/mine.js`、`lib/note.js`、`lib/lint.js`（会红规则 `lintTrailerOnly`）、`test/fold.test.js`、`test/mine.test.js`、`test/hook.test.js`、`test/note.test.js`、`test/lint.test.js`
- **前置**：先审计**全部**写 `why` 的入口并把完整集合写进本节——§1 列了 15 个 lib 入口，除上述四个外是否还有别的写 why 未核实（评审 🟡#8）。
- **验收**：
  - 新写入的原子 `why` 不含 `Co-Authored-By|Signed-off-by|Generated with`。
  - 剥后为空 → 不写 `why` 键（而非写空串）。
  - 渲染侧 `renderDecisionHistory` 行为不变（老原子仍防御性剥离）。
  - **lint 会红**（审计 D9-lint）：`lintTrailerOnly` 查两个落点——已 finalize 的页（正文独立成行的 trailer）与 journal 原子（why 剥完为空）；命中即 `clean:false` 并在 CLI 输出 `trailer-only (N)`。历史 127 条不回填，但一直可见。
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
分两阶段执行（S4a 自检先绿再进 S4b）：**S4a 存储层** → **S4b 统一 CLI 与边界**。
- **目标**：`.lore/human/*.jsonl`（visits / read / blackbox / checks）+ 统一入口 `node lib/cli.js <verb>`（`visit|read|blackbox|human export`）+ 边界（不进 git）。
- **文件**：
  - S4a：`lib/human.js`（新）、`test/human.test.js`（新）
  - S4b：`lib/cli.js`（新）、`test/cli.test.js`（新）、`package.json`（`bin: {lore: "./lib/cli.js"}`——不变量④ 的 `lore <verb>` 入口，零依赖、无副作用）、`lib/migrate.js`（GITIGNORE_LINES 增 `.lore/human/`）、`.gitignore`、`test/migrate.test.js`（增行后同步该行数期望值）
- **验收**：
  - 四类记录（visits / read / blackbox / checks）可 append 与读回；坏行跳过不崩。
  - 五个 verb（visit / read / blackbox / human export / **human clear**）可读写且幂等——不变量⑥ 明列「可清除」必须有 CLI（评审 🟡#4）。
  - `lore human clear --kind <visits|read|blackbox|checks|all> [--yes]` 写前打印将删条数（存储层 `clearHuman` 的 `dryRun`）；**缺 `--yes` 一律不删并 exit 1**（静默「什么都没做」是最危险的失败形态），`--yes` 才删；清除 = 删文件，之后 `appendHuman` 按需重建（清除后可继续追加，审计 D9）。
  - `lore check`（设计 §3.3）本期只落 `checks.jsonl` 存储层、不落 verb——**显式声明延后到 ④ 期**，避免被当成不变量④ 漏项（评审 🔵#9）。
  - `lore human export` 产出可移植 JSON（含 schema 版本号）。
  - 新 init 的仓库自动 ignore `.lore/human/`（不变量⑥）。
  - 未 `init` 过的目录调用 verb → 明确报错而非静默写散文件。
  - `--root` 给了却没值 → 用法 + exit 1（与 `--out` 同一纪律，不静默回落 cwd——审计 D9-cli）。
- **自检**：S4a `node --test test/human.test.js`；S4b `node --test test/cli.test.js test/migrate.test.js`

### S5 · 体检 + 捕获召回率（"没记下来"要能看见）
- **目标**：`node lib/cli.js doctor` 报告：hook 指向是否有效、上次成功捕获时间、断流天数、决策捕获率（`kind:decision` ÷ 提交数）、trailer-only 计数、**踩坑计数（`kind==='pitfall'`）** 与 `refs.pitfall` 两个口径分列；支持 `--json`。
- **文件**：`lib/doctor.js`（新）、`lib/cli.js`、`test/doctor.test.js`（新）
- **验收**：
  - 对本仓库输出真实数字（原子 509 / decision 1 / trailer-only 127 / **pitfall 11**）。
  - 踩坑计数按 `kind==='pitfall'` 统计：S3 落地后 `refs.pitfall` 恒为 null，若只数它，体检会报 0 而与记录层事实矛盾（审计 D1）。
  - 非 git 目录降级不崩，字段标 `unknown` 而非 0。
  - `--json` 输出可被程序消费（字段稳定）；踩坑按 kind 的计数落在 `capture.pitfalls`（审计 D1：键集只增不改，既有键名/语义不动）。
- **自检**：`node --test test/doctor.test.js`

### S6 · 成本账本 + 预算闸
- **目标**：每次 LLM 调用追加 `.lore/.state/cost.ndjson`（`{ts,page,backend,ms,ok,tokens?,version}`）；每版本预算（token 与**可回退计量**），超限时 auto 不启动**并把原因送到可见处**。
- **文件**：`lib/cost.js`（新）、`lib/runner.js`、`lib/backend.js`、`lib/syncstate.js`、`server.js`（`/api/sync/status` 的原因出口）、`lib/cli.js`（`budget` verb）、`test/cost.test.js`（新）、`test/server.test.js`、`test/cli.test.js`
- **验收**：
  - 成功/失败/超时都记账；坏行跳过。
  - `tokens` 拿不到时留空（不伪造 0）——CLI 后端目前不回报 token 数。
  - 预算超限 → `shouldRunAuto` 返回 `{run:false, reason:'budget'}`，且不产生副作用。
  - **计量可回退**：三个 CLI 后端都不回报 token 数，只按 token 计预算则永远算不出超支（评审 🟡#7 / 审计 D3）→ 预算维度支持 `tokens | calls | ms`，**未显式选 tokens/ms 时用 `calls` 兜底**（`calls` = 窗口内账目条数，与后端是否回报用量无关，必然可算），且测试要证明闸**能被触发**（注入计量值，不依赖真实 token 回报）。
  - **配置形状**：`.lore/.state/budget.json` = `{budget: n, dimension: 'tokens'|'calls'|'ms'}`；旧形状 `{token_budget: n}` 仍可读（等价 `{budget: n, dimension: 'tokens'}`），写入时归一到新形状。
  - **原因有出口**：`/api/sync/status` 增 `budget:{configured,dimension,budget,used,exceeded,version}`，壳状态行可读；新增 `lore budget <n> [--dimension <d>] | lore budget --clear` verb（复用已有 `writeBudgetConfig`）——否则 auto 静默停摆（审计 D4）。
  - 预算未配置 → 行为与今天一致（不阻断）。
- **自检**：`node --test test/cost.test.js test/runner.test.js`

### S7 · 壳打开传感器
- **目标**：壳打开页面时调用 `visit`（本地、失败静默），为 ② 期的再入简报与健康度提供数据。
- **文件**：`server.js`（新增 localhost-only `POST /api/human/visit`，复用 S4 `lib/human.js`）、`site/shell.mjs`、`test/server.test.js`、`test/shell.test.js`
- **验收**：
  - `POST /api/human/visit` 写入一条 visit 到 `.lore/human/visits.jsonl`；非 localhost 请求被拒；非法/越界 page 路径被拒。
  - 同一页短时间内重复打开可去重（**单一旋钮**：存储层 `windowMs`，壳侧不再单独配 `dedupeMs`——评审 🔵#10 指两处配置会漂移）。
  - **自装配必须推导 base**：`installVisitSensor()` 默认 base 用 `baseFromPathname(location.pathname)`，否则 portal 形态下请求打到 `/wiki/…` 而非 `/<repo>/wiki/…` → 恒 `no-manifest`、零 visit、零告警（审计 D5 已实测复现）。
  - CLI 不可用 / 无 .lore → 壳静默降级，不影响阅读。
  - 不引入任何宿主依赖（浏览器内不调用外部网络）。
- **自检**：`node --test test/server.test.js test/shell.test.js`

### S8 · agent 代捕获约定 + 捕获召回率闸门（评审 🔴#1/#2；审计 D2）

设计 §7⓪ 明列这两项，原计划只做了度量（S5）却没做**供给**与**闸门**——"只测沉默，不防沉默"。本阶段补齐。

- **目标**：
  - **约定**：在 `lib/resident.js` 生成的 resident 区块里加一条规则——「做出非显然决策时，追加一条 `kind:decision` 的 **draft** 原子（附 why 与源码锚点）」，并给出 `lore note --draft` 的 CLI 示例；CLAUDE.md / AGENTS.md 同源渲染、内容一致（沿用 S3 去重纪律）。
  - **CLI**：`lib/note.js` 的 `noteAtom` 补 `status:'draft'`（现在连 status 都没有），新增 `--draft` 旗标，默认行为不变。
  - **闸门**：`doctor` 增可配置阈值——捕获率低于 X 或断流超过 N 天 → 醒目告警 + **非零退出码**，供 CI 与壳状态行消费。
- **阈值与采样口径（先定死后实现，评审 🔴#2）**：
  - **闸门口径**（doctor，沿用 S5 既有指标，不新增口径——审计「键集只增不改」）：`captureRatePct` = 全仓 `kind:decision` 原子数 ÷ `git rev-list --count --no-merges HEAD`；`gapDays` = 现在 − 最新 `source:'hook'` 原子的 `ts`（整天下取整）。
  - **阈值 X（捕获率下限，百分数）与 N（断流上限，天）可配置，默认不配置 = 不阻断**（与 S6 预算闸同纪律：未配置 → 行为与今天一致）。配置落 `.lore/config.yml`：
    ```yaml
    doctor:
      capture_rate_min: 5      # 捕获率下限，百分数 0–100；低于它 → 闸门红
      gap_days_max: 30         # 断流上限，天（≥1）；超过它 → 闸门红
    ```
    或 CLI 覆盖：`lore doctor --capture-rate-min 5 --gap-days-max 30`。**任一阈值被配置（config 或 flag）→ 闸门生效**；未配置 → `gate:{ok:true,reason:'not-configured'}` 且 exit 0。阈值非法（越界/非数字）→ 判红并写明 `invalid`，绝不静默失效（否则又是「安静地不工作」）。
  - **unknown 判红**：闸门生效时，取不到的数字（非 git → commits unknown；无 hook 原子 → gapDays unknown）**算不通过**（unknown 不是健康证据），reason 写明 unknown；未配置阈值时 unknown 照旧只显示不拦。
  - **per-backend 采样口径**（评审 🔴#2；本期落口径与报告格式，不追求统计显著）：每个后端（claude / codex / opencode）各跑 **5 个会话**，每个会话给**同一组 3 个决策任务**（选型 / 否决 / 权衡各一）；逐会话记 `{backend, session, decisions_made, atoms_captured, status_draft, anchors_attached}`；报告形状 `{schemaVersion, generated_at, per_backend:[…], gate:{ok,reason}}`，其中 `rate = atoms_captured / decisions_made`，闸门阈值同 X。**采样脚本本身未排进本阶段文件清单**（清单无 `scripts/`）——口径与报告格式先落此节，脚本作为 S8 的显式待办。
- **文件**：`lib/resident.js`、`lib/note.js`、`lib/doctor.js`、`lib/cli.js`、`CLAUDE.md`、`AGENTS.md`、`test/resident.test.js`、`test/note.test.js`、`test/doctor.test.js`
- **验收**：
  - resident 区块出现该约定，且 CLAUDE.md 与 AGENTS.md 渲染一致（同源）。
  - `lore note --draft` 产出的原子 `status:'draft'`，过 S1 的「机器来源 ⇒ draft」规则。
  - `doctor` 在低于阈值时**非零退出**；`--json` 含 `gate:{ok,reason}`。
  - **per-backend 矩阵**：至少覆盖 claude / codex / opencode 三后端下"约定是否被遵守"的采样口径（本期只落采样脚本与报告格式，不追求统计显著）。
  - 阈值 X / N 与采样口径写进本节后再动手（评审 🔴#2 要求现在定死，不能留到 ②）。
- **自检**：`node --test test/resident.test.js test/note.test.js test/doctor.test.js`

## 3. 全局验收（本期完成判据）

| 项 | 判据 |
|---|---|
| 六类原子 | schema + 校验器落地，现有原子全兼容 |
| trailer-only | 新写入为 0；lint/测试会红 |
| 踩坑 | 11 条入库且幂等；`claude_md_pitfalls` 不再是死声明；doctor 按 `kind` 报出 11（不再是 0） |
| 燃料供给 | resident 约定 + `lore note --draft` 落地；机器来源写入恒为 `draft` |
| 捕获闸门 | 低于阈值时 doctor 非零退出；per-backend 采样矩阵可跑并出报告 |
| CLI 对等 | `visit/read/blackbox/human export/human clear/doctor/budget` 全部有一等 CLI |
| per-human 边界 | `.lore/human/` 不进 git，可导出、可清除 |
| 可见性 | `doctor` 能报出断流天数、决策捕获率、踩坑数、闸门状态 |
| 成本 | 每次调用有账；预算可闸（token/calls/ms 任一维度可触发）；超限原因能从 `/api/sync/status` 与壳状态行读到 |
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
