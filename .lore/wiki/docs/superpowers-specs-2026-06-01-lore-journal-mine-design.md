---
title: journal 基座 + `/lore:mine` — 捕获生产者（commits）
summary: > 设计文档 (spec) · 2026-06-01 · 子项目 **journal 基座 + `/lore:mine`（v1，commits-only）** · 状态: 已 brainstorm 收敛，待转实施计划 > > 母 spec: `docs/superpowers/specs/2026-05-31-lore-repo-wiki-design.md` §4（捕获：3 源 + 原子 ...
source_path: docs/superpowers/specs/2026-06-01-lore-journal-mine-design.md
last_updated: 2026-06-01
---
> 源文档：`docs/superpowers/specs/2026-06-01-lore-journal-mine-design.md`

# journal 基座 + `/lore:mine` — 捕获生产者（commits）

> 设计文档 (spec) · 2026-06-01 · 子项目 **journal 基座 + `/lore:mine`（v1，commits-only）** · 状态: 已 brainstorm 收敛，待转实施计划
>
> 母 spec: `docs/superpowers/specs/2026-05-31-lore-repo-wiki-design.md` §4（捕获：3 源 + 原子 schema + facet 打标）/ §6（通用引擎内核）/ §11（验收）
> 同类范例: `docs/superpowers/plans/2026-06-01-lore-sync.md`（sync 实施计划，TDD + 模块/CLI 风格范例）

---

## 0. 背景：数据链的生产者侧

lore 数据流：**捕获(hook/note/mine) → journal → sync → wiki → serve**。两端（`/lore:init` 脚手架、`/lore:serve` 浏览）+ 中段 `/lore:sync`（合成）已实现。但 **journal 一直是空的** —— 没有任何已实现命令往里写原子。后果：`/lore:sync` 的「决策历史」段只能填占位「暂无 journal 原子」。

母 spec §4 列三个捕获源：**① post-commit hook**（耐久地板）· **② `/lore:note`**（agent 补 why）· **③ artifact miner**（bootstrap 回填）。本 spec 实现 **③ 的 commits 部分** —— `/lore:mine` 从 git 历史回填 commit 原子，给 journal 第一批内容。

**为什么 mine 先**：commits 是**唯一普世**的捕获源（任何 git repo 都有 commit 历史），且**全确定性**（无需 LLM/agent，不像 hook 要装进 git hooks、不像 note 要 agent 在决策当下介入）。一条命令把历史变成可导航的多 facet 原子流。

---

## 1. 范围

| 维度 | 决策 |
|---|---|
| **journal 基座** | 新 `lib/journal.js`：ndjson 原子读写 + 去重（`appendAtom` / `readAllAtoms` / `existingIds` / `atomPath`）。**未来 hook/note/sync-fold 全复用它**。 |
| **commits miner** | 新 `lib/mine.js`：`git log` → commit 原子（确定性解析 + component facet 打标），按 atom id 去重，append 到 journal。CLI `node lib/mine.js <repoRoot>`。 |
| **config 抽取** | 新 `lib/config.js`：把 `parseConfigCodeRoots` 从 `lib/sync.js` 搬来（第 2 消费者 = DRY）；sync + mine 共用。 |
| **facet 打标** | 只 **component**（母 §4 层 1：变更路径 → `code_roots` 前缀匹配，确定性，EXTRACTED）。flow/theme（层 2）推迟。 |

**决策记录（brainstorm）**：
- *源范围*（用户拍板）：选「commits-only」而非「+changelog」「+全 §4③」。commits 普世 + 全确定性 + node:test 全覆盖；changelog/pitfalls 是格式特定提取器，可插拔 source 架构留着，以后 config-gated 增量加，不改内核。
- *facet 范围*：选 component-only，与 sync v1（也 component-only）一致；flow/theme 需更复杂 config 解析 + 用户填 `match:`（init 产的 config 里是空），同期推迟。
- *拆分*：选「`lib/journal.js`（基座）+ `lib/mine.js`（miner）双模块」而非单模块。基座有已知第二批消费者（hook/note/sync-fold），边界先立。

**核心不变量（继承母 §6）**：纯引擎，零 repo 耦合。本 spec 范围内只写 `.lore/journal/`；只读目标 repo 的 git 历史；不碰业务源码；零外部依赖；**纯确定性（无 LLM）**。

---

## 2. 架构

镜像现有 `manifest.js` / `sync.js` 模式：纯逻辑落 `lib/`，命令 `.md` 是薄壳，全 node:test。

