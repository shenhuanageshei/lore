// test/lint.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { lintOrphans, lintMissing, lintStale, lintUnfolded, lint, lintMissingDiagram, lintMissingMechanism, lintDeepConfig, lintThemeDeepConfig, lintThemeDeepPages } from '../lib/lint.js';
import { init } from '../lib/init.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-lint-')); }

test('lintOrphans: page ids not matching any code_root last-segment', () => {
  assert.deepEqual(lintOrphans(['lib', 'gone'], ['lib', 'src/pkg']), ['gone']);
  assert.deepEqual(lintOrphans(['lib', 'pkg'], ['lib', 'src/pkg']), []);   // pkg ← src/pkg
});

test('lintMissing: code_root last-segments with no page', () => {
  assert.deepEqual(lintMissing(['lib'], ['lib', 'src/pkg']), ['pkg']);     // pkg page missing
  assert.deepEqual(lintMissing(['lib', 'pkg'], ['lib', 'src/pkg']), []);
});

test('lintStale: pages whose code_sha != current → behind via countSince', () => {
  const pages = [
    { id: 'a', code_sha: 'old1234' },
    { id: 'b', code_sha: 'cur5678' },   // == current → not stale
    { id: 'c', code_sha: '' },           // no sha → skipped
  ];
  const countSince = sha => (sha === 'old1234' ? 3 : 0);
  assert.deepEqual(lintStale(pages, 'cur5678', countSince), [
    { page: 'a', code_sha: 'old1234', behind: 3 },
  ]);
});

function gitRepo() {
  const root = tmpDir();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  writeFileSync(join(root, 'f.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'c1'], { cwd: root });
  return root;
}
function page(loreDir, id, codeSha) {
  const dir = join(loreDir, 'wiki', 'component');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), `---\ntitle: ${id}\ncode_sha: ${codeSha}\n---\n# ${id}\n\n\`\`\`mermaid\nflowchart TD\n  A --> B\n\`\`\`\n`);
}

test('lint orchestrator reports stale + orphan + missing', () => {
  const root = gitRepo();   // has commit c1
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    const sha1 = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
    // a second commit so HEAD advances past sha1 (sha1 is now 1 behind)
    writeFileSync(join(root, 'g.txt'), 'y');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'c2'], { cwd: root });

    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib, site]\n');
    page(lore, 'lib', sha1);    // stale: page stamped at c1, HEAD now at c2 → behind 1
    page(lore, 'gone', execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim());   // orphan, current sha → not stale
    // 'site' code_root has no page → missing

    const r = lint({ loreDir: lore });
    assert.deepEqual(r.stale.map(s => s.page), ['lib']);
    assert.equal(r.stale[0].behind, 1);          // exactly 1 commit behind (real reachable sha)
    assert.deepEqual(r.orphans, ['gone']);
    assert.deepEqual(r.missing, ['site']);
    assert.equal(r.clean, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lint: clean repo → clean:true', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    const cur = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib]\n');
    page(lore, 'lib', cur);   // current sha, matches root → no drift
    const r = lint({ loreDir: lore });
    assert.deepEqual(r, { stale: [], orphans: [], missing: [], unfolded: [], mermaid: [], missingDiagram: [], missingMechanism: [], deepConfig: [], themeDeep: [], themeDeepWarnings: [], clean: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: prints report and exits 0 (drift)', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib, site]\n');
    page(lore, 'gone', '');   // orphan
    const out = execFileSync('node', ['lib/lint.js', lore], { cwd: process.cwd() }).toString();
    assert.match(out, /orphans/);
    assert.match(out, /gone/);
    assert.match(out, /missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: clean repo prints clean and exits 0', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    const cur = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib]\n');
    page(lore, 'lib', cur);
    const out = execFileSync('node', ['lib/lint.js', lore], { cwd: process.cwd() }).toString();
    assert.match(out, /clean/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('integration: sync then a new commit makes the page stale → lint reports it', () => {
  const root = gitRepo();
  try {
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'a.js'), 'export const x = 1;');
    init({ repoRoot: root, srcSiteDir: join(process.cwd(), 'site') });
    // 本测试只验证 finalize→commit→lint 的 stale 检测，不涉及 hook。移除 init 装的 post-commit
    // hook —— 否则下面的 commit 会触发 hook 的 detached finalize（manifest 已存在），其后台进程
    // 在 Windows 上持有临时目录句柄，与 finally 的 rmSync 竞态报 EPERM。
    rmSync(join(root, '.git', 'hooks', 'post-commit'), { force: true });
    const lore = join(root, '.lore');
    const compDir = join(lore, 'wiki', 'component');
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, 'lib.md'), `---\ntitle: Lib\nsummary: c\n---\n# component: Lib\n\n## Current architecture\n\nx\n\n## Decision history\n\n{{LORE_JOURNAL}}\n\n## Cross-links\n\n- [[x]]\n`);
    execFileSync('node', ['lib/sync.js', 'finalize', lore], { cwd: process.cwd() });   // stamps page code_sha = current HEAD
    assert.equal(lint({ loreDir: lore }).stale.length, 0);   // page sha == HEAD → not stale
    // a new commit moves HEAD forward → page is now behind
    writeFileSync(join(root, 'lib', 'b.js'), 'export const y = 2;');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'add b'], { cwd: root });
    const r = lint({ loreDir: lore });
    assert.deepEqual(r.stale.map(s => s.page), ['lib']);
    assert.ok(r.stale[0].behind >= 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function wikiPage(loreDir, axis, id, frontmatter, body) {
  const dir = join(loreDir, 'wiki', axis);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), `---\n${frontmatter}\n---\n${body}`);
}

