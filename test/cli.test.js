// test/cli.test.js —— S4b 统一 CLI（不变量④）与 per-human 边界（不变量⑥）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { init } from '../lib/init.js';
import { readHuman, exportHuman } from '../lib/human.js';
import { readAllRecords } from '../lib/journal.js';
import { readBudgetConfig } from '../lib/syncstate.js';
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

test('budget：设上限（含维度）/ 清空 / 非法取值；未 init 目录明确报错（审计 D4 的 CLI 出口）', () => {
  const root = tmp();
  try {
    // 未 init → 明确报错，不凭空造 .lore/.state
    const noInit = run('budget', '5', '--root', root);
    assert.equal(noInit.status, 1);
    assert.match(noInit.stderr, /no \.lore at/);
    assert.equal(existsSync(loreOf(root)), false);

    mkdirSync(loreOf(root), { recursive: true });
    const state = join(loreOf(root), '.state');

    const r1 = run('budget', '3', '--dimension', 'calls', '--root', root);
    assert.equal(r1.status, 0);
    assert.match(r1.stdout, /✓ budget 3 \(dimension calls\)/);
    assert.deepEqual(readBudgetConfig(state), { budget: 3, dimension: 'calls' });

    // 缺省维度 = calls（审计 D3：后端不回报 token 用量，token 维度算不出超支）
    assert.equal(run('budget', '2', '--root', root).status, 0);
    assert.deepEqual(readBudgetConfig(state), { budget: 2, dimension: 'calls' });

    assert.equal(run('budget', '2000', '--dimension', 'ms', '--root', root).status, 0);
    assert.deepEqual(readBudgetConfig(state), { budget: 2000, dimension: 'ms' });

    // 清空 = 不阻断
    const r4 = run('budget', '--clear', '--root', root);
    assert.equal(r4.status, 0);
    assert.match(r4.stdout, /budget cleared/);
    assert.deepEqual(readBudgetConfig(state), { budget: null, dimension: 'calls' });
    assert.equal(readFileSync(join(state, 'budget.json'), 'utf8'), '{}\n');

    // 用法错误：消息 + 用法块
    const usage = run('budget', '--root', root);
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /budget requires <n> or --clear/);
    assert.match(usage.stderr, /usage: node lib\/cli\.js/);
    // --dimension 给了却没值 → 用法错误（直调 main，避免测试壳把它吞成 --root 的值）
    const sink = [];
    assert.equal(main(['budget', '5', '--dimension'], { cwd: root, out: s => sink.push(s), err: s => sink.push(s) }), 1);
    assert.match(sink.join('\n'), /--dimension requires/);

    // 取值非法：校验规则住在 lib/syncstate.js，CLI 不复制一份
    for (const bad of [['budget', '0'], ['budget', '-1'], ['budget', 'lots']]) {
      const r = run(...bad, '--root', root);
      assert.equal(r.status, 1, bad.join(' '));
      assert.match(r.stderr, /invalid budget/, bad.join(' '));
    }
    const badDim = run('budget', '5', '--dimension', 'minutes', '--root', root);
    assert.equal(badDim.status, 1);
    assert.match(badDim.stderr, /invalid budget dimension/);
    assert.deepEqual(readBudgetConfig(state), { budget: null, dimension: 'calls' });   // 非法没落盘
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('human clear：缺 --yes 只报将删条数不删；--yes 才删；按 kind/all；清后可继续追加（不变量⑥）', () => {
  const root = tmp();
  try {
    mkdirSync(loreOf(root), { recursive: true });
    run('visit', 'a', '--root', root);
    run('visit', 'b', '--root', root);
    run('read', 'p', '--at', 'sha1', '--root', root);
    const visitsFile = join(loreOf(root), 'human', 'visits.jsonl');

    // 缺 --yes → 报将删条数、不删、exit 1（不是静默 0）
    const dry = run('human', 'clear', '--kind', 'visits', '--root', root);
    assert.equal(dry.status, 1);
    assert.match(dry.stderr, /will delete 2 record\(s\) from visits/);
    assert.match(dry.stderr, /--yes/);
    assert.equal(readHuman(loreOf(root), 'visits').length, 2);            // 一条没删

    // --yes → 真删（只清该类）
    const done = run('human', 'clear', '--kind', 'visits', '--yes', '--root', root);
    assert.equal(done.status, 0);
    assert.match(done.stdout, /✓ cleared 2 record\(s\) \(visits\)/);
    assert.equal(readHuman(loreOf(root), 'visits').length, 0);
    assert.equal(existsSync(visitsFile), false);
    assert.equal(readHuman(loreOf(root), 'read').length, 1);              // 别的类不受影响

    // 清除后可继续追加（同一页不再被短窗去重挡住）
    const again = run('visit', 'a', '--root', root);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /✓ visit a$/m);
    assert.equal(readHuman(loreOf(root), 'visits').length, 1);

    // --kind all → 清全部
    const all = run('human', 'clear', '--kind', 'all', '--yes', '--root', root);
    assert.equal(all.status, 0);
    assert.match(all.stdout, /✓ cleared 2 record\(s\) \(all\)/);        // 1 visit + 1 read
    assert.deepEqual(exportHuman(loreOf(root)).counts, { visits: 0, read: 0, blackbox: 0, checks: 0 });

    // 用法/取值错误
    for (const [args, re] of [[['human', 'clear'], /human clear requires --kind/],
                              [['human', 'clear', '--kind', 'nope', '--yes'], /kind must be one of/]]) {
      const r = run(...args, '--root', root);
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, re, args.join(' '));
    }
    // --kind 给了却没值 → 用法错误（直调 main，避免测试壳把 --root 吞成 --kind 的值）
    const sink = [];
    assert.equal(main(['human', 'clear', '--kind'], { cwd: root, out: s => sink.push(s), err: s => sink.push(s) }), 1);
    assert.match(sink.join('\n'), /--kind requires/);
    assert.match(sink.join('\n'), /usage: node lib\/cli\.js/);
    assert.equal(run('human', 'clear', '--kind', 'visits', '--root', root).status, 1);   // 仍未删（上面已清空）
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
      [['confirm'], /confirm requires <atom-id> or --list/],
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


test('旗标吞旗标：非布尔旗标的下一个 token 是旗标 → 明确报错 exit 1（不静默吞成值）', () => {
  const root = tmp();
  try {
    mkdirSync(loreOf(root), { recursive: true });
    const cases = [
      [['doctor', '--capture-rate-min', '--json'], /flag --capture-rate-min requires a value/],
      [['doctor', '--gap-days-max', '--json'], /flag --gap-days-max requires a value/],
      [['visit', 'p', '--root', '--json'], /flag --root requires a value/],
      [['budget', '5', '--dimension', '--clear'], /flag --dimension requires a value/],
      [['human', 'export', '--out', '--root', 'x'], /flag --out requires a value/],
    ];
    for (const [args, re] of cases) {
      const r = run(...args);
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, re, args.join(' '));
      assert.match(r.stderr, /usage: node lib\/cli\.js/, args.join(' '));
      assert.equal(r.stdout, '', args.join(' '));           // 解析失败 → 一个 verb 都不跑
    }
    // 值确实被消费时照常工作：--capture-rate-min 5 进的是阈值，不是 '--json'
    const ok = run('doctor', '--json', '--capture-rate-min', '5', '--root', root);
    const report = JSON.parse(ok.stdout);
    assert.equal(report.gate.ok, false);                    // 空仓库 → 捕获率 unknown → 闸门红
    assert.match(report.gate.reason, /unknown < 5%/);       // 阈值真的读成了 5
    // 直调 main() 同语义（不依赖测试壳）
    const sink = [];
    assert.equal(main(['doctor', '--capture-rate-min', '--json'], { cwd: process.cwd(), out: s => sink.push(s), err: s => sink.push(s) }), 1);
    assert.match(sink.join('\n'), /flag --capture-rate-min requires a value/);
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


// ---------- S3：lore confirm（CLI 接线；形状/幂等/派生全在 lib/confirm.js） ----------
function ndjsonFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...ndjsonFiles(p));
    else if (e.name.endsWith('.ndjson')) out.push(p);
  }
  return out;
}
// 夹具：一个已 init 的 repo + 一条 note 草稿决策原子，返回 { root, id }
function notedDecision() {
  const root = tmp();
  mkdirSync(loreOf(root), { recursive: true });
  const r = run('note', '--title', '选 X 弃 Y', '--why', '因为 Z', '--draft', '--root', root);
  assert.equal(r.status, 0);
  const id = r.stdout.match(/note (\S+)/)[1];
  return { root, id };
}

test('confirm：追加 kind:confirmation（原原子字节不变）、幂等、dispute 派生 disputed、--list 列队列', () => {
  const { root, id } = notedDecision();
  try {
    const j = join(loreOf(root), 'journal');
    const shard = ndjsonFiles(j)[0];
    const before = readFileSync(shard, 'utf8');

    const r1 = run('confirm', id, '--why', '读过实现，判断成立', '--root', root);
    assert.equal(r1.status, 0);
    assert.match(r1.stdout, new RegExp('✓ confirm ' + id + ' → confirmed · confirmation:'));

    // append-only：旧字节是新内容的字节前缀，原原子逐字节不变
    const after = readFileSync(shard, 'utf8');
    assert.ok(after.startsWith(before), '旧内容必须是新内容的字节前缀（append-only）');
    const recs = readAllRecords(j);
    assert.equal(recs.length, 2);
    assert.equal(recs[1].kind, 'confirmation');
    assert.equal(recs[1].atom, id);
    assert.equal(recs[1].verdict, 'confirm');
    assert.equal(recs[1].confirmed_by, 'unattributed');   // D1：不带 --by 不冒充 owner（不变量⑦）
    assert.deepEqual(recs[1].provenance, { via: 'cli', by: 'unattributed' });
    assert.ok(recs[1].confirmed_at);
    assert.equal(recs[1].why, '读过实现，判断成立');
    assert.equal(recs[0].status, 'draft');                // 内联 status 未被改写

    // 重复确认幂等：同 (verdict, why) 不写第二行
    const r2 = run('confirm', id, '--why', '读过实现，判断成立', '--root', root);
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /\(deduped\)/);
    assert.equal(readAllRecords(j).length, 2);

    // --list：已确认 / 待确认 / 已否决（口径与 doctor 的 confirm 行同源）
    const list = run('confirm', '--list', '--root', root);
    assert.equal(list.status, 0);
    assert.match(list.stdout, /决策 已确认 1 · 待确认 0 · 已否决 0（决策 1 · confirmation 记录 1）/);
    assert.match(list.stdout, /已确认 \(1\)/);
    assert.ok(list.stdout.includes(id));

    // --verdict dispute → 派生状态 disputed（追加记录，仍不改原行）
    const d = run('confirm', id, '--verdict', 'dispute', '--why', '锚点已漂移', '--root', root);
    assert.equal(d.status, 0);
    assert.match(d.stdout, /→ disputed/);
    const afterDispute = run('confirm', '--list', '--root', root);
    assert.match(afterDispute.stdout, /决策 已确认 0 · 待确认 0 · 已否决 1（决策 1 · confirmation 记录 2）/);
    assert.match(afterDispute.stdout, /已否决 \(1\)/);
    assert.equal(readAllRecords(j)[0].status, 'draft');
    // doctor 与 --list 同源：确认后体检报「已确认 / 待确认」
    const doc = JSON.parse(run('doctor', '--json', '--root', root).stdout);
    assert.deepEqual(doc.capture.confirmation,
      { records: 2, unattributed: 2, decisions: 1, confirmed: 0, disputed: 1, pending: 0 });
    assert.match(run('doctor', '--root', root).stdout, /confirm\s+已确认 0 · 待确认 0 · 已否决 1 · 未署名 2/);

    // D1：只有显式署名（--by owner）才写 owner；provenance.via 恒为 cli（来源诚实，不变量⑦）
    const byOwner = run('confirm', id, '--by', 'owner', '--why', 'owner 本人确认', '--root', root);
    assert.equal(byOwner.status, 0);
    assert.match(byOwner.stdout, /· by owner/);
    const lastRec = readAllRecords(j).at(-1);
    assert.equal(lastRec.confirmed_by, 'owner');
    assert.deepEqual(lastRec.provenance, { via: 'cli', by: 'owner' });
    // 未署名计数随记录走：前两条（confirm + dispute）都没署名，最后一条署了 owner
    const signedDoc = JSON.parse(run('doctor', '--json', '--root', root).stdout);
    assert.deepEqual(signedDoc.capture.confirmation,
      { records: 3, unattributed: 2, decisions: 1, confirmed: 1, disputed: 0, pending: 0 });
    assert.match(run('evidence', '--root', root).stdout, /未署名确认 2/);
    // evidence --json 与 doctor 同口径（都走 lib/confirm.js 的 isUnattributedConfirmation）
    const ev = JSON.parse(run('evidence', '--json', '--root', root).stdout);
    assert.equal(ev.counts.unattributedConfirmations, signedDoc.capture.confirmation.unattributed);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('confirm 错误路径：未知 atom id / 非法 verdict / 缺 atom-id / 未 init → exit 1，一个字节都不落', () => {
  const { root, id } = notedDecision();
  const other = tmp();
  try {
    const j = join(loreOf(root), 'journal');
    const before = readAllRecords(j);

    // 未知 atom id → 明确报错（不写一条指向空气的确认）
    const unknown = run('confirm', 'decision:does-not-exist', '--root', root);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown atom id: decision:does-not-exist/);
    assert.equal(unknown.stdout, '');
    assert.deepEqual(readAllRecords(j), before);

    // 非法 verdict → 校验规则住在 lib/confirm.js，CLI 不复制一份（明确消息 + exit 1，不打印用法块）
    const bad = run('confirm', id, '--verdict', 'maybe', '--root', root);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /verdict must be one of confirm\|dispute/);
    assert.deepEqual(readAllRecords(j), before);

    // 缺 atom-id（也没给 --list）→ 用法错误 + 用法块
    const missing = run('confirm', '--root', root);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /confirm requires <atom-id> or --list/);
    assert.match(missing.stderr, /usage: node lib\/cli\.js/);

    // --verdict 给了却没值 → 用法错误（直调 main，避免测试壳把 --root 吞成 --verdict 的值）
    const sink = [];
    assert.equal(main(['confirm', id, '--verdict'], { cwd: root, out: s => sink.push(s), err: s => sink.push(s) }), 1);
    assert.match(sink.join('\n'), /--verdict requires/);

    // --by 给了却没值 → 用法错误（不静默回落 unattributed：用户明确署名时丢掉署名也是失真）
    const bySink = [];
    assert.equal(main(['confirm', id, '--by'], { cwd: root, out: s => bySink.push(s), err: s => bySink.push(s) }), 1);
    assert.match(bySink.join('\n'), /--by requires <who>/);
    assert.deepEqual(readAllRecords(j), before);

    // 未 init → 明确报错，不凭空造 .lore
    const noInit = run('confirm', 'decision:x', '--root', other);
    assert.equal(noInit.status, 1);
    assert.match(noInit.stderr, /no \.lore at/);
    assert.equal(existsSync(loreOf(other)), false);
    assert.deepEqual(readAllRecords(j), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

// ---------- ① 期遗留 B③：CLI 写入口的校验拒绝 = 可读错误（exit 1 + 一行消息，不是栈） ----------
test('cli.js 遇 AtomRejected → 可读消息 + exit 1（不打印栈、一个字节不落）', () => {
  const root = tmp();
  try {
    mkdirSync(loreOf(root), { recursive: true });
    // 全空白 title 过得了 cmdNote 的存在性检查（'   ' 是真值），过不了 schema 的 isNonEmptyStr
    // （kind decision 必须有非空标题）→ appendNote 抛 AtomRejected 冒泡到 main 的域错误出口。
    const r = run('note', '--title', '   ', '--why', 'w', '--root', root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^lore: refusing to write invalid atom "note:[^"]+": title: missing-title/m);
    assert.equal(r.stdout, '');
    assert.doesNotMatch(r.stderr, /\n\s+at /);                     // 不打印栈（同一条消息埋深一层）
    assert.equal(existsSync(join(loreOf(root), 'journal')), false);   // 拒绝路径不产生半行
    // 直调 main() 同语义（不依赖测试壳）
    const sink = [];
    assert.equal(main(['note', '--title', '  ', '--root', root], { cwd: process.cwd(), out: s => sink.push(s), err: s => sink.push(s) }), 1);
    assert.match(sink.join('\n'), /lore: refusing to write invalid atom/);
    assert.equal(existsSync(join(loreOf(root), 'journal')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
