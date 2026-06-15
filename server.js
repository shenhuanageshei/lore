// server.js
import http from 'node:http';
import { appendFileSync, createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { translationSourceHash } from './lib/i18n.js';
import { readSyncMode, writeSyncMode, writeSyncConfig, appendRewriteRequest, readRewriteRequests,
  readSyncConfig, runnerAlive, readAutoRuns, readAutoPending, clearAutoPending } from './lib/syncstate.js';
import { isAlive } from './lib/serve.js';

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
export async function handleApi(root, req, res, pathname, { spawnFn = spawn, reposPath = join(homedir(), '.lore', 'repos.json') } = {}) {
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

    // --- B1 同步控制 API（spec 2026-06-09-lore-sync-console）---
    if (req.method === 'GET' && pathname === '/api/sync/status') {
      const stateDir = join(root, '.state');
      const config = readSyncConfig(stateDir);
      let lastFinalize = null;
      try { lastFinalize = JSON.parse(readFileSync(join(root, 'wiki', '.manifest.json'), 'utf8')).generated ?? null; }
      catch { /* 无 manifest（未 sync）→ null */ }
      return sendJson(res, 200, { mode: config.mode, last_finalize: lastFinalize, config, runner_running: runnerAlive(stateDir, isAlive) });
    }

    if (req.method === 'POST' && pathname === '/api/sync/config') {
      try {
        const body = await readJson(req);
        const patch = {};
        if ('debounce_minutes' in body) patch.debounce_minutes = Number(body.debounce_minutes);
        if ('schedule' in body) patch.schedule = body.schedule === null || body.schedule === '' ? null : String(body.schedule);
        if ('max_pages' in body) patch.max_pages = Number(body.max_pages);
        writeSyncConfig(join(root, '.state'), patch);      // 非法值 throw → 400
        return sendJson(res, 200, { ok: true, config: readSyncConfig(join(root, '.state')) });
      } catch { return sendJson(res, 400, { error: 'invalid config (debounce 0-1440, schedule HH:MM|null, max_pages 1-50)' }); }
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

export function createServer(rootDir, { spawnFn = spawn, reposPath = join(homedir(), '.lore', 'repos.json') } = {}) {
  const root = normalize(rootDir).replace(/[/\\]+$/, '');
  return http.createServer(async (req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch { res.writeHead(400); return res.end('bad request'); }

    if (await handleApi(root, req, res, pathname, { spawnFn, reposPath })) return;

    const rel = pathname.replace(/^\/+/, '');
    return serveStatic(root, rel, res, pathname);
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
