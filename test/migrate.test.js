// test/migrate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readMigrations, appendMigration, alignShell, SHELL_FILES, alignHookStub, renderHookStub, HOOK_MARKER, alignResidentAssets, alignConfig, CONFIG_BLOCKS, alignGitignore, alignGitattributes, GITIGNORE_LINES, alignAssets } from '../lib/migrate.js';
import { writeEnabledHosts } from '../lib/host.js';
import { installResident } from '../lib/resident.js';
import { renderConfigYaml } from '../lib/init.js';
import { finalizeSync } from '../lib/sync.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-mig-')); }

const OLD_CONFIG = `# old config
axes:
  component:
    discover: auto
    code_roots: [src]
`;

test('migrations: 缺文件/坏 JSON → 空 Set；append → 读回；幂等', () => {
  const st = tmp();
  try {
    assert.equal(readMigrations(st).size, 0);
    writeFileSync(join(st, 'migrations.json'), '{broken');
    assert.equal(readMigrations(st).size, 0);
    appendMigration(st, 'config:axes.docs');
    appendMigration(st, 'config:axes.docs');           // 重复 append 幂等
    appendMigration(st, 'resident:install');
    const s = readMigrations(st);
    assert.deepEqual([...s].sort(), ['config:axes.docs', 'resident:install']);
  } finally { rmSync(st, { recursive: true, force: true }); }
});

test('alignShell: 目标缺 → installed；内容同 → 零动作；stale → refreshed；引擎缺文件 → 跳过', () => {
  const eng = tmp(); const lore = tmp();
  try {
    writeFileSync(join(eng, 'index.html'), '<html>v2</html>');
    writeFileSync(join(eng, 'shell.mjs'), 'export const v = 2;');
    // mermaid.min.js 故意不建 → 跳过不抛
    const a1 = alignShell(eng, lore);
    assert.deepEqual(a1.map(x => x.action), ['installed', 'installed']);
    assert.equal(readFileSync(join(lore, 'site', 'shell.mjs'), 'utf8'), 'export const v = 2;');
    assert.deepEqual(alignShell(eng, lore), []);        // 幂等
    writeFileSync(join(lore, 'site', 'shell.mjs'), 'export const v = 1;');   // stale
    const a2 = alignShell(eng, lore);
    assert.deepEqual(a2, [{ asset: 'shell:shell.mjs', action: 'refreshed' }]);
    assert.equal(readFileSync(join(lore, 'site', 'shell.mjs'), 'utf8'), 'export const v = 2;');
  } finally { rmSync(eng, { recursive: true, force: true }); rmSync(lore, { recursive: true, force: true }); }
});

