// test/journal.test.js —— 记录层落盘入口（S1 起 = 唯一写入闸门）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atomPath, appendAtom, appendJournalRecord, AtomRejected, RecordRejected, CONFIRMATION_KIND, readAllAtoms, existingIds,
} from '../lib/journal.js';
import { validateAtom } from '../lib/atom.js';
import { commitAtom } from '../lib/mine.js';
import { noteAtom } from '../lib/note.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-journal-')); }
// 合法骨架（kind=commit 是存量形态：title 可空）
const atom = (over = {}) => ({ id: 'commit:a', ts: '2026-06-01T08:00:00Z', kind: 'commit', ...over });

test('atomPath maps ISO ts to YYYY/MM/YYYY-MM-DD.ndjson', () => {
  assert.equal(atomPath('/j', '2026-06-01T08:00:00Z'), join('/j', '2026', '06', '2026-06-01.ndjson'));
  assert.equal(atomPath('/j', '2025-12-31T23:59:59+09:00'), join('/j', '2025', '12', '2025-12-31.ndjson'));
});

test('appendAtom writes one JSON line to the date shard; second append same day → 2 lines', () => {
  const dir = tmpDir();
  try {
    const j = join(dir, 'journal');
    appendAtom(j, atom({ id: 'a', x: 1 }));                       // 未知字段保留（schema 演进靠加字段）
    appendAtom(j, atom({ id: 'b', ts: '2026-06-01T09:00:00Z', x: 2 }));
    const shard = join(j, '2026', '06', '2026-06-01.ndjson');
    const lines = readFileSync(shard, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).id, 'a');
    assert.equal(JSON.parse(lines[0]).x, 1);
    assert.equal(JSON.parse(lines[1]).id, 'b');
    assert.equal(JSON.parse(lines[1]).x, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendAtom 返回落盘的那条规范化原子（facets/refs 补空壳、机器来源补 draft）', () => {
  const dir = tmpDir();
  try {
    const j = join(dir, 'journal');
    const returned = appendAtom(j, atom({ id: 'commit:a', source: 'hook' }));
    assert.equal(returned.status, 'draft');                        // 机器来源缺 status → draft
    assert.deepEqual(returned.facets, { component: [], flow: [], theme: [] });
    assert.deepEqual(returned.refs, { files: [], related: [], pitfall: null });
    assert.deepEqual(readAllAtoms(j), [returned]);                 // 返回值 = 盘上那一条
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('机器来源（agent|miner|hook 前缀）缺 status → 落盘 draft；非机器来源（owner）保持无 status', () => {
  const dir = tmpDir();
  try {
    const j = join(dir, 'journal');
    for (const source of ['agent', 'agent:dsh', 'miner:commits', 'hook:post-commit']) {
      const a = appendAtom(j, atom({ id: `commit:${source}`, source }));
      assert.equal(a.status, 'draft', source);
    }
    const owner = appendAtom(j, atom({ id: 'commit:owner', source: 'owner' }));       // owner* = 人的写入
    assert.equal('status' in owner, false);
    const noSource = appendAtom(j, atom({ id: 'commit:none' }));
    assert.equal('status' in noSource, false);
    // 显式 status 不被覆盖
    assert.equal(appendAtom(j, atom({ id: 'commit:d', source: 'agent', status: 'superseded' })).status, 'superseded');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('非法原子被拒：缺 ts / 未知 kind / pitfall 缺三字段 → 可读错误 + 一个字节都不落', () => {
  const dir = tmpDir();
  try {
    const j = join(dir, 'journal');
    const cases = [
      [{ id: 'commit:a', kind: 'commit' }, /ts: missing-ts/],
      [atom({ kind: 'hypothesis' }), /kind: unknown-kind/],
      [{ id: 'pitfall:p', ts: '2026-06-01T08:00:00Z', kind: 'pitfall', title: 'p' },
        /problem: pitfall-missing-problem.*fix: pitfall-missing-fix.*prevention: pitfall-missing-prevention/],
    ];
    for (const [bad, re] of cases) {
      assert.throws(() => appendAtom(j, bad), (e) => {
        assert.ok(e instanceof AtomRejected, 'should be AtomRejected');
        assert.equal(e.name, 'AtomRejected');
        assert.match(e.message, /^refusing to write invalid atom/);
        assert.match(e.message, re);
        assert.ok(Array.isArray(e.errors) && e.errors.length > 0);
        return true;
      });
    }
    assert.equal(existsSync(j), false);                            // 拒绝路径连目录都不建，更不产生半行
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 评审 #6：atomPath 按位置切片拼分片路径，非补零 ISO ts（'2026-9-9' / '2026/09/09'）
// 会写出怪路径。两条落盘路径（原子 + 记录层条目）都在写盘前拒掉 → atomPath 恒安全。
test('ts 契约：非补零 ISO ts 被拒（原子与记录层两条路径），合格 ts 的分片路径不变', () => {
  const dir = tmpDir();
  try {
    const j = join(dir, 'journal');
    for (const ts of ['2026-9-9', '2026/09/09']) {
      assert.throws(() => appendAtom(j, atom({ ts })), (e) => {
        assert.ok(e instanceof AtomRejected, 'appendAtom should reject ' + ts);
        assert.match(e.message, /ts: non-iso-ts/);
        return true;
      }, ts);
      assert.throws(() => appendJournalRecord(j, { id: 'confirmation:x', ts, kind: CONFIRMATION_KIND }), (e) => {
        assert.ok(e instanceof RecordRejected, 'appendJournalRecord should reject ' + ts);
        assert.match(e.message, /zero-padded ISO-8601/);
        return true;
      }, ts);
    }
    assert.equal(existsSync(j), false);                       // 拒绝路径连目录都不建，更不产生怪分片

    // 合格 ts 照旧：YYYY/MM/YYYY-MM-DD.ndjson
    appendAtom(j, atom({ id: 'commit:ok', ts: '2026-06-01T08:00:00Z' }));
    appendJournalRecord(j, { id: 'confirmation:ok', ts: '2026-06-01T09:00:00Z', kind: CONFIRMATION_KIND, atom: 'commit:ok', verdict: 'confirm', confirmed_by: 'owner' });
    assert.deepEqual(readdirSync(join(j, '2026')), ['06']);   // 没有 '2026-9-' 这类怪目录
    assert.deepEqual(readdirSync(join(j, '2026', '06')), ['2026-06-01.ndjson']);
    assert.equal(readFileSync(join(j, '2026', '06', '2026-06-01.ndjson'), 'utf8').split('\n').filter(Boolean).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('拒绝路径不产生半行：合法 → 非法 → 合法，shard 恰好 2 行且都合法', () => {
  const dir = tmpDir();
  try {
    const j = join(dir, 'journal');
    appendAtom(j, atom({ id: 'commit:ok1' }));
    assert.throws(() => appendAtom(j, atom({ id: 'commit:bad', ts: 'not-a-date' })), AtomRejected);
    appendAtom(j, atom({ id: 'commit:ok2' }));
    const shard = join(j, '2026', '06', '2026-06-01.ndjson');
    const lines = readFileSync(shard, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    for (const l of lines) assert.equal(validateAtom(JSON.parse(l)).ok, true);
    assert.deepEqual(readAllAtoms(j).map(a => a.id), ['commit:ok1', 'commit:ok2']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('写入侧 trailer 闭合（显式回归断言）：经校验落盘的 why 已剥 trailer；trailer-only 不写 why 键', () => {
  const dir = tmpDir();
  try {
    const j = join(dir, 'journal');
    const raw = { sha: 'abc123', ts: '2026-06-01T08:00:00Z', subject: 'feat: x', files: ['lib/a.js'] };
    // 三入口的构造器各来一条：commitAtom（hook/miner）/ noteAtom（agent）
    appendAtom(j, commitAtom({ ...raw, body: 'real rationale\nCo-Authored-By: Bot <b@x>\n🤖 Generated with [Claude Code](https://x)' }, ['lib'], 'hook'));
    appendAtom(j, commitAtom({ ...raw, sha: 'def456', body: 'Co-Authored-By: Bot <b@x>' }, ['lib'], 'miner:commits'));
    appendAtom(j, noteAtom({ id: 'note:t', ts: '2026-06-02T08:00:00Z', title: 't', why: 'why text\nSigned-off-by: D <d@x>' }));
    appendAtom(j, noteAtom({ id: 'note:u', ts: '2026-06-02T09:00:00Z', title: 'u', why: 'Generated with Codex' }));
    const stored = readAllAtoms(j);
    const byId = id => stored.find(a => a.id === id);
    const c1 = byId('commit:abc123'), c2 = byId('commit:def456'), n1 = byId('note:t'), n2 = byId('note:u');
    assert.equal(c1.why, 'real rationale');                        // 落盘的 why 已剥净签名
    assert.doesNotMatch(c1.why, /Co-Authored-By|Generated with/);
    assert.equal('why' in c2, false);                              // trailer-only → 无 why 键
    assert.equal(n1.why, 'why text');
    assert.doesNotMatch(n1.why, /Signed-off-by/);
    assert.equal('why' in n2, false);
    for (const a of [c1, c2, n1, n2]) assert.equal(validateAtom(a).ok, true, a.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('历史回放：本仓库「当时全量」原子逐条重放校验全部通过（条数运行时读，不钉死）', () => {
  const journalDir = join(process.cwd(), '.lore', 'journal');
  const atoms = readAllAtoms(journalDir);
  assert.ok(atoms.length > 0, 'journal 为空——回放断言失去意义');
  let passed = 0;
  for (const a of atoms) {
    const r = validateAtom(a);
    assert.equal(r.ok, true, `${a.id}: ${JSON.stringify(r.errors)}`);
    passed++;
  }
  assert.equal(passed, atoms.length);                              // 通过条数 = 运行时读到的条数
});

test('readAllAtoms reads across day/month/year shards; missing dir → []', () => {
  const dir = tmpDir();
  try {
    const j = join(dir, 'journal');
    assert.deepEqual(readAllAtoms(j), []);                       // missing dir
    appendAtom(j, atom({ id: 'a' }));
    appendAtom(j, atom({ id: 'b', ts: '2026-07-15T08:00:00Z' }));
    appendAtom(j, atom({ id: 'c', ts: '2025-01-02T08:00:00Z' }));
    const ids = readAllAtoms(j).map(a => a.id).sort();
    assert.deepEqual(ids, ['a', 'b', 'c']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('existingIds returns the set of atom ids', () => {
  const dir = tmpDir();
  try {
    const j = join(dir, 'journal');
    appendAtom(j, atom({ id: 'commit:x' }));
    appendAtom(j, atom({ id: 'commit:y' }));
    const s = existingIds(j);
    assert.equal(s.has('commit:x'), true);
    assert.equal(s.has('commit:y'), true);
    assert.equal(s.has('commit:z'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('测试自检：tmp 目录未被泄漏（readdirSync 可用、无半成品 shard）', () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
