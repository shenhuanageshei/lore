// test/cli.test.js —— S4b 统一 CLI（不变量④）与 per-human 边界（不变量⑥）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { init } from '../lib/init.js';
import { readHuman, exportHuman } from '../lib/human.js';
import { main } from '../lib/cli.js';

const CLI = join(process.cwd(), 'lib', 'cli.js');
const SITE = join(process.cwd(), 'site');

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-cli-')); }
function run(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: process.cwd(), encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const loreOf = root => join(root, '.lore');
const lines = p => readFileSync(p, 'utf8').split('\n').filter(t => t.trim() !== '');

test('未 init 的目录：四个 verb 均明确报错 exit 1，不静默写散文件', () => {
  const root = tmp();
  try {
    const cases = [
      ['visit', 'lib/a.js', '--root', root],
      ['read', 'lib/a.js', '--at', 'sha1', '--root', root],
      ['blackbox', 'runner', '--level', '懂', '--root', root],
      ['human', 'export', '--root', root],
    ];
    for (const c of cases) {
      const r = run(...c);
      assert.equal(r.status, 1, `exit code for: ${c.join(' ')}`);
      assert.match(r.stderr, /no \.lore at/, c.join(' '));
      assert.match(r.stderr, /\/lore:init/, c.join(' '));
      assert.equal(r.stdout, '', c.join(' '));
    }
    assert.equal(existsSync(loreOf(root)), false);        // 没造目录
    assert.deepEqual(readdirSync(root), []);              // 更没写散文件
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('visit/read/blackbox：写入 .lore/human/*.jsonl；重复调用幂等（短窗去重）', () => {
  const root = tmp();
  try {
    mkdirSync(loreOf(root), { recursive: true });

    const v1 = run('visit', 'lib/runner.js', '--root', root);
    assert.equal(v1.status, 0);
    assert.match(v1.stdout, /✓ visit lib\/runner\.js/);
    const v2 = run('visit', 'lib/runner.js', '--root', root);
    assert.equal(v2.status, 0);
    assert.match(v2.stdout, /\(deduped\)/);
    assert.equal(readHuman(loreOf(root), 'visits').length, 1);

    const r1 = run('read', 'lib/fold.js', '--at', 'abc1234', '--root', root);
    assert.equal(r1.status, 0);
    assert.match(r1.stdout, /✓ read lib\/fold\.js @ abc1234/);
    assert.match(run('read', 'lib/fold.js', '--at', 'abc1234', '--root', root).stdout, /\(deduped\)/);
    assert.equal(readHuman(loreOf(root), 'read').length, 1);
    // 换版本戳 = 新记录（确认绑版本，不变量⑧）
    assert.equal(run('read', 'lib/fold.js', '--at', 'def5678', '--root', root).status, 0);
    assert.equal(readHuman(loreOf(root), 'read').length, 2);

    const b1 = run('blackbox', 'runner', '--level', '半懂', '--root', root);
    assert.equal(b1.status, 0);
    assert.match(b1.stdout, /✓ blackbox runner = 半懂/);
    assert.match(run('blackbox', 'runner', '--level', '半懂', '--root', root).stdout, /\(deduped\)/);
    assert.equal(readHuman(loreOf(root), 'blackbox').length, 1);

    // 落盘位置与记录形状（存储层形状的唯一真源在 lib/human.js）
    const rec = JSON.parse(lines(join(loreOf(root), 'human', 'visits.jsonl'))[0]);
    assert.equal(rec.kind, 'visit');
    assert.equal(rec.page, 'lib/runner.js');
    assert.ok(rec.ts);
    assert.deepEqual(readHuman(loreOf(root), 'read')[0], { ts: readHuman(loreOf(root), 'read')[0].ts, kind: 'read', page: 'lib/fold.js', at: 'abc1234' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('human export：stdout 为含 schemaVersion 的可移植 JSON；--out 落盘且重复导出不改库', () => {
  const root = tmp();
  try {
    mkdirSync(loreOf(root), { recursive: true });
    run('visit', 'a', '--root', root);
    run('blackbox', 'm', '--level', '黑盒', '--root', root);

    const r = run('human', 'export', '--root', root);
    assert.equal(r.status, 0);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.generator, 'lore');
    assert.deepEqual(doc.counts, { visits: 1, read: 0, blackbox: 1, checks: 0 });
    assert.deepEqual(doc.records.map(x => x.kind), ['visit', 'blackbox']);

    const outFile = join(root, 'out', 'nested', 'human.json');   // 父目录不存在 → CLI 自建
    const r2 = run('human', 'export', '--out', outFile, '--root', root);
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /✓ exported 2 records → /);
    const doc2 = JSON.parse(readFileSync(outFile, 'utf8'));
    assert.equal(doc2.schemaVersion, 1);
    assert.deepEqual(doc2.records, doc.records);

    assert.deepEqual(exportHuman(loreOf(root)).counts, doc.counts);        // 导出是只读
    assert.equal(lines(join(loreOf(root), 'human', 'visits.jsonl')).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('未知 verb / 缺参数 / 非法取值：打印用法并 exit 1', () => {
  const root = tmp();
  try {
    mkdirSync(loreOf(root), { recursive: true });
    // 用法错误：消息 + 用法块（未知 verb / 缺参数 / 未知子命令）
    const usageErrors = [
      [[], /usage: node lib\/cli\.js/],
      [['bogus'], /unknown verb: bogus/],
      [['visit'], /visit requires <page>/],
      [['read', 'p'], /read requires --at/],
      [['blackbox', 'm'], /blackbox requires --level/],
      [['human'], /unknown subcommand: human/],
      [['human', 'bogus'], /unknown subcommand: human bogus/],
    ];
    for (const [args, re] of usageErrors) {
      const r = run(...args, '--root', root);
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, re, args.join(' '));
      assert.match(r.stderr, /usage: node lib\/cli\.js/, args.join(' '));
    }
    // 取值非法：校验规则住在 lib/human.js，CLI 不复制一份——明确消息 + exit 1（不打印用法块）
    const r = run('blackbox', 'm', '--level', '大概', '--root', root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--level must be one of 懂\|半懂\|黑盒/);

    // --out 给了却没值 → 报错，不静默改道 stdout（用 main() 直调，避免测试壳自动补 --root）
    const sink = [];
    const code = main(['human', 'export', '--out'], { cwd: process.cwd(), out: s => sink.push(s), err: s => sink.push(s) });
    assert.equal(code, 1);
    assert.match(sink.join('\n'), /--out requires <file>/);
    assert.equal(existsSync(join(loreOf(root), 'human')), false);          // 参数错误不落任何记录
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('--root 给了却没值 → 用法 + exit 1（不静默回落 cwd）', () => {
  const r = run('doctor', '--json', '--root');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--root requires <repo>/);
  assert.match(r.stderr, /usage: node lib\/cli\.js/);
  assert.equal(r.stdout, '');
  // 检查在 verb 分发之前 → 每个 verb 一致
  for (const c of [['visit', 'p', '--root'], ['human', 'export', '--root'], ['bogus', '--root']]) {
    const x = run(...c);
    assert.equal(x.status, 1, c.join(' '));
    assert.match(x.stderr, /--root requires <repo>/, c.join(' '));
  }
  // 直调 main() 也一致（不依赖测试壳）
  const sink = [];
  assert.equal(main(['doctor', '--root'], { cwd: process.cwd(), out: s => sink.push(s), err: s => sink.push(s) }), 1);
  assert.match(sink.join('\n'), /--root requires <repo>/);
});

test('package.json bin: lore → ./lib/cli.js（可执行入口；指向的就是统一 CLI）', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  assert.deepEqual(pkg.bin, { lore: './lib/cli.js' });
  assert.equal(existsSync(CLI), true);
  // 可执行 = 有 node shebang：POSIX 上 npm 的 bin shim 靠它选解释器（无 shebang 会被当 shell 脚本执行）
  assert.match(readFileSync(CLI, 'utf8').split('\n')[0], /^#!\/usr\/bin\/env node$/);
  const r = spawnSync(process.execPath, [CLI], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: node lib\/cli\.js/);
});

test('新 init 的仓库：.lore/human/ 自动进 .gitignore，visit 数据落盘且真被 git 忽略', () => {
  const root = tmp();
  const home = tmp();                                                       // 机器层宿主资产隔离进 tmp
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    init({ repoRoot: root, srcSiteDir: SITE, home });

    assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^\.lore\/human\/$/m);

    const r = run('visit', 'lib/a.js', '--root', root);
    assert.equal(r.status, 0);
    assert.equal(existsSync(join(loreOf(root), 'human', 'visits.jsonl')), true);
    assert.equal(spawnSync('git', ['check-ignore', '-q', '.lore/human/visits.jsonl'], { cwd: root }).status, 0);

    const doc = JSON.parse(run('human', 'export', '--root', root).stdout);
    assert.equal(doc.counts.visits, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('旧入口回归：node lib/note.js 位置参数语义不变（cli.js 只新增，不接管旧入口）', () => {
  const root = tmp();
  try {
    const out = execFileSync(process.execPath, ['lib/note.js', root, '--title', 't', '--why', 'w'], { cwd: process.cwd() }).toString();
    assert.match(out, /noted decision atom note:/);
    assert.equal(existsSync(join(loreOf(root), 'journal')), true);
    assert.equal(existsSync(join(loreOf(root), 'human')), false);           // 旧入口不写 per-human
  } finally { rmSync(root, { recursive: true, force: true }); }
});
