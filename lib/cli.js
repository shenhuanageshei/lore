#!/usr/bin/env node
// lib/cli.js —— 统一 CLI 入口（不变量④ CLI 对等；设计 §7 ⓪ 期）。
//
// 只做分发：参数映射 → 调用既有模块的既有函数。业务逻辑一律不住这里——
// per-human 记录形状与写入纪律在 lib/human.js，本文件不复制一份。
//
// 用法：node lib/cli.js <verb> [args] [--root <repo>]
//   visit <page>                        阅读痕迹（壳调用，同页短窗去重）
//   read <page> --at <version>          已阅 @ 版本戳（缺 --at 即非法：确认绑版本）
//   blackbox <module> --level <懂|半懂|黑盒>   黑盒自评
//   note --title <t> [--why <w>] [--draft]    记一条 kind:decision 原子（形状在 lib/note.js）
//   confirm <atom-id> [--why <w>] [--verdict confirm|dispute]   追加一条确认记录（形状/派生在 lib/confirm.js）
//   confirm --list                       列出决策原子的已确认 / 待确认 / 已否决（口径与 doctor 同源）
//   evidence [--json]                    证据账本（只读）：每条 decision|rejected|correction 的来源 / 定位 / 时间 / 置信 / 确认人
//   human export [--out <file>]         导出 per-human 档案（含 schemaVersion）
//   human clear --kind <k> [--yes]      清除 per-human 记录（不变量⑥「可清除」；缺 --yes 只报将删条数）
//   budget <n> [--dimension <dim>]      设每版本预算上限（dim=tokens|calls|ms，缺省 calls）
//   budget --clear                      清空预算 = 不阻断
//   doctor [--json]                     体检（只读）：报告形状在 lib/doctor.js，本文件不复制一份
//
// 未 init（无 .lore）→ 明确报错 exit 1（HumanStoreError 冒泡到这里的唯一出口；note 同一纪律）。
// 例外：doctor 是报告不是断言——缺 .lore / 非 git 都降级 unknown 并 exit 0；**除非配了捕获闸门阈值**
// （config 的 doctor: 子块或 --capture-rate-min/--gap-days-max），此时闸门不通过 → exit 1。
// 闸门口径 = 窗口捕获率（最近 N 个提交，N 默认 50，--capture-window 或 doctor.capture_window_commits 可配）。
// 未知 verb / 缺参数 → 用法 + exit 1。

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLACKBOX_LEVELS, CLEAR_KINDS, HumanStoreError, appendHuman, blackboxRecord, clearHuman, exportHuman,
  readRecord, visitRecord,
} from './human.js';
import { diagnose, formatReport } from './doctor.js';
import { appendNote } from './note.js';
import { ConfirmError, DEFAULT_VERDICT, VERDICTS, confirmAtom, confirmationSummary, deriveStatuses, readConfirmations } from './confirm.js';
import { readAllAtoms } from './journal.js';
import { evidenceReport, formatEvidence } from './evidence.js';
import { readBudgetConfig, writeBudgetConfig } from './syncstate.js';
import { BUDGET_DIMENSIONS, DEFAULT_BUDGET_DIMENSION } from './cost.js';

