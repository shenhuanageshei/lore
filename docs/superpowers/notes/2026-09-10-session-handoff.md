# 会话交接文档 · lore 人读理解层（2026-09-10）

> 用途：把本会话的完整上下文交给下一个会话。**读完这一份就能接着干，不需要回看聊天记录。**
> 落盘位置：`docs/superpowers/notes/2026-09-10-session-handoff.md`

---

## 0. 一句话现状

**lore 已完成「人读理解层」的 ⓪ 期（数据与证据地基）与 ① 期（证据清洗与确认），版本 0.11.0，全量测试 769 项 / 768 通过 / 0 失败；29 个提交与 2 个 tag 都在本地，因网络原因尚未推送到 GitHub。**

- 仓库：`D:\workspace\lore`，分支 `main`，HEAD `75af333`（release: 0.11.0）
- 远程：`origin` = https://github.com/shenhuanageshei/lore.git，**本地领先 29 个提交（未推送）**
- 本地 tag：`v0.10.0`、`v0.11.0`（远程一个都没有）
- 版本：`package.json` / `.claude-plugin/plugin.json` = 0.11.0

---

## 1. 这一轮到底做了什么（为什么做）

### 1.1 触发点

智谱 ZCode 等 harness 原生内置「仓库 wiki」（读代码生成架构导读、结论带源码跳转）。**生成侧被免费商品化了**——lore 再以「生成 wiki」为卖点就是和免费能力竞争。

### 1.2 定位改写（已与 owner 确认）

- **wiki 保留并继续做厚**（不是砍掉，owner 明确纠正过）。
- 差异化转向厂商结构上拿不到的两样：**时间轴（为什么这么做）** 与 **per-human 理解状态（你懂什么、何时懂的、何时过期）**。
- owner 的核心痛点原话：*「vibing coding 太多之后，我自己对项目也是黑盒。别人问起只能泛泛而谈，或者让 AI 总结——我自己的知识并没有增长。」*
- 硬约束：**无关 harness、无关 LLM provider**（多后端链保留；理解层不得依赖任何宿主特性）。

### 1.3 三层会诊 + 两轮设计评审的共同结论

- 会诊：不做 wiki 生成器，做「决策记忆 + 理解训练器」；第二护城河 = owner 的理解状态。
- 最大的洞是**燃料断流**（⓪ 期实测：490 条原子里只有 1 条 decision、205 条 why 含 commit trailer 噪音），以及**确认按钮默认必死**（owner 行为数据：note 用过 1 次、翻译 0/94）。
- 被集体漏掉的杀手级交付物：**再入简报**（离开 N 天回来 → 变了什么 / 哪些认知过期 / 先读哪三页），定为 ② 期。

---

## 2. 交付清单（⓪ 期 + ① 期）

### 2.1 提交（自 0.10.0 起，29 个，关键几条）

| commit | 内容 |
|---|---|
| `05f57cf` | docs(plan) ⓪ 期实施计划（8 阶段） |
| `ef5fe28` | S1–S3：原子 schema / 写入侧纪律 / 踩坑入库 |
| `489f9cb` | S4：per-human 存储层 + 统一 CLI 与边界 |
| `58b7958` | S5+S6：体检与捕获召回率 + 成本账本与预算闸 |
| `5b45d86` | S7：壳打开传感器（`/api/human/visit`） |
| `431eb2d` | S8：agent 代捕获约定 + 召回率闸门 |
| `aad8c01` `f4ed36c` `72bfe23` `9ab536b` `888863e` | ⓪ 期审计/评审修复轮 |
| `28def1e` | ① S1+S2：schema 接线 + 噪音分类器 |
| `c8aadfd` | ① S3+S4：确认闭环 + 证据账本 |
| `928d223` | resident 刷新域修复 |
| `70534bc` `2464e8f` | ① 期审计修复 + 遗留清零 |
| `75af333` | **release: 0.11.0**（CHANGELOG/README/ROADMAP/版本号） |

### 2.2 新增代码模块

