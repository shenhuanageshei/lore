// test/atom.test.js —— ⓪ 期 S1：六类原子 schema 与校验器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATOM_KINDS, ATOM_STATUSES, COMPREHENSION_KINDS, PITFALL_FIELDS,
  isKnownKind, requiresTitle, validateAtom, normalizeAtom, parseAtom,
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

test('normalizeAtom: 未知字段保留、facets/refs 补空壳、status 缺省 draft、数组保序去重', () => {
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
  assert.equal(r.atom.status, 'draft');                            // 缺省草稿
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