```
D:\workspace\lore\
├── lib/
│   ├── config.js           # 新：parseConfigCodeRoots（从 sync.js 抽出）
│   ├── journal.js          # 新：ndjson 基座（append/read/dedup/path）
│   ├── mine.js             # 新：commits miner + CLI
│   └── sync.js             # 改：import parseConfigCodeRoots from './config.js'（删本地定义）
├── commands/
│   └── lore-mine.md        # 新：/lore:mine slash 命令
├── test/
│   ├── config.test.js      # 新：parseConfigCodeRoots 测试（从 sync.test.js 搬来）
│   ├── journal.test.js     # 新
│   ├── mine.test.js        # 新（单元 + CLI + 集成）
│   └── sync.test.js        # 改：删 parseConfigCodeRoots import + 其 4 测试（搬去 config.test.js）
└── README.md               # 改：加 /lore:mine 段
```

**复用（不改）**：无（mine 不依赖 manifest/serve）。**config 抽取碰两处既有文件**：`lib/sync.js`（import 改源）+ `test/sync.test.js`（搬走 4 个 parseConfigCodeRoots 测试）—— 最小侵入，全套须保持绿。

**模块边界**：`config.js`（纯解析）· `journal.js`（纯存储，不知道 commit 是什么）· `mine.js`（知道 git + 原子构造，依赖 config + journal）。各自可独立理解/测试。

---

## 3. 模块 API 契约（锁定 — 实施计划须照此）

```
// lib/config.js
parseConfigCodeRoots(configText) -> string[]
  // 从 sync.js 原样搬移，行为不变

// lib/journal.js
atomPath(journalDir, isoTs) -> string
  // journalDir/YYYY/MM/YYYY-MM-DD.ndjson（从 isoTs 切片 YYYY/MM/DD）
appendAtom(journalDir, atom) -> void
  // mkdir -p atomPath 的目录；appendFileSync(JSON.stringify(atom) + '\n')
readAllAtoms(journalDir) -> object[]
  // 递归 walk journalDir 下全 *.ndjson，逐非空行 JSON.parse；缺目录 → []
existingIds(journalDir) -> Set<string>
  // new Set(readAllAtoms(journalDir).map(a => a.id))

// lib/mine.js
pathComponent(filePath, codeRoots) -> string | null
  // 最长前缀匹配的 code_root（file===root || file.startsWith(root+'/')）的末段名；无 → null
parseGitLog(stdout) -> Array<{ sha, ts, subject, body, files }>
  // 纯函数解析 git log 输出（见 §4）
commitAtom(raw, codeRoots) -> object
  // raw = parseGitLog 一项 → 全 §4 schema 原子（见 §6）
mineCommits(repoRoot, codeRoots) -> object[]
  // execFileSync git log → parseGitLog → map commitAtom
mine({ repoRoot, journalDir, codeRoots }) -> { scanned, added, skipped }
  // existingIds 去重 → appendAtom 新原子
```

CLI 入口（`import.meta.url` 守卫，同 sibling）：`node lib/mine.js <repoRoot>` —— 读 `<repoRoot>/.lore/config.yml` 的 code_roots，`journalDir = <repoRoot>/.lore/journal`，跑 `mine`，打印摘要。

---

## 4. git log 解析（确定性核心）

单次 git 调用 + 纯解析函数（可用 fixture 字符串测，无需真 repo）：

```bash
git log --no-merges --pretty=format:'%x1e%H%x1f%aI%x1f%s%x1f%b%x1f' --name-only
```

- `%x1e`(RS, U+001E) 分隔每个 commit；`%x1f`(US, U+001F) 分隔字段。
- 字段序：`%H`(full sha) · `%aI`(author date ISO 8601 严格) · `%s`(subject) · `%b`(body)。body 后**额外加一个 `%x1f`** 干净隔开「body ↔ `--name-only` 文件列表」。
- `--name-only` 把变更文件名追加在格式串后（各占一行）。

**`parseGitLog(stdout)`**：
```
stdout.split('\x1e').slice(1)           // 跳开头空串；每段 = 一个 commit
  .map(rec => {
    const [sha, ts, subject, body, filesBlob = ''] = rec.split('\x1f');
    const files = filesBlob.split('\n').map(s => s.trim()).filter(Boolean);
    return { sha, ts, subject, body, files };
  })
```
- body 多行安全（控制字符 `\x1f`/`\x1e` 不出现在 commit message）。
- merge commit 由 `--no-merges` 排除（避免无 diff 路径的噪声原子）。
- 空 body → `body = ''`。

