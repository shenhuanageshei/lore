<!-- LORE_RESIDENT:START -->
## lore wiki（本仓库的活文档）

本 repo 由 lore 维护多轴 wiki（83 页 · 8 个组件深度页 · 最后更新 2026-06-14）。
**理解架构/查模块/查决策时，先用 wiki 建框架、再按锚点下钻源码——别一上来全文 grep。**
- **建框架**：`lore_ask "<关键词>"`（返回命中节切片，含内容）→ `lore_page view=agent`（跳概览+决策史，只看机制骨架，省约 60% token）。无 MCP 时跑 `node <lore>/lib/ask.js .lore "<关键词>"` 或读 `.lore/wiki/INDEX.md` 定位。
- **精准下钻**：wiki 页内锚点写作 `func @ file`——顺锚点直接 Read 那个函数/文件，不要全文 grep（wiki 是带导航的源码地图）。
- **查「为什么/决策史/踩坑」**：`lore_page section="Decision history"`（决策史只有 wiki 有，源码注释和 git log 都查不动）。
- wiki 缺失（fresh clone：wiki 不进库）→ 先跑 `/lore:sync` 合成。
<!-- LORE_RESIDENT:END -->

## 踩坑记录

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
