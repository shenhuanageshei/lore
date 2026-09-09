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
//   human export [--out <file>]         导出 per-human 档案（含 schemaVersion）
//   doctor [--json]                     体检（只读）：报告形状在 lib/doctor.js，本文件不复制一份
//
// 未 init（无 .lore）→ 明确报错 exit 1（HumanStoreError 冒泡到这里的唯一出口；note 同一纪律）。
// 例外：doctor 是报告不是断言——缺 .lore / 非 git 都降级 unknown 并 exit 0；**除非配了捕获闸门阈值**
// （config 的 doctor: 子块或 --capture-rate-min/--gap-days-max），此时闸门不通过 → exit 1。
// 未知 verb / 缺参数 → 用法 + exit 1。

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLACKBOX_LEVELS, HumanStoreError, appendHuman, blackboxRecord, exportHuman, readRecord, visitRecord,
} from './human.js';
import { diagnose, formatReport } from './doctor.js';
import { appendNote } from './note.js';

export const USAGE = `lore — unified CLI

usage: node lib/cli.js <verb> [args] [--root <repo>]

verbs:
  visit <page>                         记录一次页面打开（壳调用；同页短窗去重）
  read <page> --at <version>           标记「已阅 @ 版本戳」（版本戳必填）
  blackbox <module> --level <level>    黑盒自评（${BLACKBOX_LEVELS.join('|')}）
  note --title <t> [--why <w>] [--draft]   记一条 kind:decision 原子（--draft = 机器代写草稿）
  human export [--out <file>]          导出 per-human 档案为可移植 JSON（含 schemaVersion）
  doctor [--json]                      体检：hook 指向 / 上次捕获 / 断流天数 / 决策捕获率（只读）

options:
  --root <repo>   仓库根目录（默认当前目录）
  --json          doctor 的机器可读输出（字段契约见 lib/doctor.js 的 DOCTOR_SCHEMA_VERSION）
  --draft         note：写 status:'draft'（agent 代捕获约定——机器代写只能是草稿）
  --capture-rate-min <pct>   doctor 捕获率下限（百分数 0–100）；也可写进 .lore/config.yml 的 doctor:
  --gap-days-max <days>      doctor 断流上限（天）；也可写进 .lore/config.yml 的 doctor:`;

// 与 lib/note.js / lib/serve.js 同一套解析约定：--key value + 位置参数进 _。
// 布尔开关（不取值）单列——否则 `doctor --json --root x` 会把 --root 吞成 --json 的值。
const BOOLEAN_FLAGS = new Set(['json', 'draft']);
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) { out[key] = true; continue; }
      out[key] = argv[++i];
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

// 返回退出码（不调 process.exit —— 便于测试直接调用 main）。
export function main(argv, { cwd = process.cwd(), out = console.log, err = console.error } = {}) {
  const args = parseArgs(argv);
  const [verb, ...rest] = args._;
  const badUsage = msg => { if (msg) err(`lore: ${msg}`); err(USAGE); return 1; };
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
      case 'doctor': {
        // 阈值旗标给了却没值 → 用法错误（不静默回落成「未配置」——那会让闸门悄悄失效）
        if ('capture-rate-min' in args && !args['capture-rate-min']) return badUsage('--capture-rate-min requires <percent>');
        if ('gap-days-max' in args && !args['gap-days-max']) return badUsage('--gap-days-max requires <days>');
        const report = diagnose(repoRoot, {
          exec: execFileSync,
          gate: { captureRateMinPct: args['capture-rate-min'], gapDaysMax: args['gap-days-max'] },
        });
        out(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
        // 闸门不通过 → 非零退出（CI 与壳状态行的机器可读出口；人读告警已在 formatReport 里）
        if (!report.gate.ok) { err(`lore: capture gate failed — ${report.gate.reason}`); return 1; }
        return 0;
      }
      case 'human': {
        const sub = rest[0];
        if (sub !== 'export') return badUsage(`unknown subcommand: human ${sub ?? '(none)'} (expected: human export)`);
        // --out 给了却没值 → 报错，别静默改道 stdout（用户要的是文件）
        if ('out' in args && !args.out) return badUsage('human export --out requires <file>');
        return cmdHumanExport({ loreDir, outPath: args.out, cwd, out });
      }
      default:
        return badUsage(verb ? `unknown verb: ${verb}` : null);
    }
  } catch (e) {
    if (e instanceof HumanStoreError) { err(`lore: ${e.message}`); return 1; }
    throw e;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
