// lib/cli.js —— 统一 CLI 入口（不变量④ CLI 对等；设计 §7 ⓪ 期）。
//
// 只做分发：参数映射 → 调用既有模块的既有函数。业务逻辑一律不住这里——
// per-human 记录形状与写入纪律在 lib/human.js，本文件不复制一份。
//
// 用法：node lib/cli.js <verb> [args] [--root <repo>]
//   visit <page>                        阅读痕迹（壳调用，同页短窗去重）
//   read <page> --at <version>          已阅 @ 版本戳（缺 --at 即非法：确认绑版本）
//   blackbox <module> --level <懂|半懂|黑盒>   黑盒自评
//   human export [--out <file>]         导出 per-human 档案（含 schemaVersion）
//
// 未 init（无 .lore）→ 明确报错 exit 1（HumanStoreError 冒泡到这里的唯一出口）。
// 未知 verb / 缺参数 → 用法 + exit 1。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLACKBOX_LEVELS, HumanStoreError, appendHuman, blackboxRecord, exportHuman, readRecord, visitRecord,
} from './human.js';

export const USAGE = `lore — unified CLI

usage: node lib/cli.js <verb> [args] [--root <repo>]

verbs:
  visit <page>                         记录一次页面打开（壳调用；同页短窗去重）
  read <page> --at <version>           标记「已阅 @ 版本戳」（版本戳必填）
  blackbox <module> --level <level>    黑盒自评（${BLACKBOX_LEVELS.join('|')}）
  human export [--out <file>]          导出 per-human 档案为可移植 JSON（含 schemaVersion）

options:
  --root <repo>   仓库根目录（默认当前目录）`;

// 与 lib/note.js / lib/serve.js 同一套解析约定：--key value + 位置参数进 _。
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

const label = r => (r.deduped ? ' (deduped)' : '');

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
  const loreDir = join(resolve(cwd, args.root ?? '.'), '.lore');
  const badUsage = msg => { if (msg) err(`lore: ${msg}`); err(USAGE); return 1; };

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
