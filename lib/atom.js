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
// 公共必填：id（非空串）/ ts（可解析的 ISO-8601 串）/ kind（ATOM_KINDS 之一）。
// status 仅 draft|confirmed|disputed|superseded；confirmed 必须带 confirmed_by
// （设计 §3.2：只有 owner 的直接动作能产生 confirmed，agent 代写只能是 draft）。
// why 任何 kind 都可选——不变量⑦：无正文不写 why（写入侧纪律见 lib/fold.js cleanWhy）。
// 未知字段一律保留（normalizeAtom 不丢）——schema 演进靠加字段，不靠删字段。

export const COMPREHENSION_KINDS = Object.freeze([
  'decision', 'rejected', 'correction', 'question', 'evidence', 'pitfall',
]);
export const LEGACY_KINDS = Object.freeze(['commit']);
export const ATOM_KINDS = Object.freeze([...COMPREHENSION_KINDS, ...LEGACY_KINDS]);
export const ATOM_STATUSES = Object.freeze(['draft', 'confirmed', 'disputed', 'superseded']);
export const CONFIDENCES = Object.freeze(['EXTRACTED', 'INFERRED']);
export const PITFALL_FIELDS = Object.freeze(['problem', 'fix', 'prevention']);

const KIND_SET = new Set(ATOM_KINDS);
const STATUS_SET = new Set(ATOM_STATUSES);
const CONFIDENCE_SET = new Set(CONFIDENCES);
const COMPREHENSION_SET = new Set(COMPREHENSION_KINDS);

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

// 规范化：校验通过才返回规范化副本（不改入参）。未知字段原样保留；
// facets/refs 缺失补空壳；status 缺省 'draft'（机器/agent 写入默认草稿）。
export function normalizeAtom(atom) {
  const { ok, errors } = validateAtom(atom);
  if (!ok) return { ok: false, atom: null, errors };
  const facets = { component: [], flow: [], theme: [], ...(atom.facets ?? {}) };
  for (const k of ['component', 'flow', 'theme']) if (Array.isArray(facets[k])) facets[k] = dedupeStrings(facets[k]);
  const refs = { files: [], related: [], pitfall: null, ...(atom.refs ?? {}) };
  for (const k of ['files', 'related', 'anchors', 'evidence']) if (Array.isArray(refs[k])) refs[k] = dedupeStrings(refs[k]);
  return { ok: true, atom: { ...atom, facets, refs, status: atom.status ?? 'draft' }, errors: [] };
}

// 单行 ndjson → 原子（坏 JSON 不抛，返回错误对象）。
export function parseAtom(line) {
  let raw;
  try { raw = JSON.parse(line); }
  catch (e) { return { ok: false, atom: null, errors: [{ field: '$', code: 'bad-json', message: String(e.message ?? e) }] }; }
  const r = validateAtom(raw);
  return { ok: r.ok, atom: raw, errors: r.errors };   // atom 回传解析结果（合法时即原原子）
}
