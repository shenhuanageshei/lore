// lib/confirm.js —— owner 确认成为一等数据（① 期 S3；设计 §7① / §3.2 / 不变量③⑧）。
//
// 存储定案（设计评审 🟡#2）：确认记录落在 journal 内、独立 `kind:'confirmation'`——与原子同源、
// 天然 append-only、可审计。字段：目标 atom id / verdict / confirmed_by / confirmed_at / why?。
//
// 有效状态 = **派生视图**（设计评审 🟡#1）：
//   原子的内联 `status` 字节永不改写（不变量③：人的写入不可被机器删改，append-only）；
//   「有效状态」由最新一条 confirmation 覆盖内联 status 派生——
//     verdict 'confirm' → 'confirmed'，verdict 'dispute' → 'disputed'；无确认记录时回退内联 status。
//   派生规则同步写进设计 §3.2（docs/superpowers/specs/2026-09-09-lore-human-comprehension-and-shell-design.md）。
//
// 纪律：
//   · 只有 owner 的直接动作产生 confirmed（设计 §3.2）——所以 confirmed_by **缺省 'unattributed'**：
//     机器代写永不冒充 owner（不变量⑦ 来源诚实）；要记成 owner 必须显式署名（CLI 的 --by owner）。
//   · 每条确认记 provenance {via, by}：via = 写入入口（cli|shell|api），by = 署名者（= confirmed_by）。
//     「来源未署名的确认」在 doctor / evidence 里单列计数（机器写的确认一眼可辨，不被当成 owner 动作）。
//   · 重复确认幂等：目标原子的最新确认与本次 (verdict, why) 一致 → 不写第二行（返回 deduped）。
//   · 未知 atom id → 明确报错（ConfirmError 'unknown-atom'），绝不静默写一条指向空气的确认。
//   · why 走写入侧纪律（不变量⑦）：剥掉 trailer 后无正文 → 不写 why 键。
//
// 本文件只做确认域的形状与派生，不做 CLI 分发（分发在 lib/cli.js）、不碰落盘细节（在 lib/journal.js）。

import { CONFIRMATION_KIND, appendJournalRecord, readAllAtoms, readAllRecords } from './journal.js';
import { whyField } from './fold.js';

// 确认记录的形状版本（--json / 导出消费方的稳定契约；字段只增不改语义）。
export const CONFIRM_SCHEMA_VERSION = 1;
export const VERDICTS = Object.freeze(['confirm', 'dispute']);
export const DEFAULT_VERDICT = 'confirm';
// 确认的写入入口（provenance.via）——封闭词表，未知入口明确报错（不静默记成 cli）。
export const PROVENANCE_VIAS = Object.freeze(['cli', 'shell', 'api']);
export const DEFAULT_VIA = 'cli';
// 「未署名」= 没有人为这条确认署名（机器代写 / 未给 --by）。不变量⑦：机器推断永不冒充人类宣告。
export const UNATTRIBUTED_BY = 'unattributed';
// 署名者缺省恒为 'unattributed'——要记成 owner 必须显式署名（CLI: --by owner）。
export const DEFAULT_CONFIRMED_BY = UNATTRIBUTED_BY;
// verdict → 派生状态（设计 §3.2 的 status 词表；确认只能产出 confirmed / disputed 两种）。
export const STATUS_BY_VERDICT = Object.freeze({ confirm: 'confirmed', dispute: 'disputed' });

const VERDICT_SET = new Set(VERDICTS);
const VIA_SET = new Set(PROVENANCE_VIAS);
const isNonEmptyStr = v => typeof v === 'string' && v.trim() !== '';
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const stamp = ts => (isNonEmptyStr(ts) ? ts : new Date().toISOString());

export class ConfirmError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfirmError';
    this.code = code;
  }
}

// 确认记录 id（CLI 层唯一允许用挂钟/随机的地方；confirmationRecord 本身接 id+ts，保持纯、可测）。
export function newConfirmationId(ms = Date.now(), rand = Math.random) {
  return `confirmation:${ms.toString(36)}${rand().toString(36).slice(2, 8)}`;
}

