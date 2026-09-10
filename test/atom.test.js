// test/atom.test.js —— ⓪ 期 S1：六类原子 schema 与校验器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATOM_KINDS, ATOM_STATUSES, COMPREHENSION_KINDS, MACHINE_SOURCES, PITFALL_FIELDS,
  isKnownKind, isMachineSource, isPaddedIsoTs, requiresTitle, validateAtom, normalizeAtom, parseAtom,
} from '../lib/atom.js';
import { readAllAtoms } from '../lib/journal.js';

const base = (over = {}) => ({
  id: 'decision:2026-09-09-lore-reposition',
  ts: '2026-09-09T08:00:00+08:00',
  kind: 'decision',
  title: 'lore 定位：wiki 保留，差异化做 owner 理解层',
  why: '厂商能生成同一份 wiki，拿不到「你懂什么」',
  ...over,
});

const codes = r => r.errors.map(e => e.code);

test('ATOM_KINDS: 六类理解层原子 + commit 存量兼容', () => {
  assert.deepEqual([...COMPREHENSION_KINDS], ['decision', 'rejected', 'correction', 'question', 'evidence', 'pitfall']);
  assert.equal(ATOM_KINDS.includes('commit'), true);          // 490 条存量原子必须仍合法
  assert.equal(isKnownKind('decision'), true);
  assert.equal(isKnownKind('commit'), true);
  assert.equal(isKnownKind('hypothesis'), false);
  assert.equal(requiresTitle('decision'), true);
  assert.equal(requiresTitle('commit'), false);                // enrich 原子 title=''
});

for (const kind of COMPREHENSION_KINDS) {
  test(`kind=${kind}: 合法原子通过`, () => {
    const a = base({ kind, title: `${kind} title` });
    if (kind === 'pitfall') { a.problem = 'p'; a.fix = 'f'; a.prevention = 'v'; }
    const r = validateAtom(a);
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
  });

  test(`kind=${kind}: 缺 title / title 空串 → 非法`, () => {
    const noTitle = base({ kind });
    delete noTitle.title;
    assert.equal(validateAtom(noTitle).ok, false);
    assert.ok(codes(validateAtom(noTitle)).includes('missing-title'));
    const blank = base({ kind, title: '   ' });
    if (kind === 'pitfall') { blank.problem = 'p'; blank.fix = 'f'; blank.prevention = 'v'; }
    assert.ok(codes(validateAtom(blank)).includes('missing-title'));
  });
}

test('未知 kind / 缺 kind → 拒绝', () => {
  assert.ok(codes(validateAtom(base({ kind: 'hypothesis' }))).includes('unknown-kind'));
  const noKind = base();
  delete noKind.kind;
  assert.ok(codes(validateAtom(noKind)).includes('unknown-kind'));
});

test('id / ts 必填且 ts 可解析', () => {
  assert.ok(codes(validateAtom(base({ id: '' }))).includes('missing-id'));
  assert.ok(codes(validateAtom(base({ ts: '' }))).includes('missing-ts'));
  assert.ok(codes(validateAtom(base({ ts: 'not-a-date' }))).includes('invalid-ts'));
  assert.equal(validateAtom(base()).ok, true);
});

// 审计 D5 / 代码评审 #6：ts 必须是**补零** ISO-8601。atomPath 用位置切片（slice(0,4)/slice(5,7)/slice(0,10)）
// 拼分片路径，而 Date.parse 对 '2026-9-9' / '2026/09/09' 都返回合法时间戳 → 收紧到写盘之前。
test('ts 收紧：非补零 ISO-8601 被拒（non-iso-ts），补零形态照常通过', () => {
  for (const ts of ['2026-9-9', '2026/09/09', '2026/9/9', '09/09/2026']) {
    const r = validateAtom(base({ ts }));
    assert.equal(r.ok, false, ts);
    const hit = r.errors.find(e => e.field === 'ts');
    assert.equal(hit.code, 'non-iso-ts', ts);
    assert.match(hit.message, /zero-padded ISO-8601/, ts);
  }
  // 两个码不合并：'not-a-date' 说「解析不了」，非补零说「没补零」
  assert.ok(codes(validateAtom(base({ ts: 'not-a-date' }))).includes('invalid-ts'));
  assert.equal(codes(validateAtom(base({ ts: 'not-a-date' }))).includes('non-iso-ts'), false);
  for (const ts of ['2026-09-09T08:00:00Z', '2026-09-09T08:00:00.000Z', '2026-09-09T08:00:00+08:00']) {
    assert.equal(validateAtom(base({ ts })).ok, true, ts);
  }
  // 判据导出给记录层复用（lib/journal.js 的 appendJournalRecord 用同一份）
  assert.equal(isPaddedIsoTs('2026-09-09T08:00:00Z'), true);
  for (const ts of ['2026-9-9', '2026/09/09', 'not-a-date', '', '   ', undefined, null, 20260909]) {
    assert.equal(isPaddedIsoTs(ts), false, JSON.stringify(ts));
  }
  // normalizeAtom 同样拒（校验不过就不产出规范化原子）
  assert.equal(normalizeAtom(base({ ts: '2026-9-9' })).ok, false);
});

