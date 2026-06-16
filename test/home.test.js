import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHomeStatus, defaultHomePage, finalizeHomeText } from '../lib/home.js';

test('defaultHomePage contains the home status token and required sections', () => {
  const md = defaultHomePage({ title: 'lore', axisPages: { component: [{ id: 'lib' }], docs: [{ id: 'pitfalls' }, { id: 'changelog' }] } });
  assert.match(md, /title: Home/);
  assert.match(md, /\{\{LORE_HOME_STATUS\}\}/);
  assert.match(md, /## Architecture overview/);
  assert.doesNotMatch(md, /## Knowledge flow/);            // 不再印 lore 工具流程图
  assert.doesNotMatch(md, /```mermaid/);                   // 脚手架占位无图；图由 LLM 重写时生成
  assert.match(md, /## Understand the project/);
  assert.match(md, /## Debug a problem/);
  assert.match(md, /## Decisions and timeline/);
});

test('defaultHomePage: title renders as the H1 heading', () => {
  assert.match(defaultHomePage({ title: 'mal-analyze-cli', axisPages: {} }), /^# mal-analyze-cli$/m);
});

test('buildHomeStatus renders code, axes, language, and translation counts', () => {
  const md = buildHomeStatus({
    version: '0.4.1',
    codeSha: 'abc1234',
    lastUpdated: '2026-06-06',
    axisPages: {
      component: [{ id: 'lib' }],
      docs: [{ id: 'changelog' }],
    },
    language: { default: 'zh', available: ['zh', 'en'] },
    translationStats: { ready: 2, stale: 1, missing: 3 },
  });
  assert.match(md, /## Status/);
  assert.match(md, /Version: `0.4.1`/);
  assert.match(md, /Code: `abc1234`/);
  assert.match(md, /component 1/);
  assert.match(md, /docs 1/);
  assert.match(md, /Language: `zh` default/);
  assert.match(md, /Translations: `2 ready`/);
});

test('finalizeHomeText replaces the token once and leaves prose intact', () => {
  const out = finalizeHomeText('# Home\n\nintro\n\n{{LORE_HOME_STATUS}}\n', '## Status\n\n- x');
  assert.match(out, /intro/);
  assert.match(out, /## Status/);
  assert.doesNotMatch(out, /\{\{LORE_HOME_STATUS\}\}/);
});

test('finalizeHomeText is idempotent: re-finalize swaps the region, no duplicate Status', () => {
  const once = finalizeHomeText('# Home\n\nintro\n\n{{LORE_HOME_STATUS}}\n', '## Status\n\n- a');
  const twice = finalizeHomeText(once, '## Status\n\n- b');
  assert.equal((twice.match(/## Status/g) || []).length, 1);   // exactly one block
  assert.match(twice, /- b/);                                   // refreshed
  assert.doesNotMatch(twice, /- a/);                            // stale values gone
  assert.doesNotMatch(twice, /\{\{LORE_HOME_STATUS\}\}/);
});

test('defaultHomePage: omits empty sections (no INDEX fallback)', () => {
  const md = defaultHomePage({ axisPages: { component: [{ id: 'lib' }] } });
  assert.match(md, /## Understand the project/);
  assert.match(md, /- \[\[lib\]\]/);
  assert.doesNotMatch(md, /## Debug a problem/);
  assert.doesNotMatch(md, /## Decisions and timeline/);
  assert.doesNotMatch(md, /\[\[INDEX\]\]/);
});

test('defaultHomePage: renders sections when docs present', () => {
  const md = defaultHomePage({ axisPages: { component: [{ id: 'lib' }], docs: [{ id: 'pitfalls' }, { id: 'changelog' }] } });
  assert.match(md, /## Debug a problem/);
  assert.match(md, /- \[\[pitfalls\]\]/);
  assert.match(md, /## Decisions and timeline/);
  assert.match(md, /- \[\[changelog\]\]/);
});
