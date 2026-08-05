import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODE_EXT, parseDeepEntry, resolveConfiguredDeep, resolveDeepSource } from '../lib/source.js';

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

test('resolveDeepSource: explicit pin resolves the exact file among same-base siblings', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'e2e_smoke.py'), 'DRIVER = 1\n');
    writeFileSync(join(root, 'scripts', 'e2e_smoke.sh'), 'exec python e2e_smoke.py\n');
    assert.deepEqual(resolveDeepSource(root, 'scripts', 'e2e_smoke.sh'), {
      status: 'ok', sourceFile: 'scripts/e2e_smoke.sh',
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveDeepSource: explicit pin missing → missing with expected path (no bare fallback)', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'e2e_smoke.py'), 'DRIVER = 1\n');
    assert.deepEqual(resolveDeepSource(root, 'scripts', 'e2e_smoke.sh'), {
      status: 'missing', candidates: [], expected: 'scripts/e2e_smoke.sh',
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('parseDeepEntry: bare → identity, explicit file → base id, edge cases', () => {
  assert.deepEqual(parseDeepEntry('e2e_smoke'), { id: 'e2e_smoke', explicit: false });
  assert.deepEqual(parseDeepEntry('e2e_smoke.sh'), { id: 'e2e_smoke', explicit: true });
  assert.deepEqual(parseDeepEntry('e2e_smoke.py'), { id: 'e2e_smoke', explicit: true });
  assert.deepEqual(parseDeepEntry('sync.tsx'), { id: 'sync', explicit: true });
  assert.deepEqual(parseDeepEntry('a.b.js'), { id: 'a.b', explicit: true });
  assert.deepEqual(parseDeepEntry('.py'), { id: '.py', explicit: false });   // 全扩展名 → extname('') → 裸名
  assert.deepEqual(parseDeepEntry('e2e_smoke.PY'), { id: 'e2e_smoke.PY', explicit: false });  // 大写扩展名不在 CODE_EXT
});

test('resolveConfiguredDeep: explicit pin → canonical mod + entry field, no issues', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'e2e_smoke.py'), 'DRIVER = 1\n');
    writeFileSync(join(root, 'scripts', 'e2e_smoke.sh'), 'exec python e2e_smoke.py\n');
    assert.deepEqual(resolveConfiguredDeep(root, ['scripts'], {
      scripts: { order: ['e2e_smoke.sh'], groups: [] },
    }), {
      entries: [{ deepRoot: 'scripts', entry: 'e2e_smoke.sh', mod: 'e2e_smoke', sourceFile: 'scripts/e2e_smoke.sh' }],
      issues: [],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveConfiguredDeep: bare + explicit same base file → collision issue, first wins', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'e2e_smoke.py'), 'DRIVER = 1\n');   // 只有这一个文件
    assert.deepEqual(resolveConfiguredDeep(root, ['scripts'], {
      scripts: { order: ['e2e_smoke', 'e2e_smoke.py'], groups: [] },
    }), {
      entries: [{ deepRoot: 'scripts', entry: 'e2e_smoke', mod: 'e2e_smoke', sourceFile: 'scripts/e2e_smoke.py' }],
      issues: [{ kind: 'deep-source-collision', deepRoot: 'scripts', mod: 'e2e_smoke', entry: 'e2e_smoke', conflictEntry: 'e2e_smoke.py' }],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveConfiguredDeep: two explicit pins same base → collision preserves both raw entries', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'e2e_smoke.py'), 'DRIVER = 1\n');
    writeFileSync(join(root, 'scripts', 'e2e_smoke.sh'), 'exec python e2e_smoke.py\n');
    assert.deepEqual(resolveConfiguredDeep(root, ['scripts'], {
      scripts: { order: ['e2e_smoke.py', 'e2e_smoke.sh'], groups: [] },
    }), {
      entries: [{ deepRoot: 'scripts', entry: 'e2e_smoke.py', mod: 'e2e_smoke', sourceFile: 'scripts/e2e_smoke.py' }],
      issues: [{ kind: 'deep-source-collision', deepRoot: 'scripts', mod: 'e2e_smoke', entry: 'e2e_smoke.py', conflictEntry: 'e2e_smoke.sh' }],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveConfiguredDeep: explicit missing → issue with explicit flag + expected', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'e2e_smoke.py'), 'DRIVER = 1\n');
    assert.deepEqual(resolveConfiguredDeep(root, ['scripts'], {
      scripts: { order: ['e2e_smoke.sh'], groups: [] },
    }), {
      entries: [],
      issues: [{ kind: 'deep-source-missing', deepRoot: 'scripts', mod: 'e2e_smoke.sh', explicit: true, expected: 'scripts/e2e_smoke.sh' }],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveConfiguredDeep: duplicate identical entry → silently deduped (no self-collision)', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'e2e_smoke.sh'), 'exec python e2e_smoke.py\n');
    assert.deepEqual(resolveConfiguredDeep(root, ['scripts'], {
      scripts: { order: ['e2e_smoke.sh', 'e2e_smoke.sh'], groups: [] },
    }), {
      entries: [{ deepRoot: 'scripts', entry: 'e2e_smoke.sh', mod: 'e2e_smoke', sourceFile: 'scripts/e2e_smoke.sh' }],
      issues: [],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveDeepSource: explicit pin whose name is a directory → missing (isFile guard)', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'scripts', 'e2e_smoke.sh'), { recursive: true });   // 目录名叫 e2e_smoke.sh
    assert.deepEqual(resolveDeepSource(root, 'scripts', 'e2e_smoke.sh'), {
      status: 'missing', candidates: [], expected: 'scripts/e2e_smoke.sh',
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
