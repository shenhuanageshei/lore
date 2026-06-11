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
