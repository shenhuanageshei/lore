import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 版本号一致性守卫：package.json / plugin.json / CHANGELOG 顶部必须同版本。
// 历史教训：0.8.0~0.8.2 三版只动了 CHANGELOG，manifest 一直停在 0.7.0。
// 改版本号请用 `npm version <patch|minor|major>`——version 钩子会自动同步 plugin.json。
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const pkgVersion = JSON.parse(read('package.json')).version;
const pluginVersion = JSON.parse(read('.claude-plugin/plugin.json')).version;
const changelogTop = (read('CHANGELOG.md').match(/^##\s*\[(\d+\.\d+\.\d+)\]/m) || [])[1];

test('package.json 与 plugin.json 版本号一致', () => {
  assert.equal(
    pluginVersion,
    pkgVersion,
    '.claude-plugin/plugin.json 与 package.json 版本不一致；用 `npm version <bump>` 改版本会自动同步',
  );
});

test('manifest 版本号与 CHANGELOG 顶部一致', () => {
  assert.ok(changelogTop, 'CHANGELOG.md 顶部未解析到 `## [x.y.z]` 版本号');
  assert.equal(
    pkgVersion,
    changelogTop,
    `package.json (${pkgVersion}) 与 CHANGELOG 顶部 (${changelogTop}) 不一致；发版需在 CHANGELOG 增一节并同步 bump manifest`,
  );
});
