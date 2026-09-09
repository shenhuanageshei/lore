// test/evidence.test.js —— ① 期 S4 证据账本（设计 §7① / 不变量⑧「证据锚定 + 不确定性显式」）。
//
// 验收口径（计划 S4）：
//   · 每条 kind:decision|rejected|correction 在账本里有一行（其余 kind 不进账）；
//   · 缺 refs.anchors → 显式标「未验证」（不变量⑧），不渲染成确定事实；
//   · 与 doctor 的噪音分布交叉：high 噪音的原子在账本里标「低置信」；
//   · --json 字段稳定，且不含 .lore/human/ 的 per-human 存储内容；
//   · 只读：跑前跑后 .lore 内文件 mtime 不变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CONFIDENCE_LEVELS, EVIDENCE_KINDS, EVIDENCE_SCHEMA_VERSION, anchorsOf, confidenceOf, countEvidence,
  evidenceEntries, evidenceReport, formatEvidence, isEvidenceAtom,
} from '../lib/evidence.js';
import { appendAtom } from '../lib/journal.js';
import { confirmAtom } from '../lib/confirm.js';
import { readJournalStats } from '../lib/doctor.js';

const ROOT = process.cwd();
const CLI = join(ROOT, 'lib', 'cli.js');
const NOW = new Date('2026-09-10T00:00:00Z');

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-evidence-')); }
function run(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const journalDirOf = root => join(root, '.lore', 'journal');
const loreOf = root => join(root, '.lore');

// 只读快照：文件集合 + 大小 + mtime（内容被改写 / 新文件落盘都会露出来）
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

// 夹具：四条结论原子（一条有锚点、一条无锚点、一条 trailer-only 噪音、一条 correction）
// + 两条非结论原子（commit / pitfall——不进账本）。
const A = (o) => ({
  commit: null, what_changed: '', facets: { component: [], flow: [], theme: [] },
  refs: { files: [], related: [], pitfall: null }, source: 'agent', ...o,
});
const FIXTURE = [
  A({ id: 'decision:d1', ts: '2026-09-01T00:00:00Z', kind: 'decision', title: 'anchored decision', why: '因为 Z', source: 'agent:dsh', refs: { anchors: ['runAuto @ lib/runner.js:77'] } }),
  A({ id: 'decision:d2', ts: '2026-09-02T00:00:00Z', kind: 'decision', title: 'unanchored decision', why: '因为 Y' }),
  A({ id: 'rejected:r1', ts: '2026-09-03T00:00:00Z', kind: 'rejected', title: 'noisy rejected', why: 'Co-Authored-By: Bot <b@x>', refs: { anchors: ['x @ a.js:1'] } }),
  A({ id: 'correction:c1', ts: '2026-09-04T00:00:00Z', kind: 'correction', title: 'correction', why: '纠错：此前判断错了', source: 'owner', refs: { anchors: ['y @ b.js:2'] } }),
  A({ id: 'commit:a1', ts: '2026-09-05T00:00:00Z', kind: 'commit', source: 'hook' }),
  A({ id: 'pitfall:p1', ts: '2026-09-06T00:00:00Z', kind: 'pitfall', title: 'pitfall', problem: 'p', fix: 'f', prevention: 'v' }),
];

function fixture(atoms = FIXTURE) {
  const root = tmp();
  mkdirSync(journalDirOf(root), { recursive: true });
  for (const a of atoms) appendAtom(journalDirOf(root), a);
  return root;
}

test('每条结论一行：只有 decision|rejected|correction 进账，commit/pitfall 不进；排序确定', () => {
  assert.equal(EVIDENCE_SCHEMA_VERSION, 1);
  assert.deepEqual(EVIDENCE_KINDS, ['decision', 'rejected', 'correction']);
  assert.deepEqual(CONFIDENCE_LEVELS, ['unverified', 'low', 'normal']);
  assert.equal(isEvidenceAtom({ kind: 'decision' }), true);
  assert.equal(isEvidenceAtom({ kind: 'commit' }), false);
  assert.equal(isEvidenceAtom(null), false);

  const root = fixture();
  try {
    const report = evidenceReport(root, { now: NOW });
    assert.deepEqual(report.entries.map(e => e.id), ['decision:d1', 'decision:d2', 'rejected:r1', 'correction:c1']);
    assert.deepEqual(report.counts, {
      total: 4,
      byKind: { decision: 2, rejected: 1, correction: 1 },
      unverified: 1,
      lowConfidence: 1,
    });
    // 字段逐条落到账上（来源 / 定位 / 时间 / 置信 / 确认人）
    const d1 = report.entries[0];
    assert.equal(d1.source, 'agent:dsh');
    assert.deepEqual(d1.anchors, ['runAuto @ lib/runner.js:77']);
    assert.equal(d1.ts, '2026-09-01T00:00:00Z');
    assert.equal(d1.verification, 'verified');
    assert.equal(d1.confidence, 'normal');
    // 排序与输入顺序无关（同一集合换顺序 → 同一本账）
    const shuffled = [FIXTURE[3], FIXTURE[0], FIXTURE[5], FIXTURE[2], FIXTURE[1], FIXTURE[4]];
    assert.deepEqual(evidenceEntries(shuffled, []), evidenceEntries(FIXTURE, []));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('无锚点 → 显式标「未验证」（不变量⑧）；有锚点不标', () => {
  const root = fixture();
  try {
    const report = evidenceReport(root, { now: NOW });
    const d2 = report.entries.find(e => e.id === 'decision:d2');
    assert.equal(d2.verification, 'unverified');
    assert.equal(d2.confidence, 'unverified');
    assert.equal(d2.lowConfidence, false);          // 未验证 ≠ 低置信：两个独立维度
    assert.deepEqual(d2.anchors, []);
    const d1 = report.entries.find(e => e.id === 'decision:d1');
    assert.equal(d1.verification, 'verified');

    const txt = formatEvidence(report);
    assert.match(txt, /decision:d2[\s\S]*定位 未验证（无 refs\.anchors）/);
    assert.match(txt, /结论 4 条（decision 2 · rejected 1 · correction 1）· 未验证 1 · 低置信 1/);
    // 纯函数：置信判定与锚点提取
    assert.deepEqual(confidenceOf([], 'none'), { verification: 'unverified', lowConfidence: false, confidence: 'unverified' });
    assert.deepEqual(confidenceOf(['a @ b.js:1'], 'high'), { verification: 'verified', lowConfidence: true, confidence: 'low' });
    assert.deepEqual(anchorsOf({ refs: { anchors: ['a', '', '  ', 42] } }), ['a']);
    assert.deepEqual(anchorsOf({ refs: {} }), []);
    assert.deepEqual(anchorsOf(null), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('high 噪音 → 标「低置信」，且与 doctor 的噪音分布同源（交叉验证）', () => {
  const root = fixture();
  try {
    const report = evidenceReport(root, { now: NOW });
    const r1 = report.entries.find(e => e.id === 'rejected:r1');
    assert.equal(r1.noise.level, 'high');
    assert.deepEqual(r1.noise.reasons, ['trailer-only']);
    assert.equal(r1.lowConfidence, true);
    assert.equal(r1.confidence, 'low');                 // 有锚点但噪音 high → 低置信
    assert.equal(report.entries.find(e => e.id === 'decision:d1').lowConfidence, false);

    // 交叉：账本里「低置信」的条数 == doctor 噪音分布里的 high 条数（同一分类器，两处不各算一套）
    const stats = readJournalStats(journalDirOf(root));
    assert.equal(stats.noise.high, report.entries.filter(e => e.lowConfidence).length);
    assert.match(formatEvidence(report), /rejected:r1[\s\S]*置信 低（噪音 high: trailer-only）/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('确认人来自 confirmation 记录（记录层）：confirm → confirmed / owner；dispute → disputed', () => {
  const root = fixture();
  try {
    const j = journalDirOf(root);
    confirmAtom(j, { atom: 'decision:d1', why: '读过实现', ts: '2026-09-07T00:00:00Z', id: 'confirmation:x1' });
    const confirmed = evidenceReport(root, { now: NOW }).entries.find(e => e.id === 'decision:d1');
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.statusFrom, 'confirmation');
    assert.equal(confirmed.confirmer, 'owner');
    assert.equal(confirmed.confirmedAt, '2026-09-07T00:00:00Z');
    assert.equal(confirmed.verdict, 'confirm');

    confirmAtom(j, { atom: 'decision:d1', verdict: 'dispute', why: '锚点漂移', ts: '2026-09-08T00:00:00Z', id: 'confirmation:x2' });
    const disputed = evidenceReport(root, { now: NOW }).entries.find(e => e.id === 'decision:d1');
    assert.equal(disputed.status, 'disputed');
    assert.equal(disputed.verdict, 'dispute');
    // 未被确认的结论：回退内联 status（机器来源规范化成 draft——S1 闸门），确认人 null（不编造）
    const d2 = evidenceReport(root, { now: NOW }).entries.find(e => e.id === 'decision:d2');
    assert.equal(d2.status, 'draft');
    assert.equal(d2.statusFrom, 'inline');
    assert.equal(d2.confirmer, null);
    assert.equal(d2.confirmedAt, null);
    // 无内联 status 且无确认 → 未定（null，不编造）
    const c1 = evidenceReport(root, { now: NOW }).entries.find(e => e.id === 'correction:c1');
    assert.equal(c1.status, null);
    assert.equal(c1.statusFrom, 'none');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--json：字段集锁定（稳定契约）；CLI 人读输出含「未验证」「低置信」', () => {
  const root = fixture();
  try {
    const r = run('evidence', '--json', '--root', root);
    assert.equal(r.status, 0);
    const doc = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(doc),
      ['schemaVersion', 'generatedAt', 'root', 'journal', 'initialized', 'counts', 'entries']);
    assert.deepEqual(Object.keys(doc.counts), ['total', 'byKind', 'unverified', 'lowConfidence']);
    assert.deepEqual(Object.keys(doc.entries[0]),
      ['id', 'kind', 'title', 'ts', 'source', 'anchors', 'verification', 'lowConfidence', 'confidence',
        'noise', 'status', 'statusFrom', 'confirmer', 'confirmedAt', 'verdict']);
    assert.deepEqual(Object.keys(doc.entries[0].noise), ['level', 'reasons']);
    assert.equal(doc.counts.total, 4);

    const human = run('evidence', '--root', root);
    assert.equal(human.status, 0);
    assert.match(human.stdout, /lore evidence — /);
    assert.match(human.stdout, /未验证（无 refs\.anchors）/);
    assert.match(human.stdout, /置信 低（噪音 high: trailer-only）/);
    // 纯函数计数（渲染与 --json 同源）
    assert.equal(countEvidence([]).total, 0);
    assert.deepEqual(countEvidence(doc.entries), doc.counts);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--json 不含 .lore/human/ 的 per-human 内容（评审 🔵#8）', () => {
  const root = fixture();
  try {
    mkdirSync(join(loreOf(root), 'human'), { recursive: true });
    writeFileSync(join(loreOf(root), 'human', 'visits.jsonl'),
      JSON.stringify({ ts: '2026-09-09T00:00:00Z', kind: 'visit', page: 'SENTINEL-PERHUMAN-PAGE' }) + '\n');
    writeFileSync(join(loreOf(root), 'human', 'read.jsonl'),
      JSON.stringify({ ts: '2026-09-09T00:00:00Z', kind: 'read', page: 'SENTINEL-PERHUMAN-PAGE', at: 'sha' }) + '\n');

    const r = run('evidence', '--json', '--root', root);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /SENTINEL-PERHUMAN-PAGE/);
    assert.doesNotMatch(r.stdout, /visits\.jsonl|read\.jsonl/);
    assert.doesNotMatch(run('evidence', '--root', root).stdout, /SENTINEL-PERHUMAN-PAGE/);

    // 结构保证：账本模块的**代码**不碰 per-human 存储（不是「碰巧没输出」）——剥掉注释后全文无 human
    const code = readFileSync(join(ROOT, 'lib', 'evidence.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /human/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('只读：evidence 跑前跑后 .lore 内文件集合 / 大小 / mtime 不变', () => {
  const root = fixture();
  try {
    mkdirSync(join(loreOf(root), 'human'), { recursive: true });
    writeFileSync(join(loreOf(root), 'human', 'visits.jsonl'), '{"kind":"visit","page":"p"}\n');
    const before = snapshot(loreOf(root));

    assert.equal(run('evidence', '--root', root).status, 0);
    assert.equal(run('evidence', '--json', '--root', root).status, 0);
    assert.equal(evidenceReport(root, { now: NOW }).counts.total, 4);
    assert.equal(run('evidence', '--root', join(root, 'nope')).status, 1);   // 未 init 也不写

    assert.deepEqual(snapshot(loreOf(root)), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('未 init：明确报错 exit 1（不把「没有 .lore」渲染成 0 条结论）', () => {
  const root = tmp();
  try {
    const r = run('evidence', '--root', root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no \.lore at/);
    assert.match(r.stderr, /\/lore:init/);
    assert.equal(r.stdout, '');
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('空 journal（已 init 无原子）：账本 0 条，人读输出明确说明，不崩', () => {
  const root = tmp();
  try {
    mkdirSync(journalDirOf(root), { recursive: true });
    const report = evidenceReport(root, { now: NOW });
    assert.equal(report.initialized, false);
    assert.deepEqual(report.counts, { total: 0, byKind: { decision: 0, rejected: 0, correction: 0 }, unverified: 0, lowConfidence: 0 });
    assert.deepEqual(report.entries, []);
    assert.match(formatEvidence(report), /（无结论原子：kind decision\|rejected\|correction）/);
    const r = run('evidence', '--json', '--root', root);
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout).entries, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
