#!/usr/bin/env node
// scripts/capture-matrix.mjs —— per-backend 捕获召回率采样矩阵（设计 §7 ⓪ 期 S8 / 评审 🟡#1）。
//
// 为什么存在：doctor 只度量「本仓真实提交里决策原子够不够」（存量体检），它答不了「换个后端，
// agent 代捕获约定还灵不灵」。S8 定了口径（每后端 5 会话 × 3 决策任务）与报告格式，却没落脚本——
// 没有脚本的口径就是空话；这条评审 🟡#1 补的就是它。
//
// 采样协议（本脚本自己定义，且离线可复算）：
//   ① 每个后端跑 --sessions 个会话（默认 ${DEFAULT_SESSIONS}），每个会话给同一组 3 个决策任务
//      （选型 / 否决 / 权衡，见 DECISION_TASKS）。
//   ② 每个会话开一个临时 fixture 仓库（src/store.js + README.md，见 writeFixture），后端 CLI 以
//      只读工具策略在其中作答（argv 与 lib/backend.js 同款只读策略，见 CLI_ARGS 的注释）。
//   ③ 约定要求「做出非显然决策时追加一条 kind:decision 的 draft 原子」，所以采样判定 = 会话输出里
//      有没有**过 S1 校验**的 kind:decision 原子（lib/atom.js validateAtom 是唯一判据）。
//      原子的 status 必须是 draft、refs.anchors 必须非空——这两项正是约定里可机械检查的硬约束。
//   ④ 逐会话记 {backend, session, decisions_made, atoms_captured, status_draft, anchors_attached}
//      （S8 定死的键），另加两个**只增不改**的诊断键 invalid_atoms / error：把「模型没吐原子」与
//      「吐了但形状非法」分开——否则两种完全不同的失败在报告里长一个样。
//
// 报告形状：{schemaVersion, generated_at, sessions_per_backend, tasks, per_backend:[…], gate:{ok,reason}}
//   per_backend[i] = {backend, status:'ok'|'skipped', reason, sessions:[…], decisions_made,
//                     atoms_captured, invalid_atoms, rate}
//   闸门：阈值同 doctor 的 capture_rate_min（--capture-rate-min 覆盖，否则读 .lore/config.yml 的 doctor:）。
//   未配置 → {ok:true, reason:'not-configured'} 且 exit 0；配置了而采样率低于阈值（或采不到样本 →
//   unknown）→ {ok:false, reason} 且 exit 1。unknown 判红与 doctor 同纪律：unknown 不是健康证据。
//
// 纪律：后端不可用标 status:'skipped'（绝不崩，也绝不把它算成 0% 去拉低整体）；采样只读，
// 不碰本仓 .lore——fixture 在系统临时目录，用完即删。
//
// 用法：node scripts/capture-matrix.mjs [--sessions <n>] [--backends <a,b>] [--capture-rate-min <pct>]
//        [--timeout-ms <ms>] [--root <repo>] [--out <file>]

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAtom } from '../lib/atom.js';
import { BACKEND_ORDER, detectAvailableBackends } from '../lib/backend.js';
import { UNKNOWN, evaluateGate, resolveGateThresholds } from '../lib/doctor.js';

export const MATRIX_SCHEMA_VERSION = 1;
export const DEFAULT_SESSIONS = 5;

// 三个决策任务：选型 / 否决 / 权衡（设计 §7 ⓪ 期 S8 明列的三类）。
export const DECISION_TASKS = Object.freeze([
  {
    id: 'selection', label: '选型',
    brief: '在两个都能用的方案之间选一个（同步 fs vs 异步 fs），说清为什么选它、为什么否掉另一个。',
  },
  {
    id: 'rejection', label: '否决',
    brief: '明确否决「把存储换成 SQLite」这个看起来可行的方案，说清否决理由。',
  },
  {
    id: 'tradeoff', label: '权衡',
    brief: '在「保持同步 API」与「改成 Promise API」之间做权衡取舍，说清代价与收益。',
  },
]);

