// lib/runner.js —— B2 自动重写运行器（spec 2026-06-10-lore-auto-rewrite）。
// LLM 只读（claude -p 白名单工具）、runner 写盘；质量门在写盘前；append-only 任务历史。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mermaidIssues } from './lint.js';
import { parseFrontmatter } from './manifest.js';
import {
  readSyncConfig, writeRunnerPid, clearRunnerPid, appendAutoRun, readRewriteRequests,
} from './syncstate.js';

// ticker 判定：静默期 / schedule 到点 / 防叠跑，全在这一个纯函数（可测）。
export function shouldRunAuto({ config, pendingTs, lastRunDate, now, runnerAlive }) {
  if (runnerAlive || config.mode !== 'auto') return { run: false, reason: null };
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

// 质量门（全机械，写盘前）：frontmatter 完整 → journal token/哨兵区在 → mermaid 全过 → 防截断。
const MERMAID_BLOCK_RE = /```mermaid\r?\n([\s\S]*?)```/g;
export function qualityGate(newText, oldText) {
  if (!newText || !newText.trim()) return { ok: false, reason: 'empty' };
  const { data } = parseFrontmatter(newText);
  if (!data.title || !data.summary) return { ok: false, reason: 'frontmatter missing title/summary' };
  if (!newText.includes('{{LORE_JOURNAL}}') && !newText.includes('LORE_JOURNAL:START')) {
    return { ok: false, reason: 'journal token/sentinel destroyed' };
  }
  let m;
  while ((m = MERMAID_BLOCK_RE.exec(newText)) !== null) {
    const issues = mermaidIssues(m[1]);
    if (issues.length) return { ok: false, reason: `mermaid: ${issues[0]}` };
  }
  if (newText.length < (oldText ?? '').length / 3) return { ok: false, reason: 'truncated (<1/3 of previous)' };
  return { ok: true };
}
