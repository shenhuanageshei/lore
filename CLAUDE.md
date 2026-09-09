<!-- LORE_RESIDENT:START -->
## lore wiki（本仓库的活文档）

本 repo 由 lore 维护多轴 wiki（96 页 · 8 个组件深度页 · 最后更新 2026-09-09）。
**理解架构/查模块/查决策时，先用 wiki 建框架、再按锚点下钻源码——别一上来全文 grep。**
- **建框架**：`lore_ask "<关键词>"`（返回命中节切片，含内容）→ `lore_page view=agent`（跳概览+决策史，只看机制骨架，省约 60% token）。无 MCP 时跑 `node <lore>/lib/ask.js .lore "<关键词>"` 或读 `.lore/wiki/INDEX.md` 定位。
- **精准下钻**：wiki 页内锚点写作 `func @ file`——顺锚点直接 Read 那个函数/文件，不要全文 grep（wiki 是带导航的源码地图）。
- **查「为什么/决策史/踩坑」**：`lore_page section="Decision history"`（决策史只有 wiki 有，源码注释和 git log 都查不动）。
- wiki 缺失（fresh clone：wiki 不进库）→ 先跑 `/lore:sync` 合成。
<!-- LORE_RESIDENT:END -->

## 踩坑记录

**问题**：runner 重写页面 LLM 调 Write 工具而非输出 stdout——`--allowedTools Read,Grep,Glob` 拒绝后 stdout 只剩 "awaiting permission" 消息，质量门 `frontmatter missing title/summary` 全挂（analyst/theme/flow 100% 失败，仅个别偶然输出格式正确的页面幸存）。
**修复**：`--disallowedTools Write,Edit,Bash` 显式封杀 + prompt TAIL 强制指令「绝不调用写盘工具」。
**预防**：runner 的 claude 调用必须同时设 allowedTools（白名单）和 disallowedTools（显式封杀 Write/Edit/Bash）——`--allowedTools` 只声明允许列表，不保证 LLM 不尝试其他工具（非交互模式下工具调用失败 ≠ 不调用）。

**问题**：runner 让 LLM 回吐整页导致 3/5 页 600s 超时，且 token 态新页 vs 物化态旧页比长度被防截断误杀（96K vs 5K 被拒）——决策史物化哨兵区可达 95K。
**修复**：重写一律 token 态（prompt 要求输出单行 `{{LORE_JOURNAL}}`，finalize 重新物化）；质量门防截断比较前两边剥哨兵区归一。
**预防**：物化哨兵区绝不过 LLM 往返——任何让模型搬运物化区的指令都是性能与正确性双杀。

**问题**：auto 档 ticker 触发的 runner 每页 20s 后非零退出（`claude exit: Command failed`），同样调用在正常 shell 里成功。
**修复**：portal 改用 detached 方式启动（`node lib/portal.js start` 或开机自启），不用 IDE preview 面板托管。
**预防**：ticker/runner 宿主必须是正常 shell 起的进程——preview 托管进程的环境里 claude CLI 起不来。

**问题**：失败页留在重写队列 → 队列时间戳恒旧 → ticker 每分钟重启一整轮失败 run（实测 5 分钟 3 轮重试风暴）。
**修复**：`shouldRunAuto` 加轮间冷却——上次 run 距今 < debounce 一律不触发。
**预防**：冷却闸是防风暴的唯一屏障，重构时删它必复发。

**问题**：python 静态 serve 当默认运行时——控制台全灰（无 API）、auto 档失效（无 ticker 宿主）、浏览器一直显示旧页（无 Cache-Control，启发式缓存）。
**修复**：serve 默认 node，python 降为显式 `--python` opt-in 并打警告。
**预防**：serve.js 本身就在 node 里跑，「没有 node」的兜底场景不存在——残缺运行时永远不该是隐式默认。

**问题**：runner 失败原因只记 `err.message` 前 80 字符——那只是命令行回显，真实错误全被截掉，诊断零信息。
**修复**：失败 reason 优先取 stderr，截 300 字符。
**预防**：子进程错误诊断抓 stderr，`err.message` 不含退出原因。

