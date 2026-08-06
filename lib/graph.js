// agent 图数据层（纯函数）：journal 原子 + wiki 页 → { nodes, edges }。
// 节点：原子（commit/decision）+ 页（跳过 INDEX 轴）。
// 边：facet（原子→component/flow/theme 页）、refs_related（原子→原子）。悬挂边丢弃。
// 无 IO；now 由调用方注入（确定性，不在纯函数里取时钟）。

const FACET_AXES = ['component', 'flow', 'theme'];

export function buildGraph(atoms, manifest, now) {
  const nodes = [];
  const edges = [];
  const pageIds = new Set();
  const atomIds = new Set();

  // 页节点（跳过 INDEX 轴）
  for (const ax of manifest.axes ?? []) {
    if (ax.id === 'INDEX') continue;
    for (const p of ax.pages ?? []) {
      const id = `page:${ax.id}/${p.id}`;
      pageIds.add(id);
      nodes.push({ id, type: 'page', axis: ax.id, title: p.title ?? p.id, path: p.path });
    }
  }

  // 原子节点
  for (const a of atoms) {
    atomIds.add(a.id);
    nodes.push({ id: a.id, type: 'atom', kind: a.kind, title: a.title ?? '', ts: a.ts ?? '' });
  }

  // 边（悬挂目标丢弃）
  for (const a of atoms) {
    for (const axis of FACET_AXES) {
      for (const v of (a.facets?.[axis] ?? [])) {
        const to = `page:${axis}/${v}`;
        if (pageIds.has(to)) edges.push({ from: a.id, to, type: 'facet' });
      }
    }
    for (const rid of (a.refs?.related ?? [])) {
      if (atomIds.has(rid)) edges.push({ from: a.id, to: rid, type: 'refs_related' });
    }
  }

  // 结构边：theme 父页 → 子页（manifest parent 元数据；双向遍历经 neighbors，悬挂目标丢弃）
  for (const ax of manifest.axes ?? []) {
    if (ax.id === 'INDEX') continue;
    for (const p of ax.pages ?? []) {
      if (!p.parent) continue;
      const from = `page:${ax.id}/${p.parent}`;
      const to = `page:${ax.id}/${p.id}`;
      if (pageIds.has(from) && pageIds.has(to)) edges.push({ from, to, type: 'contains' });
    }
  }

  return { generated: now, nodes, edges };
}

// 某节点的 1-hop 邻居：from===id 为 out 边，to===id 为 in 边。
export function neighbors(graph, nodeId) {
  const byId = new Map((graph.nodes ?? []).map(n => [n.id, n]));
  const out = [];
  for (const e of (graph.edges ?? [])) {
    if (e.from === nodeId) {
      const n = byId.get(e.to);
      out.push({ id: e.to, type: n?.type ?? '', title: n?.title ?? '', edge: e.type, dir: 'out' });
    } else if (e.to === nodeId) {
      const n = byId.get(e.from);
      out.push({ id: e.from, type: n?.type ?? '', title: n?.title ?? '', edge: e.type, dir: 'in' });
    }
  }
  return out;
}

// page node id（page:<axis>/<id>）→ wiki 相对 path；非 page: 前缀 → 原样当 path；未知 page id → null。
export function resolvePagePath(graph, id) {
  if (typeof id === 'string' && id.startsWith('page:')) {
    const n = (graph.nodes ?? []).find(x => x.id === id);
    return n ? n.path : null;
  }
  return id;
}
