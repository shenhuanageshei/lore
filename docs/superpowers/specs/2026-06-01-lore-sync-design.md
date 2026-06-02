# /lore:sync — 合成 component 页（v1 MVP：code → wiki，LLM 架构 prose）

> 设计文档 (spec) · 2026-06-01 · 子项目 **`/lore:sync`（v1 MVP，第一刀）** · 状态: 已 brainstorm 收敛，待转实施计划
>
> 母 spec: `docs/superpowers/specs/2026-05-31-lore-repo-wiki-design.md`（§4 journal / §5 合成 / §5.5 manifest+serve / §6 通用引擎内核）
> 同类范例: `docs/superpowers/specs/2026-06-01-lore-init-design.md` + `docs/superpowers/plans/2026-06-01-lore-init.md`（init 的 spec→plan，本工作的镜像；TDD + 模块/CLI 风格）

---

## 0. 背景：数据链的 keystone

lore 数据流：**捕获(hook/mine/note) → journal → sync → wiki → serve**。

已建两端：`/lore:init`（搭 `.lore/` + 自动发现组件 + config.yml）、`/lore:serve`（浏览器看 `.lore/wiki/`）。**中间整条产数据链是空的**——没有任何命令产 `.lore/wiki/` 内容。后果：真实用户 `/lore:init` 后 `/lore:serve`，wiki 为空，无可看。

`/lore:sync`（母 spec §5 line 233：「增量合成：journal + 代码 → wiki 页 + INDEX + emit .manifest.json」）是闭合该链的 keystone：产出 wiki 页让 serve 显示真内容。

**架构关键差异**：sync 与 init/serve 不同——它有 **LLM-in-the-loop 合成步**（「当前架构」段由 LLM 读源码写 prose），而 init/serve 是纯确定性 Node。本 spec 用 O1 编排把确定性（Node）与 prose（agent）干净分开。

---

## 1. 范围（v1 MVP，第一刀）

母 spec §5 的 sync 全谱 = component+flow+theme 页 + journal 原子折叠 + 增量指纹缓存 + INDEX + manifest。本 spec 做最小闭环切片：

| 维度 | 决策 |
|---|---|
| **轴** | 只产 **component** 页（每个 config `code_roots` 项一页）。flow/theme 推迟（config 里 init 产的是空 `values: []`，且需 journal 原子才有料）。 |
| **合成** | 「当前架构」段 = **LLM 读源码合成 prose**（agent 干）。「决策历史」段 = 占位「暂无 journal 原子」。「交叉链接」段 = agent 据全组件列表机械写。 |
| **编排** | **O1 两阶段**：`plan`（Node 出 worklist）→ agent 写页正文 → `finalize`（Node 盖机械 front-matter + 建 INDEX + emit manifest）。 |
| **重建** | **全量重建**：每次 sync 重写所有 component 页。增量指纹（`.state/` 每页 `{code_sha, journal_offset}` 跳过未变页）推迟。 |
| **manifest** | 复用既有 `lib/manifest.js`（`emitManifest` + `parseFrontmatter`），不重写。 |
| **推迟** | journal 折叠 · flow/theme 页 · 增量指纹 · 组件分组/改名（一名映射多 dir）· lint · /lore:ask · 真 `atoms`/`commits` 溯源（MVP 填 0）。 |

**决策记录（brainstorm）**：
- *范围*（用户拍板）：选「A: code→component + LLM 合成」而非「C: 纯机械骨架（无 LLM）」或「B: 全量 sync」。C 太薄（无合成知识 = lore 核心价值缺席）；B 太大且阻塞于 journal 未建（flow/theme 页无原子会空）。A 交付 lore 真正价值（合成架构页）+ 端到端闭环，确定性核心仍可测、只 prose 是 agent 写。
- *编排*（用户拍板）：选「O1: plan → agent 写正文 → finalize」而非「O2: 命令胶水」或「O3: Node 调 LLM API」。O1 边界干净（Node 确定性 / agent prose）、复用 manifest.js、与 init/serve 同测试家族、零新依赖。O3 要 API key + 联网 + 破零依赖 + 不可测；O2 结构松难单元测。

**核心不变量（继承母 §6）**：插件纯引擎，repo 特定只在 `.lore/config.yml` + `.lore/` 内容。sync 只读源码 + `.lore/`，只写 `.lore/wiki/`（+ `.lore/.state/` 推迟）。零侵入业务源码。

---

## 2. 架构

镜像 init/serve 模式：**确定性逻辑落 `lib/`（可 headless node:test），命令 `.md` 编排 agent。**

