# 主题轴多源深度页设计

**日期：** 2026-08-05

**状态：** 需求已批准；实现推迟到独立会话

## 目标

当单个职责横跨多个源文件或目录时，为 Lore 主题添加原生深度页。主题鸟瞰页仍是跨切面地图，而每个子页拥有一个有边界的多源机制，并参与与现有组件深度页相同的规划、陈旧度、质量、manifest、图谱、MCP 与导航生命周期。

触发案例是 `mal-analyze-cli` 的 Sidecar 配置解密。它有价值的深度页边界是：发现与关联、加密执行、协调生命周期、规范传播。每个边界都横跨多个模块，因此现有「一源文件一页」的组件深度页无法表示它——要么把机制切碎，要么给它分配误导性的陈旧度作用域。

## 当前局限

Lore 现有两种相关页类型：

- **组件深度页**声明在 `axes.component.deep` 下。它把一页映射到一个已解析的源文件，并享有精确的增量陈旧度、机制 lint、manifest 元数据与图谱可见性。
- **主题页**声明在 `axes.theme.values` 下。它是单个跨切面鸟瞰页，按 journal 原子匹配，没有原生的子页或多源陈旧度契约。

组件分组只改变侧栏顺序，并不把多个模块合并进一页。手写主题子页也不够：它们不进 `planSync`，不能声明源作用域，lint 不认它们是深度页，配置变更后还可能变成孤儿。

## 非目标

- 用通用 YAML 解析器替换轻量配置解析器。
- 改变现有组件深度页的解析方式或页 id。
- 从仓库结构或提交历史自动推断多源子页。
- 允许把仓库之外的任意文件作为源作用域。
- 给 wiki 增加嵌套物理目录层级。
- 重写现有主题页，或迁移未选择启用该功能的项目。
- 把该特性作为 `mal-analyze-cli` 文档任务的一部分实现。

## 选定的模型

引入显式的 `axes.theme.deep` 块。每个父主题拥有有序的子规格分组。子规格有稳定的局部 id，以及一组显式的、非空的、仓库相对的源路径或 glob。

示例：

```yaml
axes:
  theme:
    values:
      - { id: sidecar-config-decryption, desc: "Evidence-driven sidecar config decryption", match: [sidecar, config_crypto] }
    deep:
      sidecar-config-decryption:
        发现与关联:
          - { id: discovery-association,
              sources: [mal_analyze/sidecar/probe.py,
                        mal_analyze/sidecar/associations.py,
                        mal_analyze/sidecar/models.py] }
        执行与传播:
          - { id: crypto-execution,
              sources: [mal_analyze/sidecar/executor.py,
                        mal_analyze/sidecar/materials.py,
                        mal_analyze/native_enrichment/crypto_evidence.py,
                        mal_analyze/extractors/profiles/sidecar_scfg_aes_gcm.py] }
          - { id: canonical-propagation,
              sources: [mal_analyze/native_enrichment/finalize_findings.py,
                        server/analyst/**,
                        server/gateway/report_contract.py] }
```

解析器友好的具体序列化可能用单行子记录，但语义契约相同：

```js
{
  parent: 'sidecar-config-decryption',
  id: 'discovery-association',
  group: '发现与关联',
  sources: [
    'mal_analyze/sidecar/probe.py',
    'mal_analyze/sidecar/associations.py',
    'mal_analyze/sidecar/models.py',
  ],
}
```

## 稳定身份与物理路径

保持主题页物理扁平，以保留现有 manifest、serve 与轴假设。

- 父页：`theme/sidecar-config-decryption.md`
- 子页：`theme/sidecar-config-decryption--discovery-association.md`

规范子页 id 是 `<parent>--<child>`。两段都必须匹配现有主题 id 字符集，`--` 为本功能保留为父/子分隔符。

manifest 存显式结构，而非只从文件名推导：

```json
{
  "id": "sidecar-config-decryption--discovery-association",
  "axis": "theme",
  "kind": "deep",
  "parent": "sidecar-config-decryption",
  "group": "发现与关联",
  "sources": ["mal_analyze/sidecar/probe.py", "mal_analyze/sidecar/associations.py"]
}
```

显式元数据防止「碰巧含 `--` 的不相关主题 id」被误当成层级，并给壳、图谱与 MCP 一个稳定契约。

## 配置解析与校验

新增聚焦解析器，如 `parseConfigThemeDeep(configText)`。它返回有序父列表与有序子记录，不改 `parseConfigThemes`。

校验规则：

