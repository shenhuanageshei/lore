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
