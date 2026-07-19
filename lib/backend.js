// lib/backend.js —— auto 档 LLM 重写后端（spec 2026-07-19-lore-multi-host）。
// 契约：backend = { name, rewritePage({page, repoRoot, timeoutMs}) → Promise<string> }；抛错 = 该页失败。
// BackendError.unavailable=true 仅「后端不可用类」（cli-missing/auth/provider）——runner 只对这类 failover。
import { execFile } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export class BackendError extends Error {
  constructor(message, { unavailable = false } = {}) { super(message); this.unavailable = unavailable; }
}

// 各轴重写指引（B3 扩轴）：哨兵原位保留是共同硬约束；只输出整页 markdown。
export function axisPrompt(page) {
  const COMMON = [
    '你是 lore 的页面重写器。仓库根在当前目录。',
    `读现有页 .lore/wiki/${page.path} 与相关源码，重写整页。`,
  ];
  const TAIL = [
    '要求：保留 frontmatter 的 title/summary 结构；只输出完整 markdown 页面，不要任何解释或代码围栏。',
    '绝不调用 Write/Edit/Bash 等任何写盘工具——页面全文输出到 stdout，由调用者负责写盘。',
  ];
  // 哨兵区一律输出 token 态：物化决策史可达几十 K，让 LLM 回吐会超时且压垮防截断比例
  // （实测：theme 页 95K 物化区 → 3 页 timeout + 1 页误杀）。finalize 会重新物化。
  const JOURNAL_NOTE = '「## Decision history」节只输出单行 {{LORE_JOURNAL}}，不要搬运已物化的哨兵区内容——finalize 会重新物化填充。';
  // theme/flow 是单档页：易写成一大段密集文字，强制视觉分层。
  const LAYOUT_NOTE = '排版：用 ### 小标题把正文切成 3-6 段，枚举/对照/规则用列表或表格承载，避免连续大段密集文字（单段控制在 ~150 字内）。';
  const byAxis = {
    component: [
      `源码入口：${page.codeRoot ?? page.sourceFile ?? '相关模块'}。`,
      '按 lore 的两档页面标准（概览档零黑话 + 机制档 <details> 折叠 + 锚点锚符号）重写。',
      '枚举型事实整理成表收进机制档：入口全景（功能从哪几条路进来）、途径/分发 dispatch 表、跳过/拒绝原因全集、状态机——散在多个文件的同主题清单是 wiki 最高价值内容，宁全勿略。',
      JOURNAL_NOTE,
    ],
    theme: [
      '这是横切主线页：重写「Current state」——这条主线的当前状态/约束/为什么重要，据真实源码与近期演进写，非泛词。',
      LAYOUT_NOTE,
      JOURNAL_NOTE,
    ],
    flow: [
      '这是数据流页：重写「End-to-end path」——这条数据流端到端怎么跑。顶部 mermaid 数据流图（入口 → 各阶段(组件) → 出口），prose 讲关键转换/约束。',
      LAYOUT_NOTE,
      JOURNAL_NOTE,
    ],
    HOME: [
      '这是全仓认知入口页：一句话定位 → 状态节只输出单行 {{LORE_HOME_STATUS}}（不要搬运物化区，finalize 会重新填充）→ 一张「本仓库总览」mermaid → 「理解项目/排查问题/决策与时间线」三个 wikilink 导航节。',
      '「本仓库总览」图：读 .lore/wiki/component/ 各页与 .lore/wiki/flow/ 各页综合，把本仓库的主要组件/包当节点、按真实依赖或端到端数据流连边，让人一眼看懂这个项目由哪几块组成、怎么协作；节点用仓库里的真实名字。不要画 lore 工具自身的 capture/journal/sync 流程。',
    ],
  };
  // 重写/改进（带 instruction）：注入用户对本页的额外要求，从「通用重写」升级为「按你的意图改」。
  // 仍在页面标准前提下满足——写盘照过质量门，指令只影响 prose 走向。
  const USER = (page.instruction ?? '').trim()
    ? [`【用户对本页的额外要求（在保持上述页面标准的前提下满足）】：${String(page.instruction).trim()}`]
    : [];
  return [...COMMON, ...(byAxis[page.axis] ?? byAxis.component), ...USER, ...TAIL].join('\n');
}

function classify(name, err, stderr) {
  // 诊断优先 stderr：err.message 只是命令行回显、不含退出原因（踩坑记录：只记 message 截 80 字符 → 诊断零信息）
  const detail = String(stderr ?? '').trim() || String(err.message ?? '');
  if (err.code === 'ENOENT') return new BackendError(`${name}-cli-missing`, { unavailable: true });
  if (err.killed) return new BackendError(`${name} timeout`);
  if (/auth|login|unauthor|未登录|api.key/i.test(detail)) return new BackendError(`${name} auth: ${detail.slice(0, 300)}`, { unavailable: true });
  return new BackendError(`${name} exit: ${detail.slice(0, 300)}`);
}