1. 每个父主题必须在 `axes.theme.values` 中恰好出现一次。
2. 子 id 在父内唯一；规范 `<parent>--<child>` id 在所有主题页间唯一。
3. 每个子至少有 1 条源条目。
4. 源条目是仓库相对的、斜杠归一化的路径，或受支持的 glob 模式。
5. 拒绝绝对路径、带盘符的路径、`..` 穿越、NUL 字符，以及解析后落在仓库之外的路径。
6. 字面源必须存在且是普通文件。
7. glob 必须至少匹配 1 个普通文件。零匹配是 `missing-source`，绝不当作新页。
8. 解析后的源去重并排序，保证指纹稳定；而配置里的子/分组顺序保持稳定用于展示。
9. 解析后落在仓库之外的符号链接或 junction 一律拒绝。
10. 一个子可以与其他子共享源。重叠是合法的，因为职责可能相交；工作列表必须报告它，而不是静默删掉。

配置错误累积为可执行的诊断，而不是在第一个坏子记录处崩溃。

## 源解析契约

创建共享的字面源与 glob 源解析器。其公开结果必须区分合法、缺失、非法与逃逸输入：

```js
resolveThemeDeepSources(repoRoot, entries)
// { status: 'ok', sourceFiles: ['path/to/file.js'] }
// { status: 'missing', entry, matches: [] }
// { status: 'invalid', entry, reason }
// { status: 'outside-repo', entry, resolvedPath }
```

所有返回路径用 `/` 分隔符。git pathspec、manifest 源、指纹、诊断与 Windows 测试消费同一份归一化列表。

目录 glob 不得穿越被忽略的元数据或生成的 wiki 产物，除非未来契约显式允许。至少 `.git/` 与 `.lore/` 要从 theme-deep 源展开中排除，避免自我陈旧。

## 同步规划

`planSync` 为每个合法子创建一个工作项：

```js
{
  axis: 'theme',
  id: 'sidecar-config-decryption--discovery-association',
  kind: 'deep',
  parent: 'sidecar-config-decryption',
  group: '发现与关联',
  sourceFiles: ['mal_analyze/sidecar/probe.py'],
  path: 'theme/sidecar-config-decryption--discovery-association.md',
  priorExists: true,
  stale: 3,
  reason: 'source-changed',
}
```

规划规则：

- `--all` 排队每个已配置的子。
- 配置合法但子页缺失时，以 `missing-page` 排队。
- 否则陈旧度 = 自该页 `code_sha` 以来、影响任一已解析源文件的提交数。
- 兄弟子的源文件都没变时，不排队。
- 非法配置产诊断，且不给该子产重写工作项。
- 父主题匹配仍由 journal 驱动。子源变更不强制鸟瞰页重写，除非父页在现有规则下独立陈旧。
- auto 模式把子页计入页数上限与质量门，恰好一次。

## 页面内容契约

主题深度页是机制级页面，不是第二个鸟瞰页。它遵循现有两级质量模型，必须包含：

- title 与 summary frontmatter；
- 清晰的职责边界；
- 输入与输出；
- 机制/数据流说明；
- 用 `symbol @ file` 的源码符号锚点；
- 失败与边界情形行为；
- 指向父页与相关子页的交叉链接；
- 不手工物化 Decision history 节。

父鸟瞰页按分组/顺序列出全部已配置子页。子必须链回父页。lint 在所有页可用后双向检查。

后端 prompt 收到有边界的 `sourceFiles` 列表，并被指示不得泛化到该源集合之外。大多源集合仍受现有上下文与超时预算约束；配置应偏好内聚职责，而非整仓 glob。

## 收尾与陈旧度

`finalizeSync` 把每个合法子加入 `staleScopes`：

```js
staleScopes['theme/sidecar-config-decryption--discovery-association.md'] = [
  'mal_analyze/sidecar/probe.py',
  'mal_analyze/sidecar/associations.py',
  'mal_analyze/sidecar/models.py',
];
```

规划、页 frontmatter/manifest 元数据与 finalize 后陈旧计算用同一份已解析列表。禁止各层独立重解析，否则路径或 glob 漂移会制造矛盾的「新鲜度」状态。

子页 `code_sha` 只在通过正常写入与质量门后推进。失败的重写保持陈旧，并保留最后一个合法页。

## Manifest、导航、图谱与 MCP

### Manifest

给页条目扩展可选的 `kind`、`parent`、`sources`，以及现有的 `group`。普通页省略这些字段，现有快照保持稳定。

### INDEX 与壳

Theme 节在每个鸟瞰页顶层展示，已配置的子页按其下分组/顺序排列。子不得同时作为无关的顶层主题条目出现。

从配置移除一个子，会使现有子页变成孤儿。finalize 必须报告该孤儿，并应用实现期选择的一个显式策略：

- 首选：仅当 manifest 元数据证明它是受管理的 theme-deep 页时才删除生成的页；
- 可接受兜底：保留文件但排除出导航，并在显式清理前使 lint 失败。

正常导航中不允许静默保留孤儿。

### 图谱

加一条从父页到子页的结构边。用一个稳定类型，优先 `contains`；反向遍历经 neighbors 天然可用。现有 wiki 引用保持独立的 `refs_related` 边。