export const USAGE = `lore — unified CLI

usage: node lib/cli.js <verb> [args] [--root <repo>]

verbs:
  visit <page>                         记录一次页面打开（壳调用；同页短窗去重）
  read <page> --at <version>           标记「已阅 @ 版本戳」（版本戳必填）
  blackbox <module> --level <level>    黑盒自评（${BLACKBOX_LEVELS.join('|')}）
  note --title <t> [--why <w>] [--draft]   记一条 kind:decision 原子（--draft = 机器代写草稿）
  confirm <atom-id> [--why <w>] [--verdict <v>]   确认一条原子（v = confirm|dispute，缺省 confirm；追加记录，不改原行）
  confirm --list                       列出决策原子的已确认 / 待确认 / 已否决（口径与 doctor 的 confirm 行同源）
  evidence [--json]                    证据账本（只读）：每条 decision|rejected|correction 的来源 / 定位 / 时间 / 置信 / 确认人
  human export [--out <file>]          导出 per-human 档案为可移植 JSON（含 schemaVersion）
  human clear --kind <k> [--yes]       清除 per-human 记录（k = visits|read|blackbox|checks|all）；缺 --yes 只报将删条数
  budget <n> [--dimension <d>]         设每版本预算上限（d = tokens|calls|ms，缺省 calls）
  budget --clear                       清空预算 = 不阻断（auto 立刻放行）
  doctor [--json]                      体检：hook 指向 / 上次捕获 / 断流天数 / 捕获率（窗口 + 累计，只读）

options:
  --root <repo>   仓库根目录（默认当前目录）
  --json          doctor / evidence 的机器可读输出（字段契约见各模块的 *_SCHEMA_VERSION）
  --draft         note：写 status:'draft'（agent 代捕获约定——机器代写只能是草稿）
  --verdict <v>   confirm：判定（confirm|dispute，缺省 confirm）；dispute → 派生状态 disputed
  --list          confirm：列出确认队列（不给 atom-id 时用它）
  --yes             human clear：确认执行（缺失时只报将删条数、不删）
  --dimension <d>   budget 的计量维度（tokens|calls|ms）；缺省 calls（后端不回报 token 用量）
  --clear           budget：清空预算（与 <n> 互斥，同时给了以 --clear 为准）
  --capture-rate-min <pct>   doctor 捕获率下限（百分数 0–100）；也可写进 .lore/config.yml 的 doctor:
  --gap-days-max <days>      doctor 断流上限（天）；也可写进 .lore/config.yml 的 doctor:
  --capture-window <n>       doctor 捕获率窗口（最近 n 个提交，默认 50）；也可写进 doctor.capture_window_commits`;

// 与 lib/note.js / lib/serve.js 同一套解析约定：--key value + 位置参数进 _。
// 布尔开关（不取值）单列——否则 `doctor --json --root x` 会把 --root 吞成 --json 的值。
const BOOLEAN_FLAGS = new Set(['json', 'draft', 'clear', 'yes', 'list']);

// 旗标的下一个 token 又是旗标（`doctor --capture-rate-min --json`）→ 解析期报错。
// 旧实现 `out[key] = argv[++i]` 会把它吞成值：--json 静默失效、阈值变成 '--json'——正是本仓最忌的
// 「安静地不工作」（评审 🔵#4）。缺值（旗标在末尾）仍由各 verb 自己的 `--x requires <...>` 兜底，
// 那样消息更具体（--root / --out / --kind 各有各的提示）。
class FlagValueError extends Error {
  constructor(flag) { super(`flag --${flag} requires a value`); this.name = 'FlagValueError'; this.flag = flag; }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) { out[key] = true; continue; }
      const next = argv[i + 1];
      if (next !== undefined && next.startsWith('--')) throw new FlagValueError(key);
      out[key] = next;
      i++;
    } else out._.push(a);
  }
  return out;
}

const label = r => (r.deduped ? ' (deduped)' : '');
const list = s => (s ? s.split(',').map(x => x.trim()).filter(Boolean) : []);

function cmdVisit({ page, loreDir, out }) {
  const r = appendHuman(loreDir, 'visits', visitRecord({ page }));
  out(`✓ visit ${page}${label(r)}`);
  return 0;
}

function cmdRead({ page, at, loreDir, out }) {
  const r = appendHuman(loreDir, 'read', readRecord({ page, at }));
  out(`✓ read ${page} @ ${at}${label(r)}`);
  return 0;
}

function cmdBlackbox({ module: mod, level, loreDir, out }) {
  const r = appendHuman(loreDir, 'blackbox', blackboxRecord({ module: mod, level }));
  out(`✓ blackbox ${mod} = ${level}${label(r)}`);
  return 0;
}