// ---------- 记录构造器（唯一形状真源；CLI 只映射参数，不自造字段） ----------
export function confirmationRecord({
  atom, verdict = DEFAULT_VERDICT, why = '', confirmedBy = DEFAULT_CONFIRMED_BY, via = DEFAULT_VIA, ts, id,
} = {}) {
  if (!isNonEmptyStr(atom)) throw new ConfirmError('missing-atom', 'confirm requires a target atom id');
  if (!VERDICT_SET.has(verdict)) {
    throw new ConfirmError('invalid-verdict', `verdict must be one of ${VERDICTS.join('|')}, got ${String(verdict)}`);
  }
  if (!isNonEmptyStr(confirmedBy)) throw new ConfirmError('missing-confirmed-by', 'confirm requires a non-empty confirmed_by');
  if (!VIA_SET.has(via)) {
    throw new ConfirmError('invalid-via', `provenance.via must be one of ${PROVENANCE_VIAS.join('|')}, got ${String(via)}`);
  }
  const at = stamp(ts);
  return {
    id: isNonEmptyStr(id) ? id : newConfirmationId(Date.parse(at)),
    ts: at,
    kind: CONFIRMATION_KIND,
    atom,                       // 目标原子 id
    verdict,
    confirmed_by: confirmedBy,
    confirmed_at: at,
    // 来源（不变量⑦）：via = 写入入口，by = 署名者（与 confirmed_by 同值，便于按来源审计）
    provenance: { via, by: confirmedBy },
    ...whyField(why),           // 不变量⑦：剥 trailer 后无正文 → 不写 why 键
  };
}

// ---------- 来源未署名的确认（doctor / evidence 单列计数，同一口径） ----------
// 未署名 = confirmed_by 缺失 / 空 / 恰为 'unattributed'。这是「机器代写的确认」的可见形态，
// 与「已确认/已否决」是两个维度：一条 dispute 也可以是未署名的。
export function isUnattributedConfirmation(record) {
  if (!isPlainObject(record)) return false;
  const by = isNonEmptyStr(record.confirmed_by) ? record.confirmed_by.trim() : '';
  return by === '' || by === UNATTRIBUTED_BY;
}

export function countUnattributedConfirmations(records = []) {
  return (Array.isArray(records) ? records : []).filter(isUnattributedConfirmation).length;
}

// ---------- 读回 ----------
export function readConfirmations(journalDir) {
  return readAllRecords(journalDir).filter(r => r.kind === CONFIRMATION_KIND);
}

// 某原子的全部确认记录（journal 文件顺序 = append 顺序，天然时间序）。
export function confirmationsFor(journalDir, atomId) {
  return readConfirmations(journalDir).filter(c => c.atom === atomId);
}

// 最新一条（按 confirmed_at，回退 ts；时间不可解析时保留先出现的那条——不静默丢确认）。
export function latestConfirmation(records = []) {
  let best = null;
  let bestKey = NaN;
  for (const r of records) {
    if (!isPlainObject(r)) continue;
    const k = Date.parse(r.confirmed_at ?? r.ts ?? '');
    if (best === null) { best = r; bestKey = k; continue; }
    if (!Number.isNaN(k) && (Number.isNaN(bestKey) || k >= bestKey)) { best = r; bestKey = k; }
  }
  return best;
}

// atomId → 最新确认（doctor / evidence 的共用索引）。
export function latestByAtom(records = []) {
  const out = new Map();
  for (const r of records) {
    if (!isPlainObject(r) || !isNonEmptyStr(r.atom)) continue;
    const cur = out.get(r.atom);
    out.set(r.atom, cur ? latestConfirmation([cur, r]) : r);
  }
  return out;
}

// ---------- 有效状态派生 ----------
// 返回 {status, from, confirmation}：from = 'confirmation' | 'inline' | 'none'。
// status 可为 null（既无确认也无内联 status = 未定）——绝不编造一个状态出来。
export function deriveStatus(atom, confirmations = []) {
  const id = isPlainObject(atom) ? atom.id : null;
  const latest = latestConfirmation(Array.isArray(confirmations) ? confirmations.filter(c => c.atom === id) : []);
  if (latest) return { status: STATUS_BY_VERDICT[latest.verdict] ?? null, from: 'confirmation', confirmation: latest };
  if (isPlainObject(atom) && isNonEmptyStr(atom.status)) return { status: atom.status, from: 'inline', confirmation: null };
  return { status: null, from: 'none', confirmation: null };
}

