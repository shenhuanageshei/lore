// lib/lorehook.js —— agent 消费三档（软/中/强）的 UserPromptSubmit hook（spec 2026-06-13-lore-prompt-hook）。
// 软档（默认）= CLAUDE.md resident，不装 hook。中/强档显式 install 才写 .claude/settings.local.json。
// hook 由 harness 每轮执行、agent 绕不过——比 CLAUDE.md 软提示硬一档。run 永不抛（不能挡用户 prompt）。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchPages, formatHits } from './ask.js';

// 中档注入文案：混合范式三句（与 resident 同源，但每轮新鲜注入不被长对话稀释）。
const NOTICE = '【lore】本 repo 有 wiki：理解架构/查代码先 `lore_ask "<关键词>"` 建框架 → 顺页内 `func @ file` 锚点直接 Read 下钻源码（别一上来全文 grep）；查「为什么/决策」用 `lore_page section="Decision history"`。';

// 代码理解信号词（中文 + 英文）；纯闲聊前缀排除。
const CODE_SIGNALS = /怎么|为什么|哪里|如何|架构|实现|模块|函数|方法|逻辑|流程|入口|查找|查一下|理解|在哪|哪个|怎样|是什么|how|why|where|architect|implement|module|function|method|find|understand|trace|explain/i;
const CHITCHAT = /^\s*(你好|谢谢|多谢|继续|push|ok|okay|好的|嗯|收到|行|可以了|done|stop|算了)\b/i;
// 中文连写无词边界——停用词当「分隔符」replace 成空格，切出两边实词；英文靠空格分词、整词 filter。
const ZH_STOP = ['的', '了', '是', '在', '吗', '呢', '吧', '啊', '为什么', '怎么', '怎样', '如何', '这个', '那个', '一下', '请问', '帮我', '是什么'];
const EN_STOP = new Set(['the', 'is', 'a', 'an', 'of', 'to', 'how', 'why', 'does', 'do', 'in', 'on', 'what', 'where']);

export function looksLikeCodeQuestion(prompt) {
  const p = (prompt ?? '').trim();
  if (!p || CHITCHAT.test(p)) return false;
  return CODE_SIGNALS.test(p);
}

// 取实词喂 lore_ask：去标点 → 中文停用词当分隔符 → 英文停用词 filter → 留 2-6 个。
export function keywords(prompt) {
  let s = (prompt ?? '').replace(/[^\p{L}\p{N}\s]/gu, ' ');
  for (const w of ZH_STOP) s = s.split(w).join(' ');
  return s.split(/\s+/).filter(w => w.length >= 2 && !EN_STOP.has(w.toLowerCase())).slice(0, 6).join(' ');
}

// 门控 + 注入内容。search: (query)→string（已格式化切片或空），注入便于测；CLI 用 searchPages+formatHits。
export function gateEnrich(prompt, { level, search } = {}) {
  if (level === 'notice') return { inject: true, context: NOTICE };
  if (level === 'inject') {
    if (!looksLikeCodeQuestion(prompt)) return { inject: false, context: '' };
    const slice = search ? (search(keywords(prompt)) || '') : '';
    if (!slice.trim() || slice === 'no matching pages') return { inject: false, context: '' };
    return { inject: true, context: `【lore wiki 命中（先看这个建框架，再按 func@file 锚点下钻源码）】\n${slice}` };
  }
  return { inject: false, context: '' };
}

// 生成 settings.json 的 UserPromptSubmit hook 片段。command 带 --level + 绝对路径 + lore 标记（lorehook.js）。
export function buildSettingsHooks(level, lorehookPath) {
  const cmd = `node "${lorehookPath.replace(/\\/g, '/')}" run --level=${level}`;
  return { UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 10 }] }] };
}

const LORE_MARK = 'lorehook.js';
function settingsPath(repoRoot, project) {
  return join(repoRoot, '.claude', project ? 'settings.json' : 'settings.local.json');
}
function readSettings(p) {
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')) ?? {}; } catch { return {}; }
}
function isLoreGroup(g) { return (g.hooks ?? []).some(h => (h.command ?? '').includes(LORE_MARK)); }