test('status 仅四态；confirmed 必须带 confirmed_by', () => {
  assert.deepEqual([...ATOM_STATUSES], ['draft', 'confirmed', 'disputed', 'superseded']);
  for (const s of ATOM_STATUSES) {
    const a = base({ status: s });
    if (s === 'confirmed') a.confirmed_by = 'owner';
    assert.equal(validateAtom(a).ok, true, s);
  }
  assert.ok(codes(validateAtom(base({ status: 'done' }))).includes('invalid-status'));
  assert.ok(codes(validateAtom(base({ status: 'confirmed' }))).includes('confirmed-requires-confirmed_by'));
  assert.ok(codes(validateAtom(base({ status: 'confirmed', confirmed_by: '  ' }))).includes('confirmed-requires-confirmed_by'));
  assert.equal(validateAtom(base({ status: 'confirmed', confirmed_by: 'owner', confirmed_at: '2026-09-09T09:00:00Z' })).ok, true);
  // 缺 status = 合法（存量原子无该字段）
  assert.equal(validateAtom(base()).ok, true);
});

test('pitfall 缺 problem/fix/prevention 任一 → 非法（每项独立报错）', () => {
  const ok = base({ kind: 'pitfall', title: 't', problem: 'p', fix: 'f', prevention: 'v' });
  assert.equal(validateAtom(ok).ok, true);
  for (const missing of PITFALL_FIELDS) {
    const a = { ...ok };
    delete a[missing];
    assert.equal(validateAtom(a).ok, false, missing);
    assert.ok(codes(validateAtom(a)).includes(`pitfall-missing-${missing}`));
    const blank = { ...ok, [missing]: '  ' };
    assert.ok(codes(validateAtom(blank)).includes(`pitfall-missing-${missing}`));
  }
  // 非 pitfall 的 kind 不要求这三字段
  assert.equal(validateAtom(base()).ok, true);
});

test('可选字段类型校验：facets/refs/commit/enriched/confidence', () => {
  const good = base({
    commit: null, enriched: true, confidence: 'EXTRACTED', source: 'agent',
    facets: { component: ['lib'], flow: [], theme: [] },
    refs: { files: ['lib/a.js'], pitfall: null, related: [], anchors: ['runAuto @ lib/runner.js:77'], supersedes: 'x' },
  });
  assert.equal(validateAtom(good).ok, true);
  assert.ok(codes(validateAtom(base({ why: 42 }))).includes('invalid-type'));
  assert.ok(codes(validateAtom(base({ enriched: 'yes' }))).includes('invalid-type'));
  assert.ok(codes(validateAtom(base({ confidence: 'GUESSED' }))).includes('invalid-confidence'));
  assert.ok(codes(validateAtom(base({ facets: { component: 'lib' } }))).includes('invalid-type'));
  assert.ok(codes(validateAtom(base({ refs: { files: [1] } }))).includes('invalid-type'));
  assert.ok(codes(validateAtom(base({ refs: { pitfall: 7 } }))).includes('invalid-type'));
  assert.ok(codes(validateAtom(base({ commit: 7 }))).includes('invalid-type'));
  assert.ok(codes(validateAtom(null)).includes('not-an-object'));
  assert.ok(codes(validateAtom([])).includes('not-an-object'));
});

test('validateAtom 不改入参、不抛', () => {
  const a = base({ facets: { component: ['lib', 'lib'] } });
  const snapshot = JSON.stringify(a);
  validateAtom(a);
  assert.equal(JSON.stringify(a), snapshot);
});

