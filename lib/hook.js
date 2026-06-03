// lib/hook.js
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGitLog, commitAtom, GIT_FORMAT } from './mine.js';
import { existingIds, appendAtom } from './journal.js';
import { parseConfigCodeRoots, parseConfigThemes } from './config.js';

export function captureHead({ repoRoot, journalDir, codeRoots, themes = [] }) {
  const stdout = execFileSync(
    'git',
    ['log', '-1', '--no-merges', `--pretty=format:${GIT_FORMAT}`, '--name-only', 'HEAD'],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
  ).toString();
  const raws = parseGitLog(stdout);
  if (raws.length === 0) return { added: 0 };
  const atom = commitAtom(raws[0], codeRoots, 'hook', themes);
  if (existingIds(journalDir).has(atom.id)) return { added: 0 };
  appendAtom(journalDir, atom);
  return { added: 1 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const repoRoot = process.argv[2] ?? process.cwd();
    const loreDir = join(repoRoot, '.lore');
    const configPath = join(loreDir, 'config.yml');
    const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
    const codeRoots = parseConfigCodeRoots(configText);
    const themes = parseConfigThemes(configText);
    captureHead({ repoRoot, journalDir: join(loreDir, 'journal'), codeRoots, themes });
  } catch {
    // best-effort: a hook must never block a commit
  }
  process.exit(0);
}
