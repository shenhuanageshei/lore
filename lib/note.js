// lib/note.js
import { appendAtom, AtomRejected } from './journal.js';
import { whyField } from './fold.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// draft=true（S8：agent 代捕获约定）→ 显式写 status:'draft'。机器来源（source:'agent'）只能是草稿，
// 只有 owner 的直接动作能产生 confirmed（设计 §3.2；S1 校验器同口径）。
// 不给 draft（默认）→ 与既有原子形状逐字一致（不加 status 键），既有调用方/测试行为不变。
export function noteAtom({ id, ts, title, why, component = [], flow = [], theme = [], files = [], anchors = [], draft = false }) {
  return {
    id,
    ts,
    kind: 'decision',
    commit: null,
    title,
    ...(draft ? { status: 'draft' } : {}),
    ...whyField(why),   // 写入侧纪律：剥掉 trailer 后无正文 → 不写 why 键（不变量⑦）
    what_changed: '',
    facets: { component, flow, theme },
    // anchors（源码锚点 `fn @ file:line`）非空才写键——空数组会与既有 refs 形状漂移（S1 refs 契约）
    refs: { files, pitfall: null, related: [], ...(anchors.length ? { anchors } : {}) },
    source: 'agent',
    enriched: true,
    confidence: 'EXTRACTED',
  };
}

// note 原子 id（CLI 层唯一允许用挂钟/随机的地方；noteAtom 本身接 id+ts，保持纯、可测）。
export function newNoteId(ms = Date.now(), rand = Math.random) {
  return `note:${ms.toString(36)}${rand().toString(36).slice(2, 8)}`;
}

// 落库一条 note 原子——lib/note.js 旧入口与 lib/cli.js 的 `note` verb 共用这一条写入路径，
// 免得两处各写一份（CLI 只做参数映射，业务形状住这里）。
// 返回 **appendAtom 的返回值**（规范化后的落盘原子）：机器来源缺 status 时盘上是 draft，
// 调用方据此打印/断言，不必再读盘猜（S1 起写入经 lib/journal.js 的校验闸门）。
export function appendNote(repoRoot, fields, { now = new Date() } = {}) {
  const atom = noteAtom({ id: newNoteId(now.getTime()), ts: now.toISOString(), ...fields });
  return appendAtom(join(repoRoot, '.lore', 'journal'), atom);
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

// 布尔开关（不取值）单列——否则 `--draft` 会吞掉后面的位置参数/旗标。
const BOOLEAN_FLAGS = new Set(['draft']);
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) { out[key] = true; continue; }
      out[key] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args._[0] ?? process.cwd();
  const list = s => (s ? s.split(',').map(x => x.trim()).filter(Boolean) : []);
  // 写入被校验器拒绝（S1）→ 可读错误 + exit 1，不打印栈（那只是把同一条消息埋深一层）。
  const reject = (e) => {
    if (!(e instanceof AtomRejected)) throw e;
    console.error(`lore: ${e.message}`);
    process.exit(1);
  };
  if (args.enrich) {
    if (!args.why) { console.error('lore: --enrich needs --why (the rationale to append)'); process.exit(1); }
    let fullSha;
    try { fullSha = execFileSync('git', ['rev-parse', args.enrich], { cwd: repoRoot, windowsHide: true }).toString().trim(); }
    catch { console.error(`lore: cannot resolve "${args.enrich}" to a commit in ${repoRoot}`); process.exit(1); }
    const atom = enrichAtom({ sha: fullSha, ts: new Date().toISOString(), why: args.why, files: list(args.files) });
    try { appendAtom(join(repoRoot, '.lore', 'journal'), atom); } catch (e) { reject(e); }
    console.log(`✓ enriched commit:${fullSha.slice(0, 7)} (why appended; fold merges on next sync)`);
    process.exit(0);
  }
  let atom;
  try {
    atom = appendNote(repoRoot, {
      title: args.title ?? '',
      why: args.why ?? '',
      component: list(args.component),
      flow: list(args.flow),
      theme: list(args.theme),
      files: list(args.files),
      anchors: list(args.anchors),
      draft: args.draft === true,
    });
  } catch (e) { reject(e); }
  console.log(`✓ noted decision atom ${atom.id}${atom.status === 'draft' ? ' (draft)' : ''}`);
}
