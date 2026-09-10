// lib/hook.js
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGitLog, commitAtom, GIT_FORMAT } from './mine.js';
import { existingIds, appendAtom, AtomRejected } from './journal.js';
import { parseConfigCodeRoots, parseConfigThemes, parseConfigFlows } from './config.js';
import { readSyncMode, writeAutoPending } from './syncstate.js';

// 落盘经 lib/journal.js 的校验闸门（S1）：appendAtom 只接受过 schema 的原子，机器来源（source:'hook'）
// 缺 status 落盘为 draft。若校验失败会抛 AtomRejected——本函数不吞它（那是引擎 bug），
// 但下面 CLI 入口整体 try/catch 兜底：post-commit hook 永不挡 commit。
// 兜底**不再全静默**（写入侧错误可见性）：校验器拒绝（AtomRejected）会向 stderr 打一行
// `lore: <message>`、退出码仍为 0。理由：commit 照常成功、journal 却什么都没有，
// 且没有任何东西留痕，就是「安静地不工作」——机器造出非法原子时没人会去看。
// 非 AtomRejected 的错误（git 不可用 / 配置坏了 …）仍静默：hook 是 best-effort，不该刷屏。
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
  } catch (e) {
    // best-effort: a hook must never block a commit
    // 例外（写入侧错误可见性，① 期遗留 B②）：校验器拒绝必须在 stderr 留下痕迹，
    // 否则「提交成功 + journal 空」这一对状态在 hook 里完全不可观测。
    // 只打一行、退出码仍为 0——post-commit 钩子绝不挡提交。
    if (e instanceof AtomRejected) console.error(`lore: ${e.message}`);
  }
  process.exit(0);
}
