# lore docs 轴 + 呈现质量升级

> 2026-06-13 · 来源：threat-intel 真实使用连环暴露（docs 一篇没收 → 手改 glob 全堆一组 → 元文档找不到/没收 → theme 页大段难读）。

## 问题（4 个相互关联的引擎缺陷）

1. **docs 自动发现缺失**：`init` 探测代码目录（`discoverComponents` 找到 `threat-intel/m1_crawler`），却从不探测文档目录——`docs_glob` 硬编码默认 `docs/**/*.md`。任何「代码/文档在子目录」的项目，docs 轴开箱即空（threat-intel 74 篇文档全在 `threat-intel/docs/`，默认 glob 指根 `docs/` 不存在，一篇没收，手改 glob 才进）。
2. **分组不通用**：`docGroup` 只认 lore 自己的 `docs/superpowers/specs|plans` 路径，别的项目全落默认「项目状态」一组（threat-intel 85 页堆成一坨，specs/plans/debugging/api 无区分）。
3. **元文档没区分、没收全**：changelog/readme/roadmap/pitfalls 这类「项目元文档」该跟设计文档（specs/plans）分开、独立置顶；且 `changelogExtractor` 只读 `repoRoot/CHANGELOG.md`，threat-intel 的 CHANGELOG/README 在子目录 `threat-intel/`，根本没收（用户「找不到」的直接原因）。
4. **theme/flow 排版差**：theme 页是「单档一大段密集文字」（accuracy 4 个加粗「第N层」挤一坨，无小标题/列表/表格），缺 component 两档那种视觉分层——根因是 theme/flow 写作标准没要求分层。

## 决策（用户拍板 2026-06-13）

- docs 自动发现做成**引擎特性**（不是 threat-intel 一次性手调）。
- docs **全收**（含 plans/debugging 过程性文档）。
- 元文档**独立成组、置顶**，跟设计文档区分。
- theme/flow 页要**分层排版**（杜绝大段密集文字）。

## 设计

### A. docs 自动发现（init）

新 `discoverDocs(repoRoot) → { docsGlobs: [...], metaDocs: [...] }`：
- **文档目录**：遍历找含 ≥3 个 `.md` 的目录，排除 `node_modules / .git / .lore / dist / build / out / target / venv / .venv / __pycache__ / .pytest_cache / .claude` 与点目录；取最浅公共祖先。threat-intel → `threat-intel/docs`。多个不相交文档根 → 多个 glob。
- **元文档**：在 repoRoot **及 code_roots 公共前缀子目录**（threat-intel/）找 `CHANGELOG.md / README.md / ROADMAP.md`（大小写无关），记录实际路径。
- `init` 把探测结果写进 `config.yml`：`docs_glob`（自动发现的目录）+ `sources` 自动含 `changelog / readme / roadmap`（探测到才加）。已有 config 不覆盖（迁移：缺 docs_glob/sources 才补，走 migrate.js 一次性补块语义）。

### B. docGroup 通用化 + 元文档独立组

```
元文档（changelog/readme/roadmap/pitfalls，不论路径）→ '项目状态'
语义子目录段（取 sourcePath 任一路径段，大小写无关）：
  specs/spec/design → '设计'    plans/plan → '计划'
  debugging/debug   → '调试'    api → '接口'
  architecture/arch → '架构'    notes/note → '笔记'
其余 → '其它'
```
兼容 lore 自己：`superpowers/specs` → 设计、`superpowers/plans` → 计划（从合并的「设计与计划」拆为两组），changelog/pitfalls → 项目状态。lore dogfood + docs.test 回归更新。

### C. 元文档收录（子目录适配）

- `changelogExtractor(repoRoot, baseDir)`：在 repoRoot 与探测到的项目子目录找 CHANGELOG，找到第一个为准。
- 新增 `readmeExtractor` / `roadmapExtractor`（README 取首段为 summary、按 `##` 切节；ROADMAP 同 changelog 风格）。
- `EXTRACTORS` 注册 `readme` / `roadmap`；config sources 声明才提取（B 的 docGroup 保证它们落「项目状态」）。

### D. GROUP_RANK 适配（manifest.js）

`{ '项目状态':0, '设计':1, '计划':2, '架构':3, '接口':4, '调试':5, '笔记':6, '其它':7 }`（元文档置顶，其余垫底 99）。

### E. theme/flow 排版标准

- `axisPrompt`（runner）+ `commands/sync.md`：theme「Current state」、flow「End-to-end path」要求**用 `###` 小标题分层** + 列表/表格承载枚举，**避免连续 >150 字大段**；component 两档标准不变。
- 不做机械门校验（引导式标准，质量门不拦排版）——避免误杀。

## dogfood

- threat-intel：`init` 重探测 docs（自动发现 `threat-intel/docs` + 元文档）→ config 补 docs_glob/sources → finalize 重分组（specs/plans/debugging/api/架构 + 项目状态置顶）→ theme 4 页 + flow 3 页按 E 重排。
- lore 自己：docGroup 通用化后分组回归（设计/计划拆组），dogfood 重 finalize。

## 测试要点

- `discoverDocs`：threat-intel 式结构（代码+文档在子目录）探测出 `threat-intel/docs` + 子目录 CHANGELOG/README；排除 node_modules/.build/worktrees/dist。
- `docGroup`：各语义段 + 元文档 + lore 兼容（superpowers/specs→设计）+ 未知→其它。
- `changelogExtractor` 子目录：threat-intel/CHANGELOG 收到；readme/roadmap extractor。
- `GROUP_RANK` 顺序：项目状态置顶。
- init 集成：自动发现写 config（缺则补、有则不覆盖）。

## 不做（YAGNI）

- 自动发现的人工确认 UI（探测即写，错了用户改 config）。
- theme 排版强制校验（标准引导，非机械门）。
- 多语言文档目录探测（按现有 i18n 路径约定）。

## 实施顺序提示（给 plan）

T1 discoverDocs（探测+排除）→ T2 docGroup 通用化 + GROUP_RANK → T3 元文档 extractor 子目录适配 + readme/roadmap → T4 init 接线（写 config，迁移补块）→ T5 axisPrompt/sync.md 排版标准 → T6 dogfood（threat-intel 重发现+重分组+theme/flow 重排；lore 回归）+ 全量。