// note：形状与写入路径全在 lib/note.js（appendNote）——这里只做参数映射与边界检查。
// 未 init 的目录明确报错（与 visit/read/blackbox 同一纪律：不静默写散文件）。
function cmdNote({ repoRoot, loreDir, args, out, err }) {
  if (!args.title) return { code: 1, usage: 'note requires --title <title>' };
  if (!existsSync(loreDir)) {
    err(`lore: no .lore at ${loreDir} — run /lore:init first`);
    return { code: 1 };
  }
  const atom = appendNote(repoRoot, {
    title: args.title,
    why: args.why ?? '',
    component: list(args.component),
    flow: list(args.flow),
    theme: list(args.theme),
    files: list(args.files),
    anchors: list(args.anchors),
    draft: args.draft === true,
  });
  out(`✓ note ${atom.id}${atom.status === 'draft' ? ' (draft)' : ''}`);
  return { code: 0 };
}

// confirm：owner 的确认（形状、幂等、派生全在 lib/confirm.js）——这里只做参数映射与边界检查。
// 未 init 的目录明确报错（与 note/visit 同一纪律：不静默写散文件）。
function cmdConfirm({ journalDir, loreDir, args, rest, out, err }) {
  if (!existsSync(loreDir)) {
    err('lore: no .lore at ' + loreDir + ' — run /lore:init first');
    return { code: 1 };
  }
  if (args.list === true) return cmdConfirmList({ journalDir, loreDir, out });
  const atomId = rest[0];
  if (!atomId) return { code: 1, usage: 'confirm requires <atom-id> or --list' };
  // 未知 atom id / 非法 verdict → ConfirmError（在 main 的 catch 里变 exit 1），绝不静默写一条指向空气的确认。
  const r = confirmAtom(journalDir, { atom: atomId, verdict: args.verdict ?? DEFAULT_VERDICT, why: args.why ?? '' });
  const status = r.record.verdict === 'dispute' ? 'disputed' : 'confirmed';
  out('✓ confirm ' + atomId + ' → ' + status + ' · ' + r.record.id + label(r));
  return { code: 0 };
}

// confirm --list：确认队列的人读出口。口径与 doctor 的 confirm 行**同源**（都出自 lib/confirm.js 的派生），
// 本文件不复制一份派生规则。列出范围 = 决策原子（确认队列本身）+ 任何已被确认过的原子
// （否则「确认过一条 pitfall」在账上凭空消失）。摘要行只报决策口径（与 doctor 一致），故明确标注「决策」。
function cmdConfirmList({ journalDir, loreDir, out }) {
  const atoms = readAllAtoms(journalDir);
  const confirmations = readConfirmations(journalDir);
  const derived = deriveStatuses(atoms, confirmations);
  const summary = confirmationSummary(atoms, confirmations);
  const confirmedIds = new Set(confirmations.map(c => c.atom));
  const rows = atoms
    .map((atom, i) => ({ atom, status: derived[i].status }))
    .filter(r => r.atom.kind === 'decision' || confirmedIds.has(r.atom.id));

  out('lore confirm — ' + loreDir);
  out('  决策 已确认 ' + summary.confirmed + ' · 待确认 ' + summary.pending + ' · 已否决 ' + summary.disputed
    + '（决策 ' + summary.decisions + ' · confirmation 记录 ' + summary.records + '）');
  if (rows.length === 0) { out('  （无决策原子）'); return 0; }
  out('');
  const bucket = status => (status === 'confirmed' ? 'confirmed' : status === 'disputed' ? 'disputed' : 'pending');
  for (const [key, title, mark] of [['confirmed', '已确认', '✓'], ['pending', '待确认', '·'], ['disputed', '已否决', '✗']]) {
    const items = rows.filter(r => bucket(r.status) === key);
    if (items.length === 0) continue;
    out('  ' + title + ' (' + items.length + ')');
    for (const r of items) {
      // 派生状态来自确认记录时不再重复打印（分组名已经说了）；否则标出内联 status（draft / superseded…）
      const inline = bucket(r.status) === 'pending' && r.status ? ' [' + r.status + ']' : '';
      out('    ' + mark + ' ' + r.atom.id + inline + (r.atom.title ? ' — ' + r.atom.title : ''));
    }
  }
  return 0;
}

