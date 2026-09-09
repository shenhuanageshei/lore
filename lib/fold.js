// 决策史折叠层（纯函数，不改 ndjson）。
// 两阶段：① 按 git 可达性丢 amend/rebase 孤儿 commit 原子（Task 2）；② 同 id 多条合并成一条。
// git I/O（可达 sha 集合）由调用方注入，保持本函数纯、可测。

// 并集去重，保持首次出现顺序。
function union(arrays) {
  const out = [], seen = new Set();
  for (const arr of arrays) for (const x of (arr ?? [])) {
    if (!seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}

// 合并同 id 的一组原子（≥1 条）成一条。基底 = ts 最早那条
// （决策史时间线位置不随后续 enrich 改变）。
function mergeGroup(group) {
  if (group.length === 1) return group[0];
  const sorted = [...group].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const base = sorted[0];

  // why：基底起头，追加后续 enriched 原子里不同的非空 why（留 skeleton→enriched 演化痕迹）
  const whys = [];
  const pushWhy = (w) => { const t = (w ?? '').trim(); if (t && !whys.includes(t)) whys.push(t); };
  pushWhy(base.why);
  for (const a of sorted.slice(1)) if (a.enriched) pushWhy(a.why);

  // 基底优先、空则后续首个非空
  const firstNonEmpty = (key) => {
    for (const a of sorted) { const v = a[key]; if (v != null && v !== '') return v; }
    return base[key];
  };

  let pitfall = base.refs?.pitfall ?? null;
  for (const a of sorted) if (a.refs?.pitfall != null) pitfall = a.refs.pitfall;

  return {
    ...base,
    title: firstNonEmpty('title'),
    why: whys.join('\n\n'),
    what_changed: firstNonEmpty('what_changed'),
    refs: {
      ...base.refs,
      files: union(sorted.map(a => a.refs?.files)),
      related: union(sorted.map(a => a.refs?.related)),
      pitfall,
    },
    enriched: sorted.some(a => a.enriched),
  };
}

export function foldAtoms(atoms, { reachableShas } = {}) {
  // ① dropOrphans —— 仅当传入 reachableShas(Set) 时过滤孤儿 commit 原子。
  // null/undefined → 不过滤；decision 原子(kind!=commit 或 commit=null) 恒保留。
  const kept = reachableShas instanceof Set
    ? atoms.filter(a => !(a.kind === 'commit' && a.commit && !reachableShas.has(a.commit)))
    : atoms;

  // ② mergeById —— 按 id 分组，保持首次出现顺序
  const order = [];
  const groups = new Map();
  for (const a of kept) {
    if (!groups.has(a.id)) { groups.set(a.id, []); order.push(a.id); }
    groups.get(a.id).push(a);
  }
  return order.map(id => mergeGroup(groups.get(id)));
}

// 剥 git trailer / 生成器签名噪音（写入侧 + 渲染侧共用同一份规则）。
// 剥两类：① `-by:` 家族（Co-Authored-By / Signed-off-by …）；
// ② 生成器签名行（`🤖 Generated with [Claude Code](…)`、`Generated with Codex`）。
// Note:/Fixes:/中文冒号等可能有信息量的行不动（YAGNI）。
// mine/note/hook 在写入侧用（新原子 why 干净）；renderDecisionHistory 也用（防御已落盘的旧原子）。
const TRAILER_RES = [
  /^[a-z][a-z0-9-]*-by:\s/i,
  /^[^\p{L}\p{N}]*generated with\b/iu,   // 只允许 emoji/空白/标点前缀（🤖 Generated with …）；中文行首词不误伤
];
export function stripTrailers(body) {
  return (body ?? '').split('\n').filter(l => !TRAILER_RES.some(re => re.test(l.trim()))).join('\n').trim();
}

// 写入侧纪律（不变量⑦「无正文不写 why」）：why 键只在剥掉 trailer 后仍有正文时出现。
// 返回 `{}` 或 `{why}`，供原子构造器展开——避免写入空串 why（那等于"看起来有正文"）。
export function whyField(body) {
  const why = stripTrailers(body);
  return why ? { why } : {};
}
