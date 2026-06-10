---
title: /lore:init — 仓库引导（脚手架 + 拷壳 + 组件自动发现）
summary: > 设计文档 (spec) · 2026-06-01 · 子项目 **`/lore:init`（v1，第一刀）** · 状态: 已 brainstorm 收敛，待转实施计划 > > 母 spec: `docs/superpowers/specs/2026-05-31-lore-repo-wiki-design.md`（§3 config.yml / §5.5 serve / §6 通用引擎内...
source_path: docs/superpowers/specs/2026-06-01-lore-init-design.md
last_updated: 2026-06-01
group: 设计与计划
paired_plan: superpowers-plans-2026-06-01-lore-init
---
> 源文档：`docs/superpowers/specs/2026-06-01-lore-init-design.md`

# /lore:init — 仓库引导（脚手架 + 拷壳 + 组件自动发现）

> 设计文档 (spec) · 2026-06-01 · 子项目 **`/lore:init`（v1，第一刀）** · 状态: 已 brainstorm 收敛，待转实施计划
>
> 母 spec: `docs/superpowers/specs/2026-05-31-lore-repo-wiki-design.md`（§3 config.yml / §5.5 serve / §6 通用引擎内核 / §7 bootstrap）
> 同类范例: `docs/superpowers/plans/2026-05-31-lore-serve.md`（serve 的实施计划，本 spec 的实现镜像其 TDD + 模块/CLI 风格）

---

## 0. 背景：要闭合的接缝

`/lore:serve` 已实现：哑静态服务器从 `.lore/site/index.html` 伺服浏览器壳。但**目前没有任何已发布命令把插件的 `site/index.html` + `site/shell.mjs` 拷进目标仓库的 `.lore/site/`**。

母 spec §5.5（line 311）把这一步指派给 `/lore:init`：「site/ 来源 | `/lore:init` 拷壳进 `.lore/site/`」。`/lore:init` 还没实现（serve-first 开发顺序）。

**后果（生产中 serve 坏掉）**：真实用户 `/lore:sync` 后跑 `/lore:serve`，服务器能起（manifest 前置检查通过），但 `http://127.0.0.1:<port>/site/` 返回 **404**，因为 `.lore/site/index.html` 不存在。e2e 集成测试（`test/integration.test.js` 第 19-22 行）手工 `cpSync` 这些文件，**掩盖了该问题**。

本 spec 实现 `/lore:init` 第一刀，闭合该接缝，并顺带交付母 spec §6 的组件自动发现。

---

## 1. 范围

