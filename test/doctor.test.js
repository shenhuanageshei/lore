// test/doctor.test.js —— S5 体检 + 捕获召回率（设计 §6 / §7 ⓪ 期）。
// 三条硬验收：本仓库真实数字 / 非 git 降级 unknown 不崩 / --json 字段稳定；
// 外加两条纪律回归：doctor 只读（绝不写 .lore）、hook 指向判定六态。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CAPTURE_WINDOW, DOCTOR_SCHEMA_VERSION, UNKNOWN, diagnose, evaluateGate, formatReport, gitWindow,
  hookHealth, parseGateConfig, readJournalStats, resolveGateThresholds, windowCapture,
} from '../lib/doctor.js';
import { renderHookStub } from '../lib/migrate.js';
import { main } from '../lib/cli.js';

const ROOT = process.cwd();
const ENGINE_HOOK = fileURLToPath(new URL('../lib/hook.js', import.meta.url));
const CLI = join(ROOT, 'lib', 'cli.js');

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-doctor-')); }
function gitInit(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
}
// 只读快照：文件集合 + 大小 + mtime（内容被改写/新文件落盘都会露出来）
function snapshot(dir) {
  const out = {};
  const walk = (d, rel) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(p, r);
      else { const st = statSync(p); out[r] = st.size + ':' + st.mtimeMs; }
    }
  };
  walk(dir, '');
  return out;
}

const atom = o => JSON.stringify(o);
const ATOMS = [
  atom({ id: 'commit:a1', ts: '2026-09-01T00:00:00Z', kind: 'commit', source: 'hook', why: 'Co-Authored-By: X <x@y>' }),   // trailer-only
  atom({ id: 'commit:a2', ts: '2026-09-02T00:00:00Z', kind: 'commit', source: 'hook', why: '真的原因' , refs: { pitfall: 'pitfall:abc' } }),
  atom({ id: 'decision:d1', ts: '2026-09-05T00:00:00Z', kind: 'decision', source: 'agent', title: 't', why: 'w' }),
  atom({ id: 'commit:a3', ts: '2026-09-09T00:00:00Z', kind: 'commit', source: 'miner:commits' }),
  // 踩坑两口径：kind==='pitfall'（S3 入库形态，审计 D1 的正口径）与 refs.pitfall（旧形态，恒 null）
  atom({ id: 'pitfall:p1', ts: '2026-09-06T00:00:00Z', kind: 'pitfall', source: 'miner:claude_md_pitfalls', problem: 'p', fix: 'f', prevention: 'v' }),
  atom({ id: 'pitfall:p2', ts: '2026-09-07T00:00:00Z', kind: 'pitfall', source: 'miner:claude_md_pitfalls', problem: 'p2', fix: 'f2', prevention: 'v2' }),
].join('\n') + '\n{oops\n42\n';

// ---------- 验收 1：本仓库真实数字 ----------
test('本仓库：原子 ~490 / decision 1 / trailer-only 127 量级；hook 指向有效', () => {
  const r = diagnose(ROOT, { now: new Date('2026-09-10T00:00:00Z') });
  assert.equal(r.schemaVersion, DOCTOR_SCHEMA_VERSION);
  assert.equal(r.repo.isGit, true);
  assert.equal(r.initialized, true);
  assert.ok(r.capture.atoms >= 400 && r.capture.atoms <= 2000, 'atoms=' + r.capture.atoms);
  assert.ok(r.capture.decisions >= 1, 'decisions=' + r.capture.decisions);
  assert.ok(r.capture.trailerOnly >= 100, 'trailerOnly=' + r.capture.trailerOnly);
  // 踩坑按 kind 计（审计 D1）：S3 之后 refs.pitfall 恒 null，只数它会报 0 而与记录层事实矛盾
  assert.ok(r.capture.pitfalls >= 11, 'pitfalls=' + r.capture.pitfalls);
  assert.equal(typeof r.capture.refsPitfall, 'number');
  assert.ok(r.capture.commits > 300, 'commits=' + r.capture.commits);
  assert.ok(r.capture.captureRate > 0 && r.capture.captureRate < 0.05, 'rate=' + r.capture.captureRate);
  assert.equal(r.hook.status, 'ok');
  assert.equal(r.hook.ok, true);
  assert.ok(Number.isInteger(r.capture.gapDays), 'gapDays=' + r.capture.gapDays);
  assert.ok(r.capture.lastHookTs);
  const txt = formatReport(r);
  assert.match(txt, /lore doctor — /);
  assert.match(txt, /trailer-only \d+/);
  // S2 噪音分布（降权强度）——本仓库 trailer-only 127 条全部 high（设计 §3.4 只降权不删除）
  assert.match(txt, /noise\s+high \d+ · low \d+ · none \d+/);
  assert.ok(r.capture.noise.high >= 100, 'noise.high=' + r.capture.noise.high);
  assert.equal(r.capture.noise.high + r.capture.noise.low + r.capture.noise.none, r.capture.atoms);
  assert.ok(r.capture.noise.high >= r.capture.trailerOnly, 'trailer-only 必须全部落在 high 里');
  assert.match(txt, /pitfall \d+（kind=pitfall）/, '两口径分列：按 kind 的踩坑数');
  assert.match(txt, /refs\.pitfall \d+/, '旧口径 refs.pitfall 仍单列');
  assert.match(txt, /decision \/ \d+ commits/);
});