### MCP

`lore_page` 可用规范 id 读子页。`lore_neighbors` 在父页上通过结构边返回子页，在子页上返回其父页。`lore_ask` 正常索引子页节，并在已返回页元数据处附带 parent/kind 元数据。

## Lint 与失败诊断

新增诊断：

- `theme-deep-parent-missing`
- `theme-deep-id-collision`
- `theme-deep-sources-empty`
- `theme-deep-source-invalid`
- `theme-deep-source-missing`
- `theme-deep-source-outside-repo`
- `theme-deep-page-missing`
- `theme-deep-parent-link-missing`
- `theme-deep-child-link-missing`
- `theme-deep-mechanism-missing`
- `theme-deep-orphan`

诊断包含父 id、子 id、原始源条目、安全处归一化候选，以及直接补救建议。不得打印任意文件内容。

## 向后兼容

兼容性是硬门：

1. 无 `axes.theme.deep` 时，`planSync`、finalize 产物、manifest JSON、图谱 JSON、INDEX 排序、壳导航、lint 输出与 MCP 行为保持不变。
2. 现有 `axes.component.deep` 的 flat/分组/pin 语法与语义保持不变。
3. 未选择启用子页的现有主题页 id 仍是顶层页。
4. 现有消费者容忍新增的可选 manifest 字段。
5. 迁移不自动注入 `theme.deep` 块；可选地单独考虑注释掉的脚手架。

## 安全与资源边界

- 在符号链接/junction 解析后，把全部源条目解析到仓库根之下。
- 限制每父子页数、每子配置源条目数、每 glob 展开文件数、每同步计划总展开文件数。
- 不静默拒绝或截断。预算超限是配置诊断。
- 配置解析与 lint 路径校验期间绝不读匹配到的源内容。
- 后端重写保留现有只读工具限制与 token 态 journal 行为。
- 宽 glob 经默认遍历不得包含 `.lore`、`.git`、依赖缓存或产物目录。

精确上限应为具名常量，实现期由边界测试覆盖。

## 测试策略

### 配置解析器

- 单父 + 平铺子。
- 分组子保留分组与顺序。
- 多父保持隔离。
- 缺父、重复子、规范 id 碰撞、空 sources、畸形记录、无块。
- 现有 `parseConfigThemes` fixtures 不变。

### 源解析

- 字面文件与 glob 解析为稳定的斜杠归一化路径。
- 重复与重叠匹配确定性去重。
- 缺失字面/glob、绝对路径、盘符路径、穿越、仓库外符号链接/junction、预算溢出都失败关闭。
- Windows 与 Linux 路径 fixtures 产等价逻辑输出。

### 同步规划与收尾

- 缺页排队 1 个子。
- 改 1 个源只排队关联子。
- 共享源排队每个声明它的子。
- 无关源变更不使子陈旧。
- `--all` 与 auto 页预算包含子。
- 规划与收尾的 `staleScopes` 用完全相同的源列表。
- 失败重写保留旧页与陈旧状态。

### Manifest、INDEX、图谱、壳与 MCP

- 仅 theme deep 页发出可选子元数据。
- INDEX/侧栏把子嵌到父下，遵循分组/顺序。
- 父/子结构图谱边两个遍历方向都可用。
- MCP 能读并导航子。
- 孤儿策略确定且可测。

### Lint 与内容质量

- 缺机制节、缺父/子链接、缺页、非法源与孤儿诊断。
- 不错误要求鸟瞰页满足深度页机制 lint。
- 组件深度页 lint 保持不变。

### 向后兼容

用无 `theme.deep` 的 fixtures 跑现有 parser、sync、manifest、graph、lint、serve、portal、runner 与 MCP 套件；快照与行为必须保持不变。

## 验收标准

满足以下条件才视为完成：

1. 一个 fixture 主题能声明至少两个分组的多源子。
2. 改一个源精确排队受影响的子。
3. plan、finalize、manifest、graph、INDEX、壳、lint 与 MCP 在子身份、父、分组与源集合上一致。
4. 负面路径与孤儿情形以可执行诊断失败。
5. Windows 与 Linux 测试在归一化源身份上一致。
6. 无 `theme.deep` 的仓库保留此前产物并全过现有套件。
7. 真实 `mal-analyze-cli` Sidecar 配置能生成一个鸟瞰页加四个职责向深度页，且不把它们当组件单源页处理。

## 实现交接

实现会话应以本文档为需求源，然后另建详细计划。在分配任务前，必须检查最新的 `lib/config.js`、`lib/source.js`、`lib/sync.js`、`lib/manifest.js`、`lib/graph.js`、`lib/lint.js`、站点导航、MCP handlers 及其测试——当前 Lore worktree 含活跃的 deep-source-disambiguation 改动，可能改变共享的源解析契约。

