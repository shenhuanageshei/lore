// test/runner.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRunAuto, qualityGate } from '../lib/runner.js';

const NOW = new Date('2026-06-10T12:00:00');
const cfgAuto = { mode: 'auto', debounce_minutes: 10, schedule: null, max_pages: 5 };

test('shouldRunAuto: 非 auto / runner 活 → false', () => {
  assert.equal(shouldRunAuto({ config: { ...cfgAuto, mode: 'notify' }, pendingTs: '2026-06-10T11:00:00', lastRunDate: null, now: NOW, runnerAlive: false }).run, false);
  assert.equal(shouldRunAuto({ config: cfgAuto, pendingTs: '2026-06-10T11:00:00', lastRunDate: null, now: NOW, runnerAlive: true }).run, false);
});

test('shouldRunAuto: debounce 未到 false；已到 true（reason debounce）', () => {
  assert.equal(shouldRunAuto({ config: cfgAuto, pendingTs: '2026-06-10T11:55:00', lastRunDate: null, now: NOW, runnerAlive: false }).run, false);   // 5 分钟前 < 10
  const r = shouldRunAuto({ config: cfgAuto, pendingTs: '2026-06-10T11:45:00', lastRunDate: null, now: NOW, runnerAlive: false });
  assert.deepEqual(r, { run: true, reason: 'debounce' });
});

test('shouldRunAuto: schedule 到点且今天没跑 → true；今天跑过 → false；无 pending 无 schedule → false', () => {
  const cfg = { ...cfgAuto, schedule: '03:00' };
  const r = shouldRunAuto({ config: cfg, pendingTs: null, lastRunDate: '2026-06-09', now: NOW, runnerAlive: false });
  assert.deepEqual(r, { run: true, reason: 'schedule' });
  assert.equal(shouldRunAuto({ config: cfg, pendingTs: null, lastRunDate: '2026-06-10', now: NOW, runnerAlive: false }).run, false);
  assert.equal(shouldRunAuto({ config: cfgAuto, pendingTs: null, lastRunDate: null, now: NOW, runnerAlive: false }).run, false);
});

const GOOD_PAGE = `---\ntitle: X\nsummary: s\n---\n# X\n\n正文足够长，超过旧文三分之一的长度要求，这里再凑一些字数保证比例没问题。\n\n<!-- LORE_JOURNAL:START -->\n- old\n<!-- LORE_JOURNAL:END -->\n`;
const OLD_PAGE = GOOD_PAGE;

test('qualityGate: 好页过门', () => {
  assert.deepEqual(qualityGate(GOOD_PAGE, OLD_PAGE), { ok: true });
});

test('qualityGate: 空 / 缺 frontmatter / token 与哨兵区全无 / 截断 各拒', () => {
  assert.equal(qualityGate('', OLD_PAGE).ok, false);
  assert.match(qualityGate('no frontmatter body here at all', OLD_PAGE).reason, /frontmatter/);
  assert.match(qualityGate('---\ntitle: X\nsummary: s\n---\n# X\n\n正文够长够长够长够长够长够长够长够长够长够长够长够长够长够长。\n', OLD_PAGE).reason, /journal/);
  const LONG_OLD = GOOD_PAGE + GOOD_PAGE + GOOD_PAGE;        // 3 倍长旧文，短新文必触发 1/3 截断检查
  assert.match(qualityGate('---\ntitle: X\nsummary: s\n---\nx\n<!-- LORE_JOURNAL:START -->\n<!-- LORE_JOURNAL:END -->\n', LONG_OLD).reason, /truncated/);
});

test('qualityGate: mermaid 坏图拒（复用 lint 第五检）', () => {
  const bad = GOOD_PAGE + '\n```mermaid\nflowchart LR\n  x --> graph["g"]\n```\n';
  assert.match(qualityGate(bad, OLD_PAGE).reason, /mermaid/);
});

test('qualityGate: HOME 页查 HOME_STATUS 哨兵；普通页仍查 JOURNAL；互不串味', () => {
  const home = '---\ntitle: H\nsummary: s\n---\n# HOME\n\n{{LORE_HOME_STATUS}}\n\n' + '正文足够长免截断。'.repeat(10);
  assert.equal(qualityGate(home, '', { path: 'HOME.md' }).ok, true);
  const homeLost = '---\ntitle: H\nsummary: s\n---\n# HOME\n\n' + '正文没了哨兵。'.repeat(10);
  assert.match(qualityGate(homeLost, '', { path: 'HOME.md' }).reason, /sentinel/);
  // HOME 哨兵区物化形态也认
  const homeMat = home.replace('{{LORE_HOME_STATUS}}', '<!-- LORE_HOME_STATUS:START -->x<!-- LORE_HOME_STATUS:END -->');
  assert.equal(qualityGate(homeMat, '', { path: 'HOME.md' }).ok, true);
  // 普通页带 HOME 哨兵不算（仍要 JOURNAL）
  assert.equal(qualityGate(homeMat, '', { path: 'theme/x.md' }).ok, false);
});

// --- runAuto 主流程（fake backend 注入，不真调 claude）---
import { runAuto } from '../lib/runner.js';
import { mkdtempSync, mkdirSync, writeFileSync as wf, readFileSync as rf, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendRewriteRequest, readRewriteRequests, readAutoRuns, readRunnerPid } from '../lib/syncstate.js';