**问题**：壳 stale 徽标点击无反应且无报错——事件绑定选择器写了 `#content button[...]`，而 chips 实际渲染在 `#meta` 容器。
**修复**：选择器改 `#meta button[data-queue-page]`。
**预防**：壳的页面元数据徽标住 `#meta` 不在 `#content`，绑事件先确认容器。

**问题**：重写后的 wiki 页浏览器顽固显示旧内容，且 server 端 curl 已证实是新版——疑似缓存但响应头已设 `no-cache`。
**修复**：`no-cache` ≠ `no-store`——无验证器（Last-Modified/ETag）时浏览器对 SPA fetch 仍吃 disk cache；serveStatic 改发 `no-store` 彻底不缓存（127.0.0.1 重下零体感）。
**预防**：本地工具的动态内容（wiki md / manifest / shell.mjs）用 `no-store` 不用 `no-cache`，别留缓存歧义——否则「server 是新的、用户看到旧的」会反复甩锅缓存却治不了。

**问题**：auto 档表面亮着、底下永不重写——机器重启后旧 runner 的 pid 被别的进程复用，而 runner.pid 只存裸 pid，`isAlive` 误判 true，ticker 永以为「runner 在跑」不再触发（实测 jpm 锁着已复用的 27064、auto-runs 却从没跑完一轮）。
**修复**：runner.pid 改存 `{pid, ts}`，`runnerAlive` 要求进程活 **且** pid 未超龄（`RUNNER_STALE_MS`）；旧格式无 ts 自动判过期，开机自愈。
**预防**：拿进程存活当互斥锁必带时间戳兜底——pid 会复用（重启后尤甚），`isAlive(pid)` 只答「这号有进程」、不答「还是我那个」。

**问题**：约一半 component 页 auto 重写撞 600s timeout 永过不去（与上「回吐物化区」不同根因：这次是 token 态下纯读源码慢）——成功的 scripts.md 就吃 492s（上限 82%），autoload 实测需 625s，卡在 600s 外侧 25 秒、连续两轮被砍。
**修复**：per-page timeout 600→1200s（正常 ~500s 的 2.4x 冗余）；`RUNNER_STALE_MS` 90→180min 联动，否则长轮被误判死 pid、ticker 双开 runner。
**预防**：单页重写耗时由「读多少源码」定、不由页大小（最小的 art.md 反最慢）；timeout 给正常耗时留 2-3x 冗余别卡中位数。改 per-page timeout 必同步抬 stale 上限。

**问题**：serve.test.js `start is idempotent` 在全量并行 `node --test test/*.test.js` 下偶发失败（a.pid≠b.pid / reused≠true），单跑 serve.test.js 稳定。根因：`start` 就绪探测 `waitForPort` 只验「端口上有人监听」、不验「是我 spawn 的子进程活着」。并行时大量 sibling 测试 `listen(0)` 抢临时端口（server.test.js 一家就 22 处），`findPort(0)` 探到端口→子进程 bind 之间的 TOCTOU 窗口里端口被抢，子进程 EADDRINUSE 崩溃（server.js 的 listen 无 error handler），`waitForPort` 却连到抢占者 → 误判就绪 → start 返回已死 pid → 下次 start 见死 pid 不复用、重启。
**修复**：就绪探测改 child-aware `waitForServer`（ready/died/timeout：连上后还 `isAlive(child.pid)` 确认是自己的子进程）；输掉端口竞争（died）换新端口有界重试（`START_ATTEMPTS=3`）；alive-but-never-bound（timeout）不重试、保留 `/did not bind/` 语义。竞态靠并行撞运气复现不了（实测 lean 子集 30 轮 0 复现），用注入「死子进程+端口被占」确定性测。
**预防**：起子进程 server 的就绪判定必须验「我的子进程在监听」、不能只验「端口有人应答」——临时端口（port:0）在并行/高负载下会被别的进程抢，纯端口 ping 分不清自己的子进程和抢占者（同 runner.pid「`isAlive` 只答这号有进程、不答还是我那个」一脉）。