## Amendments（2026-08-06）

设计评审闭合了八个缺口。下列已批准的决议修订上述章节；与上文冲突处以 amendments 为准。

### 1. 子页决策史：源级过滤

theme-deep 子页的 Decision history 从父主题的 journal 原子物化，过滤出「commit 触达过该子已解析源文件」的原子：

```js
parentAtoms = allAtoms.filter(a => a.facets?.theme?.includes(parent));
childAtoms = parentAtoms.filter(a => (a.refs?.files ?? []).some(f => childSources.includes(f)));
```

`atoms`/`commits` frontmatter 计数等于过滤后集合。空结果机械物化现有「暂无 journal 原子」占位。手工 note 原子（无 `refs.files`）按构造排除。

此方案无需新增任何 git 调用：挖掘出的原子本就携带 `refs.files`（mine 时取自 `git log --name-only`），过滤消费的正是与规划/finalize 相同的已解析源列表——不重解析。已知局限：`--name-only` 反映每个提交当时的路径，文件改名前的老提交不匹配。v1 接受。

### 2. `parseConfigDocsAxis` 框定到 `axes.docs` 块

theme-deep 块引入了 `sources:` 键，现有 `parseConfigDocsAxis` 的首个匹配正则会被劫持（多行子记录的 `sources:` 行命中）。修复：先定位 `axes:` 下的 `docs:` 子块，只在块内匹配 `sources:`/`docs_glob:`——与 `parseConfigLanguage` 同款块级作用域纪律。更新 `lib/config.js` 里「无其他块用 sources:」的假设注释。

子记录序列化为规范单行形 `- { id: ..., sources: [a, b] }`（行首 `- {`，永不命中 docs 信号）。解析器仍容忍多行。回归测试：theme-deep 块排在 `axes.docs` 前（或无 docs 块）→ docs 轴正确或不存在。

### 3. glob 展开用 git pathspec，不用 JS glob 库

零依赖的 lore 没有 glob 库。配置 glob 用一次 git 调用展开：

```
git ls-files --cached --others --exclude-standard ':(glob)<pattern>'
```

gitignore 感知天然免费：被忽略的 `.lore`/`.git`/依赖缓存由 git 自己排除，与现有 `execFileSync('git')` 模式一致。字面源保持 fs 存在性（校验规则 6），可含未跟踪文件；glob 走 git（源树必被跟踪，且陈旧度本就是 git 驱动）。非 git 仓库把 glob 解析为 `invalid`。既有预算上限（每 glob 文件数 / 每计划总数）仍是硬边界。

### 4. 历史 `--` 主题 id：非阻断警告

顶层主题 id 含 `--` 时发出信息性 `theme-id-reserved-separator`（不影响 lint `clean`，保住向后兼容）。真实规范 id 碰撞仍是硬诊断 `theme-deep-id-collision`（校验规则 2）；补救是改名旧主题或换子 id。

### 5. 孤儿策略拍板

采用首选策略：仅当 manifest 条目证明 `kind: 'deep'` + `parent` 才删除生成页——并连同翻译 sidecar（`<child>.<lang>.md`）一并删。手写页恰好占用子页路径 → 保留、排除出导航、lint 失败，直到显式清理。指纹 GC 已天然丢弃被删页。

### 6. 新增 lint 诊断

在诊断清单追加：

- `theme-deep-diagram-missing`——子页缺 mermaid 架构图。子页是机制级并要求架构图，对齐组件深度页；鸟瞰页豁免。复用 `lintMissingDiagram` 模板。本条同时修订「页面内容契约」，把 mermaid 架构图纳入必须项。
- `theme-id-reserved-separator`——信息性、非阻断（见第 4 节）。

### 7. 一致性修正

- 解析器词汇：在 `lib/source.js` 注明 `resolveThemeDeepSources`（ok/missing/invalid/outside-repo）与 `resolveDeepSource`（ok/missing/ambiguous）互补；输入域不同，错误形状纪律共享。
- 同步规划：父主题鸟瞰页当下无条件排队（主题页恒入 worklist），故原文「除非父页独立陈旧」表述修正为：父重写节奏不变（恒排队）；子陈旧度独立按源计算，互不驱动。

### 8. 测试与验收补充

测试：
- docs 解析器回归：theme-deep 块在 `axes.docs` 前，或无 docs 块。
- glob：gitignore 感知展开；`.lore`/`.git` 排除；预算超限失败。
- 子决策史：源级过滤，含空结果。
- 孤儿：受管子页确定性删除；手写页保留 + lint 失败 + 排除出导航。
- `theme-id-reserved-separator` 不影响 `clean`。
- 子页缺图诊断。

验收：
- 含 `theme.deep` 块的 fixture 使 docs 轴行为不变。
- 子页决策史严格按源过滤。