function cmdHumanExport({ loreDir, outPath, cwd, out }) {
  const doc = exportHuman(loreDir);
  const json = JSON.stringify(doc, null, 2) + '\n';
  if (!outPath) { out(json.trimEnd()); return 0; }
  const p = resolve(cwd, outPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, json);
  out(`✓ exported ${doc.records.length} records → ${p}`);
  return 0;
}

// human clear：不变量⑥「可清除」的 CLI 出口。写前只报将删条数，--yes 才真删。
// 缺 --yes → exit 1（不是 0）：静默的「什么都没做」正是本仓最忌讳的失败形态（「安静地不工作」）。
function cmdHumanClear({ loreDir, args, out, err }) {
  if (!args.kind) return { code: 1, usage: 'human clear requires --kind <' + CLEAR_KINDS.join('|') + '>' };
  const preview = clearHuman(loreDir, args.kind, { dryRun: args.yes !== true });
  if (args.yes !== true) {
    err('lore: will delete ' + preview.cleared + ' record(s) from ' + args.kind
      + ' — re-run with --yes to confirm');
    return { code: 1 };
  }
  out('✓ cleared ' + preview.cleared + ' record(s) (' + args.kind + ')');
  return { code: 0 };
}

// budget：每版本预算上限 + 计量维度（审计 D4 的「原因出口」）。
// 形状/校验全在 lib/syncstate.js 的 writeBudgetConfig（这里只做参数映射与边界检查）。
// 未 init（无 .lore）→ 明确报错：别在没初始化的目录里凭空造 .lore/.state。
function cmdBudget({ loreDir, stateDir, args, rest, out, err }) {
  if ('dimension' in args && !args.dimension) return { code: 1, usage: '--dimension requires <tokens|calls|ms>' };
  if (!existsSync(loreDir)) {
    err('lore: no .lore at ' + loreDir + ' — run /lore:init first');
    return { code: 1 };
  }
  try {
    if (args.clear === true) {
      writeBudgetConfig(stateDir, { budget: null });
      out('✓ budget cleared (未配置 = 不阻断)');
      return { code: 0 };
    }
    const raw = rest[0];
    if (raw === undefined) return { code: 1, usage: 'budget requires <n> or --clear' };
    const n = Number(raw);
    writeBudgetConfig(stateDir, { budget: n, dimension: args.dimension ?? DEFAULT_BUDGET_DIMENSION });
    const cfg = readBudgetConfig(stateDir);
    out('✓ budget ' + cfg.budget + ' (dimension ' + cfg.dimension + ')');
    return { code: 0 };
  } catch (e) {
    err('lore: ' + e.message);            // 非法取值：明确消息 + exit 1（不打印用法块，同 --level）
    return { code: 1 };
  }
}

