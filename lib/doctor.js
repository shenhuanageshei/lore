// lib/doctor.js —— 体检 + 捕获召回率（设计 2026-09-09 §6 / §7 ⓪ 期 S5）。
//
// lore 最危险的失败是「安静地不工作」：hook 曾断流 3 个月、85 提交零原子而无人察觉。
// 本模块只做一件事——把「没记下来」变成可读的数字：
//   ① hook 指向是否有效（post-commit stub 是否还指向本引擎的 lib/hook.js）
//   ② 上次成功捕获时间 + 断流天数（hook 这条捕获路径沉默了多久）
//   ③ 决策捕获率（kind:decision ÷ 提交数）——泵有没有在打水
//   ④ trailer-only 计数（不变量⑦ 的存量体检）+ refs.pitfall 计数（踩坑是否进库）
//
// 纪律：
//   · 只读：绝不写 .lore / 绝不调 alignHookStub（那是迁移器，会改 .git/hooks）——见 test/doctor.test.js 的只读回归。
//   · 取不到的数字标 'unknown'，绝不用 0 冒充（非 git 目录、无 .lore、无 tag 都是 unknown 场景）。
//   · 坏行跳过不崩：体检工具自己崩掉比数字缺失更糟。
//   · 报告形状（--json）是稳定契约：字段只增不改语义，见 DOCTOR_SCHEMA_VERSION。

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
//   trailerOnly why 非空但剥掉 trailer 后为空——「无正文」（不变量⑦）
//   refsPitfall refs.pitfall 非空
//   lastHookTs  source === 'hook' 的最新 ts（捕获路径的沉默时长看它）
//   lastAtomTs  任何来源的最新 ts（对照：hook 死了但 mine 还在跑时仍能看出差别）
export function readJournalStats(journalDir) {
  const files = walkNdjson(journalDir);
  const stats = {
    files: files.length, atoms: 0, badLines: 0, decisions: 0, trailerOnly: 0, refsPitfall: 0,
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

// ---------- ④ 汇总报告（--json 的稳定契约） ----------
export function diagnose(repoRoot, { now = new Date(), exec = execFileSync } = {}) {
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
  lines.push(`  atoms      ${show(c.atoms)} · decision ${show(c.decisions)} · trailer-only ${show(c.trailerOnly)} · refs.pitfall ${show(c.refsPitfall)} · bad lines ${show(c.badLines)}`);
  lines.push(`  rate       ${pct(c.captureRatePct)}（${show(c.decisions)} decision / ${show(c.commits)} commits）`);
  return lines.join('\n');
}