// 只读工具策略与 lib/backend.js 的三个 rewritePage argv 对齐（那边是生产路径，这里是采样器；
// 改那边的工具策略时同步这里，否则采样的「约定遵守率」测的就不是生产的后端行为）。
export const CLI_ARGS = Object.freeze({
  claude: prompt => ['-p', prompt, '--allowedTools', 'Read,Grep,Glob', '--disallowedTools', 'Write,Edit,Bash'],
  codex: (prompt, cwd) => ['exec', prompt, '-C', cwd, '--sandbox', 'read-only'],
  opencode: prompt => ['run', prompt],
});

const CONFIG_PATH = '.lore/config.yml';

export function buildSessionPrompt(task) {
  return [
    '你是本仓库的工程师。仓库根在当前目录：src/store.js（append-only 键值存储）与 README.md。',
    '',
    `决策任务（${task.label}）：${task.brief}`,
    '',
    '要求：',
    '1. 先读 src/store.js 与 README.md，结论必须基于真实代码，不要泛泛而谈。',
    '2. 做出决策后，按 lore 的 agent 代捕获约定追加一条 kind:decision 的 draft 原子，',
    '   并把该原子**作为一个单独的合法 JSON 对象**打印到 stdout（不要包在代码围栏里）。形状：',
    '   {"id":"decision:<slug>","ts":"<ISO-8601>","kind":"decision","title":"<一句话决定>",',
    '    "why":"<为什么这么定：因果，不是复述>","refs":{"anchors":["<symbol> @ src/store.js:<line>"]},',
    '    "source":"agent:capture-matrix","status":"draft"}',
    '3. 只有 owner 的直接动作能产生 confirmed——机器代写只能是 status:"draft"。',
  ].join('\n');
}

// ---------- 原子提取 ----------
// 从任意文本里扫出所有平衡的 JSON 对象（字符串/转义感知），只留 kind:'decision' 的候选。
function* jsonCandidates(text) {
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') { i++; continue; }
    let depth = 0, inStr = false, esc = false, j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) return;                      // 未闭合 → 到此为止（坏输出不该把扫描卡死）
    yield text.slice(i, j + 1);
    i = j + 1;
  }
}

// 返回 {valid, invalid}：valid = 过 S1 校验的 decision 原子；invalid = 形状非法的候选（诊断用）。
export function extractDecisionAtoms(text) {
  const valid = [];
  const invalid = [];
  for (const candidate of jsonCandidates(String(text ?? ''))) {
    let raw;
    try { raw = JSON.parse(candidate); } catch { continue; }
    for (const obj of Array.isArray(raw) ? raw : [raw]) {
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) continue;
      if (obj.kind !== 'decision') continue;
      if (validateAtom(obj).ok) valid.push(obj);
      else invalid.push(obj);
    }
  }
  return { valid, invalid };
}

const hasDraftStatus = atom => atom.status === 'draft';
const hasAnchors = atom => Array.isArray(atom?.refs?.anchors) && atom.refs.anchors.length > 0;
const clip = s => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);

