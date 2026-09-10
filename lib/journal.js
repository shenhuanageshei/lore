// lib/journal.js —— 记录层落盘入口（**唯一**原子写入路径；S1 起所有写入经 schema 校验/规范化）。
//
// 纪律（计划 ① 期 S1 / 设计 §3.2、§3.4）：
//   · 校验器是唯一闸门：normalizeAtom 不通过 → 抛 AtomRejected，**一个字节都不落**（append-only 不变：拒绝路径不产生半行）。
//   · 落盘的是**规范化后**的原子（机器来源缺 status 补 draft、facets/refs 补空壳、数组去重），不是调用方的入参副本。
//   · 非法原子给出可读错误（{field, code, message} 逐条列出）——不静默写坏数据，也不静默丢弃。
//   · appendAtom 返回规范化后的原子 = 盘上那一条（调用方据此打印/断言，不必再读盘）。
//
// 三个写入入口（lib/hook.js captureHead / lib/mine.js mine / lib/note.js appendNote+enrich）全部走这里，
// 所以「机器来源判定」（lib/atom.js 的 isMachineSource，source 前缀 agent|miner|hook）三处共用同一份实现。
import { join, dirname } from 'node:path';
import { mkdirSync, appendFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { isPaddedIsoTs, normalizeAtom } from './atom.js';

// 写入被拒（不变量⑦ 的写入侧出口）：errors 是 validateAtom 的原始列表，atom 是入参原文（诊断用）。
export class AtomRejected extends Error {
  constructor(errors, atom) {
    const id = atom && typeof atom === 'object' && !Array.isArray(atom) ? atom.id : undefined;
    const where = typeof id === 'string' && id.trim() !== '' ? ` "${id}"` : '';
    const detail = (errors ?? []).map(e => `${e.field}: ${e.code} — ${e.message}`).join('; ');
    super(`refusing to write invalid atom${where}: ${detail}`);
    this.name = 'AtomRejected';
    this.errors = errors ?? [];
    this.atom = atom;
  }
}

// 落一条原子。校验失败 → AtomRejected（含逐条错误），成功 → 返回落盘的那条规范化原子。
export function appendAtom(journalDir, atom) {
  const { ok, atom: normalized, errors } = normalizeAtom(atom);
  if (!ok) throw new AtomRejected(errors, atom);
  const p = atomPath(journalDir, normalized.ts);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(normalized) + '\n');
  return normalized;
}

// ---------- 记录层非原子条目（S3：确认记录）----------
// 确认记录与原子**同源**落在 journal 内（设计 §7① S3 存储定案：同源、天然 append-only、可审计），
// 但它的 kind 不在原子 schema（lib/atom.js 的 ATOM_KINDS）里——存储层必须能把两类分开，
// 否则确认记录会被 fold / sync / doctor 当原子消费（决策史多出幽灵条目、原子计数虚高）。
export const CONFIRMATION_KIND = 'confirmation';
export const NON_ATOM_KINDS = Object.freeze([CONFIRMATION_KIND]);

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyStr = v => typeof v === 'string' && v.trim() !== '';

// 原子 vs 记录层条目：只有 NON_ATOM_KINDS 被排除，其余（含未知/历史 kind）一律按原子看待——
// 白名单式过滤会把历史里将来出现的 kind 静默丢掉，那是「安静地不工作」。
export function isAtomRecord(record) {
  return isPlainObject(record) && !NON_ATOM_KINDS.includes(record.kind);
}

// 非原子记录的追加通道。**不是**原子的后门：kind 必须是 NON_ATOM_KINDS 之一，否则抛错并指向 appendAtom。
// 只做轻结构校验（id/ts/kind）；字段语义与合法性由各自的模块负责（确认记录 → lib/confirm.js）。
export class RecordRejected extends Error {
  constructor(message, record) {
    super(message);
    this.name = 'RecordRejected';
    this.record = record;
  }
}

export function appendJournalRecord(journalDir, record) {
  if (!isPlainObject(record)) throw new RecordRejected('journal record must be a plain object', record);
  if (!NON_ATOM_KINDS.includes(record.kind)) {
    throw new RecordRejected(`kind ${String(record.kind)} is not a journal record kind (${NON_ATOM_KINDS.join('|')}); use appendAtom for atoms`, record);
  }
  if (!isNonEmptyStr(record.id)) throw new RecordRejected('journal record requires a non-empty id', record);
  // ts 契约与原子同款（评审 #6）：记录层也走 atomPath 的位置切片，非补零 ISO（'2026-9-9' / '2026/09/09'）
  // 同样会写出怪分片——两条落盘路径都必须拒写，atomPath 才真的恒安全。判据住在 lib/atom.js，不复制一份。
  if (!isPaddedIsoTs(record.ts)) {
    throw new RecordRejected('journal record requires a zero-padded ISO-8601 ts (YYYY-MM-DDTHH:MM:SS…)', record);
  }
  const p = atomPath(journalDir, record.ts);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(record) + '\n');
  return record;
}

// 分片路径 = 对 ts 的**位置切片**（YYYY / MM / YYYY-MM-DD）——只对补零 ISO-8601 成立。
// 两个调用方（appendAtom / appendJournalRecord）都已由 `isPaddedIsoTs` 闸住，故此处不再自校验。
export function atomPath(journalDir, isoTs) {
  const year = isoTs.slice(0, 4);
  const month = isoTs.slice(5, 7);
  const date = isoTs.slice(0, 10);   // YYYY-MM-DD
  return join(journalDir, year, month, `${date}.ndjson`);
}

function walkNdjson(dir) {
  let out = [];
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkNdjson(full));
    else if (e.isFile() && e.name.endsWith('.ndjson')) out.push(full);
  }
  return out;
}

// journal 的**全部**条目（原子 + 记录层条目）。坏行不抛（跳过）——诊断工具不该被一行坏数据打断。
export function readAllRecords(journalDir) {
  if (!existsSync(journalDir)) return [];
  const out = [];
  for (const f of walkNdjson(journalDir)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let rec;
      try { rec = JSON.parse(t); } catch { continue; }
      if (isPlainObject(rec)) out.push(rec);
    }
  }
  return out;
}

// 原子视图：记录层条目（确认记录）被排除——既有调用方（fold / sync / hook / mine / doctor）语义不变。
export function readAllAtoms(journalDir) {
  return readAllRecords(journalDir).filter(isAtomRecord);
}

export function existingIds(journalDir) {
  return new Set(readAllAtoms(journalDir).map(a => a.id));
}
