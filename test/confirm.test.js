// test/confirm.test.js —— ① 期 S3：owner 确认成为一等数据（设计 §7① / §3.2 / 不变量③⑧）。
//
// 验收口径（计划 S3）：
//   · 确认记录落在 journal 内、独立 kind:'confirmation'（目标 atom id / verdict / confirmed_by / confirmed_at / why?）；
//   · 确认后原原子**字节不变**（append-only）；
//   · 重复确认幂等；未知 atom id → 明确报错（CLI 层 exit 1，见 test/cli.test.js）；
//   · 有效状态由最新 confirmation 派生（覆盖内联 status，内联字节不改）；
//   · 机器重写不改确认记录（不变量③）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIRM_SCHEMA_VERSION, ConfirmError, DEFAULT_CONFIRMED_BY, STATUS_BY_VERDICT, VERDICTS,
  confirmAtom, confirmationRecord, confirmationSummary, confirmationsFor, confirmerOf, deriveStatus, deriveStatuses,
  findAtom, latestByAtom, latestConfirmation, newConfirmationId, readConfirmations,
} from '../lib/confirm.js';
import { CONFIRMATION_KIND, appendAtom, readAllAtoms, readAllRecords } from '../lib/journal.js';
import { foldAtoms } from '../lib/fold.js';
import { foldJournal, renderDecisionHistory } from '../lib/sync.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-confirm-')); }
const TS = '2026-09-09T10:00:00.000Z';
const LATER = '2026-09-09T11:00:00.000Z';
const ATOM = {
  id: 'decision:2026-09-09-lore-reposition', ts: '2026-09-09T08:00:00Z', kind: 'decision',
  commit: null, title: 'lore 定位：wiki 保留，差异化做 owner 理解层',
  why: '厂商能生成同一份 wiki，拿不到「你懂什么、何时懂的、何时过期」',
  status: 'draft', source: 'agent',
  refs: { files: [], related: [], pitfall: null, anchors: ['runAuto @ lib/runner.js:77'] },
  facets: { component: [], flow: [], theme: [] },
};
const journalDirOf = root => join(root, '.lore', 'journal');
const shardOf = (root, date = '2026-09-09') => join(journalDirOf(root), date.slice(0, 4), date.slice(5, 7), date + '.ndjson');
const lines = p => readFileSync(p, 'utf8').split('\n').filter(t => t.trim() !== '');

// 夹具：一个已 init 的 repo，journal 里有一条 decision 原子。
function fixture(atom = ATOM) {
  const root = tmp();
  mkdirSync(journalDirOf(root), { recursive: true });
  appendAtom(journalDirOf(root), { ...atom });
  return root;
}

test('confirmationRecord：形状含目标 atom id / verdict / confirmed_by / confirmed_at；why 走写入侧纪律', () => {
  assert.equal(CONFIRM_SCHEMA_VERSION, 1);
  assert.deepEqual(VERDICTS, ['confirm', 'dispute']);
  assert.deepEqual(STATUS_BY_VERDICT, { confirm: 'confirmed', dispute: 'disputed' });
  assert.equal(DEFAULT_CONFIRMED_BY, 'owner');

  const rec = confirmationRecord({ atom: ATOM.id, why: '读过实现，判断成立\nCo-Authored-By: Bot <b@x>', ts: TS, id: 'confirmation:fixed' });
  assert.deepEqual(rec, {
    id: 'confirmation:fixed', ts: TS, kind: CONFIRMATION_KIND, atom: ATOM.id, verdict: 'confirm',
    confirmed_by: 'owner', confirmed_at: TS, why: '读过实现，判断成立',      // trailer 已剥（不变量⑦）
  });
  // why 缺省 / 只有 trailer → 不写 why 键（无正文不写 why）
  assert.equal('why' in confirmationRecord({ atom: ATOM.id, ts: TS }), false);
  assert.equal('why' in confirmationRecord({ atom: ATOM.id, why: 'Signed-off-by: D <d@x>', ts: TS }), false);
  // dispute 分支 + 自定义确认人
  assert.equal(confirmationRecord({ atom: ATOM.id, verdict: 'dispute', confirmedBy: 'owner:magic', ts: TS }).verdict, 'dispute');
  assert.equal(confirmationRecord({ atom: ATOM.id, verdict: 'dispute', confirmedBy: 'owner:magic', ts: TS }).confirmed_by, 'owner:magic');

  // 非法输入明确报错（不静默写坏记录）
  for (const [args, code] of [
    [{ atom: '' }, 'missing-atom'],
    [{ atom: ATOM.id, verdict: 'maybe' }, 'invalid-verdict'],
    [{ atom: ATOM.id, confirmedBy: '' }, 'missing-confirmed-by'],
  ]) {
    assert.throws(() => confirmationRecord({ ...args, ts: TS }), e => e instanceof ConfirmError && e.code === code, JSON.stringify(args));
  }
  assert.match(newConfirmationId(1, () => 0.5), /^confirmation:/);
});

