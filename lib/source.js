import { readdirSync, realpathSync, lstatSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

export const CODE_EXT = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs',
  '.java', '.kt', '.rb', '.php', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.swift', '.scala', '.sh',
]);

export function resolveDeepSource(repoRoot, deepRoot, mod) {
  const absRoot = join(repoRoot, deepRoot);
  let entries = [];
  try { entries = readdirSync(absRoot, { withFileTypes: true }); } catch {}
  const candidates = entries
    .filter(entry => {
      const ext = extname(entry.name);
      return entry.isFile()
        && CODE_EXT.has(ext)
        && entry.name.slice(0, entry.name.length - ext.length) === mod;
    })
    .map(entry => relative(repoRoot, join(absRoot, entry.name)).replaceAll('\\', '/'))
    .sort();

  if (candidates.length === 1) return { status: 'ok', sourceFile: candidates[0] };
  if (candidates.length === 0) return { status: 'missing', candidates: [] };
  return { status: 'ambiguous', candidates };
}

function pathContains(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

function canonicalizeFromExisting(path) {
  let cursor = path;
  const suffix = [];
  while (true) {
    try {
      lstatSync(cursor);
      break;
    } catch (err) {
      if (err.code !== 'ENOENT') return null;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  try {
    const real = realpathSync(cursor);
    if (!lstatSync(real).isDirectory()) return null;
    return resolve(real, ...suffix);
  } catch { return null; }
}

function validDeepRoot(repoRoot, deepRoot, codeRoots) {
  const repoPath = resolve(repoRoot);
  const deepPath = resolve(repoPath, deepRoot);
  if (!pathContains(repoPath, deepPath)) return false;
  let repoReal;
  try { repoReal = realpathSync(repoPath); } catch { return false; }
  const deepReal = canonicalizeFromExisting(deepPath);
  if (!deepReal || !pathContains(repoReal, deepReal)) return false;
  return codeRoots.some(cr => {
    if (deepRoot !== cr && !deepRoot.startsWith(`${cr}/`)) return false;
    const codePath = resolve(repoPath, cr);
    if (!pathContains(repoPath, codePath) || !pathContains(codePath, deepPath)) return false;
    const codeReal = canonicalizeFromExisting(codePath);
    return codeReal !== null && pathContains(repoReal, codeReal) && pathContains(codeReal, deepReal);
  });
}

export function resolveConfiguredDeep(repoRoot, codeRoots, deep) {
  const entries = [], issues = [];
  for (const [deepRoot, { order = [] }] of Object.entries(deep)) {
    if (!validDeepRoot(repoRoot, deepRoot, codeRoots)) {
      issues.push({ kind: 'deep-root-invalid', deepRoot });
      continue;
    }
    for (const mod of order) {
      const result = resolveDeepSource(repoRoot, deepRoot, mod);
      if (result.status === 'ok') entries.push({ deepRoot, mod, sourceFile: result.sourceFile });
      else if (result.status === 'missing') issues.push({ kind: 'deep-source-missing', deepRoot, mod, expectedBase: `${deepRoot}/${mod}` });
      else issues.push({ kind: 'deep-source-ambiguous', deepRoot, mod, candidates: result.candidates });
    }
  }
  return { entries, issues };
}
