// test/server.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';

function listen(server) {
  return new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

test('serves a file with correct mime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-srv-'));
  mkdirSync(join(root, 'wiki'), { recursive: true });
  writeFileSync(join(root, 'wiki', '.manifest.json'), '{"ok":true}');
  const server = createServer(root);
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/wiki/.manifest.json`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/json');
    assert.deepEqual(await r.json(), { ok: true });
  } finally {
    server.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('404 for missing file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-srv-'));
  const server = createServer(root);
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/nope.md`);
    assert.equal(r.status, 404);
  } finally {
    server.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('rejects path traversal with 403', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-srv-'));
  writeFileSync(join(root, 'inside.txt'), 'in');
  const server = createServer(root);
  const port = await listen(server);
  try {
    // encoded ../ to dodge fetch normalization
    const r = await fetch(`http://127.0.0.1:${port}/..%2f..%2fetc%2fpasswd`);
    assert.equal(r.status, 403);
  } finally {
    server.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('rejects backslash-encoded traversal with 403 (Windows %5c vector)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-srv-'));
  writeFileSync(join(root, 'inside.txt'), 'in');
  const server = createServer(root);
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/..%5c..%5cwindows%5chosts`);
    assert.equal(r.status, 403);
  } finally {
    server.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('serves index.html for a bare directory request ending in slash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-srv-'));
  mkdirSync(join(root, 'site'), { recursive: true });
  writeFileSync(join(root, 'site', 'index.html'),
    '<!doctype html><title>lore</title><div id="app">MARKER_LORE_SHELL</div>');
  const server = createServer(root);
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/site/`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await r.text(), /MARKER_LORE_SHELL/);
  } finally {
    server.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('serves correctly when rootDir has a trailing slash', async () => {
  const base = mkdtempSync(join(tmpdir(), 'lore-srv-'));
  writeFileSync(join(base, 'a.txt'), 'hello');
  const server = createServer(base + '/');     // trailing slash
  const port = await listen(server);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/a.txt`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'hello');
  } finally {
    server.close(); rmSync(base, { recursive: true, force: true });
  }
});