| 文件 | 职责 |
|---|---|
| `lib/atom.js` | 六类原子 schema（decision/rejected/correction/question/evidence/pitfall + legacy commit）、`validateAtom`/`normalizeAtom`/`parseAtom`；机器来源（`agent\|miner\|hook`）缺 status 补 `draft` |
| `lib/confirm.js` | 确认记录 `kind:'confirmation'`（追加式）、有效状态派生、默认署名 `unattributed` |
| `lib/evidence.js` | 证据账本：来源/定位/时间/置信/确认人；无 `refs.anchors` 标「未验证」 |
| `lib/noise.js` | 噪音分级 `none\|low\|high`（trailer-only / 模板 / 重复摘要），纯函数确定性 |
| `lib/doctor.js` | 体检：hook 指向 / 断流天数 / **窗口率 + 累计捕获率** / 噪音分布 / 确认计数 / 坏行；阈值可配且非零退出 |
| `lib/cost.js` | 成本账本 + 预算闸（`tokens\|calls\|ms` 三维度） |
| `lib/human.js` | per-human 存储 `.lore/human/{visits,read,blackbox,checks}.jsonl`，导出/清除 |
| `lib/cli.js` | 统一入口 `node lib/cli.js <verb>`（也注册为 `bin: lore`） |
| `scripts/capture-matrix.mjs` | per-backend 捕获召回率采样矩阵 |

### 2.3 文档

- 设计（**最重要**）：`docs/superpowers/specs/2026-09-09-lore-human-comprehension-and-shell-design.md`（v2，含 **8 条不变量**、记录层 schema、理解层设计、**壳设计 tokens**、六期分期、砍/冻结清单）
- 计划：`plans/2026-09-09-lore-comprehension-phase0.md`（⓪，8 阶段）、`plans/2026-09-09-lore-comprehension-phase1.md`（①，4 阶段）
- 壳原型（可交互）：`notes/2026-09-09-lore-shell-light.html`
- CHANGELOG / README / ROADMAP 已同步 0.11.0

---

## 3. 当前实测数字（`node lib/cli.js doctor`）

```
git        v0.10.0 · 501 commits · head 75af333
hook       ok → D:/workspace/lore/lib/hook.js · 指向有效
capture    last hook 2026-09-10（0 天前）· last atom (hook)
atoms      522 · decision 2 · pitfall 11（kind=pitfall）· trailer-only 127 · bad lines 0
noise      high 131 · low 76 · none 315
confirm    已确认 0 · 待确认 1 · 已否决 1 · 未署名 1 · 坏确认记录 0
rate       window 2%（1 decision / 50 commits，N=50）· 累计 0.4%（2 decision / 501 commits）
gate       ok（未配置阈值 → 不阻断）
```

（`git` 行显示 v0.10.0 是因为它读自 wiki manifest，下次 finalize 会刷新为 0.11.0。）

---

## 4. 未完成的事

### 4.1 立即要处理的

1. **推送**（阻塞项，非技术缺陷）：GitHub 连接被掐——HTTPS 传输被重置（`Connection was reset` / `SSL_read: unexpected eof`），fetch 同样失败；SSH 密钥未注册（`Permission denied (publickey)`）；无代理配置。
   - 恢复后执行：`git push origin main && git push origin v0.10.0 v0.11.0`
   - 或先 `git config --global http.proxy http://127.0.0.1:PORT` / 把 `~/.ssh/id_ed25519.pub` 加到 GitHub 后切 SSH remote。

### 4.2 后续期（设计已定，未实施）

| 期 | 内容 | 关键约束 |
|---|---|---|
| **②** | **一条端到端理解切片**：再入简报 + 证据 + 一个模块打通；**锚点漂移语义**（行号变动→标 stale 还是重解析）在本期定案 | 纯派生、零新增义务 |
| **③** | 机械化扩展：docs 轴**索引化**（82 页镜像→索引页）· 痛点雷达 · **digest 骨架**（零 LLM、随代码入库）· auto **追版本**+版本切分（确定性聚类）· **graph 接消费者** · 翻译层**删除**（0/94） | 零 LLM、可与别的期并行 |
| **④** | 理解检查与回归：任务式检查（给场景/定位入口/解释决策/指出风险；opt-in + 预立死亡条款）· 变更影响回归；`lore check` verb 落地 | 默认被动模式 |
| **⑤** | `lore prep` **事件驱动**答辩准备（5 组 × 5 题 + 追问链；答案四段式：结论→机制→数字/证据→反方案对比） | 静态题库会腐，按需生成 |

### 4.3 壳的视觉实现（设计已定，未实施）