---

## 5. component facet 打标（母 §4 层 1，确定性）

`pathComponent(filePath, codeRoots)`：git 给的 file 路径是 **repo 相对 + forward-slash**；code_roots 也 forward-slash（init 产）→ 跨平台前缀匹配安全。对每个 codeRoot 测 `filePath === codeRoot || filePath.startsWith(codeRoot + '/')`；多匹配取**最长** codeRoot（最具体）；返回其末段名（`src/pkg` → `pkg`，同 sync）；无匹配 → `null`。

`commitAtom` 的 `facets.component` = 该 commit 全文件经 `pathComponent` 的**去重 + 排序**非空集；无任何匹配 → `[]`。`flow`/`theme` = `[]`（推迟）。

---

## 6. commit 原子构造（全 §4 schema）

```jsonc
{
  "id": "commit:<full-sha>",        // 全 40 位 sha
  "ts": "<%aI author date ISO>",
  "kind": "commit",
  "commit": "<full-sha>",
  "title": "<%s subject>",
  "why": "<%b body>",               // 可空
  "what_changed": "",               // commit 无独立字段；enriched=false 标骨架
  "facets": { "component": ["..."], "flow": [], "theme": [] },
  "refs": { "files": ["..."], "pitfall": null, "related": [] },
  "source": "miner:commits",
  "enriched": false,
  "confidence": "EXTRACTED"
}
```

**id 用 full sha 而非 short**（母 spec 展示 `commit:b5d4100` 短码是示意）：去重靠 id，short sha 的 abbrev 长度随 repo 增长可能变 → 同一 commit 重跑得不同短码 → 假新增。full sha 永远稳定。显示短码留给下游 sync/serve（渲染关注，非身份）。

---

## 7. journal 基座（ndjson）

- **`atomPath(journalDir, isoTs)`**：`isoTs` 形如 `2026-06-01T08:00:00Z`，切 `YYYY`=`2026`、`MM`=`06`、`DD`=`01` → `join(journalDir, '2026', '06', '2026-06-01.ndjson')`。
- **`appendAtom`**：`mkdirSync(dirname(path), {recursive:true})` + `appendFileSync(path, JSON.stringify(atom) + '\n')`。append-only（神圣，不改旧行）。
- **`readAllAtoms`**：**手写递归 walk**（零依赖，不靠 `readdirSync({recursive})` 的 Node 版本要求）收集全 `*.ndjson`，逐行 `JSON.parse`，跳空行；`journalDir` 不存在 → `[]`。
- commit 原子按**自身 `ts`（author date）** 落对应日分片 —— 与 mine 的迭代顺序无关（3 月的 commit 进 3 月的文件）。

---

## 8. mine 编排 + 去重

```
mine({ repoRoot, journalDir, codeRoots }):
  const seen = existingIds(journalDir)
  const atoms = mineCommits(repoRoot, codeRoots)
  let added = 0, skipped = 0
  for (const a of atoms):
    if (seen.has(a.id)) { skipped++; continue }
    appendAtom(journalDir, a); seen.add(a.id); added++
  return { scanned: atoms.length, added, skipped }
```

**幂等**：首跑 append 全部；重跑 `existingIds` 命中全部 → `added=0, skipped=scanned`。`seen` 跑内累加防同次重复。

---

## 9. CLI / 错误 / 边界

`node lib/mine.js <repoRoot>`：
- `loreDir = <repoRoot>/.lore`；`configPath = loreDir/config.yml`；`journalDir = loreDir/journal`。
- `codeRoots = existsSync(configPath) ? parseConfigCodeRoots(read) : []`。
- 跑 `mine`，打印：`✓ mined N new commit atom(s) (M already present, K scanned)` + 下一步提示。
- **repoRoot 非 git / 无 commit** → `git log` 失败 → 报清晰错误退出（同 manifest.js git 错误风格）。
- **无 config.yml** → `codeRoots=[]` → 原子 component 空，**仍挖**（commit 原子本身有价值；component 打标缺失）；打印提示「跑 /lore:init 启用 component 打标」。`journalDir` 由 `appendAtom` 自建。

---

## 10. 命令定义（`commands/lore-mine.md`）

