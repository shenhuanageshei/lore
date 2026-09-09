// lib/note.js
import { appendAtom } from './journal.js';
import { whyField } from './fold.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export function noteAtom({ id, ts, title, why, component = [], flow = [], theme = [], files = [] }) {
  return {
    id,
    ts,
    kind: 'decision',
    commit: null,
    title,
    ...whyField(why),   // 写入侧纪律：剥掉 trailer 后无正文 → 不写 why 键（不变量⑦）
    what_changed: '',
    facets: { component, flow, theme },
    refs: { files, pitfall: null, related: [] },
    source: 'agent',
    enriched: true,
    confidence: 'EXTRACTED',
  };
}

// enrich 已有 commit 骨架（母 §4② 后半）：同 commit:<sha> 追加一条 enriched 原子补 why。
// append-only 神圣——不改旧行；fold 层 mergeGroup 合并（骨架 title 保留、enriched why 演化追加）。
// title 留空：firstNonEmpty 基底优先，enrich 不抢骨架标题。
export function enrichAtom({ sha, ts, why, files = [] }) {
  return {
    id: `commit:${sha}`,
    ts,
    kind: 'commit',
    commit: sha,
    title: '',
    ...whyField(why),
    what_changed: '',
    facets: { component: [], flow: [], theme: [] },   // facets 不参与合并（mergeGroup 用基底的），不收
    refs: { files, pitfall: null, related: [] },
    source: 'agent',
    enriched: true,
    confidence: 'EXTRACTED',
  };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args._[0] ?? process.cwd();
  const list = s => (s ? s.split(',').map(x => x.trim()).filter(Boolean) : []);
  if (args.enrich) {
    if (!args.why) { console.error('lore: --enrich needs --why (the rationale to append)'); process.exit(1); }
    let fullSha;
    try { fullSha = execFileSync('git', ['rev-parse', args.enrich], { cwd: repoRoot, windowsHide: true }).toString().trim(); }
    catch { console.error(`lore: cannot resolve "${args.enrich}" to a commit in ${repoRoot}`); process.exit(1); }
    const atom = enrichAtom({ sha: fullSha, ts: new Date().toISOString(), why: args.why, files: list(args.files) });
    appendAtom(join(repoRoot, '.lore', 'journal'), atom);
    console.log(`✓ enriched commit:${fullSha.slice(0, 7)} (why appended; fold merges on next sync)`);
    process.exit(0);
  }
  const atom = noteAtom({
    id: `note:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    title: args.title ?? '',
    why: args.why ?? '',
    component: list(args.component),
    flow: list(args.flow),
    theme: list(args.theme),
    files: list(args.files),
  });
  appendAtom(join(repoRoot, '.lore', 'journal'), atom);
  console.log(`✓ noted decision atom ${atom.id}`);
}