设计文档 §5 已定 tokens（**浅色精密工作台**，Inter + JetBrains Mono，靛蓝 `#5B5BD6` / 青 `#0E7490`，弱色 `#6B7280` 4.83:1），原型在 `notes/2026-09-09-lore-shell-light.html`。要落的是真实的 `site/index.html` + `site/shell.mjs`：
- 快捷键栏（F1–F5）+ **底部状态行**（必须可操作、且显示燃料读数：决策捕获率 / 断流天数）
- **源码锚点 = 引出线注记**（正文角标 + 右侧注记栏）
- **决策史 = 修改记录表**（版本 / 日期 / 变更与原因）
- 无 JS / 窄屏降级仍可读

### 4.4 已知缺口（🔵，记录在案、未修）

- `refs.pitfall` 恒为 null（历史口径保留，现在按 `kind==='pitfall'` 计数）
- `.lore/config.yml` 的 `changelog` 仍是**死键**（`lib/mine.js` 静默忽略）
- pitfall 身份键只 hash「问题」——改 `fix/prevention` 不会重新入库
- **派生状态在 wiki 决策史不可见**（wiki 只渲染内联 status）→ 归属 ② 期
- 手工自测曾直接写活库 journal（应一律 `--root` 到临时目录）
- 仓库无 `METHODOLOGY.md` / specs 索引，方法学与文档归属无法自动校验

---

## 5. 环境与工具约束（新会话必读）

1. **eng-coder 单次墙钟上限 9 分钟（`budgetCapMs=540000`）**：本会话它被掐断过 8 次。**一次最多派 2 个阶段**；被掐断前通常能完成当轮阶段——所以流程是「派活 → 复验自检 → 打检查点提交」，不是等它自己跑完。
2. **工程模式（`eng` action='enter'）会锁写**：非文档文件（`lib/`、`site/`、`package.json`…）在没有有效 design token 时**拒绝编辑**。`docs/**/*.md` 与根目录 `.md` 始终可写。
3. **每个 eng_coder 调用都需要有效 design token**：由 `advisor(type='design', documents=[...])` 评审通过后签发，**TTL 约 1 小时**，过期要重新送审（约 5–10 分钟）。
4. **评审是流程闸门**：设计评审由 owner 发起（本会话中 owner 明确说过"开始实施"，据此执行）；交付代码评审（`advisor type='code'`）与偏离审计（只读 subagent）是自动节点。
5. **网络**：GitHub 间歇性不可达（本会话所有写操作失败，个别读操作成功）。
6. 全量 `node --test` 约 5–7 分钟（769 项），**别在等待时发呆**——可用于写文档。

---

## 6. 接着干的标准流程（照抄即可）

```text
1) 定下一期 → 写计划 docs/superpowers/plans/YYYY-MM-DD-<slug>.md
   （每阶段：目标 / 文件清单 / 验收 / 自检命令；≤4 阶段）
2) advisor(type='design', documents=[计划, 设计文档]) → 拿 designToken
   · 若报 🔴：改计划 → 重新送审（不要把 🔴 放着往下走）
3) eng_coder(task, docs, designToken, stages=2 个阶段) → 复验自检 → 提交检查点
4) 偏离审计：subagent（只读）核对「实现 vs 设计」→ 有偏离则再派一轮 eng_coder
5) 交付评审：advisor(type='code', paths=[改动文件], documents=[计划, 设计])
6) 逐条响应表（| # | Action | Detail |，Action ∈ Fixed / Not an issue / Deferred）
7) 全量 node --test → 更新 CHANGELOG / README / ROADMAP → 提交
```

---

## 7. 立即可用的命令

```bash
node --test                                   # 全量回归（769 项，约 5–7 分钟）
node lib/cli.js doctor                        # 体检：捕获率 / 噪音 / 确认 / 闸门
node lib/cli.js doctor --json                 # 机读版本
node lib/cli.js confirm --list                # 确认清单
node lib/cli.js evidence                      # 证据账本
node lib/cli.js note --draft --title "…" --why "…" --anchors "fn @ file:line"   # 记决策草稿
node lib/migrate.js .                         # 资产对齐（resident / 壳 / hook stub）
node lib/lint.js .lore                        # 漂移检查
git log --oneline origin/main..main           # 未推送的 29 个提交
```
