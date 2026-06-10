// lib/hook.js
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGitLog, commitAtom, GIT_FORMAT } from './mine.js';
import { existingIds, appendAtom } from './journal.js';
import { parseConfigCodeRoots, parseConfigThemes, parseConfigFlows } from './config.js';
import { readSyncMode } from './syncstate.js';

export function captureHead({ repoRoot, journalDir, codeRoots, themes = [], flows = [] }) {
  const stdout = execFileSync(
    'git',
    ['log', '-1', '--no-merges', `--pretty=format:${GIT_FORMAT}`, '--name-only', 'HEAD'],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
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
    if (readSyncMode(join(loreDir, '.state')) === 'manual') return { spawned: false, reason: 'manual' };
    if (!existsSync(join(loreDir, 'wiki', '.manifest.json'))) return { spawned: false };
    const syncJs = join(dirname(fileURLToPath(import.meta.url)), 'sync.js');
    const child = spawnFn(process.execPath, [syncJs, 'finalize', loreDir], { detached: true, stdio: 'ignore' });
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
