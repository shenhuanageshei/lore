# lore 深度页模块消歧（deep source disambiguation）—— 设计

- 日期：2026-08-03
- 状态：设计已批，待写实施计划
- 北极星：config 声明的深度页**必须能唯一解析到源文件**，歧义可消解、页面永不静默冻结
- 前置（已在 main）：源文件级深度页（`config.deep.<root>: [子模块…]`）、`resolveDeepSource` 裸名匹配、`lintDeepConfig` 五检、`parseConfigDeep` 分组 map
- 缺陷出处：`docs/DEFECT-deep-source-ambiguity.md`（mal-analyze-cli 上报：`e2e_smoke.py` + `e2e_smoke.sh` 同目录 → ambiguous → 页面永久冻结、lint 常驻报警）

## 背景 / 问题

`resolveDeepSource` 按「basename 去扩展名 == 模块名」匹配源文件（`lib/source.js:9-26`）。同一目录存在同名不同扩展的文件（`.py`+`.sh`、`.ts`+`.js`、`.tsx`+`.jsx`）时模块被判 `ambiguous` **整体跳过**——不进 plan worklist、prose 永不重写、lint 每次报 `deep-config` 且 config 没有任何语法能把模块钉到具体文件。

根因：config 条目只有「裸模块名」一种语义，缺「钉到具体文件」的语法。缺陷文档已核验：把条目写成 `e2e_smoke.py` 只会从 ambiguous 变 missing，依然无解。

## 目标 / 非目标

**目标**：
1. config 条目可写 `<name>.<ext>`（如 `e2e_smoke.sh`）显式钉住文件；裸名语义不变（向后兼容）。
2. 页面 id 恒为基名（`component/e2e_smoke.md`，不是 `e2e_smoke.sh.md`）——五个消费点统一归一化。
3. lint 从「报歧义」升级为「报歧义 + 给出可操作钉法」；显式钉住的文件缺失时严格报 missing（不回退）。
4. 防呆：同基名条目（裸名 + 显式并存）检测为配置错误。

**非目标**：
- 歧义页进 worklist「待消歧」流程（缺陷文档方案 3，实现量最大）——本期不做，lint 已给出钉法提示，人工/agent 改 config 一行即可。
- 扩展名优先级消歧（缺陷文档方案 2）——隐式、不可覆盖、规则脆弱，已否决。
- deepRoot 内子路径条目（`tools/e2e_smoke.py`）——本期只支持基名+扩展名；与「裸名不搜嵌套目录」语义一致（既有测试断言）。

## 决策（已锁）

| 项 | 决策 |
|---|---|
| 消歧语法 | **显式文件名**：条目带 CODE_EXT 扩展名 → 精确文件名命中；裸名行为不变 |
| 条目形态 | 仅基名+扩展名（`e2e_smoke.sh`），匹配 deepRoot 直接子文件；不支持子路径 |
| 显式缺失语义 | **严格报 missing**（带精确期望路径 `expected`），不回退裸名匹配——钉文件是明确意图，静默回退会复活歧义 |
| 页 id 推导 | 纯语法函数 `parseDeepEntry(entry) → { id, explicit }`（不碰 fs，`legalIds` 无 repoRoot 分支也能用） |
| 碰撞防呆 | 同 deepRoot 下两个条目归一化出同 id（`e2e_smoke` + `e2e_smoke.sh`）→ 新诊断 `deep-source-collision`，entries 只留第一个（first-wins） |
| config 解析 | `parseConfigDeep` **不改**（order 保留原文案，显式信号留给 resolver）→ config 测试零破坏 |
| lint 消息 | 可操作化：ambiguous 附候选 + 钉法；显式缺失附精确路径；碰撞单独诊断 |

## 设计

### S1 · 解析双形态（`lib/source.js`）

**新增纯函数 `parseDeepEntry(entry)`**（导出）：

```js
export function parseDeepEntry(entry) {
  const ext = extname(entry);
  const explicit = ext !== '' && CODE_EXT.has(ext);
  return { id: explicit ? entry.slice(0, -ext.length) : entry, explicit };
}
// 'e2e_smoke'    → { id: 'e2e_smoke', explicit: false }
// 'e2e_smoke.sh' → { id: 'e2e_smoke', explicit: true }
// '.py'（全扩展名）→ extname 返回 '' → 裸名，自然安全
```

**`resolveDeepSource(repoRoot, deepRoot, entry)`** 入口先走 `parseDeepEntry`：

