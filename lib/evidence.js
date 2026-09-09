// lib/evidence.js —— ① 期 S4 证据账本（设计 §7① / 不变量⑧「证据锚定 + 不确定性显式」）。
//
// 目的：为**每条面向人的结论**（kind: decision | rejected | correction）列账——
//   来源 / 定位（refs.anchors）/ 时间 / 置信 / 确认人，让「这条结论凭什么信」在裸终端一眼可查。
//
// 纪律（验收口径，计划 S4）：
//   · 每条结论在账本里有且只有一行；口径与 doctor 的噪音分布**同源**（都走 lib/noise.js 的分类器），
//     所以「doctor 说 high 的原子」在账本里必定标「低置信」，不会两处各算一套。
//   · 缺 refs.anchors → 显式标「未验证」（不变量⑧：不得渲染成确定事实）。**不猜、不回填、不省略**。
//   · 噪音 level=high → 标「低置信」（与「未验证」是两个独立维度：可同时成立，两个都显示）。
//   · 来源诚实（不变量⑦）：来源未署名的确认（confirmed_by 缺失/空/'unattributed'）单列计数，
//     与 doctor 的 confirmation.unattributed **同一口径**（都走 lib/confirm.js 的 isUnattributedConfirmation）。
//   · 只读：本模块只读 journal（append-only 记录层），绝不写 .lore 任何字节。
//   · --json 不含 .lore/human/ 的 per-human 存储内容（评审 🔵#8）：本模块**不 import** lib/human.js，
//     也不读 .lore/human/；确认人来自 journal 内的 confirmation 记录（记录层，属公开历史）。
//   · 确定性：同一份 journal 两次跑出同样的账（排序按 ts/id 稳定排序，不读挂钟除 generatedAt）。
//
// 本模块不做 CLI 分发（在 lib/cli.js）、不复制确认派生（在 lib/confirm.js）、不复制噪音判级（在 lib/noise.js）。

import { join, resolve } from 'node:path';
import { readAllAtoms } from './journal.js';
import { classifyAtoms } from './noise.js';
import { confirmerOf, countUnattributedConfirmations, deriveStatuses, readConfirmations } from './confirm.js';

// 账本形状版本（--json / 下游消费方的稳定契约；字段只增不改语义）。
export const EVIDENCE_SCHEMA_VERSION = 1;
// 「面向人的结论」= 这三类原子（设计 §3.1 的 kind 词表；commit/question/evidence/pitfall 不进账本）。
export const EVIDENCE_KINDS = Object.freeze(['decision', 'rejected', 'correction']);
// 置信档位（稳定词表）：unverified = 无锚点（不变量⑧）；low = 噪音 high；normal = 有锚点且噪音非 high。
export const CONFIDENCE_LEVELS = Object.freeze(['unverified', 'low', 'normal']);

const isNonEmptyStr = v => typeof v === 'string' && v.trim() !== '';
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function isEvidenceAtom(atom) {
  return isPlainObject(atom) && EVIDENCE_KINDS.includes(atom.kind);
}

// refs.anchors → 干净字符串数组（非数组 / 非字符串 / 空白项一律丢掉：账本不显示无法定位的东西）。
export function anchorsOf(atom) {
  const raw = isPlainObject(atom) && isPlainObject(atom.refs) ? atom.refs.anchors : null;
  return Array.isArray(raw) ? raw.filter(isNonEmptyStr).map(a => a.trim()) : [];
}

// 置信判定（两个独立维度 + 一个显示档位）：
//   verification  verified（有锚点）/ unverified（无锚点——显式标「未验证」）
//   lowConfidence 噪音 level === 'high'（与 doctor 同源）
//   confidence    显示档位：无锚点优先（unverified）> 低置信（low）> normal
export function confidenceOf(anchors = [], noiseLevel = 'none') {
  const verified = Array.isArray(anchors) && anchors.length > 0;
  const low = noiseLevel === 'high';
  return {
    verification: verified ? 'verified' : 'unverified',
    lowConfidence: low,
    confidence: !verified ? 'unverified' : (low ? 'low' : 'normal'),
  };
}