```
D:\workspace\lore\
├── lib/
│   └── sync.js              # 新：config读 + planSync + stampFrontmatter + buildIndex + finalizeSync + CLI
├── commands/
│   └── lore-sync.md         # 新：/lore:sync 编排（precheck → plan → agent合成 → finalize）
└── test/
    └── sync.test.js         # 新：确定性部分单元 + finalize 集成
README.md                    # 改：加 /lore:sync 段
```

**复用既有**：`lib/manifest.js` 的 `parseFrontmatter`（解析页 front-matter）+ `emitManifest`（拼 `.manifest.json`）。sync 的 finalize 末步即调 `emitManifest`（母 spec line 347：「/lore:sync 末尾 emit manifest」）。

**路子（brainstorm）**：单模块 `lib/sync.js`（同 init 的路子 A）。config 子集解析器内部为纯函数；待 mine/sync 都需复用 config 读取时再抽 `lib/config.js`（接缝留着，不预抽）。

---

## 3. 模块 API 契约（锁定 — 实施计划须照此）

`lib/sync.js`（ESM exports）：

```
parseConfigCodeRoots(configText) -> string[]
  // 零依赖 YAML 子集：从 config.yml 文本抽 `code_roots: [a, b, 'c d']`（init renderConfigYaml 产的单行 flow 形态，含加固引号项）。
  // 去引号、trim、滤空。无该行 / 畸形 → []

planSync(loreDir) -> { codeRoots: string[], worklist: Array<{component, codeRoot, path, priorExists}> }
  // 读 loreDir/config.yml → parseConfigCodeRoots → 每 root 一项。
  // component = root 的末段名（'src/pkg' → 'pkg'；冲突见 §6）。path = 'component/<component>.md'。priorExists = 该页文件已在。

stampFrontmatter(pageText, { codeSha, lastUpdated, commits, atoms }) -> string
  // 解析 agent 写的 front-matter（复用 manifest.parseFrontmatter 拿 title/summary），merge 机械字段，重写 front-matter 块，body 原样保留。

buildIndex(pages) -> string
  // pages = [{ id, title }]（component 页）。→ INDEX.md 全文：自带半 front-matter（title:Index, summary:table of contents）+ '# lore wiki — index' + '## Component' 段列 [[id]]（id = 页文件名 stem = component 名）。
  // (机械字段由 finalize 经 stampFrontmatter 盖。)

finalizeSync(loreDir, now) -> { stamped: string[], indexWritten: bool, manifestPath: string }
  // now = ISO 串；lastUpdated = now.slice(0,10)（YYYY-MM-DD）
  // 1. currentSha = git rev-parse --short HEAD（在 loreDir/.. 跑）
  // 2. 枚举 wiki/component/*.md → 每页 stampFrontmatter({ codeSha:currentSha, lastUpdated, commits:0, atoms:0 })
  // 3. 收集各页 id(文件名 stem) + title(front-matter) → buildIndex → stampFrontmatter(同上) → 写 wiki/INDEX.md
  // 4. runManifestCli(loreDir, now)（复用 manifest.js：内部 git sha + 计数 + emitManifest + 写 wiki/.manifest.json）→ manifestPath
```

CLI（同 init/manifest 的 `import.meta.url` 守卫）：
- `node lib/sync.js plan <loreDir>` —— 打印 worklist（JSON，供命令/agent 读）。
- `node lib/sync.js finalize <loreDir>` —— 跑 finalizeSync，打印摘要（盖了几页、INDEX、manifest 路径）。

---

## 4. 数据流（plan → agent → finalize）

1. **precheck**（命令）：`.lore/` 在 + `config.yml` 有非空 `code_roots`，否则 → 提示先 `/lore:init`（或编辑 config），退出。
2. **plan**（Node）：`node lib/sync.js plan <loreDir>` → worklist JSON。
3. **agent 合成**（命令驱动 Claude）：对每个 worklist 项，**读该 `codeRoot` 源码**，写 `wiki/component/<component>.md` = 半 front-matter（`title` + `summary`）+ 三段正文（§5）。cross-links 用 worklist 的全组件列表。
4. **finalize**（Node）：`node lib/sync.js finalize <loreDir>` → 盖机械 front-matter + 建 INDEX + emit manifest。
5. **report**（命令）：写了哪些页 → 提示 `/lore:serve`。

**分工铁律**：agent 写整个 body（3 段）+ `title`/`summary`；Node 只盖机械 front-matter（`code_sha`/`last_updated`/`atoms`/`commits`）+ 建 INDEX + manifest。**Node 不碰 body；agent 不算 sha/计数。** 交接靠文件（agent 写 md，Node 盖章+索引）。

---

## 5. 页输出契约（component 页）

