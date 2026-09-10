// lib/doctor.js —— 体检 + 捕获召回率（设计 2026-09-09 §6 / §7 ⓪ 期 S5）。
//
// lore 最危险的失败是「安静地不工作」：hook 曾断流 3 个月、85 提交零原子而无人察觉。
// 本模块只做一件事——把「没记下来」变成可读的数字：
//   ① hook 指向是否有效（post-commit stub 是否还指向本引擎的 lib/hook.js）
//   ② 上次成功捕获时间 + 断流天数（hook 这条捕获路径沉默了多久）
//   ③ 决策捕获率（kind:decision ÷ 提交数）——泵有没有在打水
//   ④ trailer-only 计数（不变量⑦ 的存量体检）+ 踩坑计数（两个口径分列：
//      kind==='pitfall' 是 S3 落地后的真实入库口径，refs.pitfall 是旧口径——S3 之后它恒为 null，
//      只数它体检会报 0 而与记录层事实矛盾（审计 D1））
//
// 纪律：
//   · 只读：绝不写 .lore / 绝不调 alignHookStub（那是迁移器，会改 .git/hooks）——见 test/doctor.test.js 的只读回归。
//   · 取不到的数字标 'unknown'，绝不用 0 冒充（非 git 目录、无 .lore、无 tag 都是 unknown 场景）。
//   · 坏行跳过不崩：体检工具自己崩掉比数字缺失更糟。
//   · 报告形状（--json）是稳定契约：字段只增不改语义，见 DOCTOR_SCHEMA_VERSION。
//
// ⑤ 捕获闸门（S8，评审 🔴#1/#2）：只测沉默不防沉默 = 白测。阈值可配置（.lore/config.yml 的 doctor: 子块，
//   或 CLI 旗标覆盖）；任一阈值被配置 → 闸门生效，低于阈值 exit 非零 + 醒目告警；未配置 → 不阻断（同 S6 预算闸）。
// ⑥ 窗口捕获率（S8 修订，评审 🟡#2）：设计 §7⓪ 的验收是「下 N 个提交中 ≥X% 的真实决策落成原子」——**前向窗口**。
//   只按全仓累计率（decision ÷ 全部非 merge 提交）判定时，85 个历史零原子提交会把闸门长期压红，且分不清
//   「最近变好/变差」与「历史就是差」。故：
//     · capture.window    = 最近 N 个提交的窗口率（N = doctor.capture_window_commits / --capture-window，默认 50）
//     · captureRate(Pct)  = 累计率，保留为报告字段（历史对比），不再参与闸门
//   窗口分子 = 落在窗口内的 kind:'decision' 原子（ts 落在窗口时间跨度内，或 commit sha 命中窗口内提交）；
//   分母 = 窗口内的非 merge 提交数。窗口下界取「第 N+1 个提交」的 committer 时间：提交总数 ≤ N 时下界开放
//   （窗口 = 全史），这样刚记的决策原子不会被下一个提交的时间戳甩出窗口。

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTrailers } from './fold.js';
import { noiseSummary } from './noise.js';
import { CONFIRMATION_KIND } from './journal.js';
import { confirmationSummary, countBadConfirmations } from './confirm.js';
import { HOOK_MARKER } from './migrate.js';

export const DOCTOR_SCHEMA_VERSION = 1;
// 取不到的数字一律用它——0 是「测出来是零」，unknown 是「测不出来」，两者不可混。
export const UNKNOWN = 'unknown';
// 窗口捕获率的默认窗口大小（提交数）；配置键 doctor.capture_window_commits、旗标 --capture-window 可覆盖。
export const DEFAULT_CAPTURE_WINDOW = 50;

const isNonEmptyStr = v => typeof v === 'string' && v.trim() !== '';
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// 本引擎的 hook 入口——stub 必须指向它，「指向有效性」的期望值。
const EXPECTED_HOOK = fileURLToPath(new URL('./hook.js', import.meta.url));

