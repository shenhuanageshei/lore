// server.js
import http from 'node:http';
import { appendFileSync, createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { translationSourceHash } from './lib/i18n.js';

const LANG_RE = /^[a-z]{2}(?:-[A-Za-z0-9]+)?$/;

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
export function serveStatic(rootDir, rel, res) {
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
    full = join(full, 'index.html');
    try { st = statSync(full); } catch { res.writeHead(404); return res.end('not found'); }
  }
  if (st.isDirectory()) { res.writeHead(404); return res.end('not found'); }

  const stream = createReadStream(full);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream' });
  stream.pipe(res);
}

export function createServer(rootDir) {
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

    const rel = pathname.replace(/^\/+/, '');
    return serveStatic(root, rel, res);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , rootDir, portStr] = process.argv;
  if (!rootDir || !portStr) { console.error('usage: node server.js <rootDir> <port>'); process.exit(1); }
  createServer(rootDir).listen(Number(portStr), '127.0.0.1',
    () => console.log(`lore static server on 127.0.0.1:${portStr} root=${rootDir}`));
}
