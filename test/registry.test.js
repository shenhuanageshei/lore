import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerServer, unregisterServer, listServers } from '../lib/registry.js';

function tmpPath() { return join(mkdtempSync(join(tmpdir(), 'lore-reg-')), 'servers.json'); }

test('registry: missing file → []', () => {
  assert.deepEqual(listServers(join(tmpdir(), 'lore-reg-nope', 'x.json')), []);
});

test('registry: register, dedupe by loreDir, unregister', () => {
  const p = tmpPath();
  try {
    registerServer({ loreDir: '/a', pid: 1, port: 7001, started: 't' }, p);
    registerServer({ loreDir: '/b', pid: 2, port: 7002, started: 't' }, p);
    registerServer({ loreDir: '/a', pid: 3, port: 7003, started: 't' }, p);   // 替换 /a
    let all = listServers(p);
    assert.equal(all.length, 2);
    assert.equal(all.find(e => e.loreDir === '/a').pid, 3);
    unregisterServer('/a', p);
    all = listServers(p);
    assert.deepEqual(all.map(e => e.loreDir), ['/b']);
  } finally { rmSync(join(p, '..'), { recursive: true, force: true }); }
});

test('registry: corrupt JSON → []', () => {
  const p = tmpPath();
  try { writeFileSync(p, '{bad'); assert.deepEqual(listServers(p), []); }
  finally { rmSync(join(p, '..'), { recursive: true, force: true }); }
});
