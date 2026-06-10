// lib/syncstate.js —— B1 同步控制状态层（.state/ 本地存储，best-effort 容错同 registry.js）
// 档位是 per-machine 工作流偏好：删文件 = 回默认 notify，无损坏（spec 决策）。
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const MODES = new Set(['manual', 'notify']);   // B2 加 'auto'
const MODE_FILE = 'sync.json';
const QUEUE_FILE = 'rewrite-requests.ndjson';

export function readSyncMode(stateDir) {
  const p = join(stateDir, MODE_FILE);
  if (!existsSync(p)) return 'notify';
  try {
    const m = JSON.parse(readFileSync(p, 'utf8')).mode;
    return MODES.has(m) ? m : 'notify';
  } catch { return 'notify'; }
}

export function writeSyncMode(stateDir, mode) {
  if (!MODES.has(mode)) throw new Error(`lore: invalid sync mode "${mode}" (B1: manual|notify)`);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, MODE_FILE), JSON.stringify({ mode }, null, 2) + '\n');
}
