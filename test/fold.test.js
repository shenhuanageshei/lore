import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldAtoms } from '../lib/fold.js';

// 真实 atom 形状的最小工厂；over 覆盖单个字段
const atom = (over = {}) => ({
  id: 'commit:aaa', ts: '2026-06-06T01:00:00-07:00', kind: 'commit', commit: 'aaa',
  title: 't', why: '', what_changed: '',
  facets: { component: ['lib'], flow: [], theme: [] },
  refs: { files: [], pitfall: null, related: [] },
  source: 'hook', enriched: false, confidence: 'EXTRACTED',
  ...over,
});

test('foldAtoms: empty → empty', () => {
  assert.deepEqual(foldAtoms([]), []);
});

test('foldAtoms: single atom passes through unchanged', () => {
  const a = atom();
  assert.deepEqual(foldAtoms([a]), [a]);
});

test('foldAtoms: distinct ids kept in first-seen order', () => {
  const a = atom({ id: 'commit:a', commit: 'a' });
  const b = atom({ id: 'commit:b', commit: 'b' });
  assert.deepEqual(foldAtoms([a, b]).map(x => x.id), ['commit:a', 'commit:b']);
});

test('foldAtoms: same id merges — ts earliest, why appended, files union, pitfall last-non-null, enriched OR', () => {
  const skeleton = atom({
    id: 'commit:x', commit: 'x', ts: '2026-06-06T01:00:00-07:00',
    why: 'commit body', enriched: false,
    refs: { files: ['a.js'], pitfall: null, related: [] },
  });
  const enrichedAtom = atom({
    id: 'commit:x', commit: 'x', ts: '2026-06-06T05:00:00-07:00',
    why: 'agent rationale', enriched: true,
    refs: { files: ['b.js'], pitfall: 'watch the lock', related: ['commit:y'] },
  });
  const out = foldAtoms([skeleton, enrichedAtom]);
  assert.equal(out.length, 1);
  const m = out[0];
  assert.equal(m.ts, '2026-06-06T01:00:00-07:00');        // 基底 = 最早
  assert.equal(m.why, 'commit body\n\nagent rationale');   // 追加，不覆盖
  assert.deepEqual(m.refs.files, ['a.js', 'b.js']);        // 并集
  assert.deepEqual(m.refs.related, ['commit:y']);
  assert.equal(m.refs.pitfall, 'watch the lock');          // 最后非 null
  assert.equal(m.enriched, true);                          // OR
});

test('foldAtoms: drops orphan commit atoms (sha not in reachable set)', () => {
  const live = atom({ id: 'commit:live', commit: 'live' });
  const orphan = atom({ id: 'commit:orphan', commit: 'orphan' });
  const out = foldAtoms([live, orphan], { reachableShas: new Set(['live']) });
  assert.deepEqual(out.map(x => x.id), ['commit:live']);
});

test('foldAtoms: no reachableShas (omitted / {} / null) → nothing dropped', () => {
  const orphan = atom({ id: 'commit:orphan', commit: 'orphan' });
  assert.equal(foldAtoms([orphan]).length, 1);
  assert.equal(foldAtoms([orphan], {}).length, 1);
  assert.equal(foldAtoms([orphan], { reachableShas: null }).length, 1);
});

test('foldAtoms: decision atoms (kind!=commit, commit=null) never dropped by reachability', () => {
  const decision = atom({ id: 'note:1', kind: 'decision', commit: null, enriched: true });
  const out = foldAtoms([decision], { reachableShas: new Set() });   // 空集 = 啥都不可达
  assert.deepEqual(out.map(x => x.id), ['note:1']);
});

test('foldAtoms: amend biting — orphan(old) + reborn(new), same title diff id → only reborn survives', () => {
  const oldA = atom({ id: 'commit:old', commit: 'old', title: 'feat: widget', ts: '2026-06-06T01:00:00-07:00' });
  const reborn = atom({ id: 'commit:new', commit: 'new', title: 'feat: widget', ts: '2026-06-06T01:00:01-07:00' });
  const out = foldAtoms([oldA, reborn], { reachableShas: new Set(['new']) });
  assert.deepEqual(out.map(x => x.id), ['commit:new']);
});
