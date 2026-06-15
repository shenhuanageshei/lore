// lib/syncstate.js —— B1 同步控制状态层（.state/ 本地存储，best-effort 容错同 registry.js）
// 档位是 per-machine 工作流偏好：删文件 = 回默认 notify，无损坏（spec 决策）。
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const MODES = new Set(['manual', 'notify', 'auto']);
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
  if (!MODES.has(mode)) throw new Error(`lore: invalid sync mode "${mode}" (manual|notify|auto)`);
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

// 排队/同步（无 instruction）= 同页去重，攒「这页要更新」意图；
// 重写/改进（有 instruction）= 更新同页条目（指令可改写，用户改主意能覆盖）。
export function appendRewriteRequest(stateDir, { page, instruction, now = new Date().toISOString() }) {
  if (!page || typeof page !== 'string') return { queued: false };   // 防御：read 侧过滤同款谓词，append 侧对称把门
  const existing = readRewriteRequests(stateDir);
  const dup = existing.find(r => r.page === page);
  const entry = { ts: now, page, ...(instruction ? { instruction: String(instruction) } : {}) };
  mkdirSync(stateDir, { recursive: true });
  if (dup) {
    if (!instruction) return { queued: false };                      // 无新指令 → 同步去重，跳过
    const rest = existing.filter(r => r.page !== page);              // 有新指令 → 删旧加新（覆盖指令）
    writeFileSync(join(stateDir, QUEUE_FILE), [...rest, entry].map(r => JSON.stringify(r)).join('\n') + '\n');
    return { queued: true, updated: true };
  }
  appendFileSync(join(stateDir, QUEUE_FILE), JSON.stringify(entry) + '\n');
  return { queued: true };
}

// --- B2 自动重写状态（spec 2026-06-10-lore-auto-rewrite）---
const PENDING_FILE = 'auto-pending.json';
const RUNNER_PID_FILE = 'runner.pid';
const RUNS_FILE = 'auto-runs.ndjson';
const CONFIG_DEFAULTS = { mode: 'notify', debounce_minutes: 10, schedule: null, max_pages: 5, stale_threshold: 15 };

// sync.json 的全配置视图（B1 的 {mode} 形状向后兼容，未知字段忽略，非法值回默认）。
export function readSyncConfig(stateDir) {
  const p = join(stateDir, MODE_FILE);
  let raw = {};
  if (existsSync(p)) { try { raw = JSON.parse(readFileSync(p, 'utf8')) ?? {}; } catch { raw = {}; } }
  return {
    mode: MODES.has(raw.mode) ? raw.mode : CONFIG_DEFAULTS.mode,
    debounce_minutes: Number.isFinite(raw.debounce_minutes) ? raw.debounce_minutes : CONFIG_DEFAULTS.debounce_minutes,
    schedule: typeof raw.schedule === 'string' && /^\d{2}:\d{2}$/.test(raw.schedule) ? raw.schedule : CONFIG_DEFAULTS.schedule,
    max_pages: Number.isFinite(raw.max_pages) ? raw.max_pages : CONFIG_DEFAULTS.max_pages,
    // 非 component 页（HOME/theme/flow）入 auto 工单的 stale 门槛——全仓 commit 口径偏高，无阈值会每轮重写
    stale_threshold: Number.isFinite(raw.stale_threshold) ? raw.stale_threshold : CONFIG_DEFAULTS.stale_threshold,
  };
}

// 配置部分更新（控制台「保存参数」）：读现有 raw → 合并 patch → 校验 → 整写。mode 不在此改（走 writeSyncMode）。
export function writeSyncConfig(stateDir, patch) {
  if ('debounce_minutes' in patch && !(Number.isFinite(patch.debounce_minutes) && patch.debounce_minutes >= 0 && patch.debounce_minutes <= 1440)) {
    throw new Error(`lore: invalid debounce_minutes (0-1440)`);
  }
  if ('schedule' in patch && patch.schedule !== null) {
    const m = typeof patch.schedule === 'string' && patch.schedule.match(/^(\d{2}):(\d{2})$/);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`lore: invalid schedule (HH:MM or null)`);
  }
  if ('max_pages' in patch && !(Number.isFinite(patch.max_pages) && patch.max_pages >= 1 && patch.max_pages <= 50)) {
    throw new Error(`lore: invalid max_pages (1-50)`);
  }
  if ('stale_threshold' in patch && !(Number.isFinite(patch.stale_threshold) && patch.stale_threshold >= 1 && patch.stale_threshold <= 500)) {
    throw new Error(`lore: invalid stale_threshold (1-500)`);
  }
  const p = join(stateDir, MODE_FILE);
  let raw = {};
  if (existsSync(p)) { try { raw = JSON.parse(readFileSync(p, 'utf8')) ?? {}; } catch { raw = {}; } }
  const next = { ...raw };
  for (const k of ['debounce_minutes', 'schedule', 'max_pages', 'stale_threshold']) if (k in patch) next[k] = patch[k];
  if (next.schedule === null) delete next.schedule;        // null = 清空回默认，不留键
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2) + '\n');
}

export function writeAutoPending(stateDir, ts) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, PENDING_FILE), JSON.stringify({ since: ts }) + '\n');
}
export function readAutoPending(stateDir) {
  const p = join(stateDir, PENDING_FILE);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')).since ?? null; } catch { return null; }
}
export function clearAutoPending(stateDir) {
  try { rmSync(join(stateDir, PENDING_FILE), { force: true }); } catch { /* best-effort */ }
}

// runner 一轮绝对上限（max_pages × timeout 保守上界）——超过此龄的 pid 必是残留/卡死，不再认作「在跑」。
// 防 pid 复用死锁：机器重启后旧 runner 的 pid 被新进程占用，isAlive 误判 true 会让 ticker 永不触发（实测踩过）。
export const RUNNER_STALE_MS = 90 * 60 * 1000;

export function writeRunnerPid(stateDir, pid, now = Date.now()) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, RUNNER_PID_FILE), JSON.stringify({ pid, ts: now }) + '\n');
}
export function readRunnerPid(stateDir) {           // 兼容：仍返回 pid number（status 灯等消费）
  const p = join(stateDir, RUNNER_PID_FILE);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')).pid ?? null; } catch { return null; }
}
// runner 是否真在跑：pid 存在 + 进程活 + pid 未过期。旧格式 {pid}（无 ts）→ ts=0 → 判过期（自动解旧残留死锁）。
export function runnerAlive(stateDir, isAliveFn, now = Date.now()) {
  const p = join(stateDir, RUNNER_PID_FILE);
  if (!existsSync(p)) return false;
  try {
    const { pid, ts } = JSON.parse(readFileSync(p, 'utf8'));
    return pid != null && isAliveFn(pid) && (now - (ts ?? 0) < RUNNER_STALE_MS);
  } catch { return false; }
}
export function clearRunnerPid(stateDir) {
  try { rmSync(join(stateDir, RUNNER_PID_FILE), { force: true }); } catch { /* best-effort */ }
}

export function appendAutoRun(stateDir, run) {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, RUNS_FILE), JSON.stringify(run) + '\n');
}
export function readAutoRuns(stateDir, limit = 20) {
  const p = join(stateDir, RUNS_FILE);
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip bad line */ }
  }
  return out.reverse().slice(0, limit);                    // 最新在前
}
