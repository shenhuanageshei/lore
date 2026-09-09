// lib/human.js —— per-human 理解档案存储层（设计 2026-09-09 §3.3 / 不变量⑥）。
//
// 四类记录各一个 append-only ndjson 文件（.lore/human/{visits,read,blackbox,checks}.jsonl）：
//   visits   阅读痕迹（壳调用）    {ts, kind:'visit',    page}
//   read     已阅 @ 版本戳         {ts, kind:'read',     page, at}
//   blackbox 黑盒自评（修正手段）  {ts, kind:'blackbox', module, level}
//   checks   理解检查记录          {ts, kind:'check',    page, ...附加字段原样保留}
//
// 纪律：
//   ① 边界：默认不进 git（migrate 追加 .lore/human/ 到 .gitignore），可导出（exportHuman 带 schemaVersion）。
//   ② 未 init 的目录（无 .lore）→ 抛 HumanStoreError('not-initialized')，绝不静默写散文件。
//   ③ 读回时坏行跳过不崩（坏 JSON / 非对象行）；跳过数如实计数，导出时一并报出。
//   ④ 同页短窗去重：同 (kind, 主体, 版本/等级) 在窗口内重复 append → 不写第二行，返回 deduped:true。
//      窗口按记录自带的 ts 判定（不读挂钟）——同一输入重复调用结果一致（不变量⑤ 的确定性思路）。
//   ⑤ append-only：去重只跳过重复，从不改写既有行。
//   ⑥ 可清除（不变量⑥）：clearHuman 按 kind 删文件并返回将删条数；清除后 appendHuman 照常重建文件。
//
// 本文件只做存储层，不做 CLI 分发（分发在 lib/cli.js）。

import { existsSync, mkdirSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const HUMAN_SCHEMA_VERSION = 1;
export const HUMAN_KINDS = Object.freeze(['visits', 'read', 'blackbox', 'checks']);
// 文件名（复数）→ 记录 kind（单数）。checks 目前无 CLI verb（S4 只分发 visit|read|blackbox|human export），
// 存储层先立住：检查是 ④ 期的事，本期不造它的交互。
export const RECORD_KINDS = Object.freeze({ visits: 'visit', read: 'read', blackbox: 'blackbox', checks: 'check' });
// clearHuman 的合法 kind：四类 + 'all'（清除全部）。
export const CLEAR_KINDS = Object.freeze([...HUMAN_KINDS, 'all']);
export const BLACKBOX_LEVELS = Object.freeze(['懂', '半懂', '黑盒']);
// 壳打开传感器（§7 S7）同页短窗去重窗口；appendHuman 可用 windowMs 覆盖，0 = 关闭去重。
export const DEDUPE_WINDOW_MS = 30 * 60 * 1000;

const KIND_SET = new Set(HUMAN_KINDS);
const LEVEL_SET = new Set(BLACKBOX_LEVELS);
const isNonEmptyStr = v => typeof v === 'string' && v.trim() !== '';
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export class HumanStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HumanStoreError';
    this.code = code;
  }
}

export function humanDir(loreDir) { return join(loreDir, 'human'); }
export function humanFilePath(loreDir, kind) { return join(humanDir(loreDir), `${kind}.jsonl`); }

// 未 init（无 .lore）→ 明确报错。壳传感器（S7）自己捕获降级，存储层不做静默兜底。
export function assertInitialized(loreDir) {
  if (!isNonEmptyStr(loreDir) || !existsSync(loreDir)) {
    throw new HumanStoreError('not-initialized', `no .lore at ${loreDir ?? '(unset)'} — run /lore:init first`);
  }
  return loreDir;
}

function assertKind(kind) {
  if (!KIND_SET.has(kind)) {
    throw new HumanStoreError('unknown-kind', `kind must be one of ${HUMAN_KINDS.join('|')}, got ${String(kind)}`);
  }
}

const stamp = ts => (isNonEmptyStr(ts) ? ts : new Date().toISOString());

// ---------- 记录构造器（唯一记录形状真源；CLI 只映射参数，不自造字段） ----------
export function visitRecord({ page, ts } = {}) {
  if (!isNonEmptyStr(page)) throw new HumanStoreError('invalid-record', 'visit requires a non-empty page');
  return { ts: stamp(ts), kind: 'visit', page };
}

// 已阅必须挂版本戳（设计 §3.3 / 不变量⑧：结论要能机械判过期）——--at 缺失即非法。
export function readRecord({ page, at, ts } = {}) {
  if (!isNonEmptyStr(page)) throw new HumanStoreError('invalid-record', 'read requires a non-empty page');
  if (!isNonEmptyStr(at)) throw new HumanStoreError('invalid-record', 'read requires --at <version> (已阅 @ 版本戳)');
  return { ts: stamp(ts), kind: 'read', page, at };
}

export function blackboxRecord({ module: mod, level, ts } = {}) {
  if (!isNonEmptyStr(mod)) throw new HumanStoreError('invalid-record', 'blackbox requires a non-empty module');
  if (!LEVEL_SET.has(level)) {
    throw new HumanStoreError('invalid-record', `blackbox --level must be one of ${BLACKBOX_LEVELS.join('|')}`);
  }
  return { ts: stamp(ts), kind: 'blackbox', module: mod, level };
}