**agent 写**（半 front-matter + 3 段 body）：
```markdown
---
title: <Component 显示名>
summary: <一行语义摘要>
---
# component: <name>

## Current architecture

<LLM 读源码合成的当前架构 prose —— 关键模块/数据流/职责>

## Decision history

暂无 journal 原子（跑 /lore:mine 或 /lore:note 后再 sync 补全）。

## Cross-links

- [[<sibling-component>]]
- ...
```

**Node finalize 盖后**（front-matter 变完整，`manifest.js` 可消费）：
```yaml
---
title: <Component 显示名>
summary: <一行语义摘要>
last_updated: 2026-06-01
code_sha: <current HEAD short>
atoms: 0
commits: 0
---
```

`atoms:0` / `commits:0` = 诚实反映 code-only 合成（无 journal 溯源）。journal 集成后再填真值。front-matter 字段对齐 `manifest.parseFrontmatter` 期望（`title`/`summary`/`last_updated`/`code_sha`/`atoms`/`commits` 扁平 `key: value`）。

---

## 6. config 读取（零依赖 YAML 子集）

`parseConfigCodeRoots` 只解一种形态——init `renderConfigYaml` 产的单行 flow 列表：
```yaml
    code_roots: [lib, site, 'a b']
```
算法：正则定位 `code_roots:` 行 → 取 `[...]` 内文 → 逗号分割 → 每项 trim + 去包裹单/双引号 → 滤空。无该行 / 无 `[...]` → `[]`。**不引 YAML 库**（零依赖；config 形态小且已知）。

`component` 名 = `codeRoot` 末段（`split('/').pop()`：`src/pkg` → `pkg`，`lib` → `lib`）。**末段冲突**（如 `a/util` + `b/util` 都 → `util`）：v1 后者覆盖前者页（少见；记为已知限制，组件改名/分组推迟解决）。

**推迟**：组件分组/改名（config 里一个命名 component 映射多个 dir）、flow/theme 轴读取。

---

## 7. INDEX.md（100% Node 机械建）

`buildIndex(pages)` 从全 component 页拼 TOC（无 agent prose）：
```markdown
---
title: Index
summary: table of contents
---
# lore wiki — index

## Component
- [[<id>]]
- ...
```
finalize 经 `stampFrontmatter` 盖机械字段。INDEX 与 `.manifest.json` = 同源孪生（finalize 一次产俩，母 spec line 333）。`manifest.emitManifest` 已把 `INDEX.md` 当带 front-matter 的页处理（AXIS_ORDER 含 'INDEX'）→ 兼容。

---

## 8. code_sha 语义

finalize 时 `code_sha` = `git rev-parse --short HEAD`（在 `loreDir/..` 跑），盖每页 + INDEX。新鲜合成 → manifest 算 `stale=0`。**按子树 sha**（页只随其 code_root 变而陈旧）+ **增量跳过** = 推迟（属增量指纹那块）。

---

## 9. precheck / 错误 / 幂等

- `.lore/` 缺 或 `config.yml` 无非空 `code_roots` → 命令提示先 `/lore:init`（或编辑 config 填 code_roots），退出。
- `wiki/` 或 `wiki/component/` 缺 → finalize/agent 写页时建（`mkdir -p`）。
- git 不可用 / 无 commit → finalize 报错（复用 `manifest.js` 既有清晰报错）。
- **全量重建**：每次 sync 重写所有 component 页（agent 重合成 body，Node 重盖 + 重建 INDEX/manifest）。**结构幂等**：同 code_roots → 同页集 + 同 INDEX/manifest 结构（body prose 因 LLM 非逐字幂等，属预期）。

---

## 10. 测试策略（确定性 node:test；LLM prose 不自动测）

`test/sync.test.js`，`node:test`，临时目录：

- **`parseConfigCodeRoots` 表驱动**：单行列表 `[lib, site]` → `['lib','site']`；引号项 `['a b', m1]` → `['a b','m1']`；缺 `code_roots:` 行 → `[]`；空 `[]` → `[]`；畸形 → `[]`。
- **`planSync`**：临时 `.lore/config.yml`（含 `code_roots: [lib, src/pkg]`）+ 建对应目录 → 断言 worklist（component 末段名、path、priorExists）。
- **`stampFrontmatter`**：agent 半 front-matter（title+summary）→ 注入 `code_sha`/`last_updated`/`atoms`/`commits`，断言 body 原样、字段齐。
- **`buildIndex`**：页集 → INDEX 文本含 front-matter + `## Component` + `[[id]]` 列。
- **`finalizeSync`**：预写 2 个 agent component 页 fixture（半 front-matter + 3 段）→ finalize → 断言每页 front-matter 被盖全、`INDEX.md` 在且列两页、`.manifest.json`（finalize 经 `runManifestCli` 写）有效（轴 component 含两页，字段齐）。git sha 经临时 git repo 真算。
- **集成**：finalize 后 `runManifestCli` 结果一致；可沿 `test/integration.test.js` 风格扩一条（init → 手放 agent 页 → finalize → serve → fetch `/site/` + 页 200）。
- **agent 合成 prose 不进自动测**（非确定性）：命令文档化，靠结构断言（页有 3 段 H2 + front-matter）。

