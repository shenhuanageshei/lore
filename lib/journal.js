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
import { normalizeAtom } from './atom.js';

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

export function readAllAtoms(journalDir) {
  if (!existsSync(journalDir)) return [];
  const atoms = [];
  for (const f of walkNdjson(journalDir)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (t) atoms.push(JSON.parse(t));
    }
  }
  return atoms;
}

export function existingIds(journalDir) {
  return new Set(readAllAtoms(journalDir).map(a => a.id));
}
