// test/syncstate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSyncMode, writeSyncMode, appendRewriteRequest, readRewriteRequests } from '../lib/syncstate.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-ss-')); }

test('writeSyncMode → readSyncMode round-trip', () => {
  const dir = tmp();
  try {
    writeSyncMode(dir, 'manual');
    assert.equal(readSyncMode(dir), 'manual');
    writeSyncMode(dir, 'notify');
    assert.equal(readSyncMode(dir), 'notify');
    // 落盘格式可读（控制台/人都能看）——锁字节格式：两空格缩进 + 尾换行
    assert.equal(readFileSync(join(dir, 'sync.json'), 'utf8'), '{\n  "mode": "notify"\n}\n');
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

test('writeSyncMode: 非法值 throw；auto 自 B2 起合法', () => {
  const dir = tmp();
  try {
    writeSyncMode(dir, 'auto');                                  // B2 解锁
    assert.equal(readSyncMode(dir), 'auto');
    assert.throws(() => writeSyncMode(dir, ''), /invalid sync mode/);
    assert.throws(() => writeSyncMode(dir, 'warp'), /invalid sync mode/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { readSyncConfig, writeSyncConfig, writeAutoPending, readAutoPending, clearAutoPending,
  writeRunnerPid, readRunnerPid, clearRunnerPid, appendAutoRun, readAutoRuns } from '../lib/syncstate.js';

test('readSyncConfig: 默认值兜底 + B1 形状向后兼容 + 扩展字段', () => {
  const dir = tmp();
  try {
    assert.deepEqual(readSyncConfig(dir), { mode: 'notify', debounce_minutes: 10, schedule: null, max_pages: 5, stale_threshold: 15 });
    writeFileSync(join(dir, 'sync.json'), JSON.stringify({ mode: 'manual' }));            // B1 形状
    assert.equal(readSyncConfig(dir).mode, 'manual');
    assert.equal(readSyncConfig(dir).debounce_minutes, 10);
    writeFileSync(join(dir, 'sync.json'), JSON.stringify({ mode: 'auto', debounce_minutes: 3, schedule: '03:00', max_pages: 2, future_field: 1 }));
    assert.deepEqual(readSyncConfig(dir), { mode: 'auto', debounce_minutes: 3, schedule: '03:00', max_pages: 2, stale_threshold: 15 });
    writeFileSync(join(dir, 'sync.json'), JSON.stringify({ mode: 'auto', schedule: 'not-a-time' }));
    assert.equal(readSyncConfig(dir).schedule, null);            // 非法 schedule 回默认
    writeFileSync(join(dir, 'sync.json'), JSON.stringify({ mode: 'auto', stale_threshold: 'lots' }));
    assert.equal(readSyncConfig(dir).stale_threshold, 15);       // 非法 stale_threshold 回默认
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeSyncConfig: 部分更新合并（mode 保留）+ 校验非法值拒绝', () => {
  const dir = tmp();
  try {
    writeSyncMode(dir, 'auto');
    writeSyncConfig(dir, { debounce_minutes: 3, schedule: '03:30' });
    assert.deepEqual(readSyncConfig(dir), { mode: 'auto', debounce_minutes: 3, schedule: '03:30', max_pages: 5, stale_threshold: 15 });
    writeSyncConfig(dir, { schedule: null, max_pages: 2, stale_threshold: 30 });            // schedule 可清空
    assert.deepEqual(readSyncConfig(dir), { mode: 'auto', debounce_minutes: 3, schedule: null, max_pages: 2, stale_threshold: 30 });
    assert.throws(() => writeSyncConfig(dir, { debounce_minutes: -1 }), /invalid/);
    assert.throws(() => writeSyncConfig(dir, { stale_threshold: 0 }), /stale_threshold/);
    assert.throws(() => writeSyncConfig(dir, { schedule: '25:99' }), /invalid/);
    assert.throws(() => writeSyncConfig(dir, { max_pages: 0 }), /invalid/);
    assert.equal(readSyncConfig(dir).debounce_minutes, 3);              // 非法不落盘
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('auto-pending: 写读清 round-trip；缺文件 null', () => {
  const dir = tmp();
  try {
    assert.equal(readAutoPending(dir), null);
    writeAutoPending(dir, '2026-06-10T01:00:00Z');
    assert.equal(readAutoPending(dir), '2026-06-10T01:00:00Z');
    clearAutoPending(dir);
    assert.equal(readAutoPending(dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner pid: 写读清；坏 JSON → null', () => {
  const dir = tmp();
  try {
    assert.equal(readRunnerPid(dir), null);
    writeRunnerPid(dir, 12345);
    assert.equal(readRunnerPid(dir), 12345);
    clearRunnerPid(dir);
    assert.equal(readRunnerPid(dir), null);
    writeFileSync(join(dir, 'runner.pid'), '{oops');
    assert.equal(readRunnerPid(dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('auto-runs: append + 读最近 N 条（新在前）；缺文件 []', () => {
  const dir = tmp();
  try {
    assert.deepEqual(readAutoRuns(dir), []);
    appendAutoRun(dir, { ts: 't1', pages: [{ page: 'component/a.md', ok: true, ms: 100 }], total_ms: 100 });
    appendAutoRun(dir, { ts: 't2', pages: [], total_ms: 5 });
    const runs = readAutoRuns(dir, 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].ts, 't2');                              // 最新在前
    assert.equal(readAutoRuns(dir).length, 2);
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

test('appendRewriteRequest + readRewriteRequests round-trip', () => {
  const dir = tmp();
  try {
    const r1 = appendRewriteRequest(dir, { page: 'component/sync.md', now: '2026-06-09T01:00:00Z' });
    assert.equal(r1.queued, true);
    const list = readRewriteRequests(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].page, 'component/sync.md');
    assert.equal(list[0].ts, '2026-06-09T01:00:00Z');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendRewriteRequest: 同页未消化不重复排（去重）', () => {
  const dir = tmp();
  try {
    appendRewriteRequest(dir, { page: 'component/sync.md' });
    const r2 = appendRewriteRequest(dir, { page: 'component/sync.md' });
    assert.equal(r2.queued, false);
    assert.equal(readRewriteRequests(dir).length, 1);
    const r3 = appendRewriteRequest(dir, { page: 'component/hook.md' });
    assert.equal(r3.queued, true);
    assert.equal(readRewriteRequests(dir).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendRewriteRequest: 带 instruction → 更新同页条目（指令可改写）；无指令仍去重', () => {
  const dir = tmp();
  try {
    appendRewriteRequest(dir, { page: 'component/sync.md', now: 't1' });
    assert.equal(appendRewriteRequest(dir, { page: 'component/sync.md', now: 't2' }).queued, false);   // 无指令 → 去重
    const r = appendRewriteRequest(dir, { page: 'component/sync.md', instruction: '精简概览段', now: 't3' });
    assert.equal(r.queued, true);                                          // 有指令 → 更新（非跳过）
    const q = readRewriteRequests(dir);
    assert.equal(q.length, 1);                                             // 同页不重复
    assert.equal(q[0].instruction, '精简概览段');                          // 指令持久化 + 读回
    appendRewriteRequest(dir, { page: 'component/sync.md', instruction: '改主意：加个例子', now: 't4' });
    assert.equal(readRewriteRequests(dir)[0].instruction, '改主意：加个例子');   // 指令可覆盖（改主意）
    assert.equal(readRewriteRequests(dir).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readRewriteRequests: 缺文件 → []；坏行跳过好行保留', () => {
  const dir = tmp();
  try {
    assert.deepEqual(readRewriteRequests(dir), []);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rewrite-requests.ndjson'),
      '{"ts":"t1","page":"component/a.md"}\n{oops\n{"ts":"t2","page":"component/b.md"}\n{"nopage":1}\n');
    const list = readRewriteRequests(dir);
    assert.deepEqual(list.map(r => r.page), ['component/a.md', 'component/b.md']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