// ---------- 验收 2：非 git 目录降级 unknown（不是 0）且不崩 ----------
test('非 git 目录：git 派生指标一律 unknown，不崩、不写成 0', () => {
  const dir = tmp();
  try {
    const r = diagnose(dir);
    assert.equal(r.repo.isGit, false);
    assert.equal(r.repo.commits, UNKNOWN);
    assert.equal(r.capture.commits, UNKNOWN);
    assert.equal(r.capture.captureRate, UNKNOWN);
    assert.equal(r.capture.captureRatePct, UNKNOWN);
    assert.equal(r.capture.atoms, UNKNOWN);          // 无 .lore → 没数过，不是 0
    assert.equal(r.capture.pitfalls, UNKNOWN);
    assert.equal(r.capture.gapDays, UNKNOWN);
    assert.equal(r.capture.lastHookTs, UNKNOWN);
    assert.equal(r.hook.status, 'no-git');
    assert.equal(r.hook.ok, UNKNOWN);
    assert.equal(r.initialized, false);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(r)));
    const txt = formatReport(r);
    assert.match(txt, /unknown/);
    assert.doesNotMatch(txt, /0\.00%/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- 验收 3：--json 字段稳定 ----------
test('--json：顶层与子对象键集锁定，可被程序消费；--json 不吞后续开关', () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, '.lore', 'journal', '2026', '09'), { recursive: true });
    writeFileSync(join(dir, '.lore', 'journal', '2026', '09', '2026-09-09.ndjson'), ATOMS);
    const sink = [];
    assert.equal(main(['doctor', '--json', '--root', dir], { cwd: ROOT, out: s => sink.push(s), err: s => sink.push(s) }), 0);
    const doc = JSON.parse(sink.join('\n'));
    // S8 新增顶层 gate（键集只增不改：既有键名/语义一律不动）
    assert.deepEqual(Object.keys(doc), ['schemaVersion', 'generatedAt', 'repo', 'initialized', 'hook', 'capture', 'gate']);
    assert.deepEqual(Object.keys(doc.gate), ['ok', 'reason']);   // 闸门契约只有这两个键
    assert.deepEqual(doc.gate, { ok: true, reason: 'not-configured' });   // 未配阈值 → 不阻断
    assert.deepEqual(Object.keys(doc.repo), ['root', 'isGit', 'head', 'version', 'commits']);
    assert.deepEqual(Object.keys(doc.hook), ['status', 'ok', 'hookPath', 'target', 'expected']);
    // 键集只增不改：pitfalls / window 是新增，既有键名/语义一律不动
    // S2 新增 noise（键集只增不改：既有键名/语义一律不动）
    assert.deepEqual(Object.keys(doc.capture),
      ['atoms', 'badLines', 'decisions', 'pitfalls', 'trailerOnly', 'noise', 'refsPitfall', 'commits', 'captureRate',
        'captureRatePct', 'window', 'lastAtomTs', 'lastHookTs', 'lastSource', 'gapDays']);
    assert.deepEqual(Object.keys(doc.capture.noise), ['high', 'low', 'none']);   // 分布契约只有这三个键
    // 夹具里只有 a1 是 trailer-only → high；其余五条干净 → none
    assert.deepEqual(doc.capture.noise, { high: 1, low: 0, none: 5 });
    assert.deepEqual(Object.keys(doc.capture.window), ['size', 'commits', 'decisions', 'startTs', 'rate', 'ratePct']);
    assert.equal(doc.repo.root, resolve(dir));       // --json 后跟 --root 未被吞掉
    assert.equal(doc.capture.atoms, 6);
    assert.equal(doc.capture.badLines, 2);
    assert.equal(doc.capture.pitfalls, 2);
    assert.equal(doc.capture.refsPitfall, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI 端到端：node lib/cli.js doctor --json 输出可解析', () => {
  const r = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.schemaVersion, DOCTOR_SCHEMA_VERSION);
  assert.equal(doc.repo.root, ROOT);
  assert.ok(doc.capture.atoms >= 400);
});

