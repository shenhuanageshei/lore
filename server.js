// server.js
import http from 'node:http';
import { appendFileSync, createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { translationSourceHash } from './lib/i18n.js';
import { readSyncMode, writeSyncMode, writeSyncConfig, appendRewriteRequest, readRewriteRequests,
  readSyncConfig, readRunnerPid, readAutoRuns, readAutoPending, clearAutoPending } from './lib/syncstate.js';
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
  // no-cache（≠no-store）：每次 revalidate。本地 127.0.0.1 毫秒级零体感，
  // 根治浏览器 module 缓存旧 shell.mjs（缺新 export → import 炸 → 整壳白屏）。
  res.writeHead(200, {
    'content-type': MIME[extname(full)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  stream.pipe(res);
}

export function createServer(rootDir, { spawnFn = spawn } = {}) {
  const root = normalize(rootDir).replace(/[/\\]+$/, '');
  return http.createServer(async (req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch { res.writeHead(400); return res.end('bad request'); }

    // Local write APIs (only reachable on 127.0.0.1). Scoped to <root>/.state and
    // a read of <root>/wiki; never write arbitrary paths.
    if (req.method === 'POST' && pathname.startsWith('/api/') && !localHost(req)) {
      return sendJson(res, 403, { error: 'forbidden host' });
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
      const pid = readRunnerPid(stateDir);
      return sendJson(res, 200, { mode: config.mode, last_finalize: lastFinalize, config, runner_running: pid != null && isAlive(pid) });
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
          return sendJson(res, 200, { ok: true, ...appendRewriteRequest(join(root, '.state'), { page }) });
        } catch { return sendJson(res, 400, { error: 'bad json' }); }
      }
    }

    const rel = pathname.replace(/^\/+/, '');
    return serveStatic(root, rel, res, pathname);
  });
}

const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderRepoList(names) {
  const items = names.length
    ? names.map(n => `<li><a href="/${encodeURIComponent(n)}/site/">${escHtml(n)}</a></li>`).join('')
    : '<li class="empty">（暂无登记仓库：在某个 repo 跑 <code>/lore:init</code>）</li>';
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>lore portal</title>
<style>body{font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#1a1b26;color:#c0caf5;max-width:680px;margin:48px auto;padding:0 20px}
h1{color:#fff;font-size:22px}a{color:#7aa2f7;text-decoration:none}a:hover{text-decoration:underline}
ul{list-style:none;padding:0}li{margin:10px 0;font-size:16px}.empty{color:#565f89;font-size:13px}
code{background:#1e202e;padding:2px 6px;border-radius:4px}</style>
</head><body><h1>lore portal</h1><p>本机已登记的 lore 仓库：</p><ul>${items}</ul></body></html>`;
}

// 单机共享门户：一个端口聚合本机所有 lore repo。repoMap: { name -> loreDir }。
// MVP 只读：/<name>/api/… 一律 404（无 write 面 → 无 DNS-rebind 写风险）。配合 .listen 仅绑 127.0.0.1。
export function createPortalServer(repoMap) {
  return http.createServer((req, res) => {
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
    if (rel === 'api' || rel.startsWith('api/')) {   // MVP 只读：不路由写接口
      res.writeHead(404); return res.end('not found');
    }
    return serveStatic(repoMap[name], rel, res, pathname);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , rootDir, portStr] = process.argv;
  if (!rootDir || !portStr) { console.error('usage: node server.js <rootDir> <port>'); process.exit(1); }
  createServer(rootDir).listen(Number(portStr), '127.0.0.1',
    () => console.log(`lore static server on 127.0.0.1:${portStr} root=${rootDir}`));
  // B2 ticker：统一调度静默期与 schedule（仅 per-repo server；portal 只读不带 ticker）。
  // 动态 import runner——ticker 是进程级关注点，不把判定链拖进 createServer 工厂（测试零影响）。
  const RUNNER_JS = join(HERE, 'lib', 'runner.js');
  setInterval(async () => {
    try {
      const stateDir = join(rootDir, '.state');
      const config = readSyncConfig(stateDir);
      if (config.mode !== 'auto') return;
      const { shouldRunAuto } = await import('./lib/runner.js');
      const pid = readRunnerPid(stateDir);
      const runs = readAutoRuns(stateDir, 1);
      const d = shouldRunAuto({
        config,
        pendingTs: readAutoPending(stateDir),
        lastRunDate: runs[0]?.ts?.slice(0, 10) ?? null,
        now: new Date(),
        runnerAlive: pid != null && isAlive(pid),
      });
      if (!d.run) return;
      clearAutoPending(stateDir);
      const child = spawn(process.execPath, [RUNNER_JS, rootDir], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once?.('error', () => {});
      child.unref();
    } catch { /* ticker 永不击落 server */ }
  }, 60_000).unref();
}