// checks 无 CLI verb（见 RECORD_KINDS 注释）：附加字段原样保留不丢（同 atom.js 的未知字段纪律）。
export function checkRecord({ page, ts, ...rest } = {}) {
  if (!isNonEmptyStr(page)) throw new HumanStoreError('invalid-record', 'check requires a non-empty page');
  return { ts: stamp(ts), kind: 'check', page, ...rest };
}

// 去重键：主体（page/module）+ 变体（at/level）。已阅换版本、黑盒改等级都是新记录，不是重复。
export function dedupeKey(record) {
  const subject = isNonEmptyStr(record?.page) ? record.page : (isNonEmptyStr(record?.module) ? record.module : '');
  const variant = isNonEmptyStr(record?.at) ? record.at : (isNonEmptyStr(record?.level) ? record.level : '');
  return `${record?.kind ?? ''}|${subject}|${variant}`;
}

// ---------- 读回（坏行跳过） ----------
export function readHumanFile(loreDir, kind) {
  assertInitialized(loreDir);
  assertKind(kind);
  const path = humanFilePath(loreDir, kind);
  if (!existsSync(path)) return { records: [], skipped: 0, path };
  const records = [];
  let skipped = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try { rec = JSON.parse(t); } catch { skipped++; continue; }
    if (!isPlainObject(rec)) { skipped++; continue; }
    records.push(rec);
  }
  return { records, skipped, path };
}

export function readHuman(loreDir, kind) { return readHumanFile(loreDir, kind).records; }

export function readAllHuman(loreDir) {
  assertInitialized(loreDir);
  const out = {};
  for (const k of HUMAN_KINDS) out[k] = readHumanFile(loreDir, k).records;
  return out;
}

// ---------- 追加（同页短窗去重；append-only） ----------
export function appendHuman(loreDir, kind, record, { windowMs = DEDUPE_WINDOW_MS } = {}) {
  assertInitialized(loreDir);
  assertKind(kind);
  if (!isPlainObject(record)) throw new HumanStoreError('invalid-record', 'record must be a plain object');
  const want = RECORD_KINDS[kind];
  if (record.kind !== want) {
    throw new HumanStoreError('invalid-record', `${kind}.jsonl expects kind=${want}, got ${String(record.kind)}`);
  }

  const { records, path } = readHumanFile(loreDir, kind);

  if (windowMs > 0) {
    const key = dedupeKey(record);
    const ts = Date.parse(record.ts);
    for (let i = records.length - 1; i >= 0; i--) {
      if (dedupeKey(records[i]) !== key) continue;
      const prev = Date.parse(records[i].ts);
      // 只跟同键的最后一条比；时间戳不可解析 → 不判重（宁可多记一行，也不静默丢一次阅读）
      if (!Number.isNaN(prev) && !Number.isNaN(ts) && ts - prev >= 0 && ts - prev < windowMs) {
        return { appended: false, deduped: true, record: records[i], path };
      }
      break;
    }
  }

  mkdirSync(humanDir(loreDir), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + '\n');
  return { appended: true, deduped: false, record, path };
}

// ---------- 清除（不变量⑥「可清除」） ----------
// 按 kind 清空对应 ndjson（'all' = 四类全清）。返回**将删条数**；dryRun 时不落任何写。
// 清除 = 删文件（不是写空行）：文件不存在时 readHumanFile 已回空数组，appendHuman 会按需重建，
// 所以「清除后可继续追加」天然成立；坏行不计数（它们是损坏数据，不是记录），另用 skipped 报出。
export function clearHuman(loreDir, kind, { dryRun = false } = {}) {
  assertInitialized(loreDir);
  if (!CLEAR_KINDS.includes(kind)) {
    throw new HumanStoreError('unknown-kind', 'kind must be one of ' + CLEAR_KINDS.join('|') + ', got ' + String(kind));
  }
  const targets = kind === 'all' ? [...HUMAN_KINDS] : [kind];
  const perKind = {};
  const paths = [];
  let cleared = 0;
  let skipped = 0;
  for (const k of targets) {
    const f = readHumanFile(loreDir, k);
    perKind[k] = f.records.length;
    cleared += f.records.length;
    skipped += f.skipped;
    paths.push(f.path);
    if (!dryRun && existsSync(f.path)) rmSync(f.path, { force: true });
  }
  return { kind, cleared, skipped, perKind, paths, dryRun };
}

// ---------- 导出（可移植 JSON，含 schema 版本号；不变量⑥「可导出」） ----------
export function exportHuman(loreDir, { exportedAt } = {}) {
  assertInitialized(loreDir);
  const counts = {};
  const skipped = {};
  const records = [];
  for (const k of HUMAN_KINDS) {
    const r = readHumanFile(loreDir, k);
    counts[k] = r.records.length;
    skipped[k] = r.skipped;
    records.push(...r.records);
  }
  return {
    schemaVersion: HUMAN_SCHEMA_VERSION,
    generator: 'lore',
    exportedAt: exportedAt ?? new Date().toISOString(),
    counts,
    skipped,
    records,
  };
}
