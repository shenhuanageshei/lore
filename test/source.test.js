import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODE_EXT, parseDeepEntry, resolveConfiguredDeep, resolveDeepSource, resolveThemeDeepSource, resolveThemeDeepSources, resolveConfiguredThemeDeep } from '../lib/source.js';
import { parseConfigThemeDeep } from '../lib/config.js';

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

test('resolveThemeDeepSource: literal file resolves to slash-normalized repo path', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'mal_analyze', 'sidecar'), { recursive: true });
    writeFileSync(join(root, 'mal_analyze', 'sidecar', 'probe.py'), 'x');
    assert.deepEqual(resolveThemeDeepSource(root, 'mal_analyze/sidecar/probe.py'), {
      status: 'ok', sourceFiles: ['mal_analyze/sidecar/probe.py'],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveThemeDeepSource: literal missing → missing with matches []', () => {
  const root = tmpRepo();
  try {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    assert.deepEqual(resolveThemeDeepSource(root, 'pkg/nope.py'), { status: 'missing', matches: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveThemeDeepSource: absolute / drive / .. paths → invalid', () => {
  const root = tmpRepo();
  try {
    for (const entry of ['C:/x/y.py', '/etc/passwd', '../outside.py', 'a/../../b.py']) {
      assert.equal(resolveThemeDeepSource(root, entry).status, 'invalid', entry);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// git 仓库：glob 展开尊重 .gitignore；零匹配 → missing
function gitRepoWith(files, ignoreLines = []) {
  const root = tmpRepo();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  if (ignoreLines.length) writeFileSync(join(root, '.gitignore'), ignoreLines.join('\n') + '\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  return root;
}

test('resolveThemeDeepSource: glob expands via git, excludes gitignored files', () => {
  const root = gitRepoWith({
    'server/analyst/a.py': 'x',
    'server/analyst/b.py': 'x',
    'server/analyst/nested/c.py': 'x',
    'server/analyst/ignored.py': 'x',
  }, ['server/analyst/ignored.py']);
  try {
    const r = resolveThemeDeepSource(root, 'server/analyst/**');
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.sourceFiles, ['server/analyst/a.py', 'server/analyst/b.py', 'server/analyst/nested/c.py']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveThemeDeepSource: glob no match → missing', () => {
  const root = gitRepoWith({ 'f.txt': 'x' });
  try {
    assert.deepEqual(resolveThemeDeepSource(root, 'server/**'), { status: 'missing', matches: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveThemeDeepSource: glob budget overflow → invalid (configuration diagnostic)', () => {
  const many = {};
  for (let k = 0; k < 250; k++) many[`gen/f${k}.py`] = 'x';
  const root = gitRepoWith(many);
  try {
    const r = resolveThemeDeepSource(root, 'gen/**');
    assert.equal(r.status, 'invalid');
    assert.match(r.reason, /expanded to 250 files/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveThemeDeepSources: aggregates, dedupes, sorts across entries', () => {
  const root = gitRepoWith({ 'pkg/a.py': 'x', 'pkg/b.py': 'x' });
  try {
    assert.deepEqual(resolveThemeDeepSources(root, ['pkg/b.py', 'pkg/a.py', 'pkg/b.py']), {
      status: 'ok', sourceFiles: ['pkg/a.py', 'pkg/b.py'],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveThemeDeepSources: first failing entry short-circuits', () => {
  const root = gitRepoWith({ 'pkg/a.py': 'x' });
  try {
    const r = resolveThemeDeepSources(root, ['pkg/a.py', 'pkg/missing.py']);
    assert.equal(r.status, 'missing');
    assert.equal(r.entry, 'pkg/missing.py');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveConfiguredThemeDeep: valid config → children with deduped sorted sourceFiles', () => {
  const root = gitRepoWith({ 'sidecar/probe.py': 'x', 'sidecar/assoc.py': 'x' });
  try {
    const themes = [{ id: 'sidecar-config-decryption', match: [] }];
    const themeDeep = parseConfigThemeDeep(`axes:
  theme:
    deep:
      sidecar-config-decryption:
        发现与关联:
          - { id: discovery-association, sources: [sidecar/assoc.py, sidecar/probe.py] }
`);
    const r = resolveConfiguredThemeDeep(root, themes, themeDeep);
    assert.deepEqual(r.children, [{
      parent: 'sidecar-config-decryption', id: 'discovery-association', group: '发现与关联',
      sources: ['sidecar/assoc.py', 'sidecar/probe.py'], sourceFiles: ['sidecar/assoc.py', 'sidecar/probe.py'],
    }]);
    assert.deepEqual(r.issues, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveConfiguredThemeDeep: missing parent / duplicate child / empty sources / shared source', () => {
  const root = gitRepoWith({ 'a.py': 'x', 'b.py': 'x' });
  try {
    const themes = [{ id: 'p', match: [] }];
    const themeDeep = parseConfigThemeDeep(`axes:
  theme:
    deep:
      p:
        g:
          - { id: c1, sources: [a.py] }
          - { id: c1, sources: [b.py] }
          - { id: c2, sources: [] }
          - { id: c3, sources: [a.py] }
      ghost:
        g:
          - { id: c4, sources: [a.py] }
`);
    const r = resolveConfiguredThemeDeep(root, themes, themeDeep);
    assert.deepEqual(r.children.map(c => c.id), ['c1', 'c3']);        // c2 空 sources、c4 父缺失 → 不进 children；c1/c3 共享 a.py 都保留
    const kinds = r.issues.map(i => i.kind);
    assert.ok(kinds.includes('theme-deep-id-collision'));
    assert.ok(kinds.includes('theme-deep-sources-empty'));
    assert.ok(kinds.includes('theme-deep-parent-missing'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveConfiguredThemeDeep: symlink/junction outside repo → outside-repo', (t) => {
  const root = tmpRepo();
  const outside = tmpRepo();
  try {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    mkdirSync(join(outside, 'pkg'), { recursive: true });
    writeFileSync(join(outside, 'pkg', 'x.py'), 'x');
    try {
      if (process.platform === 'win32') {
        execFileSync('cmd', ['/c', 'mklink', '/J', join(root, 'pkg', 'link'), outside], { stdio: 'pipe' });
      } else {
        execFileSync('ln', ['-s', outside, join(root, 'pkg', 'link')], { stdio: 'pipe' });
      }
    } catch { t.skip('symlink/junction unavailable'); return; }
    const r = resolveThemeDeepSource(root, 'pkg/link/pkg/x.py');
    assert.equal(r.status, 'outside-repo');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('resolveThemeDeepSource: glob preserves non-ASCII filenames (core.quotePath=false)', () => {
  const root = gitRepoWith({ 'pkg/文档.py': 'x', 'pkg/b.py': 'x' });
  try {
    const r = resolveThemeDeepSource(root, 'pkg/**');
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.sourceFiles, ['pkg/b.py', 'pkg/文档.py']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveThemeDeepSource: glob containing an escaping symlink → outside-repo', (t) => {
  const root = tmpRepo();
  const outside = tmpRepo();
  try {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'a.py'), 'x');
    writeFileSync(join(outside, 'evil.py'), 'x');
    try {
      symlinkSync(join(outside, 'evil.py'), join(root, 'pkg', 'evil.py'), 'file');
    } catch { t.skip('file symlink unavailable'); return; }
    // git must track the symlink as a symlink for the escape to be visible
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    execFileSync('git', ['config', 'core.symlinks', 'true'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
    const r = resolveThemeDeepSource(root, 'pkg/**');
    assert.equal(r.status, 'outside-repo');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('resolveThemeDeepSources: aggregate child budget overflow → invalid (sum across entries)', () => {
  const many = {};
  for (let k = 0; k < 150; k++) { many[`d1/f${k}.py`] = 'x'; many[`d2/f${k}.py`] = 'x'; }
  const root = gitRepoWith(many);
  try {
    const r = resolveThemeDeepSources(root, ['d1/**', 'd2/**']);
    assert.equal(r.status, 'invalid');
    assert.equal(r.entry, '');
    assert.match(r.reason, /child expanded to 300 files/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
