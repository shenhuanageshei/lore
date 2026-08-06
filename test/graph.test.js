import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, neighbors, resolvePagePath } from '../lib/graph.js';

const atom = (over = {}) => ({
  id: 'commit:a', ts: '2026-06-06T01:00:00-07:00', kind: 'commit', commit: 'a',
  title: 't', why: '', what_changed: '',
  facets: { component: [], flow: [], theme: [] },
  refs: { files: [], pitfall: null, related: [] },
  source: 'hook', enriched: false, confidence: 'EXTRACTED',
  ...over,
});
const mf = (axes = []) => ({ axes });

test('buildGraph: empty atoms + empty manifest → empty graph', () => {
  assert.deepEqual(buildGraph([], mf([]), 'NOW'), { generated: 'NOW', nodes: [], edges: [] });
});

test('buildGraph: page nodes from manifest, INDEX axis skipped', () => {
  const manifest = mf([
    { id: 'INDEX', pages: [{ id: 'INDEX', title: 'INDEX', path: 'INDEX.md' }] },
    { id: 'component', pages: [{ id: 'lib', title: 'Lib', path: 'component/lib.md' }] },
    { id: 'docs', pages: [{ id: 'x', title: 'X', path: 'docs/x.md' }] },
  ]);
  const pageNodes = buildGraph([], manifest, 'NOW').nodes.filter(n => n.type === 'page').map(n => n.id);
  assert.deepEqual(pageNodes.sort(), ['page:component/lib', 'page:docs/x']);
});

test('buildGraph: atom nodes carry type/kind/title/ts', () => {
  const a = atom({ id: 'commit:x', kind: 'commit', title: 'feat: x', ts: '2026-06-06T02:00:00-07:00' });
  const d = atom({ id: 'decision:y', kind: 'decision', commit: null, title: 'chose X' });
  const nodes = buildGraph([a, d], mf([]), 'NOW').nodes;
  assert.deepEqual(nodes.find(n => n.id === 'commit:x'),
    { id: 'commit:x', type: 'atom', kind: 'commit', title: 'feat: x', ts: '2026-06-06T02:00:00-07:00' });
  assert.equal(nodes.find(n => n.id === 'decision:y').kind, 'decision');
});

test('buildGraph: facet edge only when target page exists (dangling dropped)', () => {
  const manifest = mf([{ id: 'component', pages: [{ id: 'lib', title: 'Lib', path: 'component/lib.md' }] }]);
  const a = atom({ id: 'commit:x', facets: { component: ['lib', 'ghost'], flow: [], theme: [] } });
  const facet = buildGraph([a], manifest, 'NOW').edges.filter(e => e.type === 'facet');
  assert.deepEqual(facet, [{ from: 'commit:x', to: 'page:component/lib', type: 'facet' }]);
});

test('buildGraph: refs_related edge only when target atom exists (dangling dropped)', () => {
  const x = atom({ id: 'commit:x', refs: { files: [], pitfall: null, related: ['commit:y', 'commit:gone'] } });
  const y = atom({ id: 'commit:y' });
  const rel = buildGraph([x, y], mf([]), 'NOW').edges.filter(e => e.type === 'refs_related');
  assert.deepEqual(rel, [{ from: 'commit:x', to: 'commit:y', type: 'refs_related' }]);
});

test('buildGraph: facet edges across flow/theme axes', () => {
  const manifest = mf([
    { id: 'flow', pages: [{ id: 'pipe', title: 'Pipe', path: 'flow/pipe.md' }] },
    { id: 'theme', pages: [{ id: 'quality', title: 'Quality', path: 'theme/quality.md' }] },
  ]);
  const a = atom({ id: 'commit:x', facets: { component: [], flow: ['pipe'], theme: ['quality'] } });
  const facet = buildGraph([a], manifest, 'NOW').edges.filter(e => e.type === 'facet').map(e => e.to).sort();
  assert.deepEqual(facet, ['page:flow/pipe', 'page:theme/quality']);
});

test('neighbors: out+in edges, dir + edge type, type/title from node', () => {
  const graph = {
    nodes: [
      { id: 'commit:x', type: 'atom', kind: 'commit', title: 'feat: x', ts: '' },
      { id: 'commit:y', type: 'atom', kind: 'commit', title: 'feat: y', ts: '' },
      { id: 'page:component/lib', type: 'page', axis: 'component', title: 'Lib', path: 'component/lib.md' },
    ],
    edges: [
      { from: 'commit:x', to: 'page:component/lib', type: 'facet' },
      { from: 'commit:x', to: 'commit:y', type: 'refs_related' },
      { from: 'commit:y', to: 'commit:x', type: 'refs_related' },
    ],
  };
  const nb = neighbors(graph, 'commit:x');
  assert.equal(nb.length, 3);
  assert.ok(nb.some(n => n.id === 'page:component/lib' && n.edge === 'facet' && n.dir === 'out' && n.type === 'page' && n.title === 'Lib'));
  assert.ok(nb.some(n => n.id === 'commit:y' && n.edge === 'refs_related' && n.dir === 'out'));
  assert.ok(nb.some(n => n.id === 'commit:y' && n.edge === 'refs_related' && n.dir === 'in'));
});

test('neighbors: unknown node → []', () => {
  assert.deepEqual(neighbors({ nodes: [], edges: [] }, 'nope'), []);
});

test('resolvePagePath: page id → path; plain path passthrough; unknown page id → null', () => {
  const graph = { nodes: [{ id: 'page:component/lib', type: 'page', path: 'component/lib.md' }], edges: [] };
  assert.equal(resolvePagePath(graph, 'page:component/lib'), 'component/lib.md');
  assert.equal(resolvePagePath(graph, 'component/lib.md'), 'component/lib.md');
  assert.equal(resolvePagePath(graph, 'page:component/ghost'), null);
});

test('buildGraph: theme parent → child adds contains edge (both traversal directions)', () => {
  const manifest = mf([
    { id: 'theme', pages: [
      { id: 'p', title: 'P', path: 'theme/p.md' },
      { id: 'p--c1', title: 'C1', parent: 'p', kind: 'deep', path: 'theme/p--c1.md' },
      { id: 'p--ghost', title: 'G', parent: 'p', kind: 'deep', path: 'theme/p--ghost.md' },
    ] },
    { id: 'component', pages: [{ id: 'lib', title: 'Lib', path: 'component/lib.md' }] },
  ]);
  const g = buildGraph([], manifest, 'NOW');
  const contains = g.edges.filter(e => e.type === 'contains');
  assert.deepEqual(contains, [
    { from: 'page:theme/p', to: 'page:theme/p--c1', type: 'contains' },
    { from: 'page:theme/p', to: 'page:theme/p--ghost', type: 'contains' },
  ]);
  // neighbors 双向：父→子（out），子→父（in）
  const childNeighbors = neighbors(g, 'page:theme/p--c1');
  assert.ok(childNeighbors.some(n => n.id === 'page:theme/p' && n.dir === 'in' && n.edge === 'contains'));
  const parentNeighbors = neighbors(g, 'page:theme/p');
  assert.ok(parentNeighbors.some(n => n.id === 'page:theme/p--c1' && n.dir === 'out' && n.edge === 'contains'));
  // 悬挂边（父页不存在）丢弃
  const g2 = buildGraph([], mf([{ id: 'theme', pages: [{ id: 'orphan--c', title: 'C', parent: 'orphan', path: 'theme/orphan--c.md' }] }]), 'NOW');
  assert.equal(g2.edges.filter(e => e.type === 'contains').length, 0);
});