// git 只读探测：任何失败（非 git / 无 HEAD / 无 tag / git 不在 PATH）→ null，由调用方降级为 unknown。
function git(exec, args, cwd) {
  try {
    // stderr 吞掉：git 的「unknown revision」等噪音不该污染 doctor 的 stdout
    return String(exec('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) ?? '').trim();
  } catch { return null; }
}

const normPath = p => {
  const s = resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

// ---------- ① 仓库与版本（git 派生；非 git 全 unknown） ----------
export function gitInfo(repoRoot, { exec = execFileSync } = {}) {
  const inside = git(exec, ['rev-parse', '--is-inside-work-tree'], repoRoot);
  if (inside !== 'true') return { isGit: false, head: null, version: null, commits: UNKNOWN };
  const head = git(exec, ['rev-parse', 'HEAD'], repoRoot);
  const version = git(exec, ['describe', '--tags', '--abbrev=0'], repoRoot);   // 最近 tag = 版本粒度
  const countRaw = git(exec, ['rev-list', '--count', '--no-merges', 'HEAD'], repoRoot);
  const commits = countRaw !== null && /^\d+$/.test(countRaw) ? Number(countRaw) : UNKNOWN;
  return { isGit: true, head: head || null, version: version || null, commits };
}

// ---------- ② hook 指向（只读；语义与 migrate.alignHookStub 的状态集对齐，但不落任何写） ----------
// status: ok | stale | absent | foreign | hookspath-set | no-git | disabled
// ok: true=指向有效；false=指向无效（absent/foreign/stale）；'unknown'=测不出（no-git/hookspath-set）；null=用户主动关（disabled）
export function hookHealth(repoRoot, { configText = '', exec = execFileSync } = {}) {
  const expected = EXPECTED_HOOK;
  if (/^\s*hook:\s*false\b/m.test(configText)) {
    return { status: 'disabled', ok: null, hookPath: null, target: null, expected };
  }
  const inside = git(exec, ['rev-parse', '--is-inside-work-tree'], repoRoot);
  if (inside !== 'true') return { status: 'no-git', ok: UNKNOWN, hookPath: null, target: null, expected };

  const commonDir = git(exec, ['rev-parse', '--git-common-dir'], repoRoot);
  if (!commonDir) return { status: 'no-git', ok: UNKNOWN, hookPath: null, target: null, expected };
  const defaultHooks = resolve(resolve(repoRoot, commonDir), 'hooks');
  const hooksPath = git(exec, ['config', '--get', 'core.hooksPath'], repoRoot);
  // hooksPath 指到别处 → 我们看不见真正生效的 hook，只能标 unknown（不猜）
  if (hooksPath && normPath(resolve(repoRoot, hooksPath)) !== normPath(defaultHooks)) {
    return { status: 'hookspath-set', ok: UNKNOWN, hookPath: null, target: null, expected };
  }

  const hookPath = join(defaultHooks, 'post-commit');
  if (!existsSync(hookPath)) return { status: 'absent', ok: false, hookPath, target: null, expected };
  let body = '';
  try { body = readFileSync(hookPath, 'utf8'); }
  catch { return { status: 'absent', ok: false, hookPath, target: null, expected }; }
  if (!body.includes(HOOK_MARKER)) return { status: 'foreign', ok: false, hookPath, target: null, expected };

  const m = body.match(/node\s+"([^"]+)"/);
  const target = m ? m[1] : null;
  const pointsHere = target !== null && normPath(target) === normPath(expected) && existsSync(expected);
  return { status: pointsHere ? 'ok' : 'stale', ok: pointsHere, hookPath, target, expected };
}

// ---------- ③ 记录层体检（journal ndjson；坏行跳过） ----------
function walkNdjson(dir) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  let out = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkNdjson(full));
    else if (e.isFile() && e.name.endsWith('.ndjson')) out.push(full);
  }
  return out;
}