// ---------- 参数 ----------
export function parseMatrixArgs(argv) {
  const out = { sessions: DEFAULT_SESSIONS, timeoutMs: 300_000, root: process.cwd(), backends: null,
    captureRateMin: null, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${a} requires a value`);
      i++;
      return next;
    };
    if (a === '--sessions') out.sessions = Number(val());
    else if (a === '--backends') out.backends = val().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--capture-rate-min') out.captureRateMin = val();
    else if (a === '--timeout-ms') out.timeoutMs = Number(val());
    else if (a === '--root') out.root = val();
    else if (a === '--out') out.out = val();
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!Number.isInteger(out.sessions) || out.sessions < 1) throw new Error('--sessions must be a positive integer');
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) throw new Error('--timeout-ms must be a positive number');
  return out;
}

// ---------- fixture ----------
const STORE_JS = [
  '// Minimal append-only key/value store (fixture for the capture matrix).',
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  '',
  'function openStore(dir) {',
  '  fs.mkdirSync(dir, { recursive: true });',
  "  return { file: path.join(dir, 'store.log') };",
  '}',
  '',
  'function put(store, key, value) {',
  "  fs.appendFileSync(store.file, JSON.stringify({ key, value }) + '\\n');",
  '}',
  '',
  'function get(store, key) {',
  "  const lines = fs.readFileSync(store.file, 'utf8').split('\\n').filter(Boolean);",
  '  for (let i = lines.length - 1; i >= 0; i--) {',
  '    const rec = JSON.parse(lines[i]);',
  '    if (rec.key === key) return rec.value;',
  '  }',
  '  return undefined;',
  '}',
  '',
  'module.exports = { openStore, put, get };',
  '',
].join('\n');

const README_MD = [
  '# fixture-store',
  '',
  '单进程 append-only 键值存储。当前实现是同步 fs（openStore / put / get），',
  '读回时从尾部线性扫描取最后一次写入。没有并发写保护，也没有索引。',
  '',
].join('\n');

export function writeFixture(dir) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'store.js'), STORE_JS);
  writeFileSync(join(dir, 'README.md'), README_MD);
  return dir;
}

// ---------- 单次会话调用（默认走真 CLI；测试/自检注入 runSession 即可离线复算） ----------
export function defaultRunSession({ backend, prompt, cwd, timeoutMs, exec = execFile }) {
  const spec = CLI_ARGS[backend];
  if (!spec) return Promise.resolve({ ok: false, error: `unknown backend: ${backend}` });
  return new Promise(res => {
    exec(backend, spec(prompt, cwd), { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return res({ ok: false, error: clip(String(stderr ?? '').trim() || String(err.message ?? err)) });
        res({ ok: true, stdout: String(stdout ?? '') });
      });
  });
}

// 一个后端的全部会话。返回 {status, reason, sessions}。
async function sampleBackend(backend, { sessions, timeoutMs, runSession, onProgress = () => {} }) {
  const records = [];
  for (let s = 1; s <= sessions; s++) {
    const dir = mkdtempSync(join(tmpdir(), `lore-matrix-${backend}-`));
    writeFixture(dir);
    let decisionsMade = 0, captured = 0, invalid = 0, draftAll = true, anchorsAll = true, error = null;
    try {
      for (const task of DECISION_TASKS) {
        decisionsMade++;
        const r = await runSession({ backend, prompt: buildSessionPrompt(task), cwd: dir, timeoutMs });
        if (!r?.ok) { error = clip(r?.error ?? 'session failed'); continue; }
        const { valid, invalid: bad } = extractDecisionAtoms(r.stdout);
        captured += valid.length;
        invalid += bad.length;
        for (const atom of valid) {
          if (!hasDraftStatus(atom)) draftAll = false;
          if (!hasAnchors(atom)) anchorsAll = false;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    records.push({
      backend, session: s,
      decisions_made: decisionsMade,
      atoms_captured: captured,
      invalid_atoms: invalid,
      status_draft: captured > 0 && draftAll,
      anchors_attached: captured > 0 && anchorsAll,
      error,
    });
    onProgress({ backend, session: s, captured });
    // 第一个会话就「CLI 不存在」→ 整个后端标 skipped，别把剩下 N-1 个会话重复烧一遍。
    if (s === 1 && captured === 0 && /ENOENT|not found|no such file/i.test(String(error ?? ''))) {
      return { status: 'skipped', reason: 'cli-missing', sessions: records };
    }
  }
  return { status: 'ok', reason: null, sessions: records };
}

const sum = (arr, k) => arr.reduce((n, x) => n + (Number(x?.[k]) || 0), 0);
const rate = (captured, made) => (made > 0 ? Number((captured / made).toFixed(4)) : UNKNOWN);

// ---------- 主流程 ----------
export async function runMatrix({
  sessions = DEFAULT_SESSIONS,
  backends = [...BACKEND_ORDER],
  timeoutMs = 300_000,
  root = process.cwd(),
  captureRateMin = null,
  runSession = defaultRunSession,
  detect = opts => detectAvailableBackends(opts),
  exec = execFile,
  now = () => new Date(),
  onProgress = () => {},
} = {}) {
  const unknownBackends = backends.filter(b => !BACKEND_ORDER.includes(b));
  if (unknownBackends.length) throw new Error(`unknown backend(s): ${unknownBackends.join(', ')} (expected ${BACKEND_ORDER.join('|')})`);

  const available = new Set(await detect({ exec }));
  const perBackend = [];
  for (const backend of backends) {
    if (!available.has(backend)) {
      perBackend.push({ backend, status: 'skipped', reason: 'unavailable', sessions: [], decisions_made: 0, atoms_captured: 0, invalid_atoms: 0, rate: UNKNOWN });
      continue;
    }
    const { status, reason, sessions: records } = await sampleBackend(backend, { sessions, timeoutMs, runSession, onProgress });
    perBackend.push({
      backend, status, reason, sessions: records,
      decisions_made: sum(records, 'decisions_made'),
      atoms_captured: sum(records, 'atoms_captured'),
      invalid_atoms: sum(records, 'invalid_atoms'),
      rate: rate(sum(records, 'atoms_captured'), sum(records, 'decisions_made')),
    });
  }

  const sampled = perBackend.filter(b => b.status === 'ok');
  const decisionsMade = sum(sampled, 'decisions_made');
  const atomsCaptured = sum(sampled, 'atoms_captured');
  const captureRatePct = decisionsMade > 0 ? Number((atomsCaptured / decisionsMade * 100).toFixed(2)) : UNKNOWN;

  let configText = '';
  try { configText = readFileSync(join(resolve(root), CONFIG_PATH), 'utf8'); } catch { configText = ''; }
  const thresholds = resolveGateThresholds(configText, { captureRateMinPct: captureRateMin });
  // 只用捕获率这一个维度判闸（gap_days_max 是 doctor 的存量口径，采样矩阵没有「断流天数」可言）。
  const gate = evaluateGate({ captureRatePct }, { captureRateMinPct: thresholds.captureRateMinPct, invalid: thresholds.invalid });

  return {
    schemaVersion: MATRIX_SCHEMA_VERSION,
    generated_at: now().toISOString(),
    sessions_per_backend: sessions,
    tasks: DECISION_TASKS.map(t => t.label),
    per_backend: perBackend,
    gate,
  };
}

export const USAGE = [
  'usage: node scripts/capture-matrix.mjs [options]',
  '',
  'options:',
  `  --sessions <n>            每个后端跑几个会话（默认 ${DEFAULT_SESSIONS}），每个会话 3 个决策任务`,
  `  --backends <a,b>          只采样这些后端（${BACKEND_ORDER.join('|')}）；默认全部，不可用的标 skipped`,
  '  --capture-rate-min <pct>  闸门阈值（百分数）；缺省读 .lore/config.yml 的 doctor.capture_rate_min',
  '  --timeout-ms <ms>         单次后端调用超时（默认 300000）',
  '  --root <repo>             仓库根（读 config 用；默认当前目录）',
  '  --out <file>              报告写入文件（缺省 stdout）',
  '',
  'exit: 0 = 闸门通过或未配置阈值；1 = 闸门不通过（捕获率低于阈值，或采不到样本 → unknown）',
].join('\n');

async function main(argv) {
  let args;
  try { args = parseMatrixArgs(argv); }
  catch (e) { console.error(`lore: ${e.message}`); console.error(USAGE); return 1; }
  if (args.help) { console.log(USAGE); return 0; }
  const report = await runMatrix({
    sessions: args.sessions, backends: args.backends ?? [...BACKEND_ORDER], timeoutMs: args.timeoutMs,
    root: args.root, captureRateMin: args.captureRateMin,
    onProgress: p => console.error(`  ${p.backend} session ${p.session}: ${p.captured} atom(s)`),
  });
  const json = JSON.stringify(report, null, 2) + '\n';
  if (args.out) {
    const p = resolve(process.cwd(), args.out);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, json);
    console.error(`lore: matrix written → ${p}`);
  } else {
    process.stdout.write(json);
  }
  if (!report.gate.ok) { console.error(`lore: capture gate failed — ${report.gate.reason}`); return 1; }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
