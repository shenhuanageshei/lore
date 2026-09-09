// lib/cost.js —— 成本账本 + 预算闸（设计 2026-09-09 §3.6 / §7 ⓪ 期 S6）。
//
// 账本：每次 LLM 调用追加一行到 .lore/.state/cost.ndjson（per-machine、gitignored）：
//   {ts, page, backend, ms, ok, tokens?, version}
//   · tokens 只在后端真的回报用量时出现——拿不到就留空，绝不写 0 冒充
//     （0 是「这次用了 0 个 token」，不是「不知道用了多少」；伪造 0 会让预算闸永远算不出超支）。
//   · version 是「每版本预算」的窗口键 = 最近 tag（见 versionStamp）；条目自带它，账本才能按版本切片。
//   · 成功/失败/超时都记（runner 在每次后端调用后无条件追加一行）。
//
// 预算闸：预算上限 = 每版本上限，超限则自动档不启动、等人工放行（§3.6）。
//   **计量维度可回退（审计 D3）**：tokens | calls | ms。
//   三个 CLI 后端（claude/codex/opencode）都不回报 token 用量 → 只按 token 计预算则 used 恒为 0、
//   闸永远算不出超支。所以维度可显式配置，且**未显式选 tokens/ms 时用 calls 兜底**：
//     · calls = 窗口内的账目条数（一行账 = 一次 LLM 调用，与后端是否回报用量无关，必然可算）；
//     · ms    = 窗口内累计耗时（每条账目的 ms）；
//     · tokens= 窗口内回报的 token 之和（拿不到的行只计数、不估算——估算才是伪造）。
//   配置住在 .lore/.state/budget.json（lib/syncstate.js 的 readBudgetConfig/writeBudgetConfig），
//   未配置（budget 缺失/null）= 不阻断，行为与今天完全一致。
//   人工放行 = 清空预算（写 null）或发新版本（新 tag 打开新窗口）。

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const COST_FILE = 'cost.ndjson';
export const COST_SCHEMA_VERSION = 1;
// 版本戳取不到（非 git / 无 tag）时的窗口键：此时按全部账目合计（宁可多算，不可不闸）。
export const UNKNOWN_VERSION = 'unknown';
export const COST_FIELDS = Object.freeze(['ts', 'page', 'backend', 'ms', 'ok', 'tokens', 'version']);
// 预算计量维度（审计 D3）：三个后端都不回报 token 用量，只按 token 计预算闸永远不触发。
// 未显式选维度 → 'calls' 兜底（账目条数，与是否回报用量无关，必然可算）。
export const BUDGET_DIMENSIONS = Object.freeze(['tokens', 'calls', 'ms']);
export const DEFAULT_BUDGET_DIMENSION = 'calls';

const isNonEmptyStr = v => typeof v === 'string' && v.trim() !== '';

export function costPath(stateDir) { return join(stateDir, COST_FILE); }

// 版本戳 = 最近 tag（git describe --tags --abbrev=0）——稳定到「发版」粒度，正是「每版本 token 上限」的语义。
// 用 HEAD sha 会把预算窗口切到每次提交（几乎永不超支），用 package.json 版本则与本仓 git 事实脱节。
export function versionStamp(repoRoot, { exec = execFileSync } = {}) {
  try {
    const tag = String(exec('git', ['describe', '--tags', '--abbrev=0'],
      { cwd: repoRoot, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) ?? '').trim();
    return tag || UNKNOWN_VERSION;
  } catch { return UNKNOWN_VERSION; }
}

// ---------- 记账 ----------
// 校验后返回落盘记录（调用方可直接断言形状）；非法输入 throw——账本是证据，不接受半条记录。
export function costRecord({ ts, page, backend, ms, ok, tokens, version } = {}) {
  if (!isNonEmptyStr(page)) throw new Error('lore: cost entry requires a non-empty page');
  if (!isNonEmptyStr(backend)) throw new Error('lore: cost entry requires a non-empty backend');
  if (!Number.isFinite(ms) || ms < 0) throw new Error('lore: cost entry requires ms >= 0');
  if (typeof ok !== 'boolean') throw new Error('lore: cost entry requires ok boolean');
  const rec = {
    ts: isNonEmptyStr(ts) ? ts : new Date().toISOString(),
    page, backend, ms, ok,
  };
  // 键只在真有值时出现：undefined/null 都不写（留空 ≠ 0）
  if (tokens !== undefined && tokens !== null) {
    if (!Number.isFinite(tokens) || tokens < 0) throw new Error('lore: cost tokens must be a finite number >= 0');
    rec.tokens = tokens;
  }
  rec.version = isNonEmptyStr(version) ? version : UNKNOWN_VERSION;
  return rec;
}

export function appendCost(stateDir, entry) {
  const rec = costRecord(entry);
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(costPath(stateDir), JSON.stringify(rec) + '\n');
  return rec;
}

// 读回：坏行（坏 JSON / 非对象行）跳过并计数，不崩——账本会被人工追加，必须容错。
export function readCost(stateDir) {
  const path = costPath(stateDir);
  const entries = [];
  let skipped = 0;
  if (!existsSync(path)) return { entries, skipped, path };
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return { entries, skipped, path }; }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try { rec = JSON.parse(t); } catch { skipped++; continue; }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) { skipped++; continue; }
    entries.push(rec);
  }
  return { entries, skipped, path };
}

