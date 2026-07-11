import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODE_EXT, resolveDeepSource } from '../lib/source.js';

function tmpRepo() { return mkdtempSync(join(tmpdir(), 'lore-source-')); }

test('CODE_EXT contains the code extensions used by deep discovery', () => {
  assert.deepEqual([...CODE_EXT], [
    '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs',
    '.java', '.kt', '.rb', '.php', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.swift', '.scala', '.sh',
  ]);
});

test('resolveDeepSource returns the unique supported direct file with forward slashes', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'src', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'src', 'pkg', 'worker.py'), 'x');
    writeFileSync(join(root, 'src', 'pkg', 'worker.md'), 'x');
    mkdirSync(join(root, 'src', 'pkg', 'worker.js'));
    assert.deepEqual(resolveDeepSource(root, 'src/pkg', 'worker'), {
      status: 'ok', sourceFile: 'src/pkg/worker.py',
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveDeepSource reports missing without searching nested directories', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'lib', 'nested'), { recursive: true });
    writeFileSync(join(root, 'lib', 'nested', 'hook.js'), 'x');
    assert.deepEqual(resolveDeepSource(root, 'lib', 'hook'), {
      status: 'missing', candidates: [],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveDeepSource reports sorted candidates for ambiguous supported files', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'lib'));
    writeFileSync(join(root, 'lib', 'sync.ts'), 'x');
    writeFileSync(join(root, 'lib', 'sync.js'), 'x');
    assert.deepEqual(resolveDeepSource(root, 'lib', 'sync'), {
      status: 'ambiguous', candidates: ['lib/sync.js', 'lib/sync.ts'],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