test('alignHookStub: absent → installed；老内容含 MARKER → refreshed；一致 → present；foreign → foreign 不碰', () => {
  const root = tmp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    // 默认（finalize 语义）absent → 不装；install:true（init 语义）→ 装
    assert.equal(alignHookStub(root, 'D:/engine/lib/hook.js', '').status, 'absent');
    assert.equal(existsSync(join(root, '.git', 'hooks', 'post-commit')), false);
    const r1 = alignHookStub(root, 'D:/engine/lib/hook.js', 'journal:\n  hook: true\n', { install: true });
    assert.equal(r1.status, 'installed');
    const hookPath = join(root, '.git', 'hooks', 'post-commit');
    assert.match(readFileSync(hookPath, 'utf8'), /D:\/engine\/lib\/hook\.js/);
    assert.equal(alignHookStub(root, 'D:/engine/lib/hook.js', '').status, 'present');     // 幂等
    const r2 = alignHookStub(root, 'D:/engine2/lib/hook.js', '');                          // 引擎挪位置
    assert.equal(r2.status, 'refreshed');
    assert.match(readFileSync(hookPath, 'utf8'), /D:\/engine2\/lib\/hook\.js/);
    writeFileSync(hookPath, '#!/bin/sh\necho mine\n');                                     // foreign
    assert.equal(alignHookStub(root, 'D:/engine/lib/hook.js', '').status, 'foreign');
    assert.match(readFileSync(hookPath, 'utf8'), /echo mine/);                             // 未被碰
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('alignResidentAssets: 首装两资产+记 resident:install；删除后 applied → 不复活；老路径条目 → refreshed', () => {
  const root = tmp();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, '.state'), { recursive: true });
    const applied = new Set();
    const rec = id => applied.add(id);
    // 首装：CLAUDE.md 节 + .mcp.json lore 条目都缺 → 都装 + 记
    const a1 = alignResidentAssets(root, lore, 'D:/engine/lib/mcp.js', applied, rec);
    assert.ok(a1.some(x => x.asset === 'claude-md' && x.action === 'installed'));
    assert.ok(a1.some(x => x.asset === 'mcp-json' && x.action === 'installed'));
    assert.ok(applied.has('resident:install'));
    assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /LORE_RESIDENT:START/);
    // 幂等：再跑零动作（节在 → refresh 无内容变化；条目在且路径同 → 不动）
    assert.deepEqual(alignResidentAssets(root, lore, 'D:/engine/lib/mcp.js', applied, rec), []);
    // 引擎挪位置 → mcp-json refreshed
    const a2 = alignResidentAssets(root, lore, 'D:/engine2/lib/mcp.js', applied, rec);
    assert.deepEqual(a2, [{ asset: 'mcp-json', action: 'refreshed' }]);
    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    assert.deepEqual(mcp.mcpServers.lore.args, ['D:/engine2/lib/mcp.js']);
    // 用户删节 + 删条目，applied 已记 → 不复活
    rmSync(join(root, 'CLAUDE.md'));
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    assert.deepEqual(alignResidentAssets(root, lore, 'D:/engine2/lib/mcp.js', applied, rec), []);
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('alignResidentAssets: CLAUDE.md 节文案/stats 过期 → refreshed（节在就刷）', () => {
  const root = tmp();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    const applied = new Set(['resident:install']);
    writeFileSync(join(root, 'CLAUDE.md'),
      '<!-- LORE_RESIDENT:START -->\nold body\n<!-- LORE_RESIDENT:END -->\n');
    const a = alignResidentAssets(root, lore, 'D:/e/mcp.js', applied, () => {});
    assert.ok(a.some(x => x.asset === 'claude-md' && x.action === 'refreshed'));
    assert.doesNotMatch(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /old body/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('alignResidentAssets: 启用 codex 后补写 AGENTS.md，且删除不复活', () => {
  // repo：已 init 过（CLAUDE.md 有 resident 节、migrations 已记 resident:install）
  const repo = mkdtempSync(join(tmpdir(), 'lore-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'lore-home-'));
  try {
    const loreDir = join(repo, '.lore');
    mkdirSync(join(loreDir, '.state'), { recursive: true });
    mkdirSync(join(loreDir, 'wiki'), { recursive: true });
    installResident(repo, { pages: 1, deepPages: 0, updated: 'x' }, ['CLAUDE.md']);
    const applied = new Set(['resident:install']);
    writeEnabledHosts(['claude', 'codex'], join(home, '.lore', 'hosts.json'));
    const rec = [];
    const actions = alignResidentAssets(repo, loreDir, 'D:/lore/lib/mcp.js', applied, k => rec.push(k), { hostsPath: join(home, '.lore', 'hosts.json') });
    assert.ok(actions.some(a => a.asset === 'agents-md' && a.action === 'installed'));
    assert.ok(rec.includes('resident:install:AGENTS.md'));
    // 用户删掉 AGENTS.md → 下轮不复活
    rmSync(join(repo, 'AGENTS.md'));
    const a2 = alignResidentAssets(repo, loreDir, 'D:/lore/lib/mcp.js', new Set([...applied, ...rec]), () => {}, { hostsPath: join(home, '.lore', 'hosts.json') });
    assert.ok(!a2.some(a => a.asset === 'agents-md' && a.action === 'installed'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('alignConfig: 老 config 补全缺失块 —— 顶层 append + axes 二级锚定插入；已有行逐字节不变', () => {
  const lore = tmp();
  try {
    writeFileSync(join(lore, 'config.yml'), OLD_CONFIG);
    const applied = new Set(); const rec = id => applied.add(id);
    const actions = alignConfig(lore, applied, rec);
    const text = readFileSync(join(lore, 'config.yml'), 'utf8');
    assert.ok(text.startsWith(OLD_CONFIG.trimEnd()));                  // 已有行原样开头
    assert.match(text, /^language:/m);                                  // 顶层补上
    assert.match(text, /^journal:/m);
    assert.match(text, /^# resident: true/m);                           // 可发现性注释块
    assert.match(text, /^  docs:/m);                                    // axes 二级补上
    assert.match(text, /^  flow:/m);
    assert.match(text, /^  theme:/m);
    // 二级块插在 axes 块内（component 之后、下一个顶层键之前）
    assert.ok(text.indexOf('  docs:') > text.indexOf('  component:'));
    assert.ok(applied.has('config:axes.docs') && applied.has('config:language'));
    assert.ok(actions.length >= 6);
    // 幂等：再跑零动作
    assert.deepEqual(alignConfig(lore, applied, rec), []);
  } finally { rmSync(lore, { recursive: true, force: true }); }
});

test('alignConfig: 删块且 applied → 不复活；fresh 模板 → 零动作；axes 锚缺 → 二级 skip 不记；无 config → 零动作', () => {
  const lore = tmp();
  try {
    // fresh 模板零动作（renderConfigYaml 含全部块）
    writeFileSync(join(lore, 'config.yml'), renderConfigYaml(['lib']));
    assert.deepEqual(alignConfig(lore, new Set(), () => {}), []);
    // 删块 + applied → 不复活
    writeFileSync(join(lore, 'config.yml'), OLD_CONFIG);
    const applied = new Set(CONFIG_BLOCKS.map(b => b.id));
    assert.deepEqual(alignConfig(lore, applied, () => {}), []);
    assert.doesNotMatch(readFileSync(join(lore, 'config.yml'), 'utf8'), /^language:/m);
    // axes 锚缺 → 二级 skip 且不记 applied
    writeFileSync(join(lore, 'config.yml'), '# bare\n');
    const ap2 = new Set(); const recd = [];
    alignConfig(lore, ap2, id => { ap2.add(id); recd.push(id); });
    assert.ok(!recd.includes('config:axes.docs'));                      // 二级没记
    assert.ok(recd.includes('config:language'));                        // 顶层照补
    // 无 config.yml → 不是迁移场景
    const lore2 = tmp();
    try { assert.deepEqual(alignConfig(lore2, new Set(), () => {}), []); }
    finally { rmSync(lore2, { recursive: true, force: true }); }
  } finally { rmSync(lore, { recursive: true, force: true }); }
});

test('alignConfig: 缺 docs 轴 + repo 有 docs/ → 补可用真 glob（migrate 缺口修复，非注释默认）', () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-migdocs-'));
  try {
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    writeFileSync(join(lore, 'config.yml'), 'axes:\n  component:\n    code_roots: [src]\n');
    mkdirSync(join(root, 'docs'), { recursive: true });
    for (const f of ['a.md', 'b.md', 'c.md']) writeFileSync(join(root, 'docs', f), '# d');
    const applied = new Set();
    alignConfig(lore, applied, id => applied.add(id));
    const t = readFileSync(join(lore, 'config.yml'), 'utf8');
    assert.match(t, /docs_glob: docs\/\*\*\/\*\.md/);                  // 可用真 glob
    assert.match(t, /sources: \[docs/);                                // 真 sources（非注释 #）
    assert.doesNotMatch(t, /#\s*docs_glob/);                           // 不是注释默认
    assert.ok(applied.has('config:axes.docs'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('alignConfig: CRLF config 保持行尾风格，已有行不变', () => {
  const lore = tmp();
  try {
    const crlf = OLD_CONFIG.replace(/\n/g, '\r\n');
    writeFileSync(join(lore, 'config.yml'), crlf);
    alignConfig(lore, new Set(), () => {});
    const text = readFileSync(join(lore, 'config.yml'), 'utf8');
    assert.ok(text.startsWith(crlf.trimEnd()));
    assert.equal(text.split('\r\n').length > 10, true);                 // 新增行也是 CRLF
    assert.doesNotMatch(text, /[^\r]\n  docs:/);                        // 无孤 LF 行
  } finally { rmSync(lore, { recursive: true, force: true }); }
});

test('renderConfigYaml: 从 CONFIG_BLOCKS 拼装 —— 含全部块 + 动态 code_roots/sample', () => {
  const yaml = renderConfigYaml(['m1', 'm2']);
  assert.match(yaml, /code_roots: \[m1, m2\]/);
  assert.match(yaml, /spans: \[m1\]/);                                  // sample 注入 flow 示例
  for (const b of CONFIG_BLOCKS) {
    const probe = b.key ? new RegExp(`^(#\\s*)?\\s*${b.key}:`, 'm') : /^# resident: true/m;
    assert.match(yaml, probe, `block ${b.id} missing from template`);
  }
});

test('alignGitignore: 三行补缺 + 已有行保留 + 幂等 + 删行 applied 不复活', () => {
  const root = tmp();
  try {
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.lore/.state/\n');
    const applied = new Set(); const rec = id => applied.add(id);
    const a1 = alignGitignore(root, applied, rec);
    assert.equal(a1.length, 2);                                          // wiki + site（.state 已在）
    const txt = readFileSync(join(root, '.gitignore'), 'utf8');
    assert.match(txt, /^node_modules\/$/m);                              // 已有行保留
    for (const l of GITIGNORE_LINES) assert.ok(txt.split(/\r?\n/).some(x => x.trim() === l));
    assert.deepEqual(alignGitignore(root, applied, rec), []);            // 幂等
    // 用户删 wiki 行 → applied → 不复活
    writeFileSync(join(root, '.gitignore'), txt.split('\n').filter(l => l !== '.lore/wiki/').join('\n'));
    assert.deepEqual(alignGitignore(root, applied, rec), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('alignGitattributes: 缺文件创建 / 已有追加 / 幂等 / 删行 applied 不复活', () => {
  const root = tmp();
  try {
    const applied = new Set(); const rec = id => applied.add(id);
    const a1 = alignGitattributes(root, applied, rec);
    assert.deepEqual(a1, [{ asset: 'gitattributes', action: 'appended' }]);
    assert.match(readFileSync(join(root, '.gitattributes'), 'utf8'), /journal\/\*\*\/\*\.ndjson merge=union/);
    assert.deepEqual(alignGitattributes(root, applied, rec), []);
    writeFileSync(join(root, '.gitattributes'), '# emptied\n');
    assert.deepEqual(alignGitattributes(root, applied, rec), []);        // 不复活
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('alignAssets 集成: 全新 git repo 一把对齐全部资产；再跑零动作', () => {
  const root = tmp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const eng = tmp();
    try {
      writeFileSync(join(eng, 'index.html'), '<html/>');
      writeFileSync(join(eng, 'shell.mjs'), 'export const v = 1;');
      writeFileSync(join(eng, 'mermaid.min.js'), '// m');
      const lore = join(root, '.lore');
      mkdirSync(lore, { recursive: true });
      writeFileSync(join(lore, 'config.yml'), OLD_CONFIG);            // 老 config
      const home = tmp();                                             // 机器层宿主资产隔离进 tmp，不碰真实 home
      try {
        writeEnabledHosts(['codex'], join(home, '.lore', 'hosts.json'));
        const opts = { engineSiteDir: eng, hookJsPath: 'D:/e/hook.js', mcpJsPath: 'D:/e/mcp.js', installHook: true, home };
        const a1 = alignAssets(root, lore, opts);
        const assets = a1.map(x => x.asset);
        assert.ok(assets.some(x => x.startsWith('shell:')));
        assert.ok(assets.includes('hook-stub'));
        assert.ok(assets.some(x => x.startsWith('config:+')));
        assert.ok(assets.some(x => x.startsWith('gitignore:')));
        assert.ok(assets.includes('gitattributes'));
        assert.ok(assets.includes('claude-md') && assets.includes('mcp-json'));
        assert.ok(!a1.some(x => x.action === 'error'));
        // 隔离生效：启用 codex → 命令写进 tmp home（断言只碰 tmp home；真实 home 结构性不受影响）
        assert.ok(assets.includes('host:codex'));
        assert.ok(existsSync(join(home, '.codex', 'prompts', 'lore-sync.md')));
        assert.deepEqual(alignAssets(root, lore, opts), []);            // 幂等
      } finally { rmSync(home, { recursive: true, force: true }); }
    } finally { rmSync(eng, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('alignAssets: resident:false config → 不装 CLAUDE.md/.mcp.json，其余照常', () => {
  const root = tmp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const lore = join(root, '.lore');
    mkdirSync(lore, { recursive: true });
    writeFileSync(join(lore, 'config.yml'), 'resident: false\n' + OLD_CONFIG);
    const eng = tmp();
    try {
      writeFileSync(join(eng, 'index.html'), '<html/>');
      const home = tmp();                                             // 无 hosts.json → 默认 claude → 零宿主命令资产
      try {
        const a = alignAssets(root, lore, { engineSiteDir: eng, hookJsPath: 'D:/e/hook.js', mcpJsPath: 'D:/e/mcp.js', home });
        assert.ok(!a.some(x => x.asset === 'claude-md' || x.asset === 'mcp-json'));
        assert.ok(!a.some(x => x.asset.startsWith('host:')));
        assert.equal(existsSync(join(root, 'CLAUDE.md')), false);
        assert.ok(a.some(x => x.asset.startsWith('gitignore:')));
      } finally { rmSync(home, { recursive: true, force: true }); }
    } finally { rmSync(eng, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('finalizeSync: 返回 migrate 动作数组，migrate 异常不挡 finalize', () => {
  const root = tmp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    const lore = join(root, '.lore');
    for (const d of ['journal', 'wiki', '.state']) mkdirSync(join(lore, d), { recursive: true });
    writeFileSync(join(lore, 'config.yml'), renderConfigYaml(['lib']));
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root });
    const r = finalizeSync(lore, '2026-06-11T00:00:00Z');
    assert.ok(Array.isArray(r.migrate));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('alignHookStub: journal hook:false → disabled 不装；非 git 目录 → no-git', () => {
  const root = tmp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    assert.equal(alignHookStub(root, 'D:/e/hook.js', 'journal:\n  hook: false\n', { install: true }).status, 'disabled');
    assert.equal(existsSync(join(root, '.git', 'hooks', 'post-commit')), false);
    const plain = tmp();
    try { assert.equal(alignHookStub(plain, 'D:/e/hook.js', '').status, 'no-git'); }
    finally { rmSync(plain, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
