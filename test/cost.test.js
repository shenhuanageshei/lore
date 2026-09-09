// test/cost.test.js —— S6 成本账本 + 预算闸（设计 §3.6 / §7 ⓪ 期）。
// 五条硬验收：成功/失败/超时都记账且坏行跳过 · tokens 拿不到留空不伪造 0 ·
// 预算超限 shouldRunAuto 返回 {run:false,reason:'budget'} 且无副作用 · 未配置预算与今天一致 ·
// **闸能被触发**（审计 D3：三个 CLI 后端都不回报 token 用量 → 维度支持 tokens|calls|ms，
// 未显式选 tokens/ms 时用 calls 兜底；触发用注入的计量值证明，不依赖真实 token 回报）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  BUDGET_DIMENSIONS, DEFAULT_BUDGET_DIMENSION, UNKNOWN_VERSION, appendCost, budgetStatus, costPath,
  meterUsage, readCost, sumCalls, sumMs, sumTokens, versionStamp,
} from '../lib/cost.js';
import { shouldRunAuto, tickAuto, runAuto } from '../lib/runner.js';
import { readBudgetConfig, writeBudgetConfig, writeAutoPending, readAutoPending } from '../lib/syncstate.js';
import { textOf, tokensOf } from '../lib/backend.js';

const NOW = new Date('2026-06-10T12:00:00');
const cfgAuto = { mode: 'auto', debounce_minutes: 10, schedule: null, max_pages: 5 };

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-cost-')); }
function gitInit(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
}

// runAuto 夹具（同 test/runner.test.js：真 git 仓库 + 一页 component）
function autoRepo() {
  const root = mkdtempSync(join(tmpdir(), 'lore-cost-run-'));
  gitInit(root);
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'lib', 'a.js'), 'export const x = 1;');
  const lore = join(root, '.lore');
  mkdirSync(join(lore, 'wiki', 'component'), { recursive: true });
  writeFileSync(join(lore, 'config.yml'), 'axes:\n  component:\n    code_roots: [lib]\n');
  writeFileSync(join(lore, 'wiki', 'component', 'lib.md'),
    '---\ntitle: Lib\nsummary: s\n---\n# Lib\n\n旧正文。\n\n<!-- LORE_JOURNAL:START -->\n- x\n<!-- LORE_JOURNAL:END -->\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  return { root, lore };
}
const FAKE_OK = '---\ntitle: Lib\nsummary: better\n---\n# Lib\n\n新正文，质量门要求长度不短于旧文三分之一，这里足够长完全没问题。\n\n<!-- LORE_JOURNAL:START -->\n- x\n<!-- LORE_JOURNAL:END -->\n';
const noopSpawn = () => ({ unref() {}, once() {} });

