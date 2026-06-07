// test/portal.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortalServer } from '../server.js';

function listen(server) {
  return new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

// 造一个最小 loreDir（含 wiki/.manifest.json，内容里带 tag 便于断言命中哪个 repo）。
function makeLoreDir(tag) {
  const loreDir = mkdtempSync(join(tmpdir(), 'lore-portal-' + tag + '-'));
  mkdirSync(join(loreDir, 'wiki'), { recursive: true });
  writeFileSync(join(loreDir, 'wiki', '.manifest.json'), `{"tag":"${tag}"}`);
  return loreDir;
}

test('portal: /<name>/wiki/... 命中对应 repo（白名单路由）', async () => {
  const loreA = makeLoreDir('A');
  const loreB = makeLoreDir('B');
  const server = createPortalServer({ lore: loreA, ti: loreB });
  const port = await listen(server);
  try {
    const a = await fetch(`http://127.0.0.1:${port}/lore/wiki/.manifest.json`);
    assert.equal(a.status, 200);
    assert.deepEqual(await a.json(), { tag: 'A' });
    const b = await fetch(`http://127.0.0.1:${port}/ti/wiki/.manifest.json`);
    assert.equal(b.status, 200);
    assert.deepEqual(await b.json(), { tag: 'B' });
  } finally {
    server.close();
    rmSync(loreA, { recursive: true, force: true });
    rmSync(loreB, { recursive: true, force: true });
  }
});

test('portal: GET / 列出每个登记仓库的链接', async () => {
  const loreA = makeLoreDir('A');
  const loreB = makeLoreDir('B');
  const server = createPortalServer({ lore: loreA, ti: loreB });
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /href="\/lore\/site\/"/);
    assert.match(html, /href="\/ti\/site\/"/);
  } finally {
    server.close();
    rmSync(loreA, { recursive: true, force: true });
    rmSync(loreB, { recursive: true, force: true });
  }
});

test('portal: 未登记 repo → 404；穿越 → 403', async () => {
  const loreA = makeLoreDir('A');
  const server = createPortalServer({ lore: loreA });
  const port = await listen(server);
  try {
    const unknown = await fetch(`http://127.0.0.1:${port}/unknown/wiki/x.md`);
    assert.equal(unknown.status, 404);
    // 编码 ../ 绕过 fetch 归一化（同 server.test 的穿越向量）；forward-slash ../ 两平台都拦
    const escape = await fetch(`http://127.0.0.1:${port}/lore/..%2f..%2fetc%2fpasswd`);
    assert.equal(escape.status, 403);
  } finally {
    server.close();
    rmSync(loreA, { recursive: true, force: true });
  }
});

test('portal: 写接口不路由（MVP 只读）→ 404', async () => {
  const loreA = makeLoreDir('A');
  const server = createPortalServer({ lore: loreA });
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/lore/api/preferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'zh' }),
    });
    assert.equal(r.status, 404);
  } finally {
    server.close();
    rmSync(loreA, { recursive: true, force: true });
  }
});
