// test/lint.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { lintOrphans, lintMissing, lintStale, lintUnfolded, lint } from '../lib/lint.js';
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
  writeFileSync(join(dir, `${id}.md`), `---\ntitle: ${id}\ncode_sha: ${codeSha}\n---\n# ${id}\n`);
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
    assert.deepEqual(r, { stale: [], orphans: [], missing: [], unfolded: [], mermaid: [], clean: true });
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
