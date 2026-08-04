# 引擎缺陷：深度页模块歧义无法消解（deep source ambiguity has no resolution path）

> 状态：已设计（2026-08-03），方案见 docs/superpowers/specs/2026-08-03-deep-source-disambiguation-design.md，实施见 docs/superpowers/plans/2026-08-03-deep-source-disambiguation.md ｜ 提交者：mal-analyze-cli 仓库维护者 ｜ 日期：2026-08-03
> 关联代码：`lib/source.js` `resolveDeepSource` / `resolveConfiguredDeep`；`lib/lint.js` `lintDeepConfig`；`lib/sync.js` `planSync`

## 一句话问题

config 的 `axes.component.deep.<root>` 用**裸模块名**声明深度页，引擎按「basename 去扩展名 == 模块名」匹配源文件；当同一目录下存在同名不同扩展的文件（如 `e2e_smoke.py` + `e2e_smoke.sh`）时，模块被判定为 `ambiguous` 并**整体跳过**——且 config 没有任何语法能把该模块钉到具体文件上，**该页面从此永不参与 sync，内容永久 frozen**。

## 影响

- 被跳过模块的 wiki 页不会出现在 `plan` worklist（`resolveConfiguredDeep` 的 entries 不含歧义项），prose 永不重写，与代码漂移越来越大。
- `lint` 每次报 `deep-config` 警告（`multiple supported source files found`），无解、常驻，污染 lint 输出。
- 该问题对「一个入口 + 多语言实现」的常见布局（`.py`+`.sh`、`.ts`+`.js`、`.tsx`+`.jsx`）是通用痛点，不是个例。

## 真实案例（mal-analyze-cli）

```text
scripts/
├── e2e_smoke.py    # 170 行，实际驱动逻辑（MCP client 走完整链路）
└── e2e_smoke.sh    # 66 行，用户入口 wrapper（Drives ... via scripts/e2e_smoke.py）
```

config 声明 `deep.scripts: [..., e2e_smoke, ...]`。

复现：

```bash
# 在 mal-analyze-cli 仓库
node "D:/workspace/lore/lib/lint.js" .lore
# → deep-config (1): scripts/e2e_smoke — multiple supported source files found for scripts/e2e_smoke

node "D:/workspace/lore/lib/sync.js" plan .lore
# → worklist 无 component/e2e_smoke.md 条目（模块被静默跳过）
```

两个文件都是**有意存在**的：`.sh` 是 DEPLOY.md 文档化的入口（`./scripts/e2e_smoke.sh`），`.py` 是它驱动的实现、也被 plans 直接引用。改名任何一个都破坏文档引用；config 侧无解（见下）。

## 根因（代码位置）

`lib/source.js:9-26` `resolveDeepSource`：

```js
const candidates = entries
  .filter(entry => {
    const ext = extname(entry.name);
    return entry.isFile()
      && CODE_EXT.has(ext)
      && entry.name.slice(0, entry.name.length - ext.length) === mod;   // 裸名 == basename 去扩展名
  })
  ...
if (candidates.length === 1) return { status: 'ok', ... };
if (candidates.length === 0) return { status: 'missing', ... };
return { status: 'ambiguous', candidates };                              // 2+ 命中 → 跳过
```

`lib/source.js:72-87` `resolveConfiguredDeep`：ambiguous 进 `issues`，**不进 `entries`** → `lib/sync.js:52-63` plan 循环遍历的是 `resolvedDeep.entries`，歧义模块永远不生成 worklist 项。

`lib/lint.js:43-57` `lintDeepConfig` 把该 issue 映射为 `deep-config` 诊断。

**已验证 config 语法无法消歧**：`resolveDeepSource` 的比较是 `name.slice(0, len-ext) === mod`，即 mod 永远按「无扩展名」语义匹配；把条目写成 `e2e_smoke.py` 或 `e2e_smoke.sh` 都匹配不上（`"e2e_smoke.py"` ≠ `"e2e_smoke"`），结果从 ambiguous 变成 missing，依然无解。

检测行为本身有测试覆盖（`test/source.test.js:41-48` ambiguous 排序、`test/lint.test.js:279-289` 报告），说明「检测并报告歧义」是设计意图；缺的是**消歧/选择机制**——这是本次要补的能力缺口。

## 期望行为（建议设计）

目标：让 `deep.<root>` 条目能唯一解析到文件，且保持向后兼容（裸名语义不变）。

候选方案（按侵入性从低到高，供引擎维护者取舍）：

1. **config 支持显式文件路径**：条目写 `e2e_smoke.sh`（或 `scripts/e2e_smoke.sh`）时按精确文件名匹配（精确命中优先于裸名匹配）；裸名行为不变。
   - 优点：零破坏，只扩展语法；用户可自己选哪个文件当「该模块的源」。
   - 注意点：`resolveDeepSource` 需先做精确文件名命中检查，再退化到裸名匹配；lint 的 `missing-source` 消息预期也要兼容两种形态。
2. **扩展名优先级消歧**：歧义时按固定优先级选（如 `.py` > `.js` > `.ts` > `.sh`），其余候选只在 lint 里提示。
   - 优点：现有 config 全兼容、无需改配置。
   - 缺点：隐式、不可覆盖；用户想以 wrapper 为页时做不到；`CODE_EXT` 集合变化会改变既有选择，规则脆弱。
3. **歧义时不跳过，列出候选供选择**：保持当前报 `deep-config` 警告，但 worklist 额外包含一个「待消歧」条目（reason: `ambiguous`），由 agent/用户在重写时决定（类似 rewrite-requests 机制，让用户 pick 一个文件，选择结果写回 config 以固化）。
   - 优点：消歧决策进入现有「人/agent 驱动」流程；不冻结页面。
   - 缺点：实现量最大，涉及 plan/worklist/写回 config 三处。

## 验收标准（建议）

1. `deep.scripts: [e2e_smoke.sh]`（显式文件名）能唯一解析到 `scripts/e2e_smoke.sh`，`plan` worklist 出现该页，`lint` 不再报 `deep-config`。
2. 裸名 `e2e_smoke` 在唯一文件（如只有 `e2e_smoke.py`）时行为与现在完全一致（回归不破坏 `test/source.test.js` 既有用例）。
3. 缺文件时报 `missing-source`、多个文件且未消歧时仍报 `ambiguous`（信息不丢失）。
4. 新增用例覆盖：精确文件名命中、裸名退化、`.py`+`.sh` 真实案例。