export function installHook(repoRoot, level, { project = false } = {}) {
  const here = fileURLToPath(import.meta.url);
  const p = settingsPath(repoRoot, project);
  const cfg = readSettings(p);
  cfg.hooks = cfg.hooks ?? {};
  const existing = (cfg.hooks.UserPromptSubmit ?? []).filter(g => !isLoreGroup(g));   // 删旧 lore 组（切档/幂等）
  existing.push(buildSettingsHooks(level, here).UserPromptSubmit[0]);
  cfg.hooks.UserPromptSubmit = existing;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  return { level, path: p };
}

export function uninstallHook(repoRoot, { project = false } = {}) {
  const p = settingsPath(repoRoot, project);
  if (!existsSync(p)) return { removed: false };
  const cfg = readSettings(p);
  const ups = (cfg.hooks?.UserPromptSubmit ?? []).filter(g => !isLoreGroup(g));
  if (ups.length) cfg.hooks.UserPromptSubmit = ups;
  else if (cfg.hooks) delete cfg.hooks.UserPromptSubmit;
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  return { removed: true };
}

// 当前装了哪档（读 settings 找 lore 组的 --level）。local 优先，再看 project。
export function hookStatus(repoRoot) {
  for (const project of [false, true]) {
    const cfg = readSettings(settingsPath(repoRoot, project));
    const g = (cfg.hooks?.UserPromptSubmit ?? []).find(isLoreGroup);
    if (g) {
      const cmd = g.hooks.find(h => (h.command ?? '').includes(LORE_MARK)).command;
      const m = cmd.match(/--level=(\w+)/);
      return { level: m ? m[1] : 'notice', scope: project ? 'project' : 'local' };
    }
  }
  return { level: 'soft', scope: null };   // 未装 hook = 软档（CLAUDE.md resident）
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const sub = args[0];
  const project = args.includes('--project');
  const repoRoot = process.cwd();
  if (sub === 'install') {
    const level = args[1] === 'inject' ? 'inject' : 'notice';
    const { path } = installHook(repoRoot, level, { project });
    console.log(`✓ lore prompt-hook 装为「${level}」档（${project ? '团队共享 settings.json' : '本机 settings.local.json'}）`);
    console.log(`  ${path}`);
    console.log('  软档（默认/卸载后）= CLAUDE.md resident；切档重跑 install；卸载 uninstall');
  } else if (sub === 'uninstall') {
    uninstallHook(repoRoot, { project });
    console.log('✓ 已卸载 lore prompt-hook（回落软档 = CLAUDE.md resident）');
  } else if (sub === 'status') {
    const s = hookStatus(repoRoot);
    console.log(s.level === 'soft' ? 'lore prompt-hook: 软档（未装 hook，靠 CLAUDE.md resident）'
      : `lore prompt-hook: ${s.level} 档（${s.scope}）`);
  } else if (sub === 'run') {
    // hook 入口：读 stdin {prompt} → gateEnrich → stdout JSON。永不抛。
    const level = (args.find(a => a.startsWith('--level=')) ?? '').split('=')[1] || 'notice';
    let raw = '';
    process.stdin.on('data', d => { raw += d; });
    process.stdin.on('end', () => {
      let prompt = '';
      try { prompt = JSON.parse(raw).prompt ?? ''; } catch { /* 坏 stdin → 空 */ }
      const loreDir = join(repoRoot, '.lore');
      const search = q => {
        try {
          const manifest = JSON.parse(readFileSync(join(loreDir, 'wiki', '.manifest.json'), 'utf8'));
          const hits = searchPages(manifest, q);
          const readPage = pp => { try { return readFileSync(join(loreDir, 'wiki', pp), 'utf8'); } catch { return ''; } };
          return formatHits(hits, { limit: 2, sliceCap: 800, readPage });
        } catch { return ''; }
      };
      const { inject, context } = gateEnrich(prompt, { level, search });
      if (inject) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
      }
      process.exit(0);
    });
  } else {
    console.error('usage: node lib/lorehook.js install [notice|inject] [--project] | uninstall | status | run --level=<lvl>');
    process.exit(1);
  }
}