// 账本条目（纯函数；输入 = 原子全集 + 确认记录全集）。
// noise 必须在**全集**上分类（重复摘要检测是集合性质的），再取本条的级别——与 doctor 同一口径。
export function evidenceEntries(atoms = [], confirmations = []) {
  const list = Array.isArray(atoms) ? atoms : [];
  const noise = classifyAtoms(list);
  const derived = deriveStatuses(list, confirmations);
  const rows = [];
  list.forEach((atom, i) => {
    if (!isEvidenceAtom(atom)) return;
    const anchors = anchorsOf(atom);
    const n = noise[i] ?? { level: 'none', reasons: [] };
    const c = confidenceOf(anchors, n.level);
    const d = derived[i];
    const conf = d.confirmation;
    rows.push({
      id: isNonEmptyStr(atom.id) ? atom.id : '',
      kind: atom.kind,
      title: isNonEmptyStr(atom.title) ? atom.title : '',
      ts: isNonEmptyStr(atom.ts) ? atom.ts : null,
      source: isNonEmptyStr(atom.source) ? atom.source : null,
      anchors,
      verification: c.verification,
      lowConfidence: c.lowConfidence,
      confidence: c.confidence,
      noise: { level: n.level, reasons: [...n.reasons] },
      status: d.status,                        // 派生有效状态（内联 status 被最新确认覆盖）
      statusFrom: d.from,                      // confirmation | inline | none
      confirmer: confirmerOf(atom, d),         // 来自 confirmation 记录（记录层），无则回退内联
      confirmedAt: conf && isNonEmptyStr(conf.confirmed_at) ? conf.confirmed_at : null,
      verdict: conf && isNonEmptyStr(conf.verdict) ? conf.verdict : null,
    });
  });
  // 稳定排序（不读挂钟、不依赖文件遍历顺序）：ts 升序（不可解析者排最后），同 ts 按 id。
  const key = r => (r.ts !== null && Number.isFinite(Date.parse(r.ts)) ? Date.parse(r.ts) : Infinity);
  return rows.map((r, i) => ({ r, i }))
    .sort((a, b) => (key(a.r) - key(b.r)) || (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0) || (a.i - b.i))
    .map(x => x.r);
}

// confirmations 参数 = journal 里的确认记录全集：未署名计数是**记录层**口径（不属于某一条结论），
// 所以按记录数而不是按账本行数算——与 doctor 的 confirmation.unattributed 逐字同源。
export function countEvidence(entries = [], confirmations = []) {
  const list = Array.isArray(entries) ? entries : [];
  const byKind = {};
  for (const k of EVIDENCE_KINDS) byKind[k] = 0;
  let unverified = 0, lowConfidence = 0;
  for (const e of list) {
    if (byKind[e.kind] !== undefined) byKind[e.kind]++;
    if (e.verification === 'unverified') unverified++;
    if (e.lowConfidence) lowConfidence++;
  }
  return {
    total: list.length, byKind, unverified, lowConfidence,
    unattributedConfirmations: countUnattributedConfirmations(confirmations),
  };
}

// 只读报告：读 journal 的原子 + 确认记录，产出账本（**不读** .lore/human/，不写任何文件）。
export function evidenceReport(repoRoot, { now = new Date() } = {}) {
  const root = resolve(repoRoot);
  const journalDir = join(root, '.lore', 'journal');
  const atoms = readAllAtoms(journalDir);
  const confirmations = readConfirmations(journalDir);
  const entries = evidenceEntries(atoms, confirmations);
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    root,
    journal: journalDir,
    initialized: atoms.length > 0 || confirmations.length > 0,
    counts: countEvidence(entries, confirmations),
    entries,
  };
}

// ---------- 人读渲染（列：时间 / 来源 / 定位 / 置信 / 确认人；与 --json 同源，不各算一遍） ----------
export function formatEvidence(report) {
  const { root, journal, counts, entries } = report;
  const lines = [];
  lines.push('lore evidence — ' + root);
  lines.push('  journal    ' + journal);
  const c = counts ?? { total: 0, byKind: {}, unverified: 0, lowConfidence: 0, unattributedConfirmations: 0 };
  const kindText = EVIDENCE_KINDS.map(k => k + ' ' + (c.byKind?.[k] ?? 0)).join(' · ');
  lines.push('  结论 ' + c.total + ' 条（' + kindText + '）· 未验证 ' + c.unverified + ' · 低置信 ' + c.lowConfidence
    + ' · 未署名确认 ' + (c.unattributedConfirmations ?? 0));
  if (!entries || entries.length === 0) {
    lines.push('  （无结论原子：kind ' + EVIDENCE_KINDS.join('|') + '）');
    return lines.join('\n');
  }
  lines.push('');
  for (const e of entries) {
    lines.push('  · ' + e.id + (e.title ? ' — ' + e.title : ''));
    const parts = [e.ts ?? 'unknown', '来源 ' + (e.source ?? 'unknown')];
    if (e.status) parts.push('状态 ' + e.status);
    if (e.confirmer) parts.push('确认人 ' + e.confirmer + (e.confirmedAt ? ' @ ' + e.confirmedAt : ''));
    // 定位：有锚点列锚点；无锚点**显式**标未验证（不变量⑧），绝不省略该行
    parts.push(e.verification === 'unverified'
      ? '定位 未验证（无 refs.anchors）'
      : '定位 ' + e.anchors.join('；'));
    // 置信：high 噪音标低置信并写明原因码（与 doctor 的噪音分布同源）
    parts.push(e.lowConfidence
      ? '置信 低（噪音 high' + (e.noise.reasons.length ? ': ' + e.noise.reasons.join(',') : '') + '）'
      : '置信 ' + (e.confidence === 'unverified' ? '未验证' : '正常'));
    lines.push('    ' + parts.join(' · '));
  }
  return lines.join('\n');
}
