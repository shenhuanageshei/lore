// test/syncstate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSyncMode, writeSyncMode } from '../lib/syncstate.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-ss-')); }

test('writeSyncMode → readSyncMode round-trip', () => {
  const dir = tmp();
  try {
    writeSyncMode(dir, 'manual');
    assert.equal(readSyncMode(dir), 'manual');
    writeSyncMode(dir, 'notify');
    assert.equal(readSyncMode(dir), 'notify');
    // 落盘格式可读（控制台/人都能看）
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'sync.json'), 'utf8')), { mode: 'notify' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readSyncMode: 缺文件 → notify（默认档）', () => {
  const dir = tmp();
  try { assert.equal(readSyncMode(dir), 'notify'); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readSyncMode: 坏 JSON / 未知 mode → notify（best-effort）', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'sync.json'), '{oops');
    assert.equal(readSyncMode(dir), 'notify');
    writeFileSync(join(dir, 'sync.json'), JSON.stringify({ mode: 'warp-speed' }));
    assert.equal(readSyncMode(dir), 'notify');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeSyncMode: 非法值 throw（B1 枚举 manual|notify，auto 留 B2）', () => {
  const dir = tmp();
  try {
    assert.throws(() => writeSyncMode(dir, 'auto'), /invalid sync mode/);
    assert.throws(() => writeSyncMode(dir, ''), /invalid sync mode/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeSyncMode: stateDir 不存在时自动创建', () => {
  const dir = tmp();
  try {
    const nested = join(dir, '.state');
    writeSyncMode(nested, 'manual');
    assert.equal(readSyncMode(nested), 'manual');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