---

## 11. 命令定义（`commands/lore-sync.md`）

镜像 `lore-init.md` / `lore-serve.md` 风格（中文、frontmatter `description`、用法、行为、给 agent 的提示）：

- **行为**：在目标 repo 根目录执行两阶段：
  1. `node "${CLAUDE_PLUGIN_ROOT}/lib/sync.js" plan "$(pwd)/.lore"` → worklist。
  2. 逐 worklist 项：读 `codeRoot` 源码 → 写 `.lore/wiki/component/<component>.md`（3 段 + title/summary）。
  3. `node "${CLAUDE_PLUGIN_ROOT}/lib/sync.js" finalize "$(pwd)/.lore"`。
- **给 agent 的提示**：
  - precheck：worklist 空 / plan 报 config 无 code_roots → 提示先 `/lore:init`（或编辑 `.lore/config.yml`）。
  - 「当前架构」段：读该 code_root 实际源码（入口、关键模块、数据流、职责），写**当前真实架构**，非泛词。
  - 「决策历史」段：本版填占位（journal 未接）。
  - 「交叉链接」段：据 worklist 全组件列表，链相关 sibling `[[name]]`。
  - 不手写机械 front-matter（`code_sha`/计数/日期）—— finalize 自动盖；agent 只给 `title` + `summary`。
  - 跑完提示 `/lore:serve` 浏览。
  - 零侵入：只写 `.lore/wiki/`，不改业务源码。

---

## 12. 验收指标

1. **端到端闭环**：`/lore:init` → `/lore:sync` → `/lore:serve` 显示**真 component 页**（非空 wiki）。
2. **页结构**：每 component 页 = 完整 front-matter（6 字段）+ 3 段（Current architecture / Decision history / Cross-links）。
3. **INDEX + manifest**：`INDEX.md` 列全 component 页；`.manifest.json` 经 `manifest.js` 有效产出，serve 渲染、wikilink 壳内跳转。
4. **config 尊重**：sync 读 `config.yml` 的 `code_roots`（用户编辑生效），非重新 discover。
5. **全量重建幂等**：重跑 sync → 同 code_roots 产同页集 + 同 INDEX/manifest 结构（body prose 非逐字幂等属预期）。
6. **零侵入 + 零依赖**：只写 `.lore/wiki/`；不改业务源码；无新外部依赖（含自写 config 子集解析器）；复用 `manifest.js`。
7. **确定性可测**：`parseConfigCodeRoots`/`planSync`/`stampFrontmatter`/`buildIndex`/`finalizeSync` 全 node:test 覆盖；全测试套件绿。

---

## 13. 不在范围 / 推迟

- **journal 原子折叠**（决策历史段填真原子、真 `atoms`/`commits` 溯源）→ 随 mine/note + journal 子系统落地。
- **flow / theme 轴页** → 需 journal 原子；随捕获子系统。
- **增量指纹缓存**（`.state/` 每页 `{code_sha, journal_offset}` 跳过未变页）→ 全量重建够用于 MVP 小 repo。
- **组件分组 / 改名**（config 一名映射多 dir）+ 末段名冲突解决 → 配置驱动增强，按需加。
- **lint（`/lore:lint`）/ ask（`/lore:ask`）** → 各自子项目。

---

## 14. 开放问题

- **summary 来源**：MVP 让 agent 写 `summary`（语义摘要）。若想机械化（取 body 首句）可省 agent 一点活，但 summary 是合成产物，agent 写更准。v1 选 agent 写。
- **component 末段名冲突**（`a/util` + `b/util` → `util`）：v1 后者覆盖。若试验田真撞，提前到「组件改名/分组」那块解决。
- **plan worklist 传给 agent 的形态**：CLI 打印 JSON，agent 读 stdout。若页多，可改写文件到 `.state/`。v1 先 stdout（页数少）。

---

*参考：母 spec `2026-05-31-lore-repo-wiki-design.md` §4/§5/§5.5/§6 · init spec+plan `2026-06-01-lore-init*`（镜像）· `lib/manifest.js`（复用 parseFrontmatter + emitManifest）· 本 spec 经交互式 brainstorming 收敛（范围 A + 编排 O1 两处用户拍板）。*
