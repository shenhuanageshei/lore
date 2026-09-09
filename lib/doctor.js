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

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTrailers } from './fold.js';
import { HOOK_MARKER } from './migrate.js';

export const DOCTOR_SCHEMA_VERSION = 1;
// 取不到的数字一律用它——0 是「测出来是零」，unknown 是「测不出来」，两者不可混。
export const UNKNOWN = 'unknown';

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
//   refsPitfall refs.pitfall 非空（口径②：旧形态，S3 之后恒为 0——两口径必须分列，不可互相替代）
//   lastHookTs  source === 'hook' 的最新 ts（捕获路径的沉默时长看它）
//   lastAtomTs  任何来源的最新 ts（对照：hook 死了但 mine 还在跑时仍能看出差别）
export function readJournalStats(journalDir) {
  const files = walkNdjson(journalDir);
  const stats = {
    files: files.length, atoms: 0, badLines: 0, decisions: 0, pitfalls: 0, trailerOnly: 0, refsPitfall: 0,
    lastHookTs: null, lastAtomTs: null, lastSource: null,
  };
  if (!existsSync(journalDir)) {
    return { ...stats, initialized: false };
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
      stats.atoms++;
      if (atom.kind === 'decision') stats.decisions++;
      if (atom.kind === 'pitfall') stats.pitfalls++;   // 踩坑口径①：按 kind 统计（S3 入库形态）
      const why = atom.why;
      if (isNonEmptyStr(why) && stripTrailers(why) === '') stats.trailerOnly++;
      if (isPlainObject(atom.refs) && isNonEmptyStr(atom.refs.pitfall)) stats.refsPitfall++;
      const before = stats.lastAtomTs;
      stats.lastAtomTs = maxTs(before, atom.ts);
      // lastSource：最后一次落盘原子的来源（诊断「是 hook 还是 mine 在记」）
      if (stats.lastAtomTs !== before) stats.lastSource = atom.source ?? null;
      if (atom.source === 'hook') stats.lastHookTs = maxTs(stats.lastHookTs, atom.ts);
    }
  }
  return { ...stats, initialized: true };
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
  const out = { captureRateMinPct: null, gapDaysMax: null, invalid: [] };
  const byKey = { capture_rate_min: 'captureRateMinPct', gap_days_max: 'gapDaysMax' };
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

// 阈值优先级：CLI 旗标 > config；两者都没有 = 未配置。返回 {captureRateMinPct, gapDaysMax, invalid}。
export function resolveGateThresholds(configText, override = {}) {
  const cfg = parseGateConfig(configText);
  const thresholds = {
    captureRateMinPct: override.captureRateMinPct ?? cfg.captureRateMinPct,
    gapDaysMax: override.gapDaysMax ?? cfg.gapDaysMax,
  };
  const invalid = [...cfg.invalid];
  for (const name of ['captureRateMinPct', 'gapDaysMax']) {
    const raw = override[name];
    if (raw === undefined || raw === null) continue;
    const parsed = parseThreshold(name, raw);
    if (parsed.ok) thresholds[name] = parsed.value;
    else { thresholds[name] = null; invalid.push({ name, key: GATE_LIMITS[name].flag, raw: parsed.raw }); }
  }
  return { ...thresholds, invalid };
}

// 闸门判定：返回稳定契约 {ok, reason}（--json 的 gate 字段只有这两个键）。
export function evaluateGate(capture, thresholds = {}) {
  const { captureRateMinPct = null, gapDaysMax = null, invalid = [] } = thresholds ?? {};
  if (captureRateMinPct === null && gapDaysMax === null && invalid.length === 0) {
    return { ok: true, reason: 'not-configured' };
  }
  const fails = invalid.map(i => `invalid ${i.key}: ${i.raw === '' ? '(empty)' : i.raw}`);
  if (captureRateMinPct !== null) {
    const pct = capture?.captureRatePct;
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
      refsPitfall: j ? j.refsPitfall : UNKNOWN,
      commits,
      captureRate,
      captureRatePct,
      lastAtomTs: j ? j.lastAtomTs : UNKNOWN,
      lastHookTs: j ? j.lastHookTs : UNKNOWN,
      lastSource: j ? j.lastSource : UNKNOWN,
      gapDays: j && j.lastHookTs ? daysBetween(j.lastHookTs, now) : UNKNOWN,
    },
    gate: evaluateGate(
      {
        captureRatePct,
        gapDays: j && j.lastHookTs ? daysBetween(j.lastHookTs, now) : UNKNOWN,
      },
      resolveGateThresholds(configText, gate),
    ),
  };
}

// ---------- 人读渲染（数字口径与 diagnose 一一对应；unknown 原样显示，不渲染成 0） ----------
export function formatReport(report) {
  const { repo, hook, capture: c, initialized } = report;
  const show = v => (v === null || v === undefined || v === UNKNOWN ? UNKNOWN : String(v));
  const pct = v => (v === UNKNOWN ? UNKNOWN : `${v}%`);
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
  lines.push(`  rate       ${pct(c.captureRatePct)}（${show(c.decisions)} decision / ${show(c.commits)} commits）`);
  // 闸门行（S8）：生效且不通过时醒目告警——人读输出与退出码是同一个判定的两个出口。
  const g = report.gate ?? { ok: true, reason: 'not-configured' };
  lines.push(`  gate       ${g.ok
    ? (g.reason === 'not-configured' ? 'ok（未配置阈值 → 不阻断）' : 'ok')
    : `⚠ FAIL — ${g.reason}`}`);
  return lines.join('\n');
}