// 返回退出码（不调 process.exit —— 便于测试直接调用 main）。
export function main(argv, { cwd = process.cwd(), out = console.log, err = console.error } = {}) {
  const badUsage = msg => { if (msg) err(`lore: ${msg}`); err(USAGE); return 1; };
  let args;
  try { args = parseArgs(argv); }
  catch (e) {
    if (e instanceof FlagValueError) return badUsage(e.message);   // 旗标吞旗标 → 用法错误 + exit 1
    throw e;
  }
  const [verb, ...rest] = args._;
  // --root 给了却没值 → 显式报错（与 --out 同一纪律），不静默回落 cwd：静默回落会把读写落到
  // 调用者没预期的地方（审计 D9-cli）。检查在任何 verb 分发之前，所有 verb 一致。
  if ('root' in args && !args.root) return badUsage('--root requires <repo>');
  const repoRoot = resolve(cwd, args.root ?? '.');
  const loreDir = join(repoRoot, '.lore');

  try {
    switch (verb) {
      case 'visit': {
        const page = rest[0];
        if (!page) return badUsage('visit requires <page>');
        return cmdVisit({ page, loreDir, out });
      }
      case 'read': {
        const page = rest[0];
        if (!page) return badUsage('read requires <page>');
        if (!args.at) return badUsage('read requires --at <version> (已阅 @ 版本戳)');
        return cmdRead({ page, at: args.at, loreDir, out });
      }
      case 'blackbox': {
        const mod = rest[0];
        if (!mod) return badUsage('blackbox requires <module>');
        if (!args.level) return badUsage(`blackbox requires --level <${BLACKBOX_LEVELS.join('|')}>`);
        return cmdBlackbox({ module: mod, level: args.level, loreDir, out });
      }
      case 'note': {
        const r = cmdNote({ repoRoot, loreDir, args, out, err });
        if (r.usage) return badUsage(r.usage);
        return r.code;
      }
      case 'confirm': {
        // --verdict 给了却没值 → 用法错误（不静默回落 confirm：那会让 dispute 变成一次误确认）
        if ('verdict' in args && !args.verdict) return badUsage('--verdict requires <' + VERDICTS.join('|') + '>');
        const r = cmdConfirm({ journalDir: join(loreDir, 'journal'), loreDir, args, rest, out, err });
        if (r.usage) return badUsage(r.usage);
        return r.code;
      }
      case 'doctor': {
        // 阈值旗标给了却没值 → 用法错误（不静默回落成「未配置」——那会让闸门悄悄失效）
        if ('capture-rate-min' in args && !args['capture-rate-min']) return badUsage('--capture-rate-min requires <percent>');
        if ('gap-days-max' in args && !args['gap-days-max']) return badUsage('--gap-days-max requires <days>');
        if ('capture-window' in args && !args['capture-window']) return badUsage('--capture-window requires <commits>');
        const report = diagnose(repoRoot, {
          exec: execFileSync,
          gate: {
            captureRateMinPct: args['capture-rate-min'],
            gapDaysMax: args['gap-days-max'],
            captureWindowCommits: args['capture-window'],
          },
        });
        out(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
        // 闸门不通过 → 非零退出（CI 与壳状态行的机器可读出口；人读告警已在 formatReport 里）
        if (!report.gate.ok) { err(`lore: capture gate failed — ${report.gate.reason}`); return 1; }
        return 0;
      }
      case 'evidence': {
        // 只读账本。未 init → 明确报错（0 条结论会被误读成「查过了、没有结论」，那是 doctor 明令禁止的 0 冒充 unknown）。
        if (!existsSync(loreDir)) {
          err('lore: no .lore at ' + loreDir + ' — run /lore:init first');
          return 1;
        }
        const report = evidenceReport(repoRoot);
        out(args.json ? JSON.stringify(report, null, 2) : formatEvidence(report));
        return 0;
      }
      case 'budget': {
        const r = cmdBudget({ loreDir, stateDir: join(loreDir, '.state'), args, rest, out, err });
        if (r.usage) return badUsage(r.usage);
        return r.code;
      }
      case 'human': {
        const sub = rest[0];
        if (sub === 'clear') {
          // --kind 给了却没值 → 用法错误（不静默当「没给」）
          if ('kind' in args && !args.kind) return badUsage('--kind requires <' + CLEAR_KINDS.join('|') + '>');
          const r = cmdHumanClear({ loreDir, args, out, err });
          if (r.usage) return badUsage(r.usage);
          return r.code;
        }
        if (sub !== 'export') return badUsage(`unknown subcommand: human ${sub ?? '(none)'} (expected: human export|clear)`);
        // --out 给了却没值 → 报错，别静默改道 stdout（用户要的是文件）
        if ('out' in args && !args.out) return badUsage('human export --out requires <file>');
        return cmdHumanExport({ loreDir, outPath: args.out, cwd, out });
      }
      default:
        return badUsage(verb ? `unknown verb: ${verb}` : null);
    }
  } catch (e) {
    // 域错误 → 可读消息 + exit 1（不打印栈：那只是把同一条消息埋深一层）。
    if (e instanceof HumanStoreError || e instanceof ConfirmError) { err(`lore: ${e.message}`); return 1; }
    throw e;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