// 口径（设计附录 B，逐条对应）：
//   atoms       全部 ndjson 行
//   decisions   kind === 'decision'
//   pitfalls    kind === 'pitfall'（口径①：踩坑入库的现代形态）
//   trailerOnly why 非空但剥掉 trailer 后为空——「无正文」（不变量⑦）
//   noise       S2 噪音分类器（lib/noise.js）的降权分布 {high, low, none}——只标级，不删不改不回填
//   refsPitfall refs.pitfall 非空（口径②：旧形态，S3 之后恒为 0——两口径必须分列，不可互相替代）
//   lastHookTs  source === 'hook' 的最新 ts（捕获路径的沉默时长看它）
//   lastAtomTs  任何来源的最新 ts（对照：hook 死了但 mine 还在跑时仍能看出差别）
//   confirmation S3 确认进度 {records, unattributed, decisions, confirmed, disputed, pending}——决策原子的 owner 确认数。
//                unattributed = 来源未署名的确认条数（confirmed_by 缺失/空/'unattributed'，不变量⑦）：
//                「确认了」与「谁确认的」必须分列，否则机器代写的确认会被读成 owner 的直接动作。
//                kind:'confirmation' 是**记录层条目，不是原子**（S3 与原子同源落在 journal 内）：
//                从原子计数（atoms/decisions/pitfalls/trailerOnly/noise/lastAtomTs）里整体剔除，
//                否则确认一条决策就会让原子数虚高、噪音分布里多出无正文的 none。
//   badConfirmations  verdict 不在词表内的确认记录条数（审计 D5）：坏记录不改写任何原子，
//                也不参与有效状态派生（否则会把内联 status 覆盖成 null）；但体检必须报出它——
//                安静地不工作是本仓最危险的失败形态。计数口径住在 lib/confirm.js（countBadConfirmations）。
export function readJournalStats(journalDir) {
  const files = walkNdjson(journalDir);
  const stats = {
    files: files.length, atoms: 0, badLines: 0, decisions: 0, pitfalls: 0, trailerOnly: 0, refsPitfall: 0,
    noise: { high: 0, low: 0, none: 0 },
    lastHookTs: null, lastAtomTs: null, lastSource: null,
    // S2：噪音分类的输入（只留判级要用的两个字符串字段，不囤整条原子——体检是只读、有界）
    noiseInput: [],
    // 窗口捕获率的分子来源（S8 修订）：每条 kind:'decision' 的 ts 与 commit 指纹，供 windowCapture 判窗口归属。
    // 只收决策原子（本仓库个位数），不囤全部原子——体检是只读、有界。
    decisionAtoms: [],
    // S3：确认记录（记录层条目，不进原子计数）。收齐后交给 lib/confirm.js 派生有效状态。
    confirmationRecords: [],
    // S3：确认派生要用到的原子视图（id/kind/status）——同样只收必要字段，不囤整条原子。
    statusAtoms: [],
  };
  if (!existsSync(journalDir)) {
    return { ...stats, badConfirmations: 0, initialized: false };   // 没数过更没有记录 → 0（不是 unknown）
  }
  const maxTs = (cur, ts) => (isNonEmptyStr(ts) && (cur === null || ts > cur) ? ts : cur);
  for (const f of files) {
    let text = '';
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let atom;
      try { atom = JSON.parse(t); } catch { stats.badLines++; continue; }
      if (!isPlainObject(atom)) { stats.badLines++; continue; }
      // 记录层条目（S3 确认记录）：与原子同源落盘，但不是原子——剔除后单独汇总。
      if (atom.kind === CONFIRMATION_KIND) { stats.confirmationRecords.push(atom); continue; }
      stats.atoms++;
      stats.statusAtoms.push({
        id: isNonEmptyStr(atom.id) ? atom.id : '',
        kind: isNonEmptyStr(atom.kind) ? atom.kind : '',
        status: isNonEmptyStr(atom.status) ? atom.status : undefined,
      });
      if (atom.kind === 'decision') {
        stats.decisions++;
        stats.decisionAtoms.push({ ts: isNonEmptyStr(atom.ts) ? atom.ts : null, commit: isNonEmptyStr(atom.commit) ? atom.commit : null });
      }
      if (atom.kind === 'pitfall') stats.pitfalls++;   // 踩坑口径①：按 kind 统计（S3 入库形态）
      const why = atom.why;
      if (isNonEmptyStr(why) && stripTrailers(why) === '') stats.trailerOnly++;
      stats.noiseInput.push({ title: isNonEmptyStr(atom.title) ? atom.title : '', why: isNonEmptyStr(why) ? why : '' });
      if (isPlainObject(atom.refs) && isNonEmptyStr(atom.refs.pitfall)) stats.refsPitfall++;
      const before = stats.lastAtomTs;
      stats.lastAtomTs = maxTs(before, atom.ts);
      // lastSource：最后一次落盘原子的来源（诊断「是 hook 还是 mine 在记」）
      if (stats.lastAtomTs !== before) stats.lastSource = atom.source ?? null;
      if (atom.source === 'hook') stats.lastHookTs = maxTs(stats.lastHookTs, atom.ts);
    }
  }
  // S2：噪音分布（分类器纯函数，见 lib/noise.js）——放在收尾算一次，报告与判级同源。
  // noiseInput 只是中间量，不进返回值（返回值形状只增稳定键）。
  const noise = noiseSummary(stats.noiseInput);
  // S3：确认进度（派生规则住在 lib/confirm.js，体检不复制一份）
  const confirmation = confirmationSummary(stats.statusAtoms, stats.confirmationRecords);
  const { noiseInput, confirmationRecords, statusAtoms, ...rest } = stats;
  return {
    ...rest,
    noise: { high: noise.high, low: noise.low, none: noise.none },
    noiseReasons: noise.reasons,
    confirmation,
    badConfirmations: countBadConfirmations(stats.confirmationRecords),   // D5：坏确认记录数（与派生同源）
    initialized: true,
  };
}