镜像 lore-init/lore-sync 风格（中文、frontmatter `description`、用法、行为、给 agent 的提示）：
- **行为**：`node "${CLAUDE_PLUGIN_ROOT}/lib/mine.js" "$(pwd)"`。
- **给 agent 的提示**：一次性 bootstrap 回填（git 历史 → journal 原子）；幂等可重跑（按 commit sha 去重）；component 打标需 config `code_roots`（先 `/lore:init`）；**纯确定性零 LLM**；下一步 `/lore:sync`（未来版本：折叠 journal 进「决策历史」段）；零侵入（只写 `.lore/journal/`，绝不改业务源码）。

---

## 11. 测试策略（全确定性 node:test，零 LLM）

- **`test/config.test.js`**：`parseConfigCodeRoots` 的 4 个测试（从 `sync.test.js` 搬来，验抽取无回归）。
- **`test/journal.test.js`**：
  - `atomPath`：ISO ts → 正确 `YYYY/MM/YYYY-MM-DD.ndjson`。
  - `appendAtom`：原子落对应日分片；追加第二条到同日 → 两行。
  - `readAllAtoms`：跨多日分片读全；缺 journalDir → `[]`；跳空行。
  - `existingIds`：返回全 id 集。
- **`test/mine.test.js`**：
  - `pathComponent`：前缀匹配 / 最长匹配（`src/pkg` 胜 `src`）/ 末段名 / 无匹配→null。
  - `parseGitLog`：fixture stdout（含多行 body + 多文件 + 空 body commit）→ 正确 rawCommits。
  - `commitAtom`：全 schema 字段 + component facet 去重排序 + `source/kind/enriched/confidence` 正确。
  - `mineCommits`：真临时 git repo（`git init` + 几个 commit 碰不同 code_root）→ 原子集。
  - `mine`：跑两次 → 第 1 次 `added=scanned`，第 2 次 `added=0`（幂等）。
  - **CLI 冒烟**：`node lib/mine.js <tmpRepo>` → 退 0 + journal 有原子。
  - **集成**：真 git repo + 一个 code 目录的 commit → `init` 起 config → `mine` → 断言原子 `facets.component` 含该组件 + 重跑幂等。
- **改 `sync.test.js` 后全套绿**：删掉搬走的 4 测试 + 该 import，sync 仍经 `config.js` 工作。

---

## 12. 验收指标

1. **回填**：git repo 上 `/lore:mine` → `.lore/journal/YYYY/MM/*.ndjson` 每个非 merge commit 一条原子，全 §4 schema。
2. **component facet**：commit 碰 `<code_root>/...` → 原子 `facets.component` 列该组件（确定性 path→code_root）。
3. **幂等**：重跑 `added=0`（按 atom id 去重）。
4. **ndjson 布局**：原子按 author date 落 `YYYY/MM/YYYY-MM-DD.ndjson`、append-only、一行一合法 JSON。
5. **config 抽取**：`parseConfigCodeRoots` 在 `lib/config.js`，sync + mine 共用；**全套绿（sync 不回归）**。
6. **零依赖零侵入**：只写 `.lore/journal/`；不碰业务源码；无新外部依赖；纯确定性（无 LLM）。
7. **确定性可测**：config/journal/mine 函数 node:test 全覆盖。

---

## 13. 不在范围 / 推迟

- **changelog / pitfalls 提取器**（母 §4③ 另两源）→ config-gated 增量，可插拔 source 架构留着。
- **flow/theme facet 打标**（母 §4 层 2，config `match:` 正则）→ 随更复杂 config 解析 + 用户填 config 落地。
- **hook（①）/ note（②）生产者** → 各自独立活儿。
- **sync 折叠 journal → 「决策历史」段渲染**（消费者侧）→ 下一个独立增量（本 spec 只生产，不消费）。
- **增量 since-sha**（只挖上次之后的 commit）→ v1 全量挖 + 去重兜底；优化推迟。
- **enrich（补 why）/ confidence 超出 EXTRACTED / merge commits** → 推迟。

---

## 14. 开放问题

- **大 repo 全量挖性能**：v1 每跑全量 `git log` + 读全 journal 去重。大历史偏慢但正确；增量 since-sha 优化推迟（§13）。
- **mine 无 init**：proceeds（commit 原子仍有价值），component facet 空 + 打印提示。可接受 —— mine 对裸 repo 也产出。
- **同次 mine 内 ts 同日多 commit**：全落同一日分片（多行），正确。

---

*参考：母 spec `2026-05-31-lore-repo-wiki-design.md` §4/§6/§11 · sync 实施计划 `2026-06-01-lore-sync.md`（TDD + 模块/CLI 范例）· 本 spec 经交互式 brainstorming 收敛（源范围用户拍板 commits-only；架构 + facet 范围两处确认）。*

