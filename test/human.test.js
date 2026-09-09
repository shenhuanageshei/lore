// test/human.test.js —— S4a per-human 存储层（设计 §3.3 / 不变量⑥）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HUMAN_SCHEMA_VERSION, HUMAN_KINDS, CLEAR_KINDS, BLACKBOX_LEVELS, DEDUPE_WINDOW_MS, HumanStoreError,
  humanDir, humanFilePath, assertInitialized, visitRecord, readRecord, blackboxRecord, checkRecord,
  dedupeKey, appendHuman, clearHuman, readHuman, readHumanFile, readAllHuman, exportHuman,
} from '../lib/human.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-human-')); }
function initLore() {
  const root = tmp();
  const lore = join(root, '.lore');
  mkdirSync(lore, { recursive: true });
  return { root, lore };
}
const lines = p => readFileSync(p, 'utf8').split('\n').filter(t => t.trim() !== '');

test('四类记录：append 与读回（字段原样、写入顺序保持）', () => {
  const { root, lore } = initLore();
  try {
    const t0 = '2026-09-09T00:00:00.000Z';
    const v = visitRecord({ page: 'lib/runner.js', ts: t0 });
    const r = readRecord({ page: 'lib/fold.js', at: 'abc1234', ts: t0 });
    const b = blackboxRecord({ module: 'runner', level: '半懂', ts: t0 });
    const c = checkRecord({ page: 'lib/human.js', ts: t0, question: '入口在哪', correct: true });

    assert.equal(appendHuman(lore, 'visits', v).appended, true);
    assert.equal(appendHuman(lore, 'read', r).appended, true);
    assert.equal(appendHuman(lore, 'blackbox', b).appended, true);
    assert.equal(appendHuman(lore, 'checks', c).appended, true);

    assert.deepEqual(readHuman(lore, 'visits'), [v]);
    assert.deepEqual(readHuman(lore, 'read'), [r]);
    assert.deepEqual(readHuman(lore, 'blackbox'), [b]);
    assert.deepEqual(readHuman(lore, 'checks'), [c]);          // 附加字段原样保留
    assert.deepEqual(Object.keys(readAllHuman(lore)), HUMAN_KINDS);
    for (const k of HUMAN_KINDS) assert.equal(existsSync(humanFilePath(lore, k)), true);
    assert.equal(humanDir(lore), join(lore, 'human'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('读回：坏行跳过不崩（坏 JSON / 非对象行 / 空行），跳过数如实计数', () => {
  const { root, lore } = initLore();
  try {
    const good1 = visitRecord({ page: 'a', ts: '2026-09-09T00:00:00.000Z' });
    const good2 = visitRecord({ page: 'b', ts: '2026-09-09T00:01:00.000Z' });
    mkdirSync(humanDir(lore), { recursive: true });
    writeFileSync(humanFilePath(lore, 'visits'), [
      JSON.stringify(good1), '{broken', '[1,2]', 'null', '   ', JSON.stringify(good2), '',
    ].join('\n') + '\n');

    const f = readHumanFile(lore, 'visits');
    assert.deepEqual(f.records, [good1, good2]);
    assert.equal(f.skipped, 3);
    assert.deepEqual(readHuman(lore, 'visits'), [good1, good2]);        // 不抛
    const doc = exportHuman(lore, { exportedAt: '2026-09-09T00:00:00.000Z' });
    assert.equal(doc.skipped.visits, 3);                                 // 导出如实报出跳过数
    assert.equal(doc.counts.visits, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('未 init 的目录（无 .lore）：四类操作全部明确报错，且不写散文件', () => {
  const root = tmp();
  const lore = join(root, '.lore');
  try {
    const isNotInit = e => e instanceof HumanStoreError && e.code === 'not-initialized';
    assert.throws(() => appendHuman(lore, 'visits', visitRecord({ page: 'p' })), isNotInit);
    assert.throws(() => readHuman(lore, 'visits'), isNotInit);
    assert.throws(() => readAllHuman(lore), isNotInit);
    assert.throws(() => exportHuman(lore), isNotInit);
    assert.throws(() => assertInitialized(lore), isNotInit);
    assert.throws(() => assertInitialized(undefined), isNotInit);
    assert.equal(existsSync(lore), false);                                // 没静默造目录
    assert.equal(existsSync(join(root, 'visits.jsonl')), false);          // 更没写散文件
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('导出：含 schemaVersion / generator / counts / records（可移植 JSON）', () => {
  const { root, lore } = initLore();
  try {
    appendHuman(lore, 'visits', visitRecord({ page: 'a', ts: '2026-09-09T00:00:00.000Z' }));
    appendHuman(lore, 'visits', visitRecord({ page: 'b', ts: '2026-09-09T00:00:00.000Z' }));
    appendHuman(lore, 'blackbox', blackboxRecord({ module: 'm', level: '黑盒', ts: '2026-09-09T00:00:00.000Z' }));

    const doc = exportHuman(lore, { exportedAt: '2026-09-09T12:00:00.000Z' });
    assert.equal(doc.schemaVersion, HUMAN_SCHEMA_VERSION);
    assert.equal(typeof doc.schemaVersion, 'number');
    assert.equal(doc.generator, 'lore');
    assert.equal(doc.exportedAt, '2026-09-09T12:00:00.000Z');
    assert.deepEqual(doc.counts, { visits: 2, read: 0, blackbox: 1, checks: 0 });
    assert.deepEqual(doc.skipped, { visits: 0, read: 0, blackbox: 0, checks: 0 });
    assert.equal(doc.records.length, 3);
    assert.deepEqual(doc.records.map(x => x.kind), ['visit', 'visit', 'blackbox']);
    JSON.parse(JSON.stringify(doc));                                      // 可序列化 = 可移植
    assert.equal(exportHuman(lore, { exportedAt: '2026-09-09T12:00:00.000Z' }).records.length, 3);  // 重复导出不改库
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('同页短窗去重：窗口内不写第二行，窗口外/换页/换等级照写；windowMs=0 关闭去重', () => {
  const { root, lore } = initLore();
  const at = ms => new Date(ms).toISOString();
  const T0 = Date.parse('2026-09-09T00:00:00.000Z');
  try {
    const first = appendHuman(lore, 'visits', visitRecord({ page: 'a', ts: at(T0) }));
    assert.equal(first.appended, true);
    assert.equal(first.deduped, false);

    const again = appendHuman(lore, 'visits', visitRecord({ page: 'a', ts: at(T0 + 60_000) }));
    assert.equal(again.appended, false);
    assert.equal(again.deduped, true);
    assert.equal(again.record.page, 'a');                                  // 回传既有记录
    assert.equal(lines(humanFilePath(lore, 'visits')).length, 1);

    assert.equal(appendHuman(lore, 'visits', visitRecord({ page: 'a', ts: at(T0 + DEDUPE_WINDOW_MS) })).appended, true);
    assert.equal(lines(humanFilePath(lore, 'visits')).length, 2);          // 窗口外 → 新记录

    assert.equal(appendHuman(lore, 'visits', visitRecord({ page: 'b', ts: at(T0 + 60_000) })).appended, true);
    assert.equal(lines(humanFilePath(lore, 'visits')).length, 3);          // 换页 → 新记录

    // 黑盒：同模块换等级是修正、不是重复；同模块同等级窗口内去重
    assert.equal(appendHuman(lore, 'blackbox', blackboxRecord({ module: 'm', level: '懂', ts: at(T0) })).appended, true);
    assert.equal(appendHuman(lore, 'blackbox', blackboxRecord({ module: 'm', level: '懂', ts: at(T0 + 1000) })).appended, false);
    assert.equal(appendHuman(lore, 'blackbox', blackboxRecord({ module: 'm', level: '半懂', ts: at(T0 + 2000) })).appended, true);
    assert.equal(readHuman(lore, 'blackbox').length, 2);

    // 已阅：换版本戳是新记录（确认绑版本），同版本窗口内去重
    assert.equal(appendHuman(lore, 'read', readRecord({ page: 'p', at: 'sha1', ts: at(T0) })).appended, true);
    assert.equal(appendHuman(lore, 'read', readRecord({ page: 'p', at: 'sha1', ts: at(T0 + 1000) })).appended, false);
    assert.equal(appendHuman(lore, 'read', readRecord({ page: 'p', at: 'sha2', ts: at(T0 + 2000) })).appended, true);
    assert.equal(readHuman(lore, 'read').length, 2);

    // windowMs:0 → 关闭去重（壳传感器之外的显式逃生门）
    assert.equal(appendHuman(lore, 'visits', visitRecord({ page: 'b', ts: at(T0 + 61_000) }), { windowMs: 0 }).appended, true);
    assert.equal(lines(humanFilePath(lore, 'visits')).length, 4);

    assert.equal(dedupeKey(visitRecord({ page: 'a', ts: at(T0) })), 'visit|a|');
    assert.equal(dedupeKey(readRecord({ page: 'p', at: 'sha1', ts: at(T0) })), 'read|p|sha1');
    assert.equal(dedupeKey(blackboxRecord({ module: 'm', level: '懂', ts: at(T0) })), 'blackbox|m|懂');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('记录构造器与 appendHuman 校验：非法输入 → HumanStoreError', () => {
  const { root, lore } = initLore();
  const invalid = e => e instanceof HumanStoreError && e.code === 'invalid-record';
  const unknownKind = e => e instanceof HumanStoreError && e.code === 'unknown-kind';
  try {
    assert.throws(() => visitRecord({}), invalid);
    assert.throws(() => visitRecord({ page: '   ' }), invalid);
    assert.throws(() => readRecord({ page: 'p' }), invalid);               // 缺 --at
    assert.throws(() => readRecord({ at: 'sha' }), invalid);
    assert.throws(() => blackboxRecord({ module: 'm', level: '差不多' }), invalid);
    assert.throws(() => blackboxRecord({ module: 'm' }), invalid);
    assert.throws(() => checkRecord({}), invalid);
    assert.deepEqual(BLACKBOX_LEVELS, ['懂', '半懂', '黑盒']);

    assert.throws(() => appendHuman(lore, 'visit', visitRecord({ page: 'p' })), unknownKind);   // 文件名复数
    assert.throws(() => appendHuman(lore, 'visits', { ts: '2026-09-09T00:00:00.000Z', kind: 'read', page: 'p' }), invalid);
    assert.throws(() => appendHuman(lore, 'visits', null), invalid);
    assert.equal(existsSync(humanDir(lore)), false);                       // 全部被拒 → 一个文件没落
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- 清除（不变量⑥「可清除」） ----------
test('clearHuman：dryRun 只报将删条数不落写；按 kind 只清该类；清除后可继续追加', () => {
  const { root, lore } = initLore();
  const T0 = '2026-09-09T00:00:00.000Z';
  try {
    assert.deepEqual([...CLEAR_KINDS], ['visits', 'read', 'blackbox', 'checks', 'all']);
    appendHuman(lore, 'visits', visitRecord({ page: 'a', ts: T0 }));
    appendHuman(lore, 'visits', visitRecord({ page: 'b', ts: T0 }));
    appendHuman(lore, 'read', readRecord({ page: 'p', at: 'sha1', ts: T0 }));
    appendHuman(lore, 'blackbox', blackboxRecord({ module: 'm', level: '懂', ts: T0 }));
    appendHuman(lore, 'checks', checkRecord({ page: 'q', ts: T0 }));

    // dryRun：报数不删
    const preview = clearHuman(lore, 'visits', { dryRun: true });
    assert.deepEqual({ kind: preview.kind, cleared: preview.cleared, skipped: preview.skipped, dryRun: preview.dryRun },
      { kind: 'visits', cleared: 2, skipped: 0, dryRun: true });
    assert.deepEqual(preview.perKind, { visits: 2 });
    assert.equal(readHuman(lore, 'visits').length, 2);                    // 一条没删

    // 真删：只清 visits，其余三类不动
    const done = clearHuman(lore, 'visits');
    assert.equal(done.cleared, 2);
    assert.equal(done.dryRun, false);
    assert.equal(existsSync(humanFilePath(lore, 'visits')), false);       // 删文件（不是写空行）
    assert.deepEqual(readHuman(lore, 'visits'), []);
    assert.equal(readHuman(lore, 'read').length, 1);
    assert.equal(readHuman(lore, 'blackbox').length, 1);
    assert.equal(readHuman(lore, 'checks').length, 1);

    // 清除后可继续追加（appendHuman 按需重建文件）
    assert.equal(appendHuman(lore, 'visits', visitRecord({ page: 'c', ts: T0 })).appended, true);
    assert.deepEqual(readHuman(lore, 'visits').map(r => r.page), ['c']);

    // 'all' 清全部；重复清除幂等（0 条）
    assert.equal(clearHuman(lore, 'all').cleared, 4);
    for (const k of HUMAN_KINDS) assert.deepEqual(readHuman(lore, k), []);
    assert.equal(clearHuman(lore, 'all').cleared, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('clearHuman：坏行不计入将删条数（另用 skipped 报出）；未知 kind / 未 init → HumanStoreError', () => {
  const { root, lore } = initLore();
  const orphanRoot = tmp();
  const notInit = join(orphanRoot, '.lore');
  try {
    mkdirSync(humanDir(lore), { recursive: true });
    writeFileSync(humanFilePath(lore, 'visits'),
      JSON.stringify(visitRecord({ page: 'a', ts: '2026-09-09T00:00:00.000Z' })) + '\n{broken\n');
    const r = clearHuman(lore, 'visits');
    assert.equal(r.cleared, 1);                                           // 只算真记录
    assert.equal(r.skipped, 1);                                           // 坏行如实报出
    assert.throws(() => clearHuman(lore, 'visit'), e => e instanceof HumanStoreError && e.code === 'unknown-kind');
    assert.throws(() => clearHuman(notInit, 'visits'), e => e instanceof HumanStoreError && e.code === 'not-initialized');
    assert.equal(existsSync(notInit), false);                             // 未 init 不静默造目录
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(orphanRoot, { recursive: true, force: true }); }
});

test('缺失的文件读回为空数组（未写的类目不崩）', () => {
  const { root, lore } = initLore();
  try {
    assert.deepEqual(readHuman(lore, 'checks'), []);
    const f = readHumanFile(lore, 'checks');
    assert.deepEqual(f.records, []);
    assert.equal(f.skipped, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