// ---------- 纪律回归：只读 ----------
test('doctor 只读：不改 .lore 任何字节，也不碰 .git/hooks', () => {
  const dir = tmp();
  try {
    gitInit(dir);
    mkdirSync(join(dir, '.lore', 'journal', '2026', '09'), { recursive: true });
    mkdirSync(join(dir, '.lore', '.state'), { recursive: true });
    writeFileSync(join(dir, '.lore', 'config.yml'), 'journal:\n  hook: true\n');
    writeFileSync(join(dir, '.lore', 'journal', '2026', '09', '2026-09-09.ndjson'), ATOMS);
    const hookPath = join(dir, '.git', 'hooks', 'post-commit');
    writeFileSync(hookPath, renderHookStub(ENGINE_HOOK));
    const before = snapshot(join(dir, '.lore'));
    const hookBefore = readFileSync(hookPath, 'utf8');
    const r = diagnose(dir, { now: new Date('2026-09-10T00:00:00Z') });
    formatReport(r);
    assert.equal(r.hook.ok, true);                       // stub 指向本引擎 lib/hook.js
    assert.deepEqual(snapshot(join(dir, '.lore')), before);
    assert.equal(readFileSync(hookPath, 'utf8'), hookBefore);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- hook 指向六态 ----------
test('hook 指向：absent / foreign / stale / ok / disabled / hookspath-set', () => {
  const dir = tmp();
  try {
    gitInit(dir);
    const hookPath = join(dir, '.git', 'hooks', 'post-commit');

    assert.equal(hookHealth(dir).status, 'absent');
    assert.equal(hookHealth(dir).ok, false);

    writeFileSync(hookPath, '#!/bin/sh\necho hi\n');
    assert.equal(hookHealth(dir).status, 'foreign');
    assert.equal(hookHealth(dir).ok, false);

    writeFileSync(hookPath, '# lore:post-commit\nnode "/elsewhere/lib/hook.js" x\n');
    const stale = hookHealth(dir);
    assert.equal(stale.status, 'stale');
    assert.equal(stale.ok, false);
    assert.equal(stale.target, '/elsewhere/lib/hook.js');

    writeFileSync(hookPath, renderHookStub(ENGINE_HOOK));
    assert.equal(hookHealth(dir).status, 'ok');
    assert.equal(hookHealth(dir).ok, true);

    // config 声明 hook:false = 用户主动关，不是故障 → ok:null（区别于 false）
    const off = hookHealth(dir, { configText: 'journal:\n  hook: false\n' });
    assert.equal(off.status, 'disabled');
    assert.equal(off.ok, null);

    // core.hooksPath 指到别处 → 生效的 hook 看不见 → unknown（不猜 ok 也不猜坏）
    execFileSync('git', ['config', 'core.hooksPath', join(dir, 'myhooks')], { cwd: dir });
    const hp = hookHealth(dir);
    assert.equal(hp.status, 'hookspath-set');
    assert.equal(hp.ok, UNKNOWN);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- 计数口径 ----------
test('计数口径：trailer-only / decision / refs.pitfall / 坏行 / lastHook / 断流天数', () => {
  const dir = tmp();
  try {
    gitInit(dir);
    mkdirSync(join(dir, '.lore', 'journal', '2026', '09'), { recursive: true });
    writeFileSync(join(dir, '.lore', 'config.yml'), 'journal:\n  hook: true\n');
    writeFileSync(join(dir, '.lore', 'journal', '2026', '09', '2026-09-09.ndjson'), ATOMS);

    const s = readJournalStats(join(dir, '.lore', 'journal'));
    assert.equal(s.atoms, 6);
    assert.equal(s.badLines, 2);
    assert.equal(s.decisions, 1);
    assert.equal(s.pitfalls, 2);                        // 口径①：kind === 'pitfall'
    assert.equal(s.trailerOnly, 1);                     // Co-Authored-By 剥完为空
    assert.equal(s.refsPitfall, 1);                     // 口径②：refs.pitfall 非空（与口径①分列，不互相替代）
    assert.equal(s.lastHookTs, '2026-09-02T00:00:00Z'); // 只看 source=hook
    assert.equal(s.lastAtomTs, '2026-09-09T00:00:00Z');
    assert.equal(s.lastSource, 'miner:commits');
    // S2：噪音分布与 trailerOnly 同源（a1 是夹具里唯一的 trailer-only）
    assert.deepEqual(s.noise, { high: 1, low: 0, none: 5 });
    assert.equal(s.noiseReasons['trailer-only'], 1);

    const r = diagnose(dir, { now: new Date('2026-09-05T00:00:00Z') });
    assert.equal(r.capture.gapDays, 3);                 // 2026-09-02 → 09-05
    assert.equal(r.capture.atoms, 6);
    assert.equal(r.capture.pitfalls, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('断流天数只算一次：报告字段与闸门判定同源（now.getTime() 只被调一次）', () => {
  const dir = tmp();
  try {
    gitInit(dir);
    mkdirSync(join(dir, '.lore', 'journal', '2026', '09'), { recursive: true });
    writeFileSync(join(dir, '.lore', 'journal', '2026', '09', '2026-09-09.ndjson'), ATOMS);
    let getTimeCalls = 0;
    const now = {
      toISOString: () => '2026-09-05T00:00:00.000Z',
      getTime: () => { getTimeCalls++; return Date.parse('2026-09-05T00:00:00Z'); },
    };
    const r = diagnose(dir, { now, gate: { gapDaysMax: 3 } });
    assert.equal(r.capture.gapDays, 3);                 // 2026-09-02 → 09-05
    assert.equal(getTimeCalls, 1);                      // 合并前会算两次（评审 🔵#5）
    assert.deepEqual(r.gate, { ok: true, reason: 'ok' });   // 边界 3 > 3 不成立 → 不误判
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- S8：捕获闸门（评审 🔴#2；阈值用注入值，不依赖本仓库真实数字） ----------
const NOW = new Date('2026-09-10T00:00:00Z');
const jAtom = o => JSON.stringify(o);

// 夹具：git 仓库 + 一个 commit + 指定 journal（commits=1 → 捕获率 = decisions/1，可控）
function gateRepo(journalLines, configText) {
  const dir = tmp();
  gitInit(dir);
  mkdirSync(join(dir, '.lore', 'journal', '2026', '09'), { recursive: true });
  writeFileSync(join(dir, '.lore', 'journal', '2026', '09', '2026-09-09.ndjson'), journalLines.join('\n') + '\n');
  if (configText) writeFileSync(join(dir, '.lore', 'config.yml'), configText);
  writeFileSync(join(dir, 'a.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}
const DECISION = jAtom({ id: 'decision:d1', ts: '2026-09-09T00:00:00Z', kind: 'decision', source: 'agent', title: 't', why: 'w' });
const HOOK_NOW = jAtom({ id: 'commit:h1', ts: '2026-09-10T00:00:00Z', kind: 'commit', source: 'hook', commit: 'h1' });
const HOOK_OLD = jAtom({ id: 'commit:h2', ts: '2026-01-01T00:00:00Z', kind: 'commit', source: 'hook', commit: 'h2' });

test('闸门：未配置阈值 → ok/not-configured 且 exit 0（默认行为与今天一致）', () => {
  const dir = gateRepo([HOOK_OLD]);            // 断流 252 天，但没配阈值 → 不阻断
  try {
    const r = diagnose(dir, { now: NOW });
    assert.deepEqual(r.gate, { ok: true, reason: 'not-configured' });
    assert.match(formatReport(r), /gate\s+ok（未配置阈值 → 不阻断）/);
    const sink = [];
    assert.equal(main(['doctor', '--json', '--root', dir], { cwd: ROOT, out: s => sink.push(s), err: s => sink.push(s) }), 0);
    assert.equal(JSON.parse(sink.join('\n')).gate.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('闸门：捕获率低于 X → 非零退出 + 醒目告警 + --json gate 写明数字', () => {
  const dir = gateRepo([jAtom({ id: 'commit:h1', ts: '2026-09-10T00:00:00Z', kind: 'commit', source: 'hook', commit: 'h1' })]);   // 0 decision / 1 commit
  try {
    const r = diagnose(dir, { now: NOW, gate: { captureRateMinPct: 5 } });
    assert.equal(r.capture.captureRatePct, 0);
    assert.equal(r.gate.ok, false);
    assert.equal(r.gate.reason, 'capture-rate 0% < 5%');
    assert.match(formatReport(r), /gate\s+⚠ FAIL — capture-rate 0% < 5%/);
    const out = [], err = [];
    const code = main(['doctor', '--json', '--capture-rate-min', '5', '--root', dir], { cwd: ROOT, out: s => out.push(s), err: s => err.push(s) });
    assert.equal(code, 1);                                     // 非零退出（CI / 壳状态行的机器可读出口）
    assert.deepEqual(JSON.parse(out.join('\n')).gate, { ok: false, reason: 'capture-rate 0% < 5%' });
    assert.match(err.join('\n'), /lore: capture gate failed — capture-rate 0% < 5%/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('闸门：断流超过 N 天 → 非零退出；未超阈值 → ok 且 exit 0', () => {
  const stale = gateRepo([DECISION, HOOK_OLD]);
  const fresh = gateRepo([DECISION, HOOK_NOW]);
  try {
    const r = diagnose(stale, { now: NOW, gate: { gapDaysMax: 30 } });
    assert.equal(r.capture.gapDays, 252);                      // 2026-01-01 → 09-10
    assert.deepEqual(r.gate, { ok: false, reason: 'gap 252d > 30d' });
    const sink = [];
    assert.equal(main(['doctor', '--gap-days-max', '30', '--root', stale], { cwd: ROOT, out: s => sink.push(s), err: s => sink.push(s) }), 1);

    const ok = diagnose(fresh, { now: NOW, gate: { gapDaysMax: 30 } });
    assert.deepEqual(ok.gate, { ok: true, reason: 'ok' });
    const sink2 = [];
    assert.equal(main(['doctor', '--gap-days-max', '30', '--root', fresh], { cwd: ROOT, out: s => sink2.push(s), err: s => sink2.push(s) }), 0);
    assert.match(sink2.join('\n'), /gate\s+ok\b/);
  } finally {
    rmSync(stale, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});

test('闸门：阈值来自 .lore/config.yml 的 doctor: 子块（CLI 旗标可覆盖）', () => {
  const config = 'axes:\n  component:\n    code_roots: [lib]\ndoctor:\n  capture_rate_min: 50   # 百分数\n  gap_days_max: 3\nlanguage:\n  default: zh\n';
  const dir = gateRepo([DECISION, HOOK_OLD], config);          // 捕获率 100%（过），断流 252 天（不过）
  try {
    assert.deepEqual(parseGateConfig(config), { captureRateMinPct: 50, gapDaysMax: 3, captureWindowCommits: null, invalid: [] });
    const r = diagnose(dir, { now: NOW });
    assert.deepEqual(r.gate, { ok: false, reason: 'gap 252d > 3d' });
    const sink = [];
    assert.equal(main(['doctor', '--json', '--root', dir], { cwd: ROOT, out: s => sink.push(s), err: s => sink.push(s) }), 1);
    // CLI 旗标覆盖 config（把断流上限放宽 → 闸门转 ok）
    assert.deepEqual(diagnose(dir, { now: NOW, gate: { gapDaysMax: 365 } }).gate, { ok: true, reason: 'ok' });
    assert.equal(main(['doctor', '--gap-days-max', '365', '--root', dir], { cwd: ROOT, out: () => {}, err: () => {} }), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('闸门：取不到的数字在生效时判红（unknown 不是健康证据）', () => {
  const dir = tmp();                                           // 非 git、无 .lore → 全 unknown
  try {
    const r = diagnose(dir, { now: NOW, gate: { captureRateMinPct: 5, gapDaysMax: 30 } });
    assert.deepEqual(r.gate, { ok: false, reason: 'capture-rate unknown < 5%; gap unknown > 30d' });
    const sink = [];
    assert.equal(main(['doctor', '--capture-rate-min', '5', '--root', dir], { cwd: ROOT, out: s => sink.push(s), err: s => sink.push(s) }), 1);
    assert.match(sink.join('\n'), /capture-rate unknown < 5%/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('闸门：非法阈值判红并写明（绝不静默回落成「未配置」）', () => {
  const dir = gateRepo([DECISION, HOOK_NOW]);
  try {
    assert.deepEqual(resolveGateThresholds('', { captureRateMinPct: 'abc' }),
      { captureRateMinPct: null, gapDaysMax: null, captureWindowCommits: DEFAULT_CAPTURE_WINDOW,
        invalid: [{ name: 'captureRateMinPct', key: '--capture-rate-min', raw: 'abc' }] });
    const r = diagnose(dir, { now: NOW, gate: { captureRateMinPct: 'abc' } });
    assert.deepEqual(r.gate, { ok: false, reason: 'invalid --capture-rate-min: abc' });
    const sink = [];
    assert.equal(main(['doctor', '--capture-rate-min', 'abc', '--root', dir], { cwd: ROOT, out: s => sink.push(s), err: s => sink.push(s) }), 1);
    // 越界值同样判红（范围校验在 parseThreshold/resolveGateThresholds，evaluateGate 只判已校验过的阈值）
    assert.equal(resolveGateThresholds('', { captureRateMinPct: 101 }).invalid.length, 1);
    assert.equal(resolveGateThresholds('', { gapDaysMax: 0 }).invalid.length, 1);
    assert.equal(evaluateGate({ captureRatePct: 100, gapDays: 0 }, resolveGateThresholds('', { captureRateMinPct: 101 })).ok, false);
    // 阈值旗标给了却没值 → 用法错误（不静默变成未配置）
    const bad = [];
    assert.equal(main(['doctor', '--root', dir, '--capture-rate-min'], { cwd: ROOT, out: s => bad.push(s), err: s => bad.push(s) }), 1);
    assert.match(bad.join('\n'), /--capture-rate-min requires <percent>/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('闸门：阈值边界（等于阈值不算越线）与 evaluateGate 纯判定', () => {
  assert.deepEqual(evaluateGate({ captureRatePct: 5, gapDays: 30 }, { captureRateMinPct: 5, gapDaysMax: 30 }), { ok: true, reason: 'ok' });
  assert.deepEqual(evaluateGate({ captureRatePct: 4.99, gapDays: 0 }, { captureRateMinPct: 5 }), { ok: false, reason: 'capture-rate 4.99% < 5%' });
  assert.deepEqual(evaluateGate({ captureRatePct: 100, gapDays: 31 }, { gapDaysMax: 30 }), { ok: false, reason: 'gap 31d > 30d' });
  assert.deepEqual(evaluateGate({ captureRatePct: 1, gapDays: 99 }, {}), { ok: true, reason: 'not-configured' });
  // 两项同时不过 → 两个原因都列出（不吞掉一个）
  assert.deepEqual(evaluateGate({ captureRatePct: 1, gapDays: 99 }, { captureRateMinPct: 5, gapDaysMax: 30 }),
    { ok: false, reason: 'capture-rate 1% < 5%; gap 99d > 30d' });
});

test('无 .lore 但有 git：atoms 等仍为 unknown（不是 0）', () => {
  const dir = tmp();
  try {
    gitInit(dir);
    const r = diagnose(dir);
    assert.equal(r.repo.isGit, true);
    assert.equal(r.initialized, false);
    assert.equal(r.capture.atoms, UNKNOWN);
    assert.equal(r.capture.decisions, UNKNOWN);
    assert.equal(r.capture.pitfalls, UNKNOWN);
    assert.equal(r.capture.trailerOnly, UNKNOWN);
    assert.equal(r.capture.gapDays, UNKNOWN);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- S8 修订：窗口捕获率（评审 🟡#2 —— 前向窗口 vs 全仓累计率） ----------
const commitAt = (dir, iso, msg = 'c') =>
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', msg], {
    cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  });

// 夹具：20 个历史提交（2026-01，零决策原子）+ 5 个近期提交（2026-09-05..09），近期两条决策原子。
// 累计率 = 2/25 = 8%；窗口 N=5 的窗口率 = 2/5 = 40% ——「历史差、近期好」两口径必须分离。
function splitRepo() {
  const dir = tmp();
  gitInit(dir);
  for (let i = 1; i <= 20; i++) commitAt(dir, `2026-01-${String(i).padStart(2, '0')}T00:00:00Z`, `old ${i}`);
  for (let i = 5; i <= 9; i++) commitAt(dir, `2026-09-0${i}T00:00:00Z`, `new ${i}`);
  mkdirSync(join(dir, '.lore', 'journal', '2026', '09'), { recursive: true });
  writeFileSync(join(dir, '.lore', 'journal', '2026', '09', '2026-09-09.ndjson'), [
    jAtom({ id: 'decision:d1', ts: '2026-09-06T00:00:00Z', kind: 'decision', source: 'agent', title: 't1', why: 'w' }),
    jAtom({ id: 'decision:d2', ts: '2026-09-08T00:00:00Z', kind: 'decision', source: 'agent', title: 't2', why: 'w' }),
  ].join('\n') + '\n');
  return dir;
}

test('窗口率与累计率分离：历史零原子 + 近期有决策 → 窗口过闸而累计仍红', () => {
  const dir = splitRepo();
  try {
    // 未配置 → 默认窗口 N=50；提交数 25 ≤ 50 → 下界开放（窗口 = 全史），此时窗口率与累计率同值
    const def = diagnose(dir, { now: NOW });
    assert.equal(def.capture.window.size, DEFAULT_CAPTURE_WINDOW);
    assert.equal(def.capture.window.ratePct, 8);

    // N=5：窗口下界 = 第 6 个提交（2026-01-20，窗口之外那个）的 committer 时间
    const win5 = gitWindow(dir, 5);
    assert.equal(win5.commits, 5);
    assert.equal(win5.shas.length, 5);
    assert.equal(Date.parse(win5.startTs), Date.parse('2026-01-20T00:00:00Z'));

    const r = diagnose(dir, { now: NOW, gate: { captureRateMinPct: 10, captureWindowCommits: 5 } });
    assert.equal(r.capture.commits, 25);
    assert.equal(r.capture.decisions, 2);
    assert.equal(r.capture.captureRatePct, 8);            // 累计 8% < 10%：按累计判必红
    assert.deepEqual(r.capture.window,
      { size: 5, commits: 5, decisions: 2, startTs: win5.startTs, rate: 0.4, ratePct: 40 });
    assert.deepEqual(r.gate, { ok: true, reason: 'ok' });  // 窗口 40% ≥ 10%：按窗口判过闸
    const txt = formatReport(r);
    assert.match(txt, /window 40%（2 decision \/ 5 commits，N=5）/);
    assert.match(txt, /累计 8%（2 decision \/ 25 commits）/);

    // 同一份数据把窗口放宽到全史 → 窗口率跌回 8%，闸门转红：证明闸门真的用窗口率而非累计率
    const wide = diagnose(dir, { now: NOW, gate: { captureRateMinPct: 10, captureWindowCommits: 25 } });
    assert.equal(wide.capture.window.ratePct, 8);
    assert.deepEqual(wide.gate, { ok: false, reason: 'capture-rate 8% < 10%' });

    // 配置键 doctor.capture_window_commits 与 CLI 旗标 --capture-window 都能定窗口大小
    assert.deepEqual(parseGateConfig('doctor:\n  capture_window_commits: 5\n'),
      { captureRateMinPct: null, gapDaysMax: null, captureWindowCommits: 5, invalid: [] });
    writeFileSync(join(dir, '.lore', 'config.yml'), 'doctor:\n  capture_rate_min: 10\n  capture_window_commits: 5\n');
    const cfg = diagnose(dir, { now: NOW });
    assert.equal(cfg.capture.window.size, 5);
    assert.equal(cfg.capture.window.ratePct, 40);
    assert.deepEqual(cfg.gate, { ok: true, reason: 'ok' });

    const sink = [];
    assert.equal(main(['doctor', '--json', '--capture-rate-min', '10', '--capture-window', '5', '--root', dir],
      { cwd: ROOT, out: s => sink.push(s), err: () => {} }), 0);
    const doc = JSON.parse(sink.join('\n'));
    assert.equal(doc.capture.window.ratePct, 40);
    assert.equal(doc.capture.captureRatePct, 8);          // 两个口径同时输出，且确实分离
    assert.deepEqual(doc.gate, { ok: true, reason: 'ok' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('窗口率：纯判定（ts 下界 / 开放下界 / commit 指纹命中）与非 git 降级 unknown', () => {
  const stats = { decisionAtoms: [
    { ts: '2026-09-01T00:00:00Z', commit: null },      // 窗口内（ts ≥ 下界）
    { ts: '2026-01-01T00:00:00Z', commit: null },      // 窗口外（ts 早于下界）
    { ts: null, commit: 'abc1234def' },                // 窗口内（commit 指纹命中，rebase 后 ts 不可靠）
  ] };
  assert.deepEqual(windowCapture(stats, { commits: 2, shas: ['abc1234def00'], startTs: '2026-08-01T00:00:00Z' }, 2),
    { size: 2, commits: 2, decisions: 2, startTs: '2026-08-01T00:00:00Z', rate: 1, ratePct: 100 });
  // 下界开放（提交数 ≤ N）→ 窗口 = 全史：三条都算（ts 早的那条也回到窗口内）
  assert.equal(windowCapture(stats, { commits: 3, shas: ['abc1234def00'], startTs: null }, 3).decisions, 3);
  // 测不出（非 git / 无 journal）→ 全 unknown（不是 0）
  assert.deepEqual(windowCapture(null, null, 5),
    { size: 5, commits: UNKNOWN, decisions: UNKNOWN, startTs: UNKNOWN, rate: UNKNOWN, ratePct: UNKNOWN });

  const dir = tmp();
  try {
    assert.deepEqual(diagnose(dir, { now: NOW }).capture.window,
      { size: DEFAULT_CAPTURE_WINDOW, commits: UNKNOWN, decisions: UNKNOWN, startTs: UNKNOWN, rate: UNKNOWN, ratePct: UNKNOWN });
    // 闸门生效时 unknown 判红（unknown 不是健康证据），且 reason 与窗口口径同源
    assert.deepEqual(diagnose(dir, { now: NOW, gate: { captureRateMinPct: 5 } }).gate,
      { ok: false, reason: 'capture-rate unknown < 5%' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('窗口大小非法（0 / 越界 / 非数字 / 旗标缺值）判红，绝不静默回落默认 50', () => {
  assert.equal(resolveGateThresholds('', { captureWindowCommits: '0' }).invalid.length, 1);
  assert.equal(resolveGateThresholds('', { captureWindowCommits: 10001 }).invalid.length, 1);
  const dir = gateRepo([DECISION, HOOK_NOW]);
  try {
    assert.deepEqual(diagnose(dir, { now: NOW, gate: { captureWindowCommits: 'abc' } }).gate,
      { ok: false, reason: 'invalid --capture-window: abc' });
    const sink = [];
    assert.equal(main(['doctor', '--capture-window', 'abc', '--root', dir],
      { cwd: ROOT, out: s => sink.push(s), err: s => sink.push(s) }), 1);
    // 旗标给了却没值 → 用法错误（不静默变成默认窗口）
    const bad = [];
    assert.equal(main(['doctor', '--root', dir, '--capture-window'],
      { cwd: ROOT, out: s => bad.push(s), err: s => bad.push(s) }), 1);
    assert.match(bad.join('\n'), /--capture-window requires <commits>/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

