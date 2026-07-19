// lib/runner.js —— B2 自动重写运行器（spec 2026-06-10-lore-auto-rewrite）。
// LLM 只读（claude -p 白名单工具）、runner 写盘；质量门在写盘前；append-only 任务历史。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mermaidIssues } from './lint.js';
import { parseFrontmatter } from './manifest.js';
import {
  readSyncConfig, writeRunnerPid, clearRunnerPid, appendAutoRun, readRewriteRequests,
  runnerAlive, readAutoPending, clearAutoPending, readAutoRuns,
} from './syncstate.js';
import { isAlive } from './serve.js';
import { claudeBackend } from './backend.js';

// axisPrompt 已搬至 lib/backend.js（三后端共用 prompt 构造）——re-export 保既有 import 兼容。
export { axisPrompt } from './backend.js';

// ticker 判定：静默期 / schedule 到点 / 防叠跑 / 轮间冷却，全在这一个纯函数（可测）。
export function shouldRunAuto({ config, pendingTs, lastRunDate, lastRunTs, now, runnerAlive }) {
  if (runnerAlive || config.mode !== 'auto') return { run: false, reason: null };
  // 轮间冷却：失败页留在队列时 queueTs 恒旧，若无此闸会每分钟重跑一轮（重试风暴，实测踩过）
  if (lastRunTs && now.getTime() - new Date(lastRunTs).getTime() < config.debounce_minutes * 60_000) {
    return { run: false, reason: null };
  }
  if (pendingTs) {
    const quietMs = now.getTime() - new Date(pendingTs).getTime();
    if (quietMs >= config.debounce_minutes * 60_000) return { run: true, reason: 'debounce' };
  }
  if (config.schedule) {
    const [hh, mm] = config.schedule.split(':').map(Number);
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const due = new Date(now); due.setHours(hh, mm, 0, 0);
    if (now >= due && lastRunDate !== today) return { run: true, reason: 'schedule' };
  }
  return { run: false, reason: null };
}

// 质量门（全机械，写盘前）：非空 → frontmatter 完整 → 哨兵在（按页型：HOME=HOME_STATUS，其余=JOURNAL）
// → mermaid 全过 → 防截断。第三参 page 可省（旧调用兼容，按普通页处理）。
const MERMAID_BLOCK_RE = /```mermaid\r?\n([\s\S]*?)```/g;
// 防截断比较前两边都归一到 token 态：盘上旧页是物化态（哨兵区可达几十 K），LLM 新页是 token 态——
// 直接比长度必然误杀（实测 flow 页 96K 物化 vs 5K token 被拒）。
const SENTINEL_RE = /<!--\s*(LORE_JOURNAL|LORE_HOME_STATUS):START\s*-->[\s\S]*?<!--\s*\1:END\s*-->/g;
const toTokenForm = t => (t ?? '').replace(SENTINEL_RE, (_, name) => `{{${name}}}`);

export function qualityGate(newText, oldText, page = {}) {
  if (!newText || !newText.trim()) return { ok: false, reason: 'empty' };
  const { data } = parseFrontmatter(newText);
  if (!data.title || !data.summary) return { ok: false, reason: 'frontmatter missing title/summary' };
  const pp = page.path ?? '';
  const sentinel = (pp === 'HOME.md' || pp.endsWith('/HOME.md')) ? 'LORE_HOME_STATUS' : 'LORE_JOURNAL';
  if (!newText.includes(`{{${sentinel}}}`) && !newText.includes(`${sentinel}:START`)) {
    return { ok: false, reason: 'journal token/sentinel destroyed' };
  }
  let m;
  while ((m = MERMAID_BLOCK_RE.exec(newText)) !== null) {
    const issues = mermaidIssues(m[1]);
    if (issues.length) return { ok: false, reason: `mermaid: ${issues[0]}` };
  }
  if (toTokenForm(newText).length < toTokenForm(oldText).length / 3) {
    return { ok: false, reason: 'truncated (<1/3 of previous)' };
  }
  return { ok: true };
}

// 消化队列条目：读全 → 滤掉该页 → 整写（commands/sync.md 同款语义，队列小可接受）。
function removeRewriteRequest(stateDir, page) {
  const remaining = readRewriteRequests(stateDir).filter(r => r.page !== page);
  try {
    writeFileSync(join(stateDir, 'rewrite-requests.ndjson'),
      remaining.map(r => JSON.stringify(r)).join('\n') + (remaining.length ? '\n' : ''));
  } catch { /* best-effort */ }
}

