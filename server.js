// server.js
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function createServer(rootDir) {
  const root = normalize(rootDir).replace(/[/\\]+$/, '');
  return http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch { res.writeHead(400); return res.end('bad request'); }

    const rel = pathname.replace(/^\/+/, '');
    let full = normalize(join(root, rel));

    // traversal guard: resolved path must stay within root.
    // (full === root is reachable for a bare "/" request, which the dir→index
    //  step below resolves to <root>/index.html.)
    if (full !== root && !full.startsWith(root + sep)) {
      res.writeHead(403); return res.end('forbidden');
    }
    let st;
    try { st = statSync(full); } catch { res.writeHead(404); return res.end('not found'); }
    // directory request → serve its index.html, mirroring python http.server.
    // covers paths ending in "/" (e.g. the advertised /site/) and bare dir names.
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
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , rootDir, portStr] = process.argv;
  if (!rootDir || !portStr) { console.error('usage: node server.js <rootDir> <port>'); process.exit(1); }
  createServer(rootDir).listen(Number(portStr), '127.0.0.1',
    () => console.log(`lore static server on 127.0.0.1:${portStr} root=${rootDir}`));
}