test('lintUnfolded: finalized page (has code_sha) still holding a literal token → flagged', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    wikiPage(lore, 'component', 'lib', 'title: Lib\ncode_sha: abc1234', '# Lib\n\n## Decision history\n\n{{LORE_JOURNAL}}\n');
    assert.deepEqual(lintUnfolded(join(lore, 'wiki')), ['component/lib.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lintUnfolded: finalized page without token → not flagged', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    wikiPage(lore, 'component', 'lib', 'title: Lib\ncode_sha: abc1234', '# Lib\n\nclean body\n');
    assert.deepEqual(lintUnfolded(join(lore, 'wiki')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lintUnfolded: pre-sync page (no code_sha) with token → not flagged (legit pre-fold state)', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    wikiPage(lore, 'component', 'lib', 'title: Lib', '# Lib\n\n{{LORE_JOURNAL}}\n');
    assert.deepEqual(lintUnfolded(join(lore, 'wiki')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lintUnfolded: scans theme + flow axes too', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    wikiPage(lore, 'theme', 'quality', 'title: Quality\ncode_sha: abc1234', '# Quality\n\n{{LORE_JOURNAL}}\n');
    wikiPage(lore, 'flow', 'pipe', 'title: Pipe\ncode_sha: abc1234', '# Pipe\n\nclean\n');
    assert.deepEqual(lintUnfolded(join(lore, 'wiki')), ['theme/quality.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lint orchestrator flags unfolded (finalized page with literal token) → clean:false', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    const cur = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib]\n');
    // current sha → not stale; matches root → not orphan/missing; but carries a literal token
    wikiPage(lore, 'component', 'lib', `title: Lib\ncode_sha: ${cur}`, '# Lib\n\n{{LORE_JOURNAL}}\n');
    const r = lint({ loreDir: lore });
    assert.deepEqual(r.unfolded, ['component/lib.md']);
    assert.equal(r.clean, false);
    assert.deepEqual(r.stale, []);
    assert.deepEqual(r.orphans, []);
    assert.deepEqual(r.missing, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: reports unfolded literal token and exits 0', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    const cur = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [lib]\n');
    wikiPage(lore, 'component', 'lib', `title: Lib\ncode_sha: ${cur}`, '# Lib\n\n{{LORE_JOURNAL}}\n');
    const out = execFileSync('node', ['lib/lint.js', lore], { cwd: process.cwd() }).toString();
    assert.match(out, /unfolded/);
    assert.match(out, /component\/lib\.md/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- 实扫暴露的两个误报修复 ---

test('lintUnfolded: 哨兵区内/inline code span 里的字面 token 引用不算残留', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    // 决策史哨兵区内提到 token（commit message 字面引用）→ 不报
    wikiPage(lore, 'component', 'a', 'title: A\ncode_sha: x',
      '# A\n\n<!-- LORE_JOURNAL:START -->\n- **fix: fold {{LORE_JOURNAL}} exactly once** (abc, 2026-06-04)\n<!-- LORE_JOURNAL:END -->\n');
    // 正文反引号 code span 引用 → 不报
    wikiPage(lore, 'component', 'b', 'title: B\ncode_sha: x',
      '# B\n\n机制：`{{LORE_JOURNAL}}` token 在首次 finalize 跳变。\n');
    // 裸 token（真残留）→ 报
    wikiPage(lore, 'component', 'c', 'title: C\ncode_sha: x', '# C\n\n{{LORE_JOURNAL}}\n');
    assert.deepEqual(lintUnfolded(join(lore, 'wiki')), ['component/c.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lintOrphans/lintMissing: deep 页不是孤儿、deep 缺页要报', () => {
  // deep 声明的子模块页是合法 component 页
  assert.deepEqual(lintOrphans(['lib', 'sync', 'rogue'], ['lib'], { lib: { order: ['sync'], groups: [] } }), ['rogue']);
  assert.deepEqual(lintMissing(['lib'], ['lib'], { lib: { order: ['sync'], groups: [] } }), ['sync']);
  // 不传 deep → 行为同旧（向后兼容）
  assert.deepEqual(lintOrphans(['lib', 'sync'], ['lib']), ['sync']);
});

test('lintUnfolded: finalized page with localized decision-history heading and literal token → flagged', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    wikiPage(lore, 'component', 'lib', 'title: Lib\ncode_sha: abc1234', '# Lib\n\n## 决策历史\n\n{{LORE_JOURNAL}}\n');
    assert.deepEqual(lintUnfolded(join(lore, 'wiki')), ['component/lib.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lintDeepConfig: accepts configured code roots and nested roots', () => {
  const root = tmpDir();
  try {
    mkdirSync(join(root, 'mal_analyze', 'native_enrichment'), { recursive: true });
    writeFileSync(join(root, 'mal_analyze', 'cli.py'), '');
    writeFileSync(join(root, 'mal_analyze', 'native_enrichment', 'startup_paths.py'), '');
    assert.deepEqual(lintDeepConfig(root, ['mal_analyze'], {
      mal_analyze: { order: ['cli'], groups: [] },
      'mal_analyze/native_enrichment': { order: ['startup_paths'], groups: [] },
    }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lintDeepConfig: rejects bare subpackages and similar prefixes', () => {
  const root = tmpDir();
  try {
    mkdirSync(join(root, 'mal_analyze'), { recursive: true });
    assert.deepEqual(lintDeepConfig(root, ['mal_analyze'], {
      native_enrichment: { order: ['startup_paths'], groups: [] },
      'mal_analyze_extra/sub': { order: ['x'], groups: [] },
    }), [
      { kind: 'invalid-root', deepRoot: 'native_enrichment', message: 'deep root must equal a code_root or be its child' },
      { kind: 'invalid-root', deepRoot: 'mal_analyze_extra/sub', message: 'deep root must equal a code_root or be its child' },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lintDeepConfig: reports missing and ambiguous direct sources', () => {
  const root = tmpDir();
  try {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'entry.py'), '');
    writeFileSync(join(root, 'pkg', 'entry.js'), '');
    assert.deepEqual(lintDeepConfig(root, ['pkg'], {
      pkg: { order: ['absent', 'entry', 'missing.sh'], groups: [] },
    }), [
      { kind: 'missing-source', deepRoot: 'pkg', mod: 'absent', message: 'no supported source file found for pkg/absent' },
      { kind: 'ambiguous-source', deepRoot: 'pkg', mod: 'entry', candidates: ['pkg/entry.js', 'pkg/entry.py'], message: 'multiple supported source files found for pkg/entry — pin one: entry.js / entry.py' },
      { kind: 'missing-source', deepRoot: 'pkg', mod: 'missing.sh', expected: 'pkg/missing.sh', message: 'no supported source file found for pkg/missing.sh (pinned file)' },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('invalid deep roots do not legitimize their module ids', () => {
  const deep = { native_enrichment: { order: ['startup_paths'], groups: [] } };
  assert.deepEqual(lintOrphans(['startup_paths'], ['mal_analyze'], deep), ['startup_paths']);
});

test('valid deep roots keep configured module ids legal when source resolution fails', () => {
  const root = tmpDir();
  try {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    const deep = { pkg: { order: ['absent'], groups: [] } };
    assert.deepEqual(lintOrphans(['absent'], ['pkg'], deep, root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legalIds normalizes explicit file entries to base ids', () => {
  const root = tmpDir();
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'e2e_smoke.py'), '');
    writeFileSync(join(root, 'scripts', 'e2e_smoke.sh'), '');
    const deep = { scripts: { order: ['e2e_smoke.sh'], groups: [] } };
    assert.deepEqual(lintOrphans(['e2e_smoke'], ['scripts'], deep, root), []);   // 页 id 是基名 → 不孤儿
    assert.deepEqual(lintMissing(['scripts', 'e2e_smoke'], ['scripts'], deep, root), []);   // 基名页 + code_root 页都在 → 不报缺
    assert.deepEqual(lintMissing(['scripts'], ['scripts'], deep, root), ['e2e_smoke']);   // 页真缺时按基名报
    // 纯配置分支（无 repoRoot，不碰 fs）
    assert.deepEqual(lintOrphans(['e2e_smoke'], ['scripts'], deep), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lintDeepConfig: two explicit pins same base → collision-source diagnostic renders both raw entries', () => {
  const root = tmpDir();
  try {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'entry.py'), '');
    writeFileSync(join(root, 'pkg', 'entry.sh'), '');
    assert.deepEqual(lintDeepConfig(root, ['pkg'], {
      pkg: { order: ['entry.py', 'entry.sh'], groups: [] },
    }), [
      { kind: 'collision-source', deepRoot: 'pkg', mod: 'entry', conflictEntry: 'entry.sh', message: '"entry.py" and "entry.sh" resolve to same page id — keep one' },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lintMissingMechanism checks the base-id page for explicit entries', () => {
  const root = tmpDir();
  try {
    mkdirSync(join(root, 'wiki', 'component'), { recursive: true });
    const deep = { scripts: { order: ['e2e_smoke.sh'], groups: [] } };
    writeFileSync(join(root, 'wiki', 'component', 'e2e_smoke.md'),
      '---\ntitle: e2e_smoke\nsummary: s\n---\n# component: e2e_smoke\n\n## 机制详解\n\nok\n');
    assert.deepEqual(lintMissingMechanism(join(root, 'wiki'), deep), []);
    writeFileSync(join(root, 'wiki', 'component', 'e2e_smoke.md'),
      '---\ntitle: e2e_smoke\nsummary: s\n---\n# component: e2e_smoke\n\nprose\n');
    assert.deepEqual(lintMissingMechanism(join(root, 'wiki'), deep), ['component/e2e_smoke.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lint deepConfig diagnostics make lint unclean and appear in CLI output', () => {
  const root = gitRepo();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(root, 'mal_analyze'), { recursive: true });
    mkdirSync(lore, { recursive: true });
    writeFileSync(join(lore, 'config.yml'), '    code_roots: [mal_analyze]\n    deep:\n      native_enrichment: [startup_paths]\n');
    const result = lint({ loreDir: lore });
    assert.equal(result.deepConfig[0].kind, 'invalid-root');
    assert.equal(result.clean, false);
    const out = execFileSync('node', ['lib/lint.js', lore], { cwd: process.cwd() }).toString();
    assert.match(out, /deep-config \(1\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- mermaid 语法启发式校验（第五检）---
import { mermaidIssues, lintMermaid } from '../lib/lint.js';

test('mermaidIssues: 合法图 → []', () => {
  assert.deepEqual(mermaidIssues('flowchart LR\n  a["A 标签"] --> b{"判断?"}\n  b -->|yes| c'), []);
  assert.deepEqual(mermaidIssues('stateDiagram-v2\n  [*] --> seed\n  seed --> 保持: hash 不变'), []);
  assert.deepEqual(mermaidIssues('graph TD\n  a --> b'), []);                  // graph 作图类型合法
  assert.deepEqual(mermaidIssues('flowchart LR\n  a -- yes --> b'), []);       // 带文本老语法箭头合法
});

test('mermaidIssues: 保留字节点 id（实测踩过 graph[...]）', () => {
  const issues = mermaidIssues('flowchart LR\n  finalize --> graph[".graph.json"]');
  assert.equal(issues.length, 1);
  assert.match(issues[0], /reserved id.*graph/);
  assert.match(mermaidIssues('flowchart TD\n  end["收尾"] --> x')[0], /reserved id.*end/);
});

test('mermaidIssues: 断箭头（实测踩过 == >）', () => {
  assert.match(mermaidIssues('flowchart LR\n  a ==立刻返回== > b')[0], /broken arrow/);
  assert.match(mermaidIssues('flowchart LR\n  a -- > b')[0], /broken arrow/);
});

test('mermaidIssues: 未知图类型 / 引号不配对', () => {
  assert.match(mermaidIssues('flowchat LR\n  a --> b')[0], /unknown diagram type/);
  assert.match(mermaidIssues('flowchart LR\n  a["未闭合 --> b')[0], /unbalanced quote/);
});

test('lintMermaid: 扫页报坏图（页名+第几个图+问题）；好页不报', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    wikiPage(lore, 'component', 'good', 'title: G', '# G\n\n```mermaid\nflowchart LR\n  a --> b\n```\n');
    wikiPage(lore, 'component', 'bad', 'title: B', '# B\n\n```mermaid\nflowchart LR\n  x --> graph["g"]\n```\n');
    const out = lintMermaid(join(lore, 'wiki'));
    assert.equal(out.length, 1);
    assert.equal(out[0].page, 'component/bad.md');
    assert.equal(out[0].diagram, 1);
    assert.match(out[0].issue, /reserved id/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lintMissingDiagram: component/flow 缺 mermaid → 报；有图不报；翻译 sidecar 跳过', () => {
  const lore = tmpDir();
  try {
    const wiki = join(lore, 'wiki');
    mkdirSync(join(wiki, 'component'), { recursive: true });
    mkdirSync(join(wiki, 'flow'), { recursive: true });
    writeFileSync(join(wiki, 'component', 'good.md'), '# x\n\n```mermaid\nflowchart TD\n  A --> B\n```\n');
    writeFileSync(join(wiki, 'component', 'bad.md'), '# x\n\n没有架构图\n');
    writeFileSync(join(wiki, 'component', 'bad.en.md'), '# x\n\n翻译 sidecar 不检测\n');
    writeFileSync(join(wiki, 'flow', 'f.md'), '# f\n\n无图\n');
    const out = lintMissingDiagram(wiki).sort();
    assert.deepEqual(out, ['component/bad.md', 'flow/f.md']);   // good 有图、.en 翻译跳过
  } finally { rmSync(lore, { recursive: true, force: true }); }
});

test('lintMissingMechanism: 深度页缺「## 机制详解」→ 报；有档不报；非深度页（不在 deep）不检测', () => {
  const lore = tmpDir();
  try {
    const wiki = join(lore, 'wiki');
    mkdirSync(join(wiki, 'component'), { recursive: true });
    const deep = { lib: { order: ['sync', 'runner'], groups: [] } };
    writeFileSync(join(wiki, 'component', 'sync.md'), '# sync\n\n## 概览\n\nx\n\n## 机制详解\n\n<details>...</details>\n');
    writeFileSync(join(wiki, 'component', 'runner.md'), '# runner\n\n## 概览\n\n只有概览，没机制档\n');
    writeFileSync(join(wiki, 'component', 'lib.md'), '# lib\n\n## 概览\n\n鸟瞰页不在 deep order，不检测\n');
    const out = lintMissingMechanism(wiki, deep);
    assert.deepEqual(out, ['component/runner.md']);   // sync 有档、runner 缺档、lib 非深度页不查
  } finally { rmSync(lore, { recursive: true, force: true }); }
});

test('lintThemeDeepConfig maps resolution issues to actionable diagnostics', () => {
  const root = tmpDir();
  try {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'a.py'), 'x');
    const themes = [{ id: 'p', match: [] }];
    const themeDeep = { parents: ['p', 'ghost'], children: [
      { parent: 'p', id: 'c1', group: '', sources: ['pkg/a.py'] },
      { parent: 'p', id: 'c1', group: '', sources: ['pkg/b.py'] },        // 父内重复
      { parent: 'p', id: 'c2', group: '', sources: [] },                  // 空 sources
      { parent: 'p', id: 'c3', group: '', sources: ['pkg/missing.py'] },  // 源缺失
      { parent: 'ghost', id: 'c4', group: '', sources: ['pkg/a.py'] },    // 父缺失
    ] };
    const diag = lintThemeDeepConfig(root, themes, themeDeep);
    const kinds = diag.map(d => d.kind);
    assert.ok(kinds.includes('theme-deep-id-collision'));
    assert.ok(kinds.includes('theme-deep-sources-empty'));
    assert.ok(kinds.includes('theme-deep-source-missing'));
    assert.ok(kinds.includes('theme-deep-parent-missing'));
    const missing = diag.find(d => d.kind === 'theme-deep-source-missing');
    assert.equal(missing.entry, 'pkg/missing.py');
    assert.match(missing.message, /no source file matched/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lintThemeDeepPages: mechanism, diagram, links, missing page, orphan, separator warning', () => {
  const root = tmpDir();
  try {
    const themeDir = join(root, 'wiki', 'theme');
    mkdirSync(themeDir, { recursive: true });
    // 合法子页：机制 + 图 + 父链接齐全
    writeFileSync(join(themeDir, 'p--good.md'),
      '---\ntitle: G\nsummary: s\n---\n# x\n\n[[p]]\n\n## 机制详解\n\nok\n\n```mermaid\nflowchart LR\n  a-->b\n```\n');
    // 缺机制 + 缺图 + 缺父链接
    writeFileSync(join(themeDir, 'p--bad.md'), '---\ntitle: B\nsummary: s\n---\n# x\n\nprose\n');
    // 父页缺子链接
    writeFileSync(join(themeDir, 'p.md'), '---\ntitle: P\nsummary: s\n---\n# x\n');
    // 孤儿子路径 + 历史 `--` 顶层主题
    writeFileSync(join(themeDir, 'p--ghost.md'), '---\ntitle: G2\nsummary: s\n---\n# x\n');
    writeFileSync(join(themeDir, 'legacy--theme.md'), '---\ntitle: L\nsummary: s\n---\n# x\n');
    const children = [
      { parent: 'p', id: 'good', group: 'g1', sourceFiles: ['a.py'] },
      { parent: 'p', id: 'bad', group: 'g1', sourceFiles: ['b.py'] },
      { parent: 'p', id: 'missing', group: 'g1', sourceFiles: ['c.py'] },
    ];
    const themes = [{ id: 'p', match: [] }, { id: 'legacy--theme', match: [] }];
    const diag = lintThemeDeepPages(join(root, 'wiki'), children, themes);
    const byKind = k => diag.filter(d => d.kind === k);
    assert.equal(byKind('theme-deep-mechanism-missing').some(d => d.child === 'bad'), true);
    assert.equal(byKind('theme-deep-diagram-missing').some(d => d.child === 'bad'), true);
    assert.equal(byKind('theme-deep-parent-link-missing').some(d => d.child === 'bad'), true);
    assert.equal(byKind('theme-deep-child-link-missing').some(d => d.child === 'good'), true);
    assert.equal(byKind('theme-deep-page-missing').some(d => d.child === 'missing'), true);
    assert.equal(byKind('theme-deep-orphan').some(d => d.child === 'p--ghost'), true);
    assert.equal(byKind('theme-id-reserved-separator').some(d => d.parent === 'legacy--theme'), true);
    // good 页零诊断
    assert.equal(byKind('theme-deep-mechanism-missing').some(d => d.child === 'good'), false);
    assert.equal(byKind('theme-deep-diagram-missing').some(d => d.child === 'good'), false);
    assert.equal(byKind('theme-deep-parent-link-missing').some(d => d.child === 'good'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lint: separator-only warning keeps clean true but surfaces themeDeepWarnings', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki', 'theme'), { recursive: true });
    writeFileSync(join(lore, 'config.yml'), 'axes:\n  theme:\n    values:\n      - { id: legacy--theme, desc: d, match: [x] }\n');
    writeFileSync(join(lore, 'wiki', 'theme', 'legacy--theme.md'), '---\ntitle: L\nsummary: s\n---\n# x\n');
    const r = lint({ loreDir: lore });
    assert.equal(r.clean, true);                                   // separator 是非阻断警告
    assert.equal(r.themeDeep.length, 0);
    assert.equal(r.themeDeepWarnings.length, 1);
    assert.equal(r.themeDeepWarnings[0].kind, 'theme-id-reserved-separator');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: separator-only warning prints even on a clean repo (not swallowed by else branch)', () => {
  const root = tmpDir();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki', 'theme'), { recursive: true });
    writeFileSync(join(lore, 'config.yml'), 'axes:\n  theme:\n    values:\n      - { id: legacy--theme, desc: d, match: [x] }\n');
    writeFileSync(join(lore, 'wiki', 'theme', 'legacy--theme.md'), '---\ntitle: L\nsummary: s\n---\n# x\n');
    const out = execFileSync('node', ['lib/lint.js', lore], { cwd: process.cwd() }).toString();
    assert.match(out, /clean/);                      // 仍报 clean（警告不阻断）
    assert.match(out, /theme-deep-warning \(1\)/);   // 但警告必须被打印
    assert.match(out, /legacy--theme/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
