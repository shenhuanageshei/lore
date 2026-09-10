// lib/atom.js —— ⓪ 期原子 schema 与校验/规范化（纯新增：不接入任何现有写入路径）。
//
// 字段契约（设计 2026-09-09 §3.1 / §3.2）：
//   kind=decision    采纳的决定        title 必填
//   kind=rejected    被否决的方案      title 必填
//   kind=correction  对自身判断的纠错  title 必填
//   kind=question    待决问题          title 必填
//   kind=evidence    支撑结论的证据    title 必填
//   kind=pitfall     踩坑              title 必填 + problem/fix/prevention 三者皆必填非空
//   kind=commit      存量骨架原子（490 条历史数据）——保留兼容；title 可空（enrich 原子 title=''）
//
// 公共必填：id（非空串）/ ts（可解析且**补零**的 ISO-8601 串）/ kind（ATOM_KINDS 之一）。
// ts 收紧（① 期审计 D5 / 代码评审 #6）：ts 必须是 `YYYY-MM-DDTHH:MM:SS…` 形态的补零 ISO-8601 串。
// 理由：lib/journal.js 的 atomPath 按**位置切片**从 ts 拼分片路径（isoTs.slice(0,4)/slice(5,7)/slice(0,10)），
// 所以 '2026-9-9'（Date.parse 能解析、切片却错位）会写出 '2026/9-/2026-9-9.ndjson' 这类怪路径；
// '2026/09/09' 同理。校验器把非补零 ts 挡在写盘之前（拒写，不静默改写 ts）。
// status 仅 draft|confirmed|disputed|superseded；confirmed 必须带 confirmed_by
// （设计 §3.2：只有 owner 的直接动作能产生 confirmed，agent 代写只能是 draft）。
// normalizeAtom 只给**机器来源**（MACHINE_SOURCES：agent/miner/hook）缺 status 的原子补 'draft'；
// 历史/人工来源缺 status 就保持缺 status（不把 owner 手写的原子标成机器草稿）。
// why 任何 kind 都可选——不变量⑦：无正文不写 why（写入侧纪律见 lib/fold.js cleanWhy）。
// 未知字段一律保留（normalizeAtom 不丢）——schema 演进靠加字段，不靠删字段。

export const COMPREHENSION_KINDS = Object.freeze([
  'decision', 'rejected', 'correction', 'question', 'evidence', 'pitfall',
]);
export const LEGACY_KINDS = Object.freeze(['commit']);
export const ATOM_KINDS = Object.freeze([...COMPREHENSION_KINDS, ...LEGACY_KINDS]);
export const ATOM_STATUSES = Object.freeze(['draft', 'confirmed', 'disputed', 'superseded']);
export const CONFIDENCES = Object.freeze(['EXTRACTED', 'INFERRED']);
// 机器来源（设计 §3.2 / 评审 🟡#5）：只有它们写入时缺省为 draft。
// 历史 / 人工来源的原子保持**无 status**——owner 手写的 decision 被补成 draft 是伪造来源
// （不变量③：人的写入不可被机器删改；§3.2：只有 owner 的直接动作能产生 confirmed）。
export const MACHINE_SOURCES = Object.freeze(['agent', 'miner', 'hook']);
export const PITFALL_FIELDS = Object.freeze(['problem', 'fix', 'prevention']);

const KIND_SET = new Set(ATOM_KINDS);
const MACHINE_SOURCE_SET = new Set(MACHINE_SOURCES);
const STATUS_SET = new Set(ATOM_STATUSES);
const CONFIDENCE_SET = new Set(CONFIDENCES);
const COMPREHENSION_SET = new Set(COMPREHENSION_KINDS);

// 补零 ISO-8601 日期时间（评审 #6）。Date.parse 单独用不够：它对 '2026-9-9' / '2026/09/09' 都
// 返回合法时间戳（宽松回退解析），而 atomPath 的位置切片只对 `YYYY-MM-DDTHH:MM:SS…` 成立。
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T/;

// ts 是否**补零 ISO-8601 且可解析**——写入侧（原子 + 记录层条目）共用的唯一判据。
export function isPaddedIsoTs(ts) {
  return isNonEmptyStr(ts) && !Number.isNaN(Date.parse(ts)) && ISO_TS_RE.test(ts);
}

export function isKnownKind(kind) { return KIND_SET.has(kind); }

// 六类理解层原子必须有人读的标题；commit 骨架不要求（enrich 原子刻意 title=''）。
export function requiresTitle(kind) { return COMPREHENSION_SET.has(kind); }

const isStr = v => typeof v === 'string';
const isNonEmptyStr = v => isStr(v) && v.trim() !== '';
const isStrArray = v => Array.isArray(v) && v.every(isStr);