// 批量派生：返回与输入等长同序的 [{status, from, confirmation}]。
export function deriveStatuses(atoms = [], confirmations = []) {
  const byAtom = latestByAtom(confirmations);
  return (Array.isArray(atoms) ? atoms : []).map(atom => {
    const latest = isPlainObject(atom) ? byAtom.get(atom.id) : undefined;
    if (latest) return { status: STATUS_BY_VERDICT[latest.verdict] ?? null, from: 'confirmation', confirmation: latest };
    if (isPlainObject(atom) && isNonEmptyStr(atom.status)) return { status: atom.status, from: 'inline', confirmation: null };
    return { status: null, from: 'none', confirmation: null };
  });
}

// 确认人（来自 confirmation 记录；无确认记录时回退原子内联 confirmed_by）。
export function confirmerOf(atom, derived) {
  if (derived && derived.confirmation && isNonEmptyStr(derived.confirmation.confirmed_by)) {
    return derived.confirmation.confirmed_by;
  }
  return isPlainObject(atom) && isNonEmptyStr(atom.confirmed_by) ? atom.confirmed_by : null;
}

// ---------- 追加（幂等） ----------
// 目标原子必须真实存在于 journal（readAllAtoms 已排除确认记录本身 → 确认指向确认 = 未知 id）。
export function findAtom(journalDir, atomId) {
  if (!isNonEmptyStr(atomId)) throw new ConfirmError('missing-atom', 'confirm requires a target atom id');
  return readAllAtoms(journalDir).find(a => a.id === atomId) ?? null;
}

// 落一条确认。返回 {appended, deduped, record, atom}：
//   · appended=true  = 新写了一条确认记录
//   · appended=false = 与最新确认同 (verdict, why) → 幂等，不写第二行（append-only：只跳重复，从不改写）
export function confirmAtom(journalDir, { atom, verdict = DEFAULT_VERDICT, why = '', confirmedBy = DEFAULT_CONFIRMED_BY, via = DEFAULT_VIA, ts, id, now = new Date() } = {}) {
  const target = findAtom(journalDir, atom);
  if (!target) {
    throw new ConfirmError('unknown-atom', `unknown atom id: ${String(atom)} — 未在 journal 中找到该原子`);
  }
  const cleanWhy = whyField(why).why ?? '';
  const latest = latestConfirmation(confirmationsFor(journalDir, atom));
  if (latest && latest.verdict === verdict && (isNonEmptyStr(latest.why) ? latest.why : '') === cleanWhy) {
    return { appended: false, deduped: true, record: latest, atom: target };
  }
  const record = confirmationRecord({ atom, verdict, why, confirmedBy, via, ts: ts ?? now.toISOString(), id });
  appendJournalRecord(journalDir, record);
  return { appended: true, deduped: false, record, atom: target };
}

// ---------- 汇总（doctor 消费） ----------
// 决策原子的确认进度：confirmed / disputed / pending（既未确认也未否决）+ 确认记录条数。
// 口径：只统计 kind:'decision'（计划 S3「已确认决策数 / 待确认数」）；其他 kind 的确认记录仍计入 records。
export function confirmationSummary(atoms = [], confirmations = []) {
  const list = Array.isArray(atoms) ? atoms : [];
  const derived = deriveStatuses(list, confirmations);
  const out = {
    records: Array.isArray(confirmations) ? confirmations.length : 0,
    // 不变量⑦：来源未署名的确认单列（机器写的确认不得混进「已确认」而不留痕）
    unattributed: countUnattributedConfirmations(confirmations),
    decisions: 0, confirmed: 0, disputed: 0, pending: 0,
  };
  list.forEach((atom, i) => {
    if (!isPlainObject(atom) || atom.kind !== 'decision') return;
    out.decisions++;
    const s = derived[i].status;
    if (s === 'confirmed') out.confirmed++;
    else if (s === 'disputed') out.disputed++;
    else out.pending++;          // draft / superseded / 无 status —— 都还没被 owner 确认
  });
  return out;
}