function autoRepo() {
  const root = mkdtempSync(join(tmpdir(), 'lore-runner-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  mkdirSync(join(root, 'lib'), { recursive: true });
  wf(join(root, 'lib', 'a.js'), 'export const x = 1;');
  const lore = join(root, '.lore');
  mkdirSync(join(lore, 'wiki', 'component'), { recursive: true });
  wf(join(lore, 'config.yml'), 'axes:\n  component:\n    code_roots: [lib]\n');
  wf(join(lore, 'wiki', 'component', 'lib.md'),
    '---\ntitle: Lib\nsummary: s\n---\n# Lib\n\n旧正文。\n\n<!-- LORE_JOURNAL:START -->\n- x\n<!-- LORE_JOURNAL:END -->\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  return { root, lore };
}

const FAKE_OK = `---\ntitle: Lib\nsummary: better\n---\n# Lib\n\n新正文，质量门要求长度不短于旧文三分之一，这里足够长完全没问题。\n\n<!-- LORE_JOURNAL:START -->\n- x\n<!-- LORE_JOURNAL:END -->\n`;
const noopSpawn = () => ({ unref() {}, once() {} });

test('runAuto: 好页写盘+队列移除+历史记录+pid 清理', async () => {
  const { root, lore } = autoRepo();
  try {
    appendRewriteRequest(join(lore, '.state'), { page: 'component/lib.md' });
    let calls = 0;
    const backend = { rewritePage: async () => { calls++; return FAKE_OK; } };
    const res = await runAuto(lore, { backend, maxPages: 5, spawnFn: noopSpawn, now: () => new Date('2026-06-10T12:00:00') });
    assert.equal(calls, 1);                                              // 只有 lib 一页
    assert.equal(res.pages[0].ok, true);
    assert.match(rf(join(lore, 'wiki', 'component', 'lib.md'), 'utf8'), /新正文/);   // 写盘了
    assert.deepEqual(readRewriteRequests(join(lore, '.state')), []);     // 队列消化
    assert.equal(readAutoRuns(join(lore, '.state')).length, 1);          // 历史
    assert.equal(readRunnerPid(join(lore, '.state')), null);             // pid 清了
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runAuto: 质量门不过 → 页面原样 + reason 入历史', async () => {
  const { root, lore } = autoRepo();
  try {
    const backend = { rewritePage: async () => 'garbage no frontmatter' };
    const res = await runAuto(lore, { backend, maxPages: 5, spawnFn: noopSpawn, now: () => new Date() });
    assert.equal(res.pages[0].ok, false);
    assert.match(res.pages[0].reason, /frontmatter/);
    assert.match(rf(join(lore, 'wiki', 'component', 'lib.md'), 'utf8'), /旧正文/);   // 没动
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runAuto: backend 抛错 → 该页失败记 reason，不崩', async () => {
  const { root, lore } = autoRepo();
  try {
    const backend = { rewritePage: async () => { throw new Error('claude-cli-missing'); } };
    const res = await runAuto(lore, { backend, maxPages: 5, spawnFn: noopSpawn, now: () => new Date() });
    assert.equal(res.pages[0].ok, false);
    assert.match(res.pages[0].reason, /claude-cli-missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tickAuto: auto+pending 过期 → spawn runner + 清 pending；notify → 不动', async () => {
  const { tickAuto } = await import('../lib/runner.js');
  const { writeSyncMode, writeAutoPending, readAutoPending } = await import('../lib/syncstate.js');
  const { root, lore } = autoRepo();
  try {
    const state = join(lore, '.state');
    mkdirSync(state, { recursive: true });
    wf(join(state, 'sync.json'), JSON.stringify({ mode: 'auto', debounce_minutes: 0 }));
    writeAutoPending(state, '2026-06-10T00:00:00Z');           // 早已过静默期
    const calls = [];
    const r = tickAuto(lore, { spawnFn: (cmd, args) => { calls.push(args); return { unref() {}, once() {} }; } });
    assert.equal(r.run, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0][0], /runner\.js$/);
    assert.equal(calls[0][1], lore);
    assert.equal(readAutoPending(state), null);                // pending 清了
    // notify 档对照
    writeSyncMode(state, 'notify');
    writeAutoPending(state, '2026-06-10T00:00:00Z');
    assert.equal(tickAuto(lore, { spawnFn: () => { throw new Error('should not spawn'); } }).run, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tickAuto: 重写队列非空（无 commit pending）也触发——排队即意图', async () => {
  const { tickAuto } = await import('../lib/runner.js');
  const { appendRewriteRequest: q } = await import('../lib/syncstate.js');
  const { root, lore } = autoRepo();
  try {
    const state = join(lore, '.state');
    mkdirSync(state, { recursive: true });
    wf(join(state, 'sync.json'), JSON.stringify({ mode: 'auto', debounce_minutes: 0 }));
    q(state, { page: 'component/lib.md', now: '2026-06-10T00:00:00Z' });   // 只排队，不 commit
    const calls = [];
    const r = tickAuto(lore, { spawnFn: (cmd, args) => { calls.push(args); return { unref() {}, once() {} }; } });
    assert.equal(r.run, true);
    assert.equal(calls.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runAuto: maxPages 截断', async () => {
  const { root, lore } = autoRepo();
  try {
    const backend = { rewritePage: async () => FAKE_OK };
    const res = await runAuto(lore, { backend, maxPages: 0, spawnFn: noopSpawn, now: () => new Date() });
    assert.equal(res.pages.length, 0);                       // 0 页上限 → 啥都不跑（截断生效）
  } finally { rmSync(root, { recursive: true, force: true }); }
});