// ---------- 记账 ----------
test('记账：append → readCost round-trip；tokens 缺失不写键（不伪造 0），显式回报 0 保留', () => {
  const dir = tmp();
  try {
    const ok = appendCost(dir, { ts: '2026-09-09T00:00:00Z', page: 'component/a.md', backend: 'claude', ms: 1234, ok: true, version: 'v1.0.0' });
    assert.deepEqual(ok, { ts: '2026-09-09T00:00:00Z', page: 'component/a.md', backend: 'claude', ms: 1234, ok: true, version: 'v1.0.0' });
    assert.equal('tokens' in ok, false);                                   // 拿不到 = 键不存在
    appendCost(dir, { ts: '2026-09-09T00:00:01Z', page: 'component/b.md', backend: 'codex', ms: 10, ok: false, version: 'v1.0.0' });
    appendCost(dir, { ts: '2026-09-09T00:00:02Z', page: 'component/c.md', backend: 'codex', ms: 5, ok: true, tokens: 0, version: 'v1.0.0' });
    appendCost(dir, { ts: '2026-09-09T00:00:03Z', page: 'component/d.md', backend: 'claude', ms: 9, ok: true, tokens: 1234, version: 'v1.0.0' });

    const { entries, skipped } = readCost(dir);
    assert.equal(entries.length, 4);
    assert.equal(skipped, 0);
    assert.equal(entries[1].ok, false);
    assert.equal('tokens' in entries[1], false);
    assert.equal(entries[2].tokens, 0);                                    // 真回报 0 ≠ 不知道
    assert.equal(entries[3].tokens, 1234);

    // 坏行跳过不崩（坏 JSON / 数组 / null / 空行）
    writeFileSync(costPath(dir), readFileSync(costPath(dir), 'utf8') + '{oops\n[1,2]\nnull\n\n');
    const again = readCost(dir);
    assert.equal(again.entries.length, 4);
    assert.equal(again.skipped, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('记账校验：缺 page/backend/ms/ok、tokens 非法 → throw；version 缺省 unknown', () => {
  const dir = tmp();
  try {
    const base = { page: 'p', backend: 'claude', ms: 1, ok: true };
    assert.throws(() => appendCost(dir, { ...base, page: '' }), /non-empty page/);
    assert.throws(() => appendCost(dir, { ...base, backend: undefined }), /non-empty backend/);
    assert.throws(() => appendCost(dir, { ...base, ms: -1 }), /ms >= 0/);
    assert.throws(() => appendCost(dir, { ...base, ok: 'yes' }), /ok boolean/);
    assert.throws(() => appendCost(dir, { ...base, tokens: -5 }), /tokens/);
    assert.throws(() => appendCost(dir, { ...base, tokens: 'many' }), /tokens/);
    assert.equal(existsSync(costPath(dir)), false);                        // 非法输入不落盘
    const rec = appendCost(dir, base);
    assert.equal(rec.version, UNKNOWN_VERSION);
    assert.equal('tokens' in rec, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- 版本戳（每版本窗口的键） ----------
test('versionStamp：取最近 tag；tag 之后的新提交不换窗口；无 tag / 非 git → unknown', () => {
  const tagged = tmp();
  const untagged = tmp();
  const nogit = tmp();
  try {
    gitInit(tagged);
    writeFileSync(join(tagged, 'a.txt'), '1');
    execFileSync('git', ['add', '.'], { cwd: tagged });
    execFileSync('git', ['commit', '-qm', 'a'], { cwd: tagged });
    execFileSync('git', ['tag', 'v1.0.0'], { cwd: tagged });
    assert.equal(versionStamp(tagged), 'v1.0.0');
    writeFileSync(join(tagged, 'a.txt'), '2');
    execFileSync('git', ['commit', '-qam', 'b'], { cwd: tagged });
    assert.equal(versionStamp(tagged), 'v1.0.0');                          // 窗口稳定到发版，不随提交漂移

    gitInit(untagged);
    writeFileSync(join(untagged, 'a.txt'), '1');
    execFileSync('git', ['add', '.'], { cwd: untagged });
    execFileSync('git', ['commit', '-qm', 'a'], { cwd: untagged });
    assert.equal(versionStamp(untagged), UNKNOWN_VERSION);

    assert.equal(versionStamp(nogit), UNKNOWN_VERSION);                    // 非 git 不崩
  } finally {
    for (const d of [tagged, untagged, nogit]) rmSync(d, { recursive: true, force: true });
  }
});

// ---------- 求和与预算状态 ----------
test('sumTokens：按版本切片；unknown 版本合计全部；缺 tokens 只计数不估算', () => {
  const entries = [
    { ts: 't', page: 'p', backend: 'claude', ms: 1, ok: true, tokens: 60, version: 'v1.0.0' },
    { ts: 't', page: 'p', backend: 'claude', ms: 1, ok: true, version: 'v1.0.0' },              // 无 tokens
    { ts: 't', page: 'p', backend: 'codex', ms: 1, ok: true, tokens: 50, version: 'v0.9.0' },
  ];
  assert.deepEqual(sumTokens(entries, { version: 'v1.0.0' }), { used: 60, counted: 2, unknownTokens: 1 });
  assert.deepEqual(sumTokens(entries, { version: 'v0.9.0' }), { used: 50, counted: 1, unknownTokens: 0 });
  assert.deepEqual(sumTokens(entries, { version: UNKNOWN_VERSION }), { used: 110, counted: 3, unknownTokens: 1 });
  assert.deepEqual(sumTokens(entries), { used: 110, counted: 3, unknownTokens: 1 });
});

test('budgetStatus：未配置不阻断；超限 exceeded；窗口外条目不计；缺 tokens 不虚增 used', () => {
  const dir = tmp();
  try {
    appendCost(dir, { ts: 't', page: 'p', backend: 'claude', ms: 1, ok: true, tokens: 60, version: 'v1.0.0' });
    appendCost(dir, { ts: 't', page: 'p', backend: 'claude', ms: 1, ok: true, tokens: 50, version: 'v1.0.0' });
    appendCost(dir, { ts: 't', page: 'p', backend: 'claude', ms: 1, ok: true, version: 'v1.0.0' });      // 无 tokens
    appendCost(dir, { ts: 't', page: 'p', backend: 'codex', ms: 1, ok: true, tokens: 999, version: 'v0.9.0' });

    const off = budgetStatus({ stateDir: dir, version: 'v1.0.0', tokenBudget: null });
    assert.equal(off.configured, false);
    assert.equal(off.exceeded, false);                                     // 未配置 → 永不阻断

    const under = budgetStatus({ stateDir: dir, version: 'v1.0.0', tokenBudget: 200 });
    assert.equal(under.used, 110);
    assert.equal(under.counted, 3);
    assert.equal(under.unknownTokens, 1);
    assert.equal(under.exceeded, false);

    const over = budgetStatus({ stateDir: dir, version: 'v1.0.0', tokenBudget: 100 });
    assert.equal(over.exceeded, true);                                     // 110 >= 100

    // 旧版本窗口：v0.9.0 的 999 tokens 与 v1.0.0 的账目互不串味
    assert.equal(budgetStatus({ stateDir: dir, version: 'v0.9.0', tokenBudget: 100 }).used, 999);

    // 全无 tokens 的账本：used 恒 0（不估算、不伪造）→ 不超限
    const noTokens = tmp();
    try {
      appendCost(noTokens, { ts: 't', page: 'p', backend: 'claude', ms: 1, ok: true, version: 'v1.0.0' });
      const st = budgetStatus({ stateDir: noTokens, version: 'v1.0.0', tokenBudget: 1 });
      assert.equal(st.used, 0);
      assert.equal(st.unknownTokens, 1);
      assert.equal(st.exceeded, false);
    } finally { rmSync(noTokens, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- 计量维度（审计 D3：闸必须能被触发） ----------
test('meterUsage：calls/ms/tokens 三维度口径；缺省与未知维度都回 calls 兜底', () => {
  const entries = [
    { ts: 't', page: 'p', backend: 'claude', ms: 100, ok: true, version: 'v1.0.0' },            // 无 tokens
    { ts: 't', page: 'p', backend: 'codex', ms: 250, ok: true, tokens: 60, version: 'v1.0.0' },
    { ts: 't', page: 'p', backend: 'codex', ms: 5, ok: true, version: 'v0.9.0' },
  ];
  assert.deepEqual([...BUDGET_DIMENSIONS], ['tokens', 'calls', 'ms']);
  assert.equal(DEFAULT_BUDGET_DIMENSION, 'calls');
  assert.deepEqual(meterUsage(entries, { version: 'v1.0.0', dimension: 'calls' }), { used: 2, counted: 2, unknownTokens: 1 });
  assert.deepEqual(meterUsage(entries, { version: 'v1.0.0', dimension: 'ms' }), { used: 350, counted: 2, unknownTokens: 1 });
  assert.deepEqual(meterUsage(entries, { version: 'v1.0.0', dimension: 'tokens' }), { used: 60, counted: 2, unknownTokens: 1 });
  assert.deepEqual(meterUsage(entries, { version: 'v1.0.0' }), { used: 2, counted: 2, unknownTokens: 1 });          // 缺省 calls
  assert.deepEqual(meterUsage(entries, { version: 'v1.0.0', dimension: 'bogus' }), { used: 2, counted: 2, unknownTokens: 1 });
  assert.deepEqual(sumCalls(entries, { version: UNKNOWN_VERSION }), { used: 3, counted: 3, unknownTokens: 2 });
  assert.deepEqual(sumMs(entries, { version: UNKNOWN_VERSION }), { used: 355, counted: 3, unknownTokens: 2 });
});

test('预算闸可触发（注入计量值，不依赖 token 回报）：calls 预算 1 + 已用 1 → exceeded → shouldRunAuto 拒绝', () => {
  const dir = tmp();
  try {
    // 账本里**一行 tokens 都没有**——正是三个 CLI 后端的真实情况：旧口径 used 恒 0、闸永不触发
    appendCost(dir, { ts: 't', page: 'component/a.md', backend: 'claude', ms: 1234, ok: true, version: 'v1.0.0' });

    const bs = budgetStatus({ stateDir: dir, version: 'v1.0.0', budget: 1, dimension: 'calls' });
    assert.equal(bs.configured, true);
    assert.equal(bs.dimension, 'calls');
    assert.equal(bs.budget, 1);
    assert.equal(bs.used, 1);
    assert.equal(bs.unknownTokens, 1);
    assert.equal(bs.exceeded, true);                                        // ← 闸真能红

    const base = { config: cfgAuto, pendingTs: '2026-06-10T11:00:00', lastRunDate: null, now: NOW, runnerAlive: false };
    assert.deepEqual(shouldRunAuto({ ...base, budget: bs }), { run: false, reason: 'budget' });

    // ms 维度同样可触发（注入耗时）
    assert.equal(budgetStatus({ stateDir: dir, version: 'v1.0.0', budget: 1000, dimension: 'ms' }).exceeded, true);
    assert.equal(budgetStatus({ stateDir: dir, version: 'v1.0.0', budget: 5000, dimension: 'ms' }).exceeded, false);
    // tokens 维度在无回报时确实算不出来（诚实保留，不估算）——这正是 calls 兜底存在的理由
    assert.equal(budgetStatus({ stateDir: dir, version: 'v1.0.0', budget: 1, dimension: 'tokens' }).exceeded, false);
    assert.equal(budgetStatus({ stateDir: dir, version: 'v1.0.0', budget: 1 }).dimension, 'calls');       // 缺省兜底
    assert.equal(budgetStatus({ stateDir: dir, version: 'v1.0.0', budget: 1 }).exceeded, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- 闸：纯函数 + ticker 无副作用 ----------
test('shouldRunAuto：预算超限 → {run:false,reason:budget}；未超限/未配置 → 与今天一致', () => {
  const base = { config: cfgAuto, pendingTs: '2026-06-10T11:00:00', lastRunDate: null, now: NOW, runnerAlive: false };
  assert.deepEqual(shouldRunAuto({ ...base, budget: { exceeded: true } }), { run: false, reason: 'budget' });
  assert.deepEqual(shouldRunAuto({ ...base, budget: { exceeded: false } }), { run: true, reason: 'debounce' });
  assert.deepEqual(shouldRunAuto(base), { run: true, reason: 'debounce' });                     // 未配置预算
  assert.deepEqual(shouldRunAuto({ ...base, budget: null }), { run: true, reason: 'debounce' });
  // 非 auto 档不会被预算理由污染（reason 仍为 null）
  assert.deepEqual(shouldRunAuto({ ...base, config: { ...cfgAuto, mode: 'notify' }, budget: { exceeded: true } }), { run: false, reason: null });
  assert.deepEqual(shouldRunAuto({ ...base, runnerAlive: true, budget: { exceeded: true } }), { run: false, reason: null });
});

test('tickAuto 超预算：不 spawn、不清 pending；清空预算后立刻放行', () => {
  const { root, lore } = autoRepo();
  try {
    const state = join(lore, '.state');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'sync.json'), JSON.stringify({ mode: 'auto', debounce_minutes: 0 }));
    writeAutoPending(state, '2026-06-10T00:00:00Z');
    // 临时仓库无 tag → 版本戳 unknown → 窗口 = 全部账目（保守口径）
    appendCost(state, { ts: '2026-06-10T00:00:00Z', page: 'component/lib.md', backend: 'claude', ms: 1000, ok: true, tokens: 500, version: UNKNOWN_VERSION });
    writeBudgetConfig(state, { token_budget: 100 });

    let spawned = 0;
    const r = tickAuto(lore, { spawnFn: () => { spawned++; return noopSpawn(); } });
    assert.deepEqual(r, { run: false, reason: 'budget' });
    assert.equal(spawned, 0);                                              // 没启动
    assert.equal(readAutoPending(state), '2026-06-10T00:00:00Z');          // 没清 pending（放行后立刻能跑）
    assert.equal(existsSync(join(state, 'runner.pid')), false);            // 没留任何运行痕迹

    writeBudgetConfig(state, { token_budget: null });                      // 人工放行
    const r2 = tickAuto(lore, { spawnFn: () => { spawned++; return noopSpawn(); } });
    assert.equal(r2.run, true);
    assert.equal(spawned, 1);
    assert.equal(readAutoPending(state), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tickAuto：calls 维度预算（账本无任何 token）→ 不 spawn、不清 pending；清空后立刻放行', () => {
  const { root, lore } = autoRepo();
  try {
    const state = join(lore, '.state');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'sync.json'), JSON.stringify({ mode: 'auto', debounce_minutes: 0 }));
    writeAutoPending(state, '2026-06-10T00:00:00Z');
    appendCost(state, { ts: '2026-06-10T00:00:00Z', page: 'component/lib.md', backend: 'claude', ms: 900, ok: true, version: UNKNOWN_VERSION });
    writeBudgetConfig(state, { budget: 1, dimension: 'calls' });

    let spawned = 0;
    const r = tickAuto(lore, { spawnFn: () => { spawned++; return noopSpawn(); } });
    assert.deepEqual(r, { run: false, reason: 'budget' });
    assert.equal(spawned, 0);                                              // 没启动
    assert.equal(readAutoPending(state), '2026-06-10T00:00:00Z');          // 没清 pending
    assert.equal(existsSync(join(state, 'runner.pid')), false);            // 没留运行痕迹

    writeBudgetConfig(state, { budget: null });                            // 人工放行
    const r2 = tickAuto(lore, { spawnFn: () => { spawned++; return noopSpawn(); } });
    assert.equal(r2.run, true);
    assert.equal(spawned, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- 预算配置（syncstate） ----------
test('预算配置：{budget,dimension} round-trip / 校验 / 清空不留键 / 旧形状可读 / 坏文件回未配置', () => {
  const dir = tmp();
  try {
    assert.deepEqual(readBudgetConfig(dir), { budget: null, dimension: 'calls' });   // 缺文件 → 未配置 + 兜底维度
    writeBudgetConfig(dir, { budget: 20, dimension: 'calls' });
    assert.deepEqual(readBudgetConfig(dir), { budget: 20, dimension: 'calls' });
    assert.equal(readFileSync(join(dir, 'budget.json'), 'utf8'), '{\n  "budget": 20,\n  "dimension": "calls"\n}\n');
    writeBudgetConfig(dir, { dimension: 'ms' });                           // 只改维度
    assert.deepEqual(readBudgetConfig(dir), { budget: 20, dimension: 'ms' });
    writeBudgetConfig(dir, { budget: 30 });                                // 只改上限 → 维度保留
    assert.deepEqual(readBudgetConfig(dir), { budget: 30, dimension: 'ms' });
    writeBudgetConfig(dir, { budget: null });                              // 清空
    assert.deepEqual(readBudgetConfig(dir), { budget: null, dimension: 'calls' });
    assert.equal(readFileSync(join(dir, 'budget.json'), 'utf8'), '{}\n');  // 不留 null 键
    assert.throws(() => writeBudgetConfig(dir, { budget: 0 }), /invalid budget/);
    assert.throws(() => writeBudgetConfig(dir, { budget: -1 }), /invalid budget/);
    assert.throws(() => writeBudgetConfig(dir, { budget: 'lots' }), /invalid budget/);
    assert.throws(() => writeBudgetConfig(dir, { budget: 10, dimension: 'minutes' }), /invalid budget dimension/);
    // 旧形状（S6 首版 {token_budget:n}）仍可读 → 等价 tokens 维度；再写时归一到新形状（旧键清掉）
    writeFileSync(join(dir, 'budget.json'), JSON.stringify({ token_budget: 250000 }));
    assert.deepEqual(readBudgetConfig(dir), { budget: 250000, dimension: 'tokens' });
    writeBudgetConfig(dir, { budget: 7, dimension: 'calls' });
    assert.equal(readFileSync(join(dir, 'budget.json'), 'utf8'), '{\n  "budget": 7,\n  "dimension": "calls"\n}\n');
    // 坏文件 / 非法值 → 不阻断（不崩）
    writeFileSync(join(dir, 'budget.json'), '{oops');
    assert.deepEqual(readBudgetConfig(dir), { budget: null, dimension: 'calls' });
    writeFileSync(join(dir, 'budget.json'), JSON.stringify({ budget: 'lots', dimension: 'bogus' }));
    assert.deepEqual(readBudgetConfig(dir), { budget: null, dimension: 'calls' });   // 非法值 → 未配置
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- runAuto 记账 ----------
test('runAuto：成功/失败/超时都记账；failover 两个后端各一行；无 tokens 键', async () => {
  const { root, lore } = autoRepo();
  try {
    const state = join(lore, '.state');
    const mk = (name, fn) => ({ name, rewritePage: fn });

    // ① 成功
    await runAuto(lore, { backend: mk('claude', async () => FAKE_OK), maxPages: 5, spawnFn: noopSpawn, now: () => new Date('2026-06-10T12:00:00Z') });
    let rows = readCost(state).entries;
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { ts: '2026-06-10T12:00:00.000Z', page: 'component/lib.md', backend: 'claude', ms: rows[0].ms, ok: true, version: UNKNOWN_VERSION });
    assert.ok(rows[0].ms >= 0);

    // ② 超时（非 unavailable → 不 failover）
    await runAuto(lore, { backend: mk('claude', async () => { throw new Error('claude timeout'); }), fallbackBackends: [mk('codex', async () => FAKE_OK)], maxPages: 5, spawnFn: noopSpawn, now: () => new Date('2026-06-10T12:00:00Z') });
    rows = readCost(state).entries;
    assert.equal(rows.length, 2);
    assert.equal(rows[1].ok, false);
    assert.equal(rows[1].backend, 'claude');
    assert.equal('tokens' in rows[1], false);

    // ③ 不可用类 → failover，两个后端各记一行
    const unavail = mk('claude', async () => { const e = new Error('claude-cli-missing'); e.unavailable = true; throw e; });
    await runAuto(lore, { backend: unavail, fallbackBackends: [mk('codex', async () => FAKE_OK)], maxPages: 5, spawnFn: noopSpawn, now: () => new Date('2026-06-10T12:00:00Z') });
    rows = readCost(state).entries;
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.slice(2).map(r => [r.backend, r.ok]), [['claude', false], ['codex', true]]);

    // ④ 上限 0 页 → 没有 LLM 调用 → 账本不长（无副作用）
    await runAuto(lore, { backend: mk('claude', async () => FAKE_OK), maxPages: 0, spawnFn: noopSpawn, now: () => new Date('2026-06-10T12:00:00Z') });
    assert.equal(readCost(state).entries.length, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runAuto：后端回报 {text,tokens} → 账本记 tokens；text 仍按新页处理落盘', async () => {
  const { root, lore } = autoRepo();
  try {
    const state = join(lore, '.state');
    const backend = { name: 'claude', rewritePage: async () => ({ text: FAKE_OK, tokens: 4321 }) };
    const res = await runAuto(lore, { backend, maxPages: 5, spawnFn: noopSpawn, now: () => new Date('2026-06-10T12:00:00Z') });
    assert.equal(res.pages[0].ok, true);
    assert.match(readFileSync(join(lore, 'wiki', 'component', 'lib.md'), 'utf8'), /新正文/);
    const rows = readCost(state).entries;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tokens, 4321);
    assert.equal(rows[0].ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('结果取用：textOf/tokensOf 兼容旧字符串契约与新对象契约', () => {
  assert.equal(textOf('abc'), 'abc');
  assert.equal(textOf({ text: 'abc', tokens: 5 }), 'abc');
  assert.equal(textOf(undefined), '');
  assert.equal(tokensOf('abc'), undefined);                                // 旧契约没有用量 → 不伪造
  assert.equal(tokensOf({ text: 'abc' }), undefined);
  assert.equal(tokensOf({ text: 'abc', tokens: 0 }), 0);
  assert.equal(tokensOf({ text: 'abc', tokens: 5 }), 5);
  assert.equal(tokensOf({ text: 'abc', tokens: 'x' }), undefined);
});
