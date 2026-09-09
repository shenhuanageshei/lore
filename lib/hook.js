// lib/hook.js
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGitLog, commitAtom, GIT_FORMAT } from './mine.js';
import { existingIds, appendAtom } from './journal.js';
import { parseConfigCodeRoots, parseConfigThemes, parseConfigFlows } from './config.js';
import { readSyncMode, writeAutoPending } from './syncstate.js';

// 落盘经 lib/journal.js 的校验闸门（S1）：appendAtom 只接受过 schema 的原子，机器来源（source:'hook'）
// 缺 status 落盘为 draft。若校验失败会抛 AtomRejected——本函数不吞它（那是引擎 bug），
// 但下面 CLI 入口整体 try/catch 兜底：post-commit hook 永不挡 commit。
export function captureHead({ repoRoot, journalDir, codeRoots, themes = [], flows = [] }) {
  const stdout = execFileSync(
    'git',
    ['log', '-1', '--no-merges', `--pretty=format:${GIT_FORMAT}`, '--name-only', 'HEAD'],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  ).toString();
  const raws = parseGitLog(stdout);
  if (raws.length === 0) return { added: 0 };
  const atom = commitAtom(raws[0], codeRoots, 'hook', themes, flows);
  if (existingIds(journalDir).has(atom.id)) return { added: 0 };
  appendAtom(journalDir, atom);
  return { added: 1 };
}

// 提交后台机械刷新：已 sync 过（有 manifest）的 repo，detached spawn finalize，
// commit 立刻返回、后台刷决策史 / docs / 状态 / manifest / stale（零 LLM）。永不抛出。
export function maybeRefresh({ loreDir, spawnFn = spawn }) {
  try {
    const mode = readSyncMode(join(loreDir, '.state'));
    if (mode === 'manual') return { spawned: false, reason: 'manual' };
    if (mode === 'auto') writeAutoPending(join(loreDir, '.state'), new Date().toISOString());   // server ticker 据此判静默期；LLM 不在 hook 里跑
    if (!existsSync(join(loreDir, 'wiki', '.manifest.json'))) return { spawned: false };
    const syncJs = join(dirname(fileURLToPath(import.meta.url)), 'sync.js');
    const child = spawnFn(process.execPath, [syncJs, 'finalize', loreDir], { detached: true, stdio: 'ignore', windowsHide: true });   // windowsHide：Windows 下 detached 进程不弹控制台窗口
    child.unref();
    return { spawned: true };
  } catch {
    return { spawned: false };   // best-effort：绝不挡 commit
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const repoRoot = process.argv[2] ?? process.cwd();
    const loreDir = join(repoRoot, '.lore');
    const configPath = join(loreDir, 'config.yml');
    const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
    const codeRoots = parseConfigCodeRoots(configText);
    const themes = parseConfigThemes(configText);
    const flows = parseConfigFlows(configText);
    captureHead({ repoRoot, journalDir: join(loreDir, 'journal'), codeRoots, themes, flows });
    maybeRefresh({ loreDir });
  } catch {
    // best-effort: a hook must never block a commit
  }
  process.exit(0);
}
