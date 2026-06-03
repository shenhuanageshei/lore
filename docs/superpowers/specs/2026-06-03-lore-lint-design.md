# /lore:lint — 只读漂移报告（§5）

> 设计文档 · 2026-06-03 · 子项目 **/lore:lint v1（stale + orphan + missing）** · brainstorm 收敛
> 母 spec §5（lint）。前置：sync（页 + manifest）· init（config code_roots）· mine/note/hook（journal）全已合并。

## 0. 背景
§5：「检测/修复分离 —— hook 保 journal 鲜活；lint 报 synthesized wiki 落后；sync 修复」。lint = 只读漂移清单，不自动改。

## 1. 范围（用户拍板 A）
- `lib/lint.js`：确定性只读检查 + CLI。`commands/lore-lint.md`。
- 小改 `lib/manifest.js`：`export` 现有 `gitCurrentSha` + `makeCountCommitsSince`（lint 复用 → stale 与 serve manifest **同源**）。
- v1 三检（确定性、现在有意义）：
  1. **stale**：页 `code_sha` ≠ 当前 HEAD → 落后 N commits。
  2. **orphan**：component 页 id ∉ config code_roots 末段集（root 改名/删）。
  3. **missing**：code_root 末段 ∉ 页 id 集（加了 root 没 sync）。
**推迟**：未打标原子（flow/theme 未建→全缺→误报）· AMBIGUOUS facet（无产出）· 矛盾（轻 LLM）· 自动修复 · exit-非零 gating。

**核心**：只读——只读 config/wiki/git，**不写任何东西**（连 .lore 都不写）。

## 2. 模块 API（锁定）
```
// lib/manifest.js（加 export，不改逻辑）
export gitCurrentSha(repoRoot) -> string         // 短 sha，非 git 抛
export makeCountCommitsSince(repoRoot) -> (sha)=>number

// lib/lint.js
lintOrphans(pageIds, codeRoots) -> string[]       // 纯：页 id 不在 code_roots 末段集
lintMissing(pageIds, codeRoots) -> string[]       // 纯：code_root 末段不在页 id 集
lintStale(pages, currentSha, countSince) -> [{page, code_sha, behind}]   // 纯：pages=[{id,code_sha}]
lint({loreDir}) -> { stale, orphans, missing, clean }   // 编排：读 config/wiki/git
```
内部：`componentPages(wikiDir) -> [{id, code_sha}]`（读 `wiki/component/*.md` front-matter via `parseFrontmatter`）。

## 3. CLI / 行为
`node lib/lint.js <loreDir>`：
- 读 config code_roots（`parseConfigCodeRoots`，缺→[]）；读 component 页 front-matter；git currentSha/countSince（非 git → 跳 stale）。
- 打印分组报告：`stale (N): <page> (behind M)` · `orphans (N): <page>` · `missing (N): <component> → /lore:sync` · 全空 → `✓ clean`。
- **exit 0 always**（只读咨询；检测≠修复）。
- 无 wiki/config → 优雅（空报告 + 提示先 init/sync）。

## 4. 测试（确定性 node:test）
- `lintOrphans`/`lintMissing`：表驱动（页 id × code_roots 末段，含 `src/pkg`→`pkg`）。
- `lintStale`：pages 含旧 code_sha + 当前 sha → behind=countSince（注入桩 countSince）；code_sha 空/等于当前 → 不报。
- `lint` 编排：git temp repo + 写几页（旧 sha + 当前 sha）+ config（含/缺 root）→ 断言 stale/orphan/missing/clean。
- CLI：跑 → 打印报告 + exit 0；clean repo → `✓ clean`。
- 集成：init→（写页）→sync→改代码再 commit（HEAD 前移）→lint 报该页 stale（behind≥1）。
- manifest export：`gitCurrentSha`/`makeCountCommitsSince` 可 import + 行为不变（manifest 测不回归）。

## 5. 验收
1. stale 准（页 code_sha 落后当前 → behind N，与 manifest stale 同源逻辑）。
2. orphan/missing 准（页↔code_root 双向差集）。
3. 只读：lint 后 `git status` 对 wiki/源码/.lore 0 改动。
4. exit 0；clean repo 报 clean。
5. 零依赖；复用 manifest git helper + parseFrontmatter + config。

## 6. 不在范围
未打标/AMBIGUOUS/矛盾检查 · 自动修复 · exit-非零 · journal 原子 lint（v1 只 lint wiki 页 vs 代码/config）。

## 7. 开放问题
- **stale 阈值**：v1 任何 behind≥1 即报。未来可加阈值（behind≥N 才报）。
- **exit 码**：v1 exit 0（咨询）。CI gating（exit 1 on drift）留 flag/未来。