```js
if (explicit) {
  const hit = entries.find(e => e.isFile() && e.name === entry);   // 目录内文件名唯一，无歧义分支
  return hit ? { status: 'ok', sourceFile: rel(hit) }
             : { status: 'missing', candidates: [], expected: `${deepRoot}/${entry}` };
}
// 裸名 → 现状逻辑一字不改（唯一/缺失/歧义三分支）
```

显式缺失返回新增 `expected` 字段（精确期望路径，喂 lint 消息）。**不回退**裸名匹配。

**`resolveConfiguredDeep`**：entries 增 `entry` 字段（原文案）+ `mod` 改存规范化页 id：

```js
const { id } = parseDeepEntry(mod);
// ok        → entries.push({ deepRoot, entry: mod, mod: id, sourceFile })
// missing   → issues（裸名/显式分别带 expected）
// ambiguous → issues（带 candidates）
```

同 deepRoot 下 mod id 已存在（碰撞）→ 第二条进 issues（新 kind `deep-source-collision`，带两个 entry 原文），不重复进 entries。

### S2 · 消费点归一化（页 id 恒为基名）

| 消费点 | 改动 |
|---|---|
| `lib/sync.js:54` planSync | `id: entry.mod`（`entry` 是 resolvedDeep 条目对象），`path: component/<entry.mod>.md` |
| `lib/sync.js:306` finalize staleScopes | 键 `component/<entry.mod>.md`，值 `[sourceFile]` 不变 |
| `lib/sync.js:312-315` componentOrder / pageGroups | `order` 逐项 `parseDeepEntry(m).id`；group `mods` 同样归一化 |
| `lib/lint.js:14-31` legalIds（含无 repoRoot 纯配置分支） | `names.add(parseDeepEntry(mod).id)` |
| `lib/lint.js:173` lintMissingMechanism | `component/${parseDeepEntry(mod).id}.md` |

`lib/config.js` **零改动**（`parseConfigDeep` 原文案进 order）。

### S3 · lint 诊断增强（`lib/lint.js` `lintDeepConfig`）

| 形态 | 消息 |
|---|---|
| `invalid-root` | 不变 |
| 裸名 `missing-source` | 不变（`no supported source file found for pkg/absent`） |
| 显式 `missing-source` | `no supported source file found for pkg/e2e_smoke.sh (pinned file)`（用 `issue.expected`） |
| `ambiguous-source` | `multiple supported source files found for pkg/e2e_smoke — pin one: e2e_smoke.py / e2e_smoke.sh` |
| `deep-source-collision`（新） | `deep pkg: e2e_smoke and e2e_smoke.py resolve to same page id — keep one` |

既有 `test/lint.test.js:279-289` 断言精确消息串 → 同步更新。

### S4 · 文档

- `commands/sync.md` 深度页段落：补一行「条目可写 `<name>.<ext>` 钉住具体文件（歧义消解），页 id 恒为基名」
- `lib/init.js` `renderConfigYaml` 的 deep 注释：补钉法提示
- `docs/DEFECT-deep-source-ambiguity.md`：状态更新为已设计，附本 spec 链接

## 验收

对照缺陷文档 4 条标准（2026-08-03 版）：

1. `deep.scripts: [e2e_smoke.sh]` → `resolveDeepSource` 唯一解析到 `scripts/e2e_smoke.sh`；`planSync` worklist 出现 `component/e2e_smoke.md`（`sourceFile: scripts/e2e_smoke.sh`）；`lintDeepConfig` 不再报 ambiguous。
2. 裸名 `e2e_smoke` 在唯一文件时行为与现在完全一致（`test/source.test.js` 既有 3 个用例一字不改，回归锚）。
3. 缺文件报 `missing-source`（显式带精确路径）、多个文件未消歧仍报 `ambiguous`（信息不丢失，附钉法）。
4. 新增用例覆盖：显式命中、显式缺失（`expected` 字段）、裸名退化、`.py`+`.sh` 真实案例、碰撞诊断。

## 风险 / 缺口（诚实声明）

- `deep-source-collision` 是本期新引入的防线，前提是用户不会故意同列裸名+显式——语义自洽，无历史包袱。
- 壳（`site/index.html`）经 manifest 间接消费 `componentOrder`/`pageGroups`，不直接读 config——归一化后排序/分组键是基名，与页 id 一致，无壳改动。壳侧无自动化测试（既有惯例，手动 serve 验证）。
- lint 消息串变化会破坏既有断言（`test/lint.test.js`）——已在测试计划内显式更新，非静默。
- 全扩展名条目（`.py`）按裸名处理——`extname` 语义使然，文档一句话说明即可，不特判。