// LLM 只读：claude 工具白名单；页面全文走 stdout，写盘权在 runner。
export function claudeBackend({ exec = execFile } = {}) {
  return {
    name: 'claude',
    rewritePage({ page, repoRoot, timeoutMs = 1_200_000 }) {
      const prompt = axisPrompt(page);
      return new Promise((resolveP, rejectP) => {
        exec('claude', ['-p', '--allowedTools', 'Read,Grep,Glob', '--disallowedTools', 'Write,Edit,Bash', prompt],
          { cwd: repoRoot, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
          (err, stdout, stderr) => {
            if (err) return rejectP(classify('claude', err, stderr));
            const i = stdout.indexOf('---');               // stdout 可能混入日志：取首个 frontmatter 起到文末
            resolveP(i >= 0 ? stdout.slice(i) : stdout);
          });
      });
    },
  };
}

// codex：--sandbox read-only 内核级只读；--output-last-message 直取最终消息（失败回落 stdout 截取）。
export function codexBackend({ exec = execFile } = {}) {
  return {
    name: 'codex',
    rewritePage({ page, repoRoot, timeoutMs = 1_200_000 }) {
      const prompt = axisPrompt(page);
      const outFile = join(repoRoot, '.lore', '.state', 'codex-last-message.md');
      try { rmSync(outFile, { force: true }); } catch { /* best-effort：预清防上一轮残留文件被当本轮输出 */ }
      return new Promise((resolveP, rejectP) => {
        exec('codex', ['exec', prompt, '-C', repoRoot, '--sandbox', 'read-only', '--output-last-message', outFile],
          { cwd: repoRoot, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
          (err, stdout, stderr) => {
            if (err) return rejectP(classify('codex', err, stderr));
            let text = '';
            try { text = readFileSync(outFile, 'utf8'); } catch { /* 文件缺 → stdout 回落 */ }
            try { rmSync(outFile, { force: true }); } catch { /* best-effort */ }
            if (!text.trim()) {
              const i = stdout.indexOf('---');
              text = i >= 0 ? stdout.slice(i) : stdout;
            }
            resolveP(text);
          });
      });
    },
  };
}

// opencode：无 CLI 级 sandbox 旗标——prompt TAIL「绝不调用写盘工具」+ 质量门双保险（与 claude 加
// --disallowedTools 前的风险同级；LLM 即使违规写盘，页面落盘仍只认 stdout 且过质量门）。
export function opencodeBackend({ exec = execFile } = {}) {
  return {
    name: 'opencode',
    rewritePage({ page, repoRoot, timeoutMs = 1_200_000 }) {
      const prompt = axisPrompt(page);
      return new Promise((resolveP, rejectP) => {
        exec('opencode', ['run', prompt],
          { cwd: repoRoot, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
          (err, stdout, stderr) => {
            if (err) return rejectP(classify('opencode', err, stderr));
            const i = stdout.indexOf('---');
            resolveP(i >= 0 ? stdout.slice(i) : stdout);
          });
      });
    },
  };
}

export const BACKEND_ORDER = ['claude', 'codex', 'opencode'];

// 回调式 exec 探测（永不抛：ENOENT/超时/非零退出都归一 ok:false）
function probe(exec, cmd, args, timeoutMs = 5000) {
  return new Promise(res => {
    exec(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      res({ ok: !err, stdout: String(stdout ?? '') });
    });
  });
}

// 探测 = binary on PATH + provider 可用（装了但没登录/没配 provider 要跳过）。
// claude 无廉价 auth 探针 → 只验 binary（auth 失败走运行时 failover）。
export async function detectAvailableBackends({ exec = execFile, order = BACKEND_ORDER } = {}) {
  const out = [];
  for (const name of order) {
    if (name === 'claude') {
      if ((await probe(exec, 'claude', ['--version'])).ok) out.push('claude');
    } else if (name === 'codex') {
      if ((await probe(exec, 'codex', ['--version'])).ok && (await probe(exec, 'codex', ['login', 'status'])).ok) out.push('codex');
    } else if (name === 'opencode') {
      if ((await probe(exec, 'opencode', ['--version'])).ok && (await probe(exec, 'opencode', ['auth', 'list'])).ok) out.push('opencode');
    }
  }
  return out;
}

export function backendFor(name, opts = {}) {
  return { claude: claudeBackend, codex: codexBackend, opencode: opencodeBackend }[name]?.(opts) ?? null;
}

// configured: 'auto' | 具体后端名。返回链 [primary, ...fallbacks]；探测全 best-effort。
export async function resolveBackendChain(configured = 'auto', { exec = execFile } = {}) {
  if (configured && configured !== 'auto') {
    const b = backendFor(configured, { exec });
    return b ? [b] : [];
  }
  const names = await detectAvailableBackends({ exec });
  return names.map(n => backendFor(n, { exec }));
}