// ---------- ③b 窗口捕获率（S8 修订，评审 🟡#2）----------
// 窗口 = 最近 N 个非 merge 提交。取 N+1 个提交：前 N 个是窗口，第 N+1 个的 committer 时间就是窗口下界
// （「上一个提交之后记下的决策」算在窗口内——决策往往先记、随后才落成提交）。
// 提交总数 ≤ N → 下界开放（窗口 = 全史）；任何 git 失败 → null，由调用方降级 unknown。
export function gitWindow(repoRoot, size, { exec = execFileSync } = {}) {
  if (!Number.isInteger(size) || size < 1) return null;
  const raw = git(exec, ['log', '--no-merges', '-n', String(size + 1), '--format=%H%x1f%cI', 'HEAD'], repoRoot);
  if (raw === null) return null;
  const rows = raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const [sha, ts] = l.split('\x1f');
    return { sha, ts: ts ?? null };
  });
  if (rows.length === 0) return { commits: 0, shas: [], startTs: null };
  const win = rows.slice(0, size);
  const boundary = rows[size] ?? null;                 // 第 N+1 个提交（窗口之外）——它的时间就是窗口下界
  return { commits: win.length, shas: win.map(r => r.sha), startTs: boundary ? boundary.ts : null };
}

// 窗口归属：ts 落在窗口时间跨度内，或 atom.commit 命中窗口内提交（rebase / cherry-pick 会打乱 ts 序）。
// startTs === null 表示下界开放（提交数 ≤ N）。
function inWindow(atom, shaSet, startMs) {
  if (atom.commit && (shaSet.has(atom.commit) || [...shaSet].some(s => s.startsWith(atom.commit)))) return true;
  const tsMs = atom.ts === null ? NaN : Date.parse(atom.ts);
  if (!Number.isFinite(tsMs)) return false;
  return startMs === null ? true : tsMs >= startMs;
}

