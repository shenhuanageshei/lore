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

// rewrite 队列：壳「✍ 排队」→ append；会话 /lore:sync 优先消化后从文件移除该行（命令层职责）。
// B2 的 auto 档复用同一队列（LLM 运行器消费）。
export function readRewriteRequests(stateDir) {
  const p = join(stateDir, QUEUE_FILE);
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r.page === 'string' && r.page) out.push(r); }
    catch { /* skip bad line */ }
  }
  return out;
}

export function appendRewriteRequest(stateDir, { page, now = new Date().toISOString() }) {
  if (readRewriteRequests(stateDir).some(r => r.page === page)) return { queued: false };
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, QUEUE_FILE), JSON.stringify({ ts: now, page }) + '\n');
  return { queued: true };
}
