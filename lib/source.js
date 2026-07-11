import { readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

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