test('确认后原原子字节不变、journal 只多一行 kind:confirmation（append-only，不变量③）', () => {
  const root = fixture();
  try {
    const j = journalDirOf(root);
    const shard = shardOf(root);
    const before = readFileSync(shard, 'utf8');
    const atomLine = before.trimEnd();

    const r = confirmAtom(j, { atom: ATOM.id, why: '读过实现', ts: TS, id: 'confirmation:c1' });
    assert.equal(r.appended, true);
    assert.equal(r.deduped, false);
    assert.equal(r.atom.id, ATOM.id);                       // 返回目标原子（CLI 用来打印）

    const after = readFileSync(shard, 'utf8');
    assert.ok(after.startsWith(before), '旧内容必须是新内容的字节前缀（append-only）');
    assert.equal(after.slice(before.length).trimEnd(), JSON.stringify(r.record));
    assert.equal(lines(shard).length, 2);

    const records = readAllRecords(j);
    assert.equal(records.length, 2);
    assert.equal(records[1].kind, 'confirmation');
    assert.equal(records[1].atom, ATOM.id);
    assert.equal(records[1].verdict, 'confirm');
    assert.equal(records[1].confirmed_by, 'owner');
    assert.ok(records[1].confirmed_at);
    assert.equal(JSON.stringify(records[0]), atomLine);     // 原原子逐字节不变
    assert.equal(records[0].status, 'draft');               // 内联 status 未被改写
    // 确认记录不是原子：原子视图里看不到它（否则 fold/sync/doctor 会把它当决策消费）
    assert.deepEqual(readAllAtoms(j).map(a => a.id), [ATOM.id]);
    assert.deepEqual(readConfirmations(j).map(c => c.id), ['confirmation:c1']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('重复确认幂等：同 (verdict, why) 不写第二行；换 verdict / 换 why 是新记录', () => {
  const root = fixture();
  try {
    const j = journalDirOf(root);
    const first = confirmAtom(j, { atom: ATOM.id, why: '读过实现', ts: TS, id: 'confirmation:c1' });
    assert.equal(first.appended, true);

    const again = confirmAtom(j, { atom: ATOM.id, why: '读过实现', ts: LATER, id: 'confirmation:c2' });
    assert.equal(again.appended, false);
    assert.equal(again.deduped, true);
    assert.equal(again.record.id, 'confirmation:c1');       // 返回既有那条，不产生新 id
    assert.equal(lines(shardOf(root)).length, 2);           // 只有原子 + 一条确认

    // why 不同 = 新证据，照记（append-only：宁可多记，不静默丢）
    const richer = confirmAtom(j, { atom: ATOM.id, why: '补：对比过 ZCode 的内置 wiki', ts: LATER, id: 'confirmation:c3' });
    assert.equal(richer.appended, true);
    // verdict 不同 = 新判定
    const disputed = confirmAtom(j, { atom: ATOM.id, verdict: 'dispute', why: '锚点已漂移', ts: LATER, id: 'confirmation:c4' });
    assert.equal(disputed.appended, true);
    // 再 confirm（最新是 dispute）→ 又是新记录
    const reconfirm = confirmAtom(j, { atom: ATOM.id, why: '重看过，仍成立', ts: LATER, id: 'confirmation:c5' });
    assert.equal(reconfirm.appended, true);
    assert.deepEqual(readConfirmations(j).map(c => c.verdict), ['confirm', 'confirm', 'dispute', 'confirm']);
    assert.equal(readAllAtoms(j).length, 1);                // 全程原子集合不增不减
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('未知 atom id → ConfirmError(unknown-atom)，一个字节都不落', () => {
  const root = fixture();
  try {
    const j = journalDirOf(root);
    const before = readFileSync(shardOf(root), 'utf8');
    assert.throws(() => confirmAtom(j, { atom: 'decision:does-not-exist', ts: TS }),
      e => e instanceof ConfirmError && e.code === 'unknown-atom' && /unknown atom id/.test(e.message));
    assert.throws(() => findAtom(j, ''), e => e.code === 'missing-atom');
    assert.equal(readFileSync(shardOf(root), 'utf8'), before);
    assert.equal(readConfirmations(j).length, 0);
    // 确认记录本身不是原子 → 不能作为确认目标（否则确认指向空气）
    confirmAtom(j, { atom: ATOM.id, ts: TS, id: 'confirmation:c1' });
    assert.throws(() => confirmAtom(j, { atom: 'confirmation:c1', ts: LATER }), e => e.code === 'unknown-atom');
    assert.equal(readConfirmations(j).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('有效状态 = 派生视图：最新 confirmation 覆盖内联 status（dispute → disputed；内联字节不改）', () => {
  const draftAtom = { ...ATOM, status: 'draft' };
  const c = (verdict, at, why) => ({ kind: CONFIRMATION_KIND, atom: ATOM.id, verdict, confirmed_at: at, confirmed_by: 'owner', ...(why ? { why } : {}) });

  // 无确认 → 内联 status
  assert.deepEqual(deriveStatus(draftAtom, []), { status: 'draft', from: 'inline', confirmation: null });
  // 无内联 status、无确认 → null（未定，不编造状态）
  assert.deepEqual(deriveStatus({ ...ATOM, status: undefined }, []), { status: null, from: 'none', confirmation: null });
  // confirm 覆盖 draft
  const confirmed = deriveStatus(draftAtom, [c('confirm', TS)]);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.from, 'confirmation');
  // 多条取最新（confirmed_at 更晚者胜，与数组顺序无关）
  assert.equal(deriveStatus(draftAtom, [c('confirm', TS), c('dispute', LATER)]).status, 'disputed');
  assert.equal(deriveStatus(draftAtom, [c('dispute', LATER), c('confirm', TS)]).status, 'disputed');
  assert.equal(deriveStatus(draftAtom, [c('dispute', TS), c('confirm', LATER)]).status, 'confirmed');
  // 别的原子的确认记录不影响本原子
  assert.equal(deriveStatus(draftAtom, [{ ...c('dispute', LATER), atom: 'decision:other' }]).status, 'draft');
  // 时间戳不可解析 → 不静默丢确认（保留先出现的那条）
  assert.equal(deriveStatus(draftAtom, [c('confirm', 'not-a-date')]).status, 'confirmed');
  assert.equal(latestConfirmation([c('confirm', TS), c('dispute', LATER)]).verdict, 'dispute');
  assert.equal(latestConfirmation([]), null);

  // 批量派生：等长同序；confirmed_by 来自 confirmation 记录
  const derived = deriveStatuses([draftAtom, { id: 'decision:other', status: 'superseded' }], [c('confirm', TS)]);
  assert.equal(derived.length, 2);
  assert.equal(derived[0].status, 'confirmed');
  assert.equal(derived[1].status, 'superseded');
  assert.equal(confirmerOf(draftAtom, derived[0]), 'owner');
  assert.equal(confirmerOf({ ...draftAtom, confirmed_by: 'inline-owner' }, derived[1]), 'inline-owner');
  assert.equal(latestByAtom([c('confirm', TS), c('dispute', LATER)]).get(ATOM.id).verdict, 'dispute');

  // 端到端：确认后原子在盘上仍是 draft，派生视图是 confirmed
  const root = fixture();
  try {
    const j = journalDirOf(root);
    confirmAtom(j, { atom: ATOM.id, ts: TS, id: 'confirmation:c1' });
    const stored = readAllAtoms(j)[0];
    assert.equal(stored.status, 'draft');
    assert.equal(deriveStatus(stored, readConfirmations(j)).status, 'confirmed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('机器重写不改确认记录：写入路径与决策史重物化后，确认行逐字节不变（不变量③）', () => {
  const root = fixture();
  try {
    const j = journalDirOf(root);
    confirmAtom(j, { atom: ATOM.id, why: '读过实现', ts: TS, id: 'confirmation:c1' });
    const shard = shardOf(root);
    const before = readFileSync(shard, 'utf8');
    const confirmLine = lines(shard).find(l => JSON.parse(l).kind === CONFIRMATION_KIND);

    // 机器写入路径（hook / mine / note 共用 appendAtom）：再落一条 hook 原子
    appendAtom(j, { id: 'commit:machine1', ts: '2026-09-09T12:00:00Z', kind: 'commit', commit: 'm1', title: 'feat: machine', source: 'hook' });
    // 机器重物化路径（sync.finalizeSync 用的正是这两条）：决策史渲染 + 页面折叠
    const atoms = readAllAtoms(j);
    const md = renderDecisionHistory(foldAtoms(atoms, { reachableShas: null }));
    const page = '# P\n\n## Decision history\n\n<!-- LORE_JOURNAL:START -->\nold\n<!-- LORE_JOURNAL:END -->\n';
    const next = foldJournal(page, md, { page: 'p' });
    assert.match(next, /Decision history/);
    assert.doesNotMatch(next, /confirmation/, '确认记录不得出现在决策史物化里');

    const after = readFileSync(shard, 'utf8');
    assert.ok(after.startsWith(before), '机器写入必须是 append-only（旧字节是前缀）');
    assert.ok(after.split('\n').includes(confirmLine), '确认行逐字节仍在');
    assert.equal(readConfirmations(j).length, 1);
    assert.deepEqual(readConfirmations(j)[0].atom, ATOM.id);
    assert.equal(readAllAtoms(j).length, 2);                // 原子只多了机器那条
    assert.equal(readAllAtoms(j).filter(a => a.kind === CONFIRMATION_KIND).length, 0);
    // 确认记录落在与原子同一个 shard（同源、可审计）
    assert.equal(existsSync(shard), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('confirmationSummary：决策原子的已确认 / 已否决 / 待确认 + 确认记录条数', () => {
  const d1 = { id: 'decision:d1', kind: 'decision', status: 'draft' };
  const d2 = { id: 'decision:d2', kind: 'decision' };
  const d3 = { id: 'decision:d3', kind: 'decision', status: 'confirmed', confirmed_by: 'owner' };   // 内联 confirmed
  const p1 = { id: 'pitfall:p1', kind: 'pitfall' };
  const confirmations = [
    { kind: CONFIRMATION_KIND, atom: 'decision:d1', verdict: 'confirm', confirmed_at: TS, confirmed_by: 'owner' },
    { kind: CONFIRMATION_KIND, atom: 'decision:d2', verdict: 'dispute', confirmed_at: TS, confirmed_by: 'owner' },
    { kind: CONFIRMATION_KIND, atom: 'pitfall:p1', verdict: 'confirm', confirmed_at: TS, confirmed_by: 'owner' },
  ];
  assert.deepEqual(confirmationSummary([d1, d2, d3, p1], confirmations),
    { records: 3, decisions: 3, confirmed: 2, disputed: 1, pending: 0 });
  // 只数 kind:'decision'：pitfall 的确认记录计入 records 但不进决策进度
  assert.deepEqual(confirmationSummary([p1], confirmations),
    { records: 3, decisions: 0, confirmed: 0, disputed: 0, pending: 0 });
  // 无 .lore / 空输入 → 全 0（不是 unknown：这里数的是记录本身，缺就是 0 条）
  assert.deepEqual(confirmationSummary([], []), { records: 0, decisions: 0, confirmed: 0, disputed: 0, pending: 0 });
  // 一条未确认的决策 = pending
  assert.equal(confirmationSummary([d2], []).pending, 1);
  assert.equal(confirmationSummary([d2], []).confirmed, 0);
});

test('confirmationRecord 不写 why 空串；confirmationsFor 只看目标原子', () => {
  const root = fixture();
  try {
    const j = journalDirOf(root);
    appendAtom(j, { id: 'decision:other', ts: '2026-09-09T09:00:00Z', kind: 'decision', title: 'other' });
    confirmAtom(j, { atom: ATOM.id, ts: TS, id: 'confirmation:c1' });
    confirmAtom(j, { atom: 'decision:other', ts: TS, id: 'confirmation:c2' });
    assert.deepEqual(confirmationsFor(j, ATOM.id).map(c => c.id), ['confirmation:c1']);
    assert.deepEqual(confirmationsFor(j, 'decision:other').map(c => c.id), ['confirmation:c2']);
    assert.equal('why' in readConfirmations(j)[0], false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