// ---------- 窗口求和 ----------
// version 缺省 / 'unknown' → 全部账目计入（版本戳不可解析时的保守口径：宁可多算，不可漏闸）。
const inWindow = (entry, version) => !version || version === UNKNOWN_VERSION || entry?.version === version;

export function sumTokens(entries, { version } = {}) {
  let used = 0, counted = 0, unknownTokens = 0;
  for (const e of entries ?? []) {
    if (!inWindow(e, version)) continue;
    counted++;
    if (Number.isFinite(e?.tokens)) used += e.tokens;
    else unknownTokens++;                       // 没回报用量的调用：计数但不估算
  }
  return { used, counted, unknownTokens };
}

// 调用数维度：一行账 = 一次 LLM 调用（runner 在每次调用后无条件追加一行）。
// 后端回报不回报用量都不影响这个数——这正是「可回退计量」的意义（审计 D3）。
export function sumCalls(entries, { version } = {}) {
  let counted = 0, unknownTokens = 0;
  for (const e of entries ?? []) {
    if (!inWindow(e, version)) continue;
    counted++;
    if (!Number.isFinite(e?.tokens)) unknownTokens++;
  }
  return { used: counted, counted, unknownTokens };
}

// 耗时维度：窗口内累计 ms。ms 非有限值的行（手写坏账）按 0 计——不虚增，也不让它击落闸。
export function sumMs(entries, { version } = {}) {
  let used = 0, counted = 0, unknownTokens = 0;
  for (const e of entries ?? []) {
    if (!inWindow(e, version)) continue;
    counted++;
    if (!Number.isFinite(e?.tokens)) unknownTokens++;
    if (Number.isFinite(e?.ms)) used += e.ms;
  }
  return { used, counted, unknownTokens };
}

// 按维度求和（未知维度 → calls 兜底，与 budgetStatus 同口径）。
export function meterUsage(entries, { version, dimension = DEFAULT_BUDGET_DIMENSION } = {}) {
  const dim = BUDGET_DIMENSIONS.includes(dimension) ? dimension : DEFAULT_BUDGET_DIMENSION;
  if (dim === 'tokens') return sumTokens(entries, { version });
  if (dim === 'ms') return sumMs(entries, { version });
  return sumCalls(entries, { version });
}

// ---------- 预算状态（tickAuto 每次判定时算一次；只读，无副作用） ----------
// dimension 缺省 = calls（审计 D3 兜底）；tokenBudget 是旧签名（= tokens 维度的 budget），保留兼容。
export function budgetStatus({
  stateDir, repoRoot, budget, dimension, tokenBudget, version, exec = execFileSync,
} = {}) {
  const legacy = budget === undefined;
  const cap0 = legacy ? tokenBudget : budget;
  const dim = legacy ? 'tokens' : (BUDGET_DIMENSIONS.includes(dimension) ? dimension : DEFAULT_BUDGET_DIMENSION);
  const usable = Number.isFinite(cap0) && cap0 > 0;
  const cap = usable ? cap0 : null;
  const stamp = version ?? versionStamp(repoRoot, { exec });
  const { entries, skipped } = readCost(stateDir);
  const { used, counted, unknownTokens } = meterUsage(entries, { version: stamp, dimension: dim });
  // 不返回 invalid 键（评审 🔵#6）：非法预算在配置层就被归一——readBudgetConfig 把非正/非数字的
  // budget 归一成 null、writeBudgetConfig 对非法值直接 throw，而 CLI 只走这条写入路径。所以走到这里
  // cap0 只可能是 null 或正有限数，cap0 != null && !usable 恒为 false：既无消费者也无测试的死分支。
  return {
    configured: cap !== null,
    dimension: dim,
    budget: cap,
    version: stamp,
    used, counted, unknownTokens, skipped,
    exceeded: cap !== null && used >= cap,
  };
}
