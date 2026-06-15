# 活 wiki 缺口修复（A 常驻 + C stale 动作化 + B 工单扩轴）

> 2026-06-12 · 来源：threat-intel 真实使用四问诊断（portal 端口被占/theme 死局 stale 63/python 缓存旧页/自动链断电）。
> 用户拍板范围 A+C+B；D（标准升级工单）/E（ask-miss 质量环）做完再议。

## 诊断结论（实证）

- 7842 被单仓库 python serve 占位（threat-intel 稳定端口本是 7716，显式传了 7842）——总入口失联。
- python serve：无控制 API、无 ticker（auto 档形同虚设）、无 Cache-Control（浏览器启发式缓存旧页）。`probeRuntime` 默认 python 优先——但 serve.js 本身就是 node 跑的，**python 兜底永远不该是默认**。
- `runner.js:102` `filter(w => w.axis === 'component')`——theme/flow/HOME 永远不会被自动重写；threat-intel 的 theme/ioc 与 HOME stale=63 是死局。
- 壳 stale 徽标文案「跑 /lore:sync」误导：机械 finalize 不清 stale，清 stale 唯一途径是 LLM 重写该页。
- 质量门哨兵检查只认 `LORE_JOURNAL`——HOME 页（`LORE_HOME_STATUS` 哨兵）合法重写会被误杀（扩轴前置 bug）。
- 重启后无任何常驻：portal 不自启 → ticker 不在 → 整条自动链断电。

## 决策

1. **A1 serve 默认 node**：`probeRuntime` 翻转——默认 node；python 仅显式 `--python` 旗标 opt-in（保留路径以防无 node 远程目录场景，但不再是任何隐式选择）。`--node` 旗标保留为 no-op 兼容。
2. **A2 portal 开机自启**：`node lib/portal.js autostart on|off`——win32 写/删 Startup 文件夹 `lore-portal.vbs`（`WScript.Shell.Run "node ""<abs portal.js>"" start", 0, False`，隐藏窗口；portal start 本身幂等）。非 win32 → 打印 cron/launchd 手动指引（YAGNI 不实现）。`/lore:portal` 命令文档补 autostart 用法。
3. **C stale 徽标动作化**：[shell.mjs:136](site/shell.mjs:136) 徽标改为可点击——点击 POST 既有 rewrite-request API（复用控制台排队函数），文案「落后 N commits · 点击排队重写」→ 点击后「已排队 ✍（auto 档后台消化；或会话跑 /lore:sync）」。API 不可用（静态服务）时保持现状降级（不可点 + 原文案）。
4. **B1 质量门哨兵按页分支**：`qualityGate(newText, oldText, page?)`——`page.path === 'HOME.md'` 时检查 `{{LORE_HOME_STATUS}}` token 或 `LORE_HOME_STATUS:START` 哨兵；其余页保持 JOURNAL 检查。向后兼容（第三参可省）。
5. **B2 runner 工单扩轴**：runAuto 工单 = rewrite 队列置顶（任意轴）→ component（指纹增量，原序）→ **非 component（HOME/theme/flow）按 manifest stale ≥ 阈值过滤、stale 降序**→ 去重截 `max_pages`。阈值 `auto.stale_threshold` 进 syncstate config（默认 15；非 component 页 stale 是全仓 commit 口径，每 commit 都 >0，无阈值会每轮重写浪费 LLM）。stale 值从 `.manifest.json` 读（planSync worklist 的非 component 项无 stale 字段）。
6. **B3 rewritePage prompt 按 axis 分支**：component=现两档标准 prompt；theme=「横切主线 Current state：当前状态/约束/为什么重要」；flow=「端到端路径：mermaid 数据流图 + 各阶段组件」；HOME=「认知入口：一句话定位 + HOME_STATUS 哨兵原位 + Knowledge flow 图 + 理解/排障/决策三导航节」。各 prompt 都强调：哨兵/token 原位保留、只输出整页 markdown。
7. **顺带修**：threat-intel 切 auto 档放到验收步（用户已确认想体验全自动）。

## 不做（本轮）

- D 存量页标准升级工单、E ask-miss 质量环（ROADMAP 记录，下轮议）。
- 非 win32 自启实现。
- python runtime 移除（只降级为显式 opt-in）。

## 测试要点

- probeRuntime：默认 → node；`{python:true}` 且 canRun python → python；canRun 全假 → node。
- autostart：win32 假目录注入（APPDATA env 注入）→ on 写 vbs 含 portal.js 绝对路径 / off 删；幂等。
- qualityGate：HOME 页带 HOME_STATUS 哨兵 → 过；HOME 丢哨兵 → 拒；普通页行为不变（回归）。
- runAuto 扩轴：manifest 注入 stale（theme 20/HOME 5/flow 16）+ 阈值 15 → 工单含 theme、flow 不含 HOME；component 仍优先；max_pages 截断；prompt 按轴分支（fake backend 断言收到的 prompt 关键词）。
- 壳：buildConsoleModel/徽标纯函数级断言（stale 徽标 kind 与点击 payload）。
