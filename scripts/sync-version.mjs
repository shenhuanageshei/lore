#!/usr/bin/env node
// npm version 生命周期钩子：把 package.json 的 version 同步进 .claude-plugin/plugin.json。
// 由 package.json 的 "version" script 调用——此时 npm 已 bump 好 package.json。
// 用正则只替换 version 行的值，保留 plugin.json 原有格式/键序（不走 JSON.stringify 重排）。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const pluginPath = join(root, '.claude-plugin', 'plugin.json');

const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
const raw = readFileSync(pluginPath, 'utf8');

if (JSON.parse(raw).version === version) {
  console.log(`plugin.json already at ${version}`);
} else {
  const updated = raw.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
  if (updated === raw) {
    console.error('sync-version: 未在 plugin.json 找到 version 字段');
    process.exit(1);
  }
  writeFileSync(pluginPath, updated);
  console.log(`synced plugin.json -> ${version}`);
}
