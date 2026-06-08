// lib/fingerprint.js — 每页 prose 指纹（解耦 prose 新鲜度 与 机械 finalize）。
// 存 <loreDir>/.state/fingerprints.json（gitignored、本地缓存、可重建）。纯函数 + 路径注入。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { translationSourceHash } from './i18n.js';

export function fingerprintsPath(stateDir) {
  return join(stateDir, 'fingerprints.json');
}

// prose 指纹 = 排除 frontmatter + LORE_*:START/END 哨兵区后的正文 hash（复用 i18n）。
// 改日期/sha/决策史/状态块都不变；只有 agent 重写架构正文才变。
export function proseHash(pageText) {
  return translationSourceHash(pageText);
}

export function readFingerprints(stateDir) {
  const p = fingerprintsPath(stateDir);
  if (!existsSync(p)) return {};
  try {
    const v = JSON.parse(readFileSync(p, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

export function writeFingerprints(stateDir, map) {
  const p = fingerprintsPath(stateDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(map, null, 2) + '\n');
}