// 主流程：工单（rewrite 队列页置顶）→ 逐页串行 backend → 质量门 → 写盘 → 历史 → finalize。
export async function runAuto(loreDir, { backend, maxPages, timeoutMs = 1_200_000, spawnFn = spawn, now = () => new Date() } = {}) {
  const stateDir = join(loreDir, '.state');
  const repoRoot = join(resolve(loreDir), '..');
  const config = readSyncConfig(stateDir);
  const limit = maxPages ?? config.max_pages;
  writeRunnerPid(stateDir, process.pid);
  const started = now();
  const results = [];
  try {
    const { planSync } = await import('./sync.js');       // 动态：避免 runner←sync←(graph/docs/home…) 的常驻加载链进 ticker 判定路径
    const { worklist } = planSync(loreDir, {});
    const queued = readRewriteRequests(stateDir);   // 保留全对象（含 instruction）—— 带指令的重写要把指令传到 prompt
    const comp = worklist.filter(w => w.axis === 'component');
    // 非 component（HOME/theme/flow）：planSync 恒全列且无指纹——用 manifest stale≥阈值过滤（扩轴 B2），
    // stale 是全仓 commit 口径（每 commit 都 >0），无阈值会每轮重写浪费 LLM。
    let rest = [];
    try {
      const manifest = JSON.parse(readFileSync(join(loreDir, 'wiki', '.manifest.json'), 'utf8'));
      const staleByPath = new Map();
      for (const ax of manifest.axes ?? []) for (const pg of ax.pages ?? []) staleByPath.set(pg.path, pg.stale ?? 0);
      rest = worklist
        .filter(w => w.axis !== 'component' && (staleByPath.get(w.path) ?? 0) >= config.stale_threshold)
        .sort((a, b) => (staleByPath.get(b.path) ?? 0) - (staleByPath.get(a.path) ?? 0));
    } catch { /* 无 manifest（未 finalize 过）→ 非 component 不入单 */ }
    // user-requested 置顶（队列序，队列页可属任意轴——worklist 外的纯 path 也带上）；其余 component 优先；去重截上限
    const pathAxis = p => p === 'HOME.md' ? 'HOME' : p.split('/')[0];
    const queuedItems = queued.map(q => {
      const base = worklist.find(w => w.path === q.page) ?? { path: q.page, axis: pathAxis(q.page), reason: 'user-requested' };
      return q.instruction ? { ...base, instruction: q.instruction } : base;   // 挂指令 → axisPrompt 注入
    });
    const seen = new Set();
    const ordered = [];
    for (const w of [...queuedItems, ...comp, ...rest]) {
      if (ordered.length >= limit) break;
      if (seen.has(w.path)) continue;
      seen.add(w.path);
      ordered.push(w);
    }
    for (const w of ordered) {
      const t0 = Date.now();
      try {
        const newText = await backend.rewritePage({ page: w, repoRoot, timeoutMs });
        const pagePath = join(loreDir, 'wiki', w.path);
        const oldText = existsSync(pagePath) ? readFileSync(pagePath, 'utf8') : '';
        const gate = qualityGate(newText, oldText, w);
        if (gate.ok) {
          writeFileSync(pagePath, newText.endsWith('\n') ? newText : newText + '\n');
          removeRewriteRequest(stateDir, w.path);
          results.push({ page: w.path, ok: true, ms: Date.now() - t0 });
        } else {
          results.push({ page: w.path, ok: false, reason: gate.reason, ms: Date.now() - t0 });
        }
      } catch (e) {
        results.push({ page: w.path, ok: false, reason: String(e.message ?? e).slice(0, 120), ms: Date.now() - t0 });
      }
    }
  } finally {
    clearRunnerPid(stateDir);
  }
  appendAutoRun(stateDir, { ts: started.toISOString(), pages: results, total_ms: now().getTime() - started.getTime() });
  if (results.some(r => r.ok)) {                           // 有页落盘才值得盖章（指纹推进 + manifest + stale 归零）
    const syncJs = fileURLToPath(new URL('./sync.js', import.meta.url));
    const child = spawnFn(process.execPath, [syncJs, 'finalize', loreDir], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once?.('error', () => {});
    child.unref();
  }
  return { pages: results, total_ms: now().getTime() - started.getTime() };
}

// ticker 的单 repo 判定+触发（server.js CLI 与 portal __run 共用）。永不抛——ticker 不能击落宿主。
export function tickAuto(loreDir, { spawnFn = spawn } = {}) {
  try {
    const stateDir = join(loreDir, '.state');
    const config = readSyncConfig(stateDir);
    if (config.mode !== 'auto') return { run: false };
    const runs = readAutoRuns(stateDir, 1);
    // 排队即意图：rewrite 队列非空时，最新排队时间视同 commit pending——
    // 用户只点「✍ 排队」不 commit 也会在静默期后触发（同 debounce 防连点风暴）。
    const queue = readRewriteRequests(stateDir);
    const queueTs = queue.length ? queue[queue.length - 1].ts : null;
    const pendingTs = readAutoPending(stateDir) ?? queueTs;
    const d = shouldRunAuto({
      config,
      pendingTs,
      lastRunDate: runs[0]?.ts?.slice(0, 10) ?? null,
      lastRunTs: runs[0]?.ts ?? null,
      now: new Date(),
      runnerAlive: runnerAlive(stateDir, isAlive),   // 带 ts 过期判定：防 pid 复用/卡死永久死锁
    });
    if (!d.run) return { run: false };
    clearAutoPending(stateDir);
    const child = spawnFn(process.execPath, [fileURLToPath(import.meta.url), loreDir],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.once?.('error', () => {});
    child.unref();
    return { run: true, reason: d.reason };
  } catch { return { run: false }; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const loreDir = process.argv[2] ?? join(process.cwd(), '.lore');
  runAuto(loreDir, { backend: claudeBackend() })
    .then(r => { console.log(`auto-rewrite: ${r.pages.filter(p => p.ok).length}/${r.pages.length} pages ok (${r.total_ms}ms)`); process.exit(0); })
    .catch(e => { console.error('auto-rewrite failed:', e.message); process.exit(1); });
}
