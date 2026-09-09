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
  DOCTOR_SCHEMA_VERSION, UNKNOWN, diagnose, formatReport, hookHealth, readJournalStats,
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
    assert.deepEqual(Object.keys(doc), ['schemaVersion', 'generatedAt', 'repo', 'initialized', 'hook', 'capture']);
    assert.deepEqual(Object.keys(doc.repo), ['root', 'isGit', 'head', 'version', 'commits']);
    assert.deepEqual(Object.keys(doc.hook), ['status', 'ok', 'hookPath', 'target', 'expected']);
    // 键集只增不改：pitfalls 是新增（按 kind 计），既有键名/语义一律不动
    assert.deepEqual(Object.keys(doc.capture),
      ['atoms', 'badLines', 'decisions', 'pitfalls', 'trailerOnly', 'refsPitfall', 'commits', 'captureRate',
        'captureRatePct', 'lastAtomTs', 'lastHookTs', 'lastSource', 'gapDays']);
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

    const r = diagnose(dir, { now: new Date('2026-09-05T00:00:00Z') });
    assert.equal(r.capture.gapDays, 3);                 // 2026-09-02 → 09-05
    assert.equal(r.capture.atoms, 6);
    assert.equal(r.capture.pitfalls, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