// status 缺省补 draft **只对机器来源**（审计 D6/D9）：无差别补会把 owner 手写的原子标成机器草稿。
test('normalizeAtom: 机器来源（agent|miner|hook）缺 status → draft；人工/历史来源保持无 status', () => {
  assert.deepEqual([...MACHINE_SOURCES], ['agent', 'miner', 'hook']);
  assert.equal(isMachineSource('agent'), true);
  assert.equal(isMachineSource('agent:dsh'), true);                     // §3.2 的 source 形如 agent:dsh
  assert.equal(isMachineSource('hook:post-commit'), true);
  assert.equal(isMachineSource('miner'), true);
  assert.equal(isMachineSource('human'), false);
  assert.equal(isMachineSource('owner'), false);
  assert.equal(isMachineSource('commit'), false);
  assert.equal(isMachineSource(''), false);
  assert.equal(isMachineSource(undefined), false);

  for (const source of ['agent', 'agent:dsh', 'miner', 'hook:post-commit']) {
    const r = normalizeAtom(base({ source }));
    assert.equal(r.ok, true, source);
    assert.equal(r.atom.status, 'draft', source);
  }
  for (const over of [{ source: 'human' }, { source: 'owner' }, { source: '' }, {}]) {
    const r = normalizeAtom(base(over));
    assert.equal(r.ok, true);
    assert.equal('status' in r.atom, false, JSON.stringify(over));      // 不补 = 无 status 键
  }
  // 显式 status 永不被覆盖（机器来源写了 confirmed 也照原样回传——合法性由 validateAtom 管）
  assert.equal(normalizeAtom(base({ source: 'agent', status: 'disputed' })).atom.status, 'disputed');
  assert.equal(normalizeAtom(base({ source: 'human', status: 'confirmed', confirmed_by: 'owner' })).atom.status, 'confirmed');
});

test('normalizeAtom: 未知字段保留、facets/refs 补空壳、数组保序去重（status 见机器来源专测）', () => {
  const a = base({
    custom_field: { nested: [1, 2] },
    extra: 'keep me',
    facets: { component: ['lib', 'lib', 'site'], customFacet: ['x'] },
    refs: { files: ['a.js', 'a.js'], related: ['commit:x'], weird: true },
  });
  const r = normalizeAtom(a);
  assert.equal(r.ok, true);
  assert.deepEqual(r.atom.custom_field, { nested: [1, 2] });      // 未知字段不丢
  assert.equal(r.atom.extra, 'keep me');
  assert.deepEqual(r.atom.facets.component, ['lib', 'site']);      // 保序去重
  assert.deepEqual(r.atom.facets.customFacet, ['x']);              // 未知 facets 键也保留
  assert.deepEqual(r.atom.facets.flow, []);                        // 补空壳
  assert.deepEqual(r.atom.refs.files, ['a.js']);
  assert.equal(r.atom.refs.pitfall, null);
  assert.equal(r.atom.refs.weird, true);
  assert.equal('status' in r.atom, false);                         // 无 source → 不补 status（人工/历史原子）
  assert.equal(a.status, undefined);                               // 不改入参
  assert.equal(normalizeAtom(base({ status: 'disputed' })).atom.status, 'disputed');   // 显式值不覆盖
});

test('normalizeAtom: 非法原子 → ok:false 且不产出 atom', () => {
  const r = normalizeAtom(base({ kind: 'nope' }));
  assert.equal(r.ok, false);
  assert.equal(r.atom, null);
  assert.ok(r.errors.length > 0);
});

test('parseAtom: 坏 JSON 不抛、合法行通过', () => {
  assert.equal(parseAtom('{"id":').ok, false);
  assert.ok(parseAtom('{"id":').errors.some(e => e.code === 'bad-json'));
  const line = JSON.stringify(base());
  const r = parseAtom(line);
  assert.equal(r.ok, true);
  assert.equal(r.atom.title, 'lore 定位：wiki 保留，差异化做 owner 理解层');
});

test('存量原子全通过校验（490 条向后兼容，不因新增 schema 变红）', () => {
  const atoms = readAllAtoms('.lore/journal');
  assert.ok(atoms.length > 400, `expected the repo journal to be non-trivial, got ${atoms.length}`);
  const bad = [];
  for (const a of atoms) {
    const r = validateAtom(a);
    if (!r.ok) bad.push({ id: a.id, errors: r.errors });
  }
  assert.deepEqual(bad, []);
});
