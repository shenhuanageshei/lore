// lib/cost.js —— 成本账本 + 预算闸（设计 2026-09-09 §3.6 / §7 ⓪ 期 S6）。
//
// 账本：每次 LLM 调用追加一行到 .lore/.state/cost.ndjson（per-machine、gitignored）：
//   {ts, page, backend, ms, ok, tokens?, version}
//   · tokens 只在后端真的回报用量时出现——拿不到就留空，绝不写 0 冒充
//     （0 是「这次用了 0 个 token」，不是「不知道用了多少」；伪造 0 会让预算闸永远算不出超支）。
//   · version 是「每版本预算」的窗口键 = 最近 tag（见 versionStamp）；条目自带它，账本才能按版本切片。
//   · 成功/失败/超时都记（runner 在每次后端调用后无条件追加一行）。
//
// 预算闸：预算上限 = 每版本 token 上限，超限则自动档不启动、等人工放行（§3.6）。
//   配置住在 .lore/.state/budget.json（lib/syncstate.js 的 readBudgetConfig/writeBudgetConfig），
//   未配置（token_budget 缺失/null）= 不阻断，行为与今天完全一致。
//   人工放行 = 清空预算（写 null）或发新版本（新 tag 打开新窗口）。
//
// 诚实声明（写进代码而不是写进想象）：当前三个 CLI 后端（claude/codex/opencode）都不回报 token 用量，
// 所以账本里绝大多数行没有 tokens → used 恒为 0 → 闸算不出超支。这不是「闸没接」：
// 闸的判定、窗口、超限语义都有测试覆盖（test/cost.test.js），一旦有后端回报 tokens 就立刻生效。
// 用「估算 token」把 used 填满才是真正的伪造——本模块不做。

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const COST_FILE = 'cost.ndjson';
export const COST_SCHEMA_VERSION = 1;
// 版本戳取不到（非 git / 无 tag）时的窗口键：此时按全部账目合计（宁可多算，不可不闸）。
export const UNKNOWN_VERSION = 'unknown';
export const COST_FIELDS = Object.freeze(['ts', 'page', 'backend', 'ms', 'ok', 'tokens', 'version']);

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

// ---------- 预算状态（tickAuto 每次判定时算一次；只读，无副作用） ----------
export function budgetStatus({ stateDir, repoRoot, tokenBudget, version, exec = execFileSync } = {}) {
  const usable = Number.isFinite(tokenBudget) && tokenBudget > 0;
  const budget = usable ? tokenBudget : null;
  const stamp = version ?? versionStamp(repoRoot, { exec });
  const { entries, skipped } = readCost(stateDir);
  const { used, counted, unknownTokens } = sumTokens(entries, { version: stamp });
  return {
    configured: budget !== null,
    invalid: tokenBudget != null && !usable,    // 给了个用不了的预算 → 如实标出（不静默当没配置）
    budget,
    version: stamp,
    used, counted, unknownTokens, skipped,
    exceeded: budget !== null && used >= budget,
  };
}