// 窗口率 = 窗口内决策原子数 ÷ 窗口内提交数。测不出（非 git / 无 journal）→ 全 unknown（不是 0）。
export function windowCapture(stats, win, size = DEFAULT_CAPTURE_WINDOW) {
  const out = {
    size: Number.isInteger(size) && size > 0 ? size : UNKNOWN,
    commits: UNKNOWN, decisions: UNKNOWN, startTs: UNKNOWN, rate: UNKNOWN, ratePct: UNKNOWN,
  };
  if (!stats || !win || !Number.isFinite(win.commits)) return out;
  const startMs = win.startTs === null || win.startTs === undefined ? null : (Number.isFinite(Date.parse(win.startTs)) ? Date.parse(win.startTs) : null);
  const shaSet = new Set(win.shas ?? []);
  const decisions = (stats.decisionAtoms ?? []).filter(a => inWindow(a, shaSet, startMs)).length;
  const rate = win.commits > 0 ? decisions / win.commits : UNKNOWN;
  return {
    size: out.size,
    commits: win.commits,
    decisions,
    startTs: win.startTs ?? UNKNOWN,
    rate,
    ratePct: Number.isFinite(rate) ? Number((rate * 100).toFixed(2)) : UNKNOWN,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysBetween = (fromIso, now) => {
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return UNKNOWN;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
};

// ---------- ④ 捕获闸门（S8）----------
// 阈值来源优先级：CLI 旗标 > .lore/config.yml 的 doctor: 子块 > 未配置（不阻断）。
//   doctor:
//     capture_rate_min: 5    # 捕获率下限，百分数 0–100
//     gap_days_max: 30       # 断流上限，天（≥1）
// 纪律：阈值非法（越界/非数字）判红并写明，绝不静默回落默认值——静默回落 = 闸门静默失效，
// 正是本阶段要消灭的「安静地不工作」。闸门生效时 unknown 也算不通过（unknown 不是健康证据）。
export const GATE_LIMITS = Object.freeze({
  captureRateMinPct: Object.freeze({ min: 0, max: 100, key: 'capture_rate_min', flag: '--capture-rate-min' }),
  gapDaysMax: Object.freeze({ min: 1, max: 3650, key: 'gap_days_max', flag: '--gap-days-max' }),
  // 窗口大小是测量参数（不激活闸门），但非法值同样判红——静默回落默认 50 = 闸门换了口径还悄悄不说。
  captureWindowCommits: Object.freeze({ min: 1, max: 10000, key: 'capture_window_commits', flag: '--capture-window' }),
});

// 单个阈值：'5' / 5 都接受；越界或非数字 → ok:false（调用方决定怎么判红）。
export function parseThreshold(name, raw) {
  const lim = GATE_LIMITS[name];
  const s = String(raw ?? '').trim().replace(/^['"]|['"]$/g, '');
  const n = Number(s);
  if (!lim || s === '' || !Number.isFinite(n) || n < lim.min || n > lim.max) return { ok: false, raw: s };
  return { ok: true, value: n };
}

// 解析 config.yml 的 doctor: 子块：只认顶格 doctor: 之下、缩进更深的键；出块即停（不泄漏同级轴）。
export function parseGateConfig(configText) {
  const out = { captureRateMinPct: null, gapDaysMax: null, captureWindowCommits: null, invalid: [] };
  const byKey = {
    capture_rate_min: 'captureRateMinPct', gap_days_max: 'gapDaysMax', capture_window_commits: 'captureWindowCommits',
  };
  let inBlock = false;
  for (const rawLine of (configText ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (!inBlock) {
      if (indent === 0 && /^doctor:\s*(?:#.*)?$/.test(line)) inBlock = true;
      continue;
    }
    if (indent === 0) break;                                  // 出 doctor 块
    const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    const name = byKey[m[1]];
    if (!name) continue;                                      // 未知键不猜（键集只增不改）
    const parsed = parseThreshold(name, m[2].replace(/\s+#.*$/, ''));
    if (parsed.ok) out[name] = parsed.value;
    else out.invalid.push({ name, key: m[1], raw: parsed.raw });
  }
  return out;
}

// 阈值优先级：CLI 旗标 > config；两者都没有 = 未配置。返回 {captureRateMinPct, gapDaysMax, captureWindowCommits, invalid}。
// captureWindowCommits 是测量参数：未配置 → DEFAULT_CAPTURE_WINDOW（默认 50）；配了但非法 → null 且进 invalid（判红）。
export function resolveGateThresholds(configText, override = {}) {
  const cfg = parseGateConfig(configText);
  const invalid = [...cfg.invalid];
  const invalidNames = () => new Set(invalid.map(i => i.name));
  let captureWindowCommits = cfg.captureWindowCommits;
  if (captureWindowCommits === null && !invalidNames().has('captureWindowCommits')) {
    captureWindowCommits = DEFAULT_CAPTURE_WINDOW;
  }
  const thresholds = {
    captureRateMinPct: override.captureRateMinPct ?? cfg.captureRateMinPct,
    gapDaysMax: override.gapDaysMax ?? cfg.gapDaysMax,
    captureWindowCommits,
  };
  for (const name of ['captureRateMinPct', 'gapDaysMax', 'captureWindowCommits']) {
    const raw = override[name];
    if (raw === undefined || raw === null) continue;
    const parsed = parseThreshold(name, raw);
    if (parsed.ok) thresholds[name] = parsed.value;
    else {
      thresholds[name] = null;
      if (!invalidNames().has(name)) invalid.push({ name, key: GATE_LIMITS[name].flag, raw: parsed.raw });
    }
  }
  return { ...thresholds, invalid };
}

// 闸门判定：返回稳定契约 {ok, reason}（--json 的 gate 字段只有这两个键）。
// 捕获率口径 = **窗口率**（设计 §7 ⓪ 的前向窗口）：captureWindowRatePct 缺省（纯判定调用方只给一个率）时
// 退回 captureRatePct——diagnose 两个都给，所以真实报告恒用窗口率。reason 文案不变（CI / 壳状态行契约）。
export function evaluateGate(capture, thresholds = {}) {
  const { captureRateMinPct = null, gapDaysMax = null, invalid = [] } = thresholds ?? {};
  if (captureRateMinPct === null && gapDaysMax === null && invalid.length === 0) {
    return { ok: true, reason: 'not-configured' };
  }
  const fails = invalid.map(i => `invalid ${i.key}: ${i.raw === '' ? '(empty)' : i.raw}`);
  if (captureRateMinPct !== null) {
    const pct = capture?.captureWindowRatePct !== undefined ? capture.captureWindowRatePct : capture?.captureRatePct;
    if (pct === UNKNOWN) fails.push(`capture-rate unknown < ${captureRateMinPct}%`);
    else if (pct < captureRateMinPct) fails.push(`capture-rate ${pct}% < ${captureRateMinPct}%`);
  }
  if (gapDaysMax !== null) {
    const gap = capture?.gapDays;
    if (gap === UNKNOWN) fails.push(`gap unknown > ${gapDaysMax}d`);
    else if (gap > gapDaysMax) fails.push(`gap ${gap}d > ${gapDaysMax}d`);
  }
  return fails.length ? { ok: false, reason: fails.join('; ') } : { ok: true, reason: 'ok' };
}

// ---------- ⑤ 汇总报告（--json 的稳定契约） ----------
// 窗口读数 + 断流的**唯一派生点**（D3）：诊断报告与壳状态行的 fuel 都从这里取——
// 两处各算一遍就会漂移，而「燃料读数与 doctor 漂移」正是壳这一期最该防的失败（阶段 B 验收 2 / 8）。
function captureReadout(repoRoot, configText, j, { now, exec, gate = {} } = {}) {
  const thresholds = resolveGateThresholds(configText, gate);
  const win = j && Number.isInteger(thresholds.captureWindowCommits)
    ? gitWindow(repoRoot, thresholds.captureWindowCommits, { exec }) : null;
  return {
    thresholds,
    window: windowCapture(j, win, thresholds.captureWindowCommits),
    gapDays: j && j.lastHookTs ? daysBetween(j.lastHookTs, now) : UNKNOWN,
  };
}

export function diagnose(repoRoot, { now = new Date(), exec = execFileSync, gate = {} } = {}) {
  const root = resolve(repoRoot);
  const loreDir = join(root, '.lore');
  const initialized = existsSync(loreDir);
  const git_ = gitInfo(root, { exec });
  let configText = '';
  try { configText = readFileSync(join(loreDir, 'config.yml'), 'utf8'); } catch { configText = ''; }

  const hook = hookHealth(root, { configText, exec });
  const j = initialized ? readJournalStats(join(loreDir, 'journal')) : null;

  const atoms = j ? j.atoms : UNKNOWN;
  const commits = git_.commits;
  const decisions = j ? j.decisions : UNKNOWN;
  const captureRate = (Number.isFinite(commits) && commits > 0 && Number.isFinite(decisions))
    ? decisions / commits : UNKNOWN;
  const captureRatePct = Number.isFinite(captureRate) ? Number((captureRate * 100).toFixed(2)) : UNKNOWN;
  // 断流天数 / 窗口捕获率：与壳状态行的 fuel 同源（唯一派生点在 captureReadout，D3）。
  // 阈值解析只做一次，窗口大小与闸门判定同源（评审 🔵#5）。
  const { thresholds, window: window_, gapDays } = captureReadout(root, configText, j, { now, exec, gate });

  return {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    repo: { root, isGit: git_.isGit, head: git_.head, version: git_.version, commits },
    initialized,
    hook,
    capture: {
      atoms,
      badLines: j ? j.badLines : UNKNOWN,
      decisions,
      pitfalls: j ? j.pitfalls : UNKNOWN,
      trailerOnly: j ? j.trailerOnly : UNKNOWN,
      // S2 噪音分布（降权强度）——只增键：既有键名/语义不动，doctor 与后续章节 digest 共用同一分类器。
      noise: j ? j.noise : UNKNOWN,
      refsPitfall: j ? j.refsPitfall : UNKNOWN,
      commits,
      captureRate,
      captureRatePct,
      window: window_,
      lastAtomTs: j ? j.lastAtomTs : UNKNOWN,
      lastHookTs: j ? j.lastHookTs : UNKNOWN,
      lastSource: j ? j.lastSource : UNKNOWN,
      gapDays,
      // S3 确认进度（键集只增不改）：{records, decisions, confirmed, disputed, pending}
      confirmation: j ? j.confirmation : UNKNOWN,
      // D5：坏确认记录数（verdict 不在词表内）。与 confirmation 平级而非塞进它——confirmation
      // 的键集是既有消费方（cli / 壳）逐键读的契约，只增不改语义；这是新增维度，独立成键最小惊扰。
      badConfirmations: j ? j.badConfirmations : UNKNOWN,
    },
    // 闸门用窗口率；累计率只随报告输出（历史对比），不参与判定。
    gate: evaluateGate({ captureRatePct, captureWindowRatePct: window_.ratePct, gapDays }, thresholds),
  };
}

// ---------- ⑥ 壳状态行的燃料读数（设计 §5.3 底部 / §5.5，壳阶段 B） ----------
// 壳只读得到这四个数 + 一个三态 capture_state；口径**逐个等同** doctor 报告的同名字段
// （capture_pct = capture.window.ratePct、window_commits = capture.window.commits、
//  days_since_capture = capture.gapDays、last_hook_ts = capture.lastHookTs）——D3：同源，不重写一套。
// 取不到一律 UNKNOWN，**绝不用 0 冒充**（本文件顶部纪律）；capture_state 区分「测不出」（unknown）
// 与「测得出来但从来没有捕获过」（none）——后者正是「hook 断流 3 个月」那种要一眼看出的形态，
// 两者混成一个 unknown 就等于把最危险的失败模式藏起来。
// 性能：本函数只跑窗口 + 断流派生（不碰 hook 指向与仓库版本——那两块各自要 spawn git）。
export function fuelReadout(repoRoot, { now = new Date(), exec = execFileSync } = {}) {
  const root = resolve(repoRoot);
  const loreDir = join(root, '.lore');
  const initialized = existsSync(loreDir);
  let configText = '';
  try { configText = readFileSync(join(loreDir, 'config.yml'), 'utf8'); } catch { configText = ''; }
  const j = initialized ? readJournalStats(join(loreDir, 'journal')) : null;
  const { window: window_, gapDays } = captureReadout(root, configText, j, { now, exec });
  const orUnknown = v => (v === null || v === undefined ? UNKNOWN : v);
  return {
    capture_state: !j ? UNKNOWN : (j.lastHookTs ? 'ok' : 'none'),
    capture_pct: orUnknown(window_.ratePct),
    window_commits: orUnknown(window_.commits),
    days_since_capture: orUnknown(gapDays),
    last_hook_ts: orUnknown(j ? j.lastHookTs : null),
  };
}

// ---------- 人读渲染（数字口径与 diagnose 一一对应；unknown 原样显示，不渲染成 0） ----------
export function formatReport(report) {
  const { repo, hook, capture: c, initialized } = report;
  const show = v => (v === null || v === undefined || v === UNKNOWN ? UNKNOWN : String(v));
  const pct = v => (v === UNKNOWN || v === undefined || v === null ? UNKNOWN : `${v}%`);
  const lines = [];
  lines.push(`lore doctor — ${repo.root}`);
  lines.push(`  git        ${repo.isGit
    ? `${repo.version ?? '(no tag)'} · ${show(repo.commits)} commits · head ${(repo.head ?? '').slice(0, 8) || UNKNOWN}`
    : `${UNKNOWN}（非 git 目录）`}`);
  const hookTarget = hook.target ? ` → ${hook.target}` : '';
  const hookVerdict = hook.ok === true ? 'ok' : hook.ok === null ? '(off)' : show(hook.ok);
  lines.push(`  hook       ${hook.status}${hookTarget} · 指向有效 ${hookVerdict}`);
  if (!initialized) {
    lines.push(`  capture    ${UNKNOWN}（无 .lore — run /lore:init）`);
  } else {
    lines.push(`  capture    last hook ${show(c.lastHookTs)}（${show(c.gapDays)} 天前） · last atom ${show(c.lastAtomTs)}（${show(c.lastSource)}）`);
  }
  lines.push(`  atoms      ${show(c.atoms)} · decision ${show(c.decisions)} · pitfall ${show(c.pitfalls)}（kind=pitfall）· trailer-only ${show(c.trailerOnly)} · refs.pitfall ${show(c.refsPitfall)} · bad lines ${show(c.badLines)}`);
  // S2 噪音分布：降权强度分布（只标级，不删不改不回填——设计 §3.4）
  const n = c.noise;
  const noiseText = (n && n !== UNKNOWN)
    ? `high ${show(n.high)} · low ${show(n.low)} · none ${show(n.none)}`
    : UNKNOWN;
  lines.push(`  noise      ${noiseText}（trailer-only/模板/重复摘要降权）`);
  // S3 确认进度：已确认 / 待确认（决策原子）+ 确认记录条数。口径与 capture.confirmation 同源。
  const cf = c.confirmation;
  lines.push(`  confirm    ${(cf && cf !== UNKNOWN)
    ? `已确认 ${cf.confirmed} · 待确认 ${cf.pending} · 已否决 ${cf.disputed} · 未署名 ${show(cf.unattributed ?? 0)} · 坏确认记录 ${show(c.badConfirmations)}（决策 ${cf.decisions} · confirmation 记录 ${cf.records}）`
    : UNKNOWN}`);
  // 两个口径同时显示（S8 修订）：窗口率 = 闸门口径（最近 N 个提交），累计率 = 历史对比。
  const w = c.window ?? {};
  lines.push(`  rate       window ${pct(w.ratePct)}（${show(w.decisions)} decision / ${show(w.commits)} commits，N=${show(w.size)}）· 累计 ${pct(c.captureRatePct)}（${show(c.decisions)} decision / ${show(c.commits)} commits）`);
  // 闸门行（S8）：生效且不通过时醒目告警——人读输出与退出码是同一个判定的两个出口。
  const g = report.gate ?? { ok: true, reason: 'not-configured' };
  lines.push(`  gate       ${g.ok
    ? (g.reason === 'not-configured' ? 'ok（未配置阈值 → 不阻断）' : 'ok')
    : `⚠ FAIL — ${g.reason}`}`);
  return lines.join('\n');
}