母 spec §5 line 230 列 `/lore:init` 共 4 件事：**脚手架 `.lore/` + 装 post-commit hook + 起 config.yml(自动发现组件) + 拷 site/**。

本 spec（v1 第一刀）做其中 3 件，**推迟 hook**：

| 维度 | 决策 |
|---|---|
| **搭骨架** | 建 `.lore/{journal,wiki,site,.state}/` + 写 `config.yml`，并确保目标 repo 的 `.gitignore` 忽略 `.lore/.state/`。 |
| **拷壳** | 把插件 `site/index.html` + `site/shell.mjs` 拷进 `.lore/site/`（**闭合接缝**）。 |
| **组件自动发现** | 扫描目标 repo 提议 `code_roots`，写进 `config.yml`（通用兜底 + Python + JS 三探测器）。 |
| **不在本 spec（推迟）** | **post-commit hook 安装**。理由：hook（母 §4 捕获源①）每次 commit 要写 journal 骨架原子，依赖整套 journal 子系统（原子 schema、ndjson 写入器、路径→`code_roots` 映射、关键词打标），**这些都还没造**。现在装 hook 等于调一个不存在的 `lib/journal.js`，每次 commit 跑起失败进程。hook 安装将随造 journal 的那次活儿落地（那时它要调的写入器才真的存在）。 |

**决策记录（brainstorm）**：
- *范围*：选「脚手架 + 拷壳 + 配置（暂不装 hook）」而非「完整 init」或「最小解」。完整 init 会把整个 §4 捕获子系统拽进本 spec（过大，且和 `/lore:mine`、`/lore:note` 地盘重叠）；最小解不交付 §6 自动发现。本选项自洽、把 serve 在生产里彻底修好、交付 §6 发现，且不留半截 hook。
- *发现深度*：选「通用兜底 + Python + JS」而非「只兜底」或「全 §6 四生态」。覆盖试验田 threat-intel(Python) + lore 自身(JS)；Go 等无 repo 验证 → YAGNI，以后按需加（引擎全 config-driven，加探测器不改内核）。

**核心不变量（继承母 §6）**：lore 只读目标源码；只写 `.lore/` + 追加一行目标 repo `.gitignore`。本 spec 范围内**连 hook 都不碰** → 零侵入更彻底。

---

## 2. 架构

镜像现有 `serve.js` / `manifest.js` 模式：**纯逻辑落 `lib/`（注入依赖、可 headless 测），命令 `.md` 是薄壳。**

```
D:\workspace\lore\
├── lib/
│   └── init.js              # 新建：纯函数 + 编排 + CLI
├── commands/
│   └── lore-init.md         # 新建：/lore:init slash 命令定义（薄壳，调 lib/init.js）
├── site/                    # 已存在：被拷贝的源壳（index.html + shell.mjs）
└── test/
    ├── init.test.js         # 新建：单元 + CLI 冒烟
    └── integration.test.js  # 改：用 init 替换手工 cpSync（闭合接缝）
README.md                    # 改：加 /lore:init 段
```

**路子选择（brainstorm）**：选「路子 A — 单模块 `lib/init.js`」而非「路子 B — 拆 `lib/discover.js`」。v1 发现逻辑无第二消费者，单模块内部把纯函数分清即可；待 `/lore:sync` 需复用发现时再抽 `lib/discover.js`（接缝留着，不预先抽）。

---

## 3. 模块 API 契约（锁定 — 实施计划须照此）

`lib/init.js`（ESM exports，纯函数注入 fs/路径 → 无需真 repo 即可测）：

```
discoverComponents(repoRoot, deps) -> string[]
  // deps = { readdir, readFile, exists, statIsDir }（注入 fs）
  // 返回排序去重的建议 code_roots（相对 repoRoot 的目录路径）

renderConfigYaml(codeRoots) -> string
  // 按母 §3 形状手写 YAML 字符串（零依赖，不引 YAML 库）

scaffold(loreDir) -> void
  // mkdir -p journal/ wiki/ site/ .state/。幂等

copyShell(srcSiteDir, loreDir) -> string[]
  // 拷 index.html + shell.mjs → loreDir/site/，覆盖。返回拷的文件名

ensureGitignore(repoRoot) -> 'created'|'appended'|'present'
  // 确保 repoRoot/.gitignore 含一行 `.lore/.state/`

init({ repoRoot, srcSiteDir }) -> report
  // 编排：scaffold → copyShell → discover → (config.yml 不存在才写) → ensureGitignore
  // report = { loreDir, copied:string[], codeRoots:string[], configWritten:bool, gitignore:'created'|'appended'|'present' }
```

CLI 入口（同 `serve.js`/`manifest.js` 的 `import.meta.url` 守卫）：
- `node lib/init.js <repoRoot>` —— `srcSiteDir` 自定位 `join(HERE, '..', 'site')`（同 `serve.js` 定位 `server.js` 写法）。
- 打印 report 摘要：`.lore/` 路径、拷了哪些壳文件、发现的 `code_roots`、config.yml 是写了还是已存在保留、gitignore 动作。

---

## 4. 组件自动发现算法（§6）

**输入** repoRoot；**输出** 排序去重的建议 `code_roots`（目录路径，相对 repoRoot）。只看**目录**，顶层散落代码文件不作 root。三层 union 后去冗余。

**EXCLUDE（永不作 root，按目录名精确匹配）**：
`.git .lore node_modules .venv venv __pycache__ .pytest_cache dist build out target vendor coverage docs doc tests test __tests__ config .github .idea .vscode` —— 外加任何以 `.` 开头的目录。

**CODE_EXTENSIONS（判定"含代码"）**：`.py .js .mjs .cjs .ts .tsx .jsx .go .rs .java .kt .rb .php .c .cc .cpp .h .hpp .cs .swift .scala .sh`（实施计划可微调列表）。

**三层**：

1. **JS workspaces**：repoRoot/`package.json` 存在且有 `workspaces`（数组，或 `{packages:[...]}`）→ 展开 pattern。支持两种形态：`dir/*`（展开为 dir 下所有子目录）与字面路径。`**` 及更复杂 glob 不支持（记为限制）。

2. **Python 包**：顶层非排除目录含 `__init__.py` → 该目录作 root。另处理 `src/` 布局：若顶层有 `src/`，扫其子目录，`src/<pkg>/__init__.py` 存在 → `src/<pkg>` 作 root。

3. **兜底（总是跑，与上 union）**：顶层非排除、非点开头目录，浅扫（深度 ≤2）含 ≥1 个 CODE_EXTENSION 文件 → 作 root。

**去冗余（祖先规则）**：若 root R 是另一 root R2 的严格父目录（`R2` 以 `R + '/'` 开头），删 R 留 R2（更具体者胜）。例：兜底给 `packages`，workspaces 给 `packages/a`、`packages/b` → 删 `packages`。

**例子（验收锚点）**：
- threat-intel 形态（顶层 `m1_crawler/`…`shared/`，各含 `.py`）→ `[m1_crawler, m2_ingestion, m3_nlp, m4_report, m5_downstream, shared]`
- lore 自身（顶层 `lib/`(.js)、`site/`(.mjs/.html)、`commands/`(.md)、`docs/`、`test/`）→ `[lib, site]`（docs/test 排除；commands 无代码扩展跳过）
- monorepo（`package.json` workspaces `packages/*`，下有 `a/`、`b/`）→ `[packages/a, packages/b]`（非 `packages`）

发现是**提议非强制**：结果写进 config.yml 并带注释「自动发现，请改」；命令 `.md` 让 agent 把结果摆给用户邀请编辑。对齐 §7「提议 + 人改」，CLI 不交互阻塞。

---

## 5. config.yml 形状（§3）

`renderConfigYaml(codeRoots)` 手写如下（roots 注入 `component.code_roots`）：

```yaml
# .lore/config.yml —— lore 引擎配置（唯一存放本 repo 特定信息处）
# component 由 /lore:init 自动发现。请按需改：重命名 / 分组 / 删 / 增。
axes:
  component:                 # 内置轴 + 自动发现
    discover: auto
    code_roots: [lib, site]  # ← 自动发现填入，以实际为准
  flow:                      # 声明轴 — "数据怎么端到端跑"（示例，按需填）
    values: []
    # - { id: article-pipeline, spans: [lib] }
  theme:                     # 自定义横切轴 —"这条长期主线怎么演进"（示例，按需填）
    values: []
    # - { id: quality, desc: "质量保证", match: [质量, accuracy, 误报] }
journal:
  hook: false                # post-commit hook 由后续版本安装（本版未装）
  mine: [commits, changelog, claude_md_pitfalls]
```

`journal.hook: false` 如实反映「本版未装 hook」；后续 hook 安装步骤把它翻 `true`。`init` 本身**只检查 config.yml 是否存在、不解析 YAML**（零依赖；读 config 的命令日后另引 parser，本 spec 范围外）。

---

## 6. 关键行为

- **重跑安全 = 升级/修复语义**（init 可多次跑）：
  - `scaffold`：`mkdir` recursive → 幂等。
  - `site/`：**每次覆盖刷新** → 壳随引擎升级自动更新到目标 repo。
  - `config.yml`：**已存在则不覆盖**（保护用户编辑过的 axes/match）。report 标 `configWritten:false`。
  - `.gitignore`：去重追加（已含 `.lore/.state/` → no-op）。
- **git 跟踪**：`.lore/` 进 git（含 `config.yml` + `site/`），仅 `.lore/.state/` 被忽略（母 spec line 121/124）。`journal/`、`wiki/` 起始空 → git 不跟空目录，无妨；内容由 `/lore:mine`、`/lore:sync` 后落，serve 前置检查（manifest 缺失）此前正确提示先 sync。**不放 .gitkeep**（避免杂物）。
- **零侵入**（核心不变量）：只读目标源码（发现纯读）；只写 `.lore/` + 追加一行目标 repo `.gitignore`。本 spec 范围内不碰 `.git/hooks`。

---

## 7. 集成测试改造（闭合接缝）

`test/integration.test.js` 现状（第 19-22 行）：手工 `mkdirSync(.lore/site)` + `cpSync(site/index.html)` + `cpSync(site/shell.mjs)` —— 这正是 `/lore:init` 该干的活，手工拷掩盖了真实缺口。

**改造**：用 `init({ repoRoot: root, srcSiteDir })` 产出 `.lore/` 骨架 + 拷壳，**替换**这三行手工操作。fixture wiki（`test/fixtures/wiki`）仍 `cpSync` 进 `.lore/wiki`（那是测试数据，init 不产 wiki 内容；sync 才产）。顺序：先 `init`（建 `.lore/` 骨架含空 `wiki/` + 壳 + config + gitignore），再把 fixture wiki 叠进 `.lore/wiki`。

→ e2e 自此**真正走 init 拷壳路径**，接缝在测试层也闭合（回归护栏：以后谁删了 init 的拷壳，e2e 直接红）。

---

## 8. 测试策略（镜像 serve TDD，全确定性零 LLM）

`test/init.test.js`，`node:test`，临时目录注入 fs：

- **`discoverComponents` 表驱动**：造临时 repo —— (a) Python 顶层包（`m1/__init__.py`…）、(b) `src/` 布局（`src/pkg/__init__.py`）、(c) JS workspaces（`package.json` workspaces `packages/*` + `packages/a`、`packages/b`）、(d) 杂顶层目录 + 排除项（`docs/`、`tests/`、`.git/`、含 `.js` 的 `lib/`）→ 断言提议 roots（含祖先去冗余、排序）。
- **`renderConfigYaml`**：roots 注入正确、形状含 component/flow/theme/journal、`hook: false`。
- **`scaffold`**：四目录建对；重跑不炸（幂等）。
- **`copyShell`**：源→目标字节一致；目标已有旧壳 → 被覆盖刷新。
- **`ensureGitignore`**：三态 —— 无文件→`created`；有文件缺行→`appended`；已含行→`present`（不重复追加）。
- **`init` 编排**：跑一遍 → `.lore/{journal,wiki,site,.state}` 齐、`site/` 有两文件、`config.yml` 在、`.gitignore` 含行；**重跑** → config.yml 内容不变（写过一次用户改了的不毁）、`configWritten:false`。
- **CLI 冒烟**：`node lib/init.js <tmpRepo>` → 退 0、打印 report 摘要含发现的 roots。
- **集成**：`test/integration.test.js` 改造后整链 `init → manifest → serve → fetch → stop` 全绿。

---

## 9. 命令定义（`commands/lore-init.md`）

镜像 `lore-serve.md` 风格（中文、frontmatter `description`、用法、行为、给 agent 的提示）：

- **行为**：在目标 repo 根目录（含/将含 `.lore/` 处）执行 `node "${CLAUDE_PLUGIN_ROOT}/lib/init.js" "$(pwd)"`。
- **给 agent 的提示**：
  - 跑完把发现的 `code_roots` 摆给用户，说明是自动提议，邀请编辑 `.lore/config.yml`（重命名/分组/删/增）。
  - 下一步指引：`/lore:sync` 合成 wiki（之后才能 `/lore:serve` 浏览）。
  - 重跑 init 安全：刷新壳、保留已编辑的 config。
  - 零侵入：只写 `.lore/` + 一行 `.gitignore`，绝不改业务源码，本版不装 hook。

---

## 10. 验收指标

本 spec 视为完成当且仅当：

1. **拷壳闭合接缝**：lore 自身跑 `/lore:init` 后，`.lore/site/index.html` + `.lore/site/shell.mjs` 就位，内容与插件 `site/` 一致。
2. **serve 不再 404**（核心目标）：init 后（即便 wiki 尚空）`.lore/site/` 已存在；造个 manifest 起 serve → `GET /site/index.html` 返回 200（集成测试覆盖整链）。
3. **便携发现（对应母 §11.1 init 部分）**：lore(JS) + 一个 Python 形态 repo 上跑 init → 出有效 `.lore/` + config.yml 列出合理 `code_roots`（见 §4 例子），引擎无 repo 硬编码。
4. **重跑不毁配置**：改 config.yml 后重跑 init → config.yml 原样保留，仅壳被刷新。
5. **零侵入**：init 后 `git status` 对业务源码 0 改动；唯一写入 = `.lore/` + 一行 `.gitignore`。
6. **测试闭合**：`test/integration.test.js` 走 init 真实拷壳路径（非手工 cpSync），全测试套件绿。

---

## 11. 不在范围 / 推迟

- **post-commit hook 安装** → 随造 journal 子系统（§4 捕获）那次活儿落地，届时翻 `config.journal.hook: true`。
- **读 config.yml（YAML parser）** → 读 config 的命令（sync/mine/lint）日后另引；init 只写不读。
- **Go / 其他生态探测器** → YAGNI，按需加（引擎 config-driven，加探测器不改内核）。
- **交互式确认发现结果** → CLI 非交互；提议写入 + agent 摆给用户邀请编辑即可。
- **复杂 glob（`**` 等）workspaces** → 仅支持 `dir/*` 与字面路径。

---

## 12. 开放问题

- **`commands/` 该不该作 component**：lore 自身 `commands/` 全 `.md`（无代码扩展）→ 当前算法跳过。若日后想把纯 md/config 目录也纳入，靠用户编辑 config 增补即可，算法不强求。
- **顶层散落代码文件**（如 lore 根的 `server.js`）：当前只认目录、不认顶层散文件。绝大多数 repo 顶层文件是入口/配置，不作独立 component 合理；如需另议。

---

*参考：母 spec `2026-05-31-lore-repo-wiki-design.md` §3/§5.5/§6/§7 · serve 实施计划 `2026-05-31-lore-serve.md`（TDD + 模块/CLI 风格范例）· 本 spec 经交互式 brainstorming 收敛（范围 + 发现深度两处用户拍板）。*

