// server.js
import http from 'node:http';
import { appendFileSync, createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { translationSourceHash } from './lib/i18n.js';
import { readSyncMode, writeSyncMode, writeSyncConfig, appendRewriteRequest, readRewriteRequests,
  readSyncConfig, readBudgetConfig, runnerAlive, readAutoRuns, readAutoPending, clearAutoPending } from './lib/syncstate.js';
import { budgetStatus, versionStamp } from './lib/cost.js';
import { fuelReadout } from './lib/doctor.js';
import { isAlive } from './lib/serve.js';
import { HumanStoreError, appendHuman, visitRecord } from './lib/human.js';

const LANG_RE = /^[a-z]{2}(?:-[A-Za-z0-9]+)?$/;
const HERE = dirname(fileURLToPath(import.meta.url));

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || '{}');
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value) + '\n');
  return true;   // handleApi 各分支 `return sendJson(...)` 即「已处理」——调用方据此停止后续路由
}

// Only accept the local-loopback Host header on write APIs — blocks DNS-rebinding
// (a remote page resolving a hostname to 127.0.0.1 to POST against this server).
function localHost(req) {
  const host = (req.headers.host || '').split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

// Resolve a wiki-relative page path, refusing anything that escapes <root>/wiki.
function safeWikiPage(root, rel) {
  if (!/^[A-Za-z0-9_./-]+\.md$/.test(rel)) return null;
  const full = normalize(join(root, 'wiki', rel));
  const wikiRoot = normalize(join(root, 'wiki'));
  if (full !== wikiRoot && full.startsWith(wikiRoot + sep)) return full;
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// Serve <root>/<rel> as a static file: traversal guard, dir→index.html, stream + MIME.
// Extracted so the per-repo server AND the portal share identical static semantics.
// reqPath = 原始请求 pathname（portal 下带 /<repo> 前缀）——目录无尾斜杠时 301 用它拼。
export function serveStatic(rootDir, rel, res, reqPath = '/' + rel) {
  const root = normalize(rootDir).replace(/[/\\]+$/, '');
  let full = normalize(join(root, rel));
  // traversal guard: resolved path must stay within root.
  // (full === root is reachable for a bare "" rel, which the dir→index step resolves.)
  if (full !== root && !full.startsWith(root + sep)) {
    res.writeHead(403); return res.end('forbidden');
  }
  let st;
  try { st = statSync(full); } catch { res.writeHead(404); return res.end('not found'); }
  // directory request → serve its index.html, mirroring python http.server.
  if (st.isDirectory()) {
    // 无尾斜杠先 301 补上（python http.server 同款）：文档 URL 不带斜杠时，
    // 浏览器把 ./shell.mjs 解析到上一级 → 404 → 整壳白屏。
    if (!reqPath.endsWith('/')) {
      res.writeHead(301, { location: reqPath + '/' });
      return res.end();
    }
    full = join(full, 'index.html');
    try { st = statSync(full); } catch { res.writeHead(404); return res.end('not found'); }
  }
  if (st.isDirectory()) { res.writeHead(404); return res.end('not found'); }

  const stream = createReadStream(full);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  // no-store：本地工具彻底不缓存。no-cache 无验证器（无 Last-Modified/ETag）时，
  // 浏览器对 SPA fetch 仍可能吃 disk cache → 显示旧 wiki 页 / 旧 shell.mjs（白屏）。
  // 127.0.0.1 毫秒级重下，零体感——用 no-store 根治，别留缓存歧义。
  res.writeHead(200, {
    'content-type': MIME[extname(full)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  stream.pipe(res);
}

const PORTAL_PORT = 7842;   // 与 lib/portal.js 固定端口一致
const slashLower = p => normalize(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// 全部本地 API 的共享处理器：per-repo server 直挂根路径；portal 剥 /<name> 前缀后按 repo 转发。
// 返回 true = 已响应；false = 非 API 路径（调用方继续静态/404）。
// Local write APIs (only reachable on 127.0.0.1). Scoped to <root>/.state and
// a read of <root>/wiki; never write arbitrary paths.
//
// --- fuel 的短 TTL 缓存（审计 🟡#3 / 阶段 B 验收 8）---
// 为什么必须缓存：fuelReadout → captureReadout → gitWindow 会 **spawn 一次 `git log`**，
// 而 execFileSync 是同步的——每个 /api/sync/status 请求都会把事件循环卡住约 1 秒（实测 0.98/1.08/1.10s），
// 壳却每 15s 轮询一次 status，这个热路径花不起。
// 为什么 30s 的陈旧可以接受：fuel 的两个可变读数的最小变化粒度是「天」（days_since_capture）
// 与「提交数」（capture_pct = 窗口内 decision/commit）——30 秒的延迟不会把 38% 读成别的数，
// 只会在真实提交刚落地后晚 30 秒反映；换来的是轮询请求从 ~1s 降到毫秒级。
// 只做缓存：派生逻辑仍**唯一在 lib/doctor.js 的 fuelReadout**（D3），这里绝不重写一套口径，
// 缓存的就是那个函数的返回值本身（键名/取值原样，契约零改动）。
// 键是 (exec, repoRoot) 两段、与下方 VERSION_STAMP_CACHE 同构：fuel 同样**由某个 exec 口径派生**
// （fuelReadout → captureReadout → gitWindow 里那次 `git log` 走的就是这个 exec），
// 同一个目录换一个 exec（测试注入 stub、或将来接入别的 git 封装）就应该重算，
// 否则同一进程里两个 createServer（不同 exec stub、同 root）会互相读到对方口径的陈旧 fuel
// ——那正是隔壁函数明文拒绝的事，这里不能自相矛盾。生产里 exec 恒为 execFileSync（同一函数对象），
// WeakMap 按函数对象分桶，命中率不受影响。
const FUEL_CACHE_TTL_MS = 30_000;
const FUEL_CACHE = new WeakMap();   // exec → Map(repoRoot → { at, value })；portal 形态下每个 repo 各一条

function fuelCached(repoRoot, exec, ttlMs = FUEL_CACHE_TTL_MS, now = Date.now()) {
  let byRepo = FUEL_CACHE.get(exec);
  if (!byRepo) { byRepo = new Map(); FUEL_CACHE.set(exec, byRepo); }
  const key = resolve(repoRoot);
  const hit = byRepo.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = fuelReadout(key, { exec });
  byRepo.set(key, { at: now, value });
  // 惰性清过期项：只在这一条 key 被访问时顺带扫一遍——portal 的 repo 数是个位数，够用且无需定时器。
  for (const [k, v] of byRepo) if (now - v.at >= ttlMs) byRepo.delete(k);
  return value;
}

// --- 版本戳（预算窗口键）的短 TTL 缓存 ---
// 为什么必须缓存：budgetStatus → versionStamp（lib/cost.js:41）会 **spawn 一次 `git describe --tags`**，
// 同样是同步的 execFileSync。fuel 缓存命中后，这一条是 status 热路径上**唯一**剩余的 git 冷启动
// （实测单独 506/682ms，via budgetStatus 877ms），不消除就永远到不了毫秒级。
// 为什么选「只缓存版本戳」而不是「把整个 status 载荷一起缓存」（二选一里选更简的）：
//   ① 更简——status 载荷里 config / runner_running / last_finalize / used / exceeded 都是**便宜且会变**的
//      读数（各读一个 json / ndjson 文件），整载荷缓存会把它们一并冻住 30s：壳刚切的模式、刚跑起来的 runner
//      最长 30s 看不到，这是**语义降级**，不只是性能取舍；
//   ② 精度——贵的只有「派生」，所以只缓存派生结果（版本戳），其余每次照样现读，缓存面最小。
//   ③ 口径不动——缓存的是 lib/cost.js 的 versionStamp **本身的返回值**（D3：派生点唯一在 lib/cost.js），
//      这里只是把它当作 budgetStatus 的 `version` 入参注入（budgetStatus 签名本就支持 version 注入），
//      不重写任何预算口径、不改 budget 对象任何子字段。
// 为什么 30s 够（版本戳的变化粒度是「发版」= `git describe --tags`，比 fuel 的「天」还粗）：
//   发 tag 后 ≤30s 内，壳读到的可能是上一个版本的窗口键——可观察后果仅为「壳状态行的 used/exceeded 暂时按旧
//   窗口显示」；而**真正的闸本身不受影响**（lib/runner.js:87 每轮自算新鲜 versionStamp，不经过这个缓存），
//   且错报方向是保守（旧窗口条目只会让 used 更大，不会静默放行）。与 FUEL_CACHE_TTL_MS 同值，减少记忆负担。
// 为什么键是 (exec, repoRoot) 两段（FUEL_CACHE 同款同理由）：版本戳是**由某个 exec 口径派生的**，
//   缓存必须与口径绑定——同一个目录换一个 exec（测试注入 stub、或将来接入别的 git 封装）就应该重算，
//   否则会读到另一个口径的陈旧值。生产里 exec 恒为 execFileSync（同一函数对象），命中率不受影响。
const VERSION_STAMP_TTL_MS = 30_000;
const VERSION_STAMP_CACHE = new WeakMap();   // exec → Map(repoRoot → { at, value })；portal 形态下每个 repo 各一条

function versionStampCached(repoRoot, exec, ttlMs = VERSION_STAMP_TTL_MS, now = Date.now()) {
  let byRepo = VERSION_STAMP_CACHE.get(exec);
  if (!byRepo) { byRepo = new Map(); VERSION_STAMP_CACHE.set(exec, byRepo); }
  const key = resolve(repoRoot);
  const hit = byRepo.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = versionStamp(key, { exec });
  byRepo.set(key, { at: now, value });
  // 惰性清过期项：与 fuelCached 同款（portal 的 repo 数是个位数，无需定时器）。
  for (const [k, v] of byRepo) if (now - v.at >= ttlMs) byRepo.delete(k);
  return value;
}

export async function handleApi(root, req, res, pathname, { spawnFn = spawn, reposPath = join(homedir(), '.lore', 'repos.json'), exec = execFileSync, fuelTtlMs = FUEL_CACHE_TTL_MS, versionTtlMs = VERSION_STAMP_TTL_MS } = {}) {
    if (req.method === 'POST' && pathname.startsWith('/api/') && !localHost(req)) {
      sendJson(res, 403, { error: 'forbidden host' });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/preferences') {
      try {
        const body = await readJson(req);
        const lang = String(body.language ?? '');
        if (!LANG_RE.test(lang)) return sendJson(res, 400, { error: 'invalid language' });
        const out = join(root, '.state', 'preferences.json');
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, JSON.stringify({ language: lang }, null, 2) + '\n');
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { error: 'bad json' });
      }
    }

    if (req.method === 'POST' && pathname === '/api/translation-requests') {
      try {
        const body = await readJson(req);
        const page = String(body.page ?? '');
        const targetLang = String(body.target_lang ?? '');
        const wikiPage = safeWikiPage(root, page);
        if (!wikiPage || !LANG_RE.test(targetLang)) return sendJson(res, 400, { error: 'invalid request' });
        const text = readFileSync(wikiPage, 'utf8');
        const request = {
          ts: new Date().toISOString(),
          page,
          target_lang: targetLang,
          source_hash: translationSourceHash(text),
        };
        const out = join(root, '.state', 'translation-requests.ndjson');
        mkdirSync(dirname(out), { recursive: true });
        appendFileSync(out, JSON.stringify(request) + '\n');
        return sendJson(res, 200, { ok: true, request });
      } catch {
        return sendJson(res, 400, { error: 'bad request' });
      }
    }

    // --- S7 壳打开传感器（设计 2026-09-09 §7 / §4.4）：壳记 page-open，喂 ② 期再入简报与 wiki 健康度 ---
    // 记录形状与写入纪律的唯一真源在 lib/human.js（S4 存储层），这里只做「校验 → 追加」。
    // localHost 防护由上方统一 POST /api/* 闸门覆盖；page 沿用 safeWikiPage 白名单（仅 root/wiki 内的 .md）。
    if (req.method === 'POST' && pathname === '/api/human/visit') {
      let body;
      try { body = await readJson(req); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      const page = String(body.page ?? '');
      if (!safeWikiPage(root, page)) return sendJson(res, 400, { error: 'invalid page' });
      try {
        const r = appendHuman(root, 'visits', visitRecord({ page }));
        return sendJson(res, 200, { ok: true, page, deduped: r.deduped });
      } catch (e) {
        // 未 init（无 .lore）→ 明确报错（绝不静默写散文件）；壳侧 catch 掉即降级，阅读不受影响。
        if (e instanceof HumanStoreError) return sendJson(res, 404, { error: e.code });
        return sendJson(res, 500, { error: 'visit failed' });
      }
    }

    // --- B1 同步控制 API（spec 2026-06-09-lore-sync-console）---
    if (req.method === 'GET' && pathname === '/api/sync/status') {
      const stateDir = join(root, '.state');
      const config = readSyncConfig(stateDir);
      let lastFinalize = null;
      try { lastFinalize = JSON.parse(readFileSync(join(root, 'wiki', '.manifest.json'), 'utf8')).generated ?? null; }
      catch { /* 无 manifest（未 sync）→ null */ }
      // 预算闸的**可见出口**（审计 D4）：auto 因超预算静默停摆时，壳状态行必须读得到原因。
      // 未配置预算也照报（configured:false）——「为什么没跑」要能一眼看出是没配还是超了。
      // repoRoot：createServer(root) 的 root **就是 .lore 目录本身**（test/server.test.js:420、lib/serve.js:219），
      // 而预算版本戳与下面的 fuel 都要的是**仓库根**——统一从 root 的父目录推导，不猜、不"顺手修"传参。
      const repoRoot = join(resolve(root), '..');
      const budgetCfg = readBudgetConfig(stateDir);
      // 版本戳（预算窗口键）：唯一剩余的 per-request git spawn 就在这里，走上面的 30s TTL 缓存。
      // 传 `version` 进 budgetStatus 即让它跳过内部 versionStamp(repoRoot,{exec})——口径与 library 完全同一份。
      const budgetVersion = versionStampCached(repoRoot, exec, versionTtlMs);
      const bs = budgetStatus({
        stateDir, repoRoot,
        budget: budgetCfg.budget, dimension: budgetCfg.dimension, exec,
        version: budgetVersion,
      });
      // 壳状态行的燃料读数（设计 §5.3 底部 / §5.5；壳阶段 B）。派生**唯一在 lib/doctor.js 的 fuelReadout**
      // （计划 D3：同源同口径，绝不在 server.js 重写一套，否则与 `lore doctor` 漂移即可信度崩塌）。
      // 取不到的数一律 'unknown'（UNKNOWN），**绝不用 0 冒充**；未 init / 非 git 也不崩（全 unknown）。
      // 性能：fuelReadout 的窗口派生内部要 spawn 一次 `git log`（同步、约 1s）→ 走上面的 30s TTL 缓存，
      // 否则壳每 15s 一次的状态轮询会各自阻塞事件循环一秒（审计 🟡#3）。
      const fuel = fuelCached(repoRoot, exec, fuelTtlMs);
      return sendJson(res, 200, {
        mode: config.mode, last_finalize: lastFinalize, config,
        runner_running: runnerAlive(stateDir, isAlive),
        budget: {
          configured: bs.configured, dimension: bs.dimension, budget: bs.budget,
          used: bs.used, exceeded: bs.exceeded, version: bs.version,
        },
        fuel,
      });
    }

    if (req.method === 'POST' && pathname === '/api/sync/config') {
      try {
        const body = await readJson(req);
        const patch = {};
        if ('debounce_minutes' in body) patch.debounce_minutes = Number(body.debounce_minutes);
        if ('schedule' in body) patch.schedule = body.schedule === null || body.schedule === '' ? null : String(body.schedule);
        if ('max_pages' in body) patch.max_pages = Number(body.max_pages);
        if ('backend' in body) patch.backend = String(body.backend);
        writeSyncConfig(join(root, '.state'), patch);      // 非法值 throw → 400
        return sendJson(res, 200, { ok: true, config: readSyncConfig(join(root, '.state')) });
      } catch { return sendJson(res, 400, { error: 'invalid config (debounce 0-1440, schedule HH:MM|null, max_pages 1-50, backend auto|claude|codex|opencode)' }); }
    }

    if (req.method === 'GET' && pathname === '/api/sync/runs') {
      return sendJson(res, 200, { runs: readAutoRuns(join(root, '.state')) });
    }

    // per-repo 形态的仓库切换数据源：读中央注册表 + 报告 portal 端口（壳跳 portal 切仓库）。
    if (req.method === 'GET' && pathname === '/repos.json') {
      let entries = [];
      try { entries = JSON.parse(readFileSync(reposPath, 'utf8')) ?? []; } catch { entries = []; }
      const current = entries.find(e => slashLower(e.loreDir) === slashLower(root))?.name ?? null;
      return sendJson(res, 200, { repos: entries.map(e => e.name), portal: PORTAL_PORT, current });
    }

    if (req.method === 'POST' && pathname === '/api/sync/mode') {
      try {
        const body = await readJson(req);
        const mode = String(body.mode ?? '');
        writeSyncMode(join(root, '.state'), mode);   // 非法值 throw → 400
        return sendJson(res, 200, { ok: true, mode });
      } catch {
        return sendJson(res, 400, { error: 'invalid mode (B1: manual|notify; auto lands in B2)' });
      }
    }

    if (req.method === 'POST' && pathname === '/api/sync/finalize') {
      try {
        // 与 hook.maybeRefresh 同款 detached finalize（A 接缝③）。不加防抖：finalize 幂等、最后写赢。
        // 刻意不 gate mode：manual 档关的是「自动」刷新，手动 ⟳ 正是 manual 档的用法——别给这里补 mode 检查。
        const child = spawnFn(process.execPath, [join(HERE, 'lib', 'sync.js'), 'finalize', root],
          { detached: true, stdio: 'ignore', windowsHide: true });
        child.once?.('error', () => {});   // 异步 spawn 失败（EMFILE 等）不能击落常驻 server
        child.unref();
        return sendJson(res, 200, { spawned: true });
      } catch { return sendJson(res, 500, { error: 'spawn failed' }); }
    }

    if (pathname === '/api/sync/rewrite-requests') {
      if (req.method === 'GET') {
        return sendJson(res, 200, { requests: readRewriteRequests(join(root, '.state')) });
      }
      if (req.method === 'POST') {
        try {
          const body = await readJson(req);
          const page = String(body.page ?? '');
          if (!safeWikiPage(root, page)) return sendJson(res, 400, { error: 'invalid page' });
          // 重写/改进：透传用户指令（截断防滥用）；无指令 = 排队/同步语义
          const instruction = body.instruction != null && String(body.instruction).trim()
            ? String(body.instruction).slice(0, 500) : undefined;
          return sendJson(res, 200, { ok: true, ...appendRewriteRequest(join(root, '.state'), { page, instruction }) });
        } catch { return sendJson(res, 400, { error: 'bad json' }); }
      }
    }

  return false;   // 非 API 路径
}

// 顶层 catch 的统一收尾（代码评审 🔵#4）。这里**绝不能再抛**：响应可能已经开始/结束，
// 二次抛错又变回 unhandledRejection，兜底就白加了。头没发就 500（客户端拿到明确失败），
// 已发（流已开始 pipe）就只能结束响应；error 打进 stderr——长时进程里静默的 500 无法诊断。
function failInternal(res, req, e) {
  console.error(`lore: unhandled error on ${req.method} ${req.url}: ${e?.stack ?? e}`);
  if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
  if (!res.writableEnded) res.end('internal error');
}

export function createServer(rootDir, { spawnFn = spawn, reposPath = join(homedir(), '.lore', 'repos.json'), exec = execFileSync, fuelTtlMs = FUEL_CACHE_TTL_MS, versionTtlMs = VERSION_STAMP_TTL_MS } = {}) {
  const root = normalize(rootDir).replace(/[/\\]+$/, '');
  return http.createServer(async (req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch { res.writeHead(400); return res.end('bad request'); }

    // 顶层兜底：这是 async 处理器，promise 一旦 reject 就是 unhandledRejection ——
    // 长时运行的 serve 进程会整个挂掉（Node 默认把未处理的 rejection 当致命错误）。
    // handleApi 内部只覆盖各自**预期**的错误（400/403/404/… 都是正常 return），
    // fs 之类的意外抛错（readSyncConfig / readFileSync / readAutoRuns）会一路冒到这里。
    // 注意：既有的显式分支本来就是正常返回，走不到 catch——兜底不吞任何正常路径。
    try {
      if (await handleApi(root, req, res, pathname, { spawnFn, reposPath, exec, fuelTtlMs, versionTtlMs })) return;

      const rel = pathname.replace(/^\/+/, '');
      return serveStatic(root, rel, res, pathname);
    } catch (e) {
      return failInternal(res, req, e);
    }
  });
}

const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderRepoList(names) {
  const items = names.length
    ? names.map(n => `<li><a href="/${encodeURIComponent(n)}/site/">${escHtml(n)}</a></li>`).join('')
    : '<li class="empty">（暂无登记仓库：在某个 repo 跑 <code>/lore:init</code>）</li>';
  // 主题变量与壳同源同 key（localStorage 'lore-theme'）：壳里切的主题，列表页自动跟随。
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>lore portal</title>
<script>document.documentElement.setAttribute('data-theme', localStorage.getItem('lore-theme') || 'dark');</script>
<style>
:root{--bg:#1a1b26;--fg:#c0caf5;--fg-dim:#565f89;--fg-bright:#fff;--accent:#7aa2f7;--panel:#1f2130;--border:#2a2e42;--code-bg:#1e202e}
:root[data-theme="light"]{--bg:#ffffff;--fg:#24283b;--fg-dim:#787c99;--fg-bright:#1a1b26;--accent:#3760bf;--panel:#eef0f4;--border:#dcdfe6;--code-bg:#eef0f4}
:root[data-theme="sepia"]{--bg:#f4ecd8;--fg:#5b4636;--fg-dim:#9c8b73;--fg-bright:#3b2f25;--accent:#9a6a3a;--panel:#e7dcc0;--border:#d9c9a3;--code-bg:#e7dcc0}
body{font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--fg);max-width:680px;margin:48px auto;padding:0 20px}
h1{color:var(--fg-bright);font-size:22px;display:flex;align-items:center;justify-content:space-between}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
ul{list-style:none;padding:0}li{margin:10px 0;font-size:16px}.empty{color:var(--fg-dim);font-size:13px}
code{background:var(--code-bg);padding:2px 6px;border-radius:4px}
#theme{background:var(--panel);border:1px solid var(--border);color:var(--fg);padding:5px 9px;border-radius:7px;font-size:13px;cursor:pointer}
</style>
</head><body><h1>lore portal <select id="theme" title="主题">
<option value="dark">🌙 暗</option><option value="light">☀ 亮</option><option value="sepia">🌿 护眼</option>
</select></h1><p>本机已登记的 lore 仓库：</p><ul>${items}</ul>
<script>
const sel=document.getElementById('theme');
sel.value=localStorage.getItem('lore-theme')||'dark';
sel.onchange=()=>{document.documentElement.setAttribute('data-theme',sel.value);localStorage.setItem('lore-theme',sel.value);};
</script></body></html>`;
}

// 单机共享门户：一个端口聚合本机所有 lore repo。
// 入参可为固定 map { name -> loreDir } 或 **函数** ()=>map——传函数则每请求重读 registry，
// 新 /lore:init 的仓库免重启 portal 自动出现在路由+切仓下拉（修「启动快照」bug）。
export function createPortalServer(repoMapOrFn) {
  const getMap = typeof repoMapOrFn === 'function' ? repoMapOrFn : () => repoMapOrFn;
  return http.createServer(async (req, res) => {
    // 顶层兜底（与 createServer 同款同理由）：portal 也是长时进程，未预期的抛错同样会以
    // unhandledRejection 击落它。整段处理体都在 try 里——含 getMap()（注册表读取）与 handleApi 转发。
    try {
      const repoMap = getMap();
      let pathname;
      try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
      catch { res.writeHead(400); return res.end('bad request'); }

      if (pathname === '/' || pathname === '') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(renderRepoList(Object.keys(repoMap)));
      }

      if (pathname === '/repos.json') {                // 只读列表：壳的 repo 切换下拉数据源（不破门户零写面铁律）
        return sendJson(res, 200, { repos: Object.keys(repoMap) });
      }

      const m = pathname.match(/^\/([^/]+)(\/.*)?$/);
      const name = m && m[1];
      // hasOwnProperty（非 `in`）：避免 'constructor'/'__proto__' 这类继承键误判为已登记 repo。
      if (!name || !Object.prototype.hasOwnProperty.call(repoMap, name)) {
        res.writeHead(404); return res.end('not found');
      }
      if (m[2] === undefined) {                        // "/<name>" 无尾斜杠 → 跳到壳
        res.writeHead(302, { location: `/${name}/site/` });
        return res.end();
      }
      const rel = m[2].replace(/^\/+/, '');
      if (rel === 'api' || rel.startsWith('api/')) {
        // v0.6「portal 只读」翻转（用户需求：portal 下控制台可操作）：API 按 repo 转发，
        // localHost guard 在 handleApi 内同样生效，写面仍限对应 repo 的 .state。
        if (await handleApi(repoMap[name], req, res, '/' + rel, {})) return;
        res.writeHead(404); return res.end('not found');
      }
      return serveStatic(repoMap[name], rel, res, pathname);
    } catch (e) {
      return failInternal(res, req, e);
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , rootDir, portStr] = process.argv;
  if (!rootDir || !portStr) { console.error('usage: node server.js <rootDir> <port>'); process.exit(1); }
  const srv = createServer(rootDir);
  // EADDRINUSE: the port was stolen between start()'s probe and our bind (findPort TOCTOU).
  // Exit cleanly with a diagnostic instead of crashing as an uncaught 'error' event — lib/serve.js
  // start() watches for this non-zero exit and re-rolls the port. stdio is 'ignore' under start(),
  // so the message only surfaces when server.js is run by hand, which is exactly when it's useful.
  srv.on('error', (e) => {
    console.error(`lore: server failed to bind 127.0.0.1:${portStr}: ${e.code || e.message}`);
    process.exit(1);
  });
  srv.listen(Number(portStr), '127.0.0.1',
    () => console.log(`lore static server on 127.0.0.1:${portStr} root=${rootDir}`));
  // B2 ticker：统一调度静默期与 schedule。判定+触发在 runner.tickAuto（与 portal 共用，永不抛）。
  // 动态 import——ticker 是进程级关注点，不把判定链拖进 createServer 工厂（测试零影响）。
  setInterval(async () => {
    try { (await import('./lib/runner.js')).tickAuto(rootDir); }
    catch { /* ticker 永不击落 server */ }
  }, 60_000).unref();
}