// 保序去重（规范化只去重不排序——排序会打乱既有 facets 语义顺序）。
function dedupeStrings(arr) {
  const out = [], seen = new Set();
  for (const x of arr) if (!seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}

function checkOptionalFields(atom, err) {
  for (const f of ['why', 'what_changed', 'source', 'title', 'confirmed_by', 'confirmed_at']) {
    if (atom[f] !== undefined && !isStr(atom[f])) err(f, 'invalid-type', `${f} must be a string`);
  }
  if (atom.commit !== undefined && atom.commit !== null && !isStr(atom.commit)) {
    err('commit', 'invalid-type', 'commit must be a string or null');
  }
  if (atom.enriched !== undefined && typeof atom.enriched !== 'boolean') {
    err('enriched', 'invalid-type', 'enriched must be a boolean');
  }
  if (atom.confidence !== undefined && !CONFIDENCE_SET.has(atom.confidence)) {
    err('confidence', 'invalid-confidence', `confidence must be one of ${CONFIDENCES.join('|')}`);
  }
  if (atom.facets !== undefined) {
    if (atom.facets === null || typeof atom.facets !== 'object' || Array.isArray(atom.facets)) {
      err('facets', 'invalid-type', 'facets must be an object');
    } else {
      for (const k of ['component', 'flow', 'theme']) {
        const v = atom.facets[k];
        if (v !== undefined && !isStrArray(v)) err(`facets.${k}`, 'invalid-type', `facets.${k} must be a string array`);
      }
    }
  }
  if (atom.refs !== undefined) {
    if (atom.refs === null || typeof atom.refs !== 'object' || Array.isArray(atom.refs)) {
      err('refs', 'invalid-type', 'refs must be an object');
    } else {
      for (const k of ['files', 'related', 'anchors', 'evidence']) {
        const v = atom.refs[k];
        if (v !== undefined && !isStrArray(v)) err(`refs.${k}`, 'invalid-type', `refs.${k} must be a string array`);
      }
      const p = atom.refs.pitfall;
      if (p !== undefined && p !== null && !isStr(p)) err('refs.pitfall', 'invalid-type', 'refs.pitfall must be a string or null');
      const s = atom.refs.supersedes;
      if (s !== undefined && s !== null && !isStr(s)) err('refs.supersedes', 'invalid-type', 'refs.supersedes must be a string or null');
    }
  }
}

// 纯校验：不抛、不改入参、错误可枚举（{field, code, message}）。
export function validateAtom(atom) {
  const errors = [];
  const err = (field, code, message) => { errors.push({ field, code, message }); };

  if (atom === null || typeof atom !== 'object' || Array.isArray(atom)) {
    err('$', 'not-an-object', 'atom must be a plain object');
    return { ok: false, errors };
  }

  if (!isNonEmptyStr(atom.id)) err('id', 'missing-id', 'id must be a non-empty string');
  if (!isNonEmptyStr(atom.ts)) err('ts', 'missing-ts', 'ts must be a non-empty ISO-8601 string');
  else if (Number.isNaN(Date.parse(atom.ts))) err('ts', 'invalid-ts', `ts is not a parseable date: ${atom.ts}`);
  else if (!ISO_TS_RE.test(atom.ts)) {
    err('ts', 'non-iso-ts', `ts must be a zero-padded ISO-8601 date-time (YYYY-MM-DDTHH:MM:SS…), got: ${atom.ts}`);
  }

  if (!isKnownKind(atom.kind)) {
    err('kind', 'unknown-kind', `kind must be one of ${ATOM_KINDS.join('|')}`);
  } else if (requiresTitle(atom.kind) && !isNonEmptyStr(atom.title)) {
    err('title', 'missing-title', `kind ${atom.kind} requires a non-empty title`);
  }

  if (atom.kind === 'pitfall') {
    for (const f of PITFALL_FIELDS) {
      if (!isNonEmptyStr(atom[f])) err(f, `pitfall-missing-${f}`, `kind pitfall requires a non-empty ${f}`);
    }
  }

  if (atom.status !== undefined) {
    if (!STATUS_SET.has(atom.status)) {
      err('status', 'invalid-status', `status must be one of ${ATOM_STATUSES.join('|')}`);
    } else if (atom.status === 'confirmed' && !isNonEmptyStr(atom.confirmed_by)) {
      err('confirmed_by', 'confirmed-requires-confirmed_by', 'status confirmed requires confirmed_by');
    }
  }

  checkOptionalFields(atom, err);
  return { ok: errors.length === 0, errors };
}

// 来源是否机器（source 形如 'agent' / 'agent:dsh' / 'miner' / 'hook:post-commit'——取 ':' 前那段）。
export function isMachineSource(source) {
  return typeof source === 'string' && MACHINE_SOURCE_SET.has(source.split(':')[0].trim());
}

// 规范化：校验通过才返回规范化副本（不改入参）。未知字段原样保留；facets/refs 缺失补空壳。
// status 缺省**只对机器来源补 'draft'**（agent/miner/hook 写入恒为草稿，§3.2）；
// 历史/人工来源缺 status 就保持缺 status——无差别补 draft 会把 owner 手写的 decision 标成机器草稿。
export function normalizeAtom(atom) {
  const { ok, errors } = validateAtom(atom);
  if (!ok) return { ok: false, atom: null, errors };
  const facets = { component: [], flow: [], theme: [], ...(atom.facets ?? {}) };
  for (const k of ['component', 'flow', 'theme']) if (Array.isArray(facets[k])) facets[k] = dedupeStrings(facets[k]);
  const refs = { files: [], related: [], pitfall: null, ...(atom.refs ?? {}) };
  for (const k of ['files', 'related', 'anchors', 'evidence']) if (Array.isArray(refs[k])) refs[k] = dedupeStrings(refs[k]);
  const status = atom.status ?? (isMachineSource(atom.source) ? 'draft' : undefined);
  return { ok: true, atom: { ...atom, facets, refs, ...(status === undefined ? {} : { status }) }, errors: [] };
}

// 单行 ndjson → 原子（坏 JSON 不抛，返回错误对象）。
export function parseAtom(line) {
  let raw;
  try { raw = JSON.parse(line); }
  catch (e) { return { ok: false, atom: null, errors: [{ field: '$', code: 'bad-json', message: String(e.message ?? e) }] }; }
  const r = validateAtom(raw);
  return { ok: r.ok, atom: raw, errors: r.errors };   // atom 回传解析结果（合法时即原原子）
}
