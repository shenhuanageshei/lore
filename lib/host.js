// lib/host.js —— 多宿主能力矩阵 + 机器层启用清单（spec 2026-07-19-lore-multi-host）。
// 每宿主一个适配器对象声明差异面；启用清单是机器级（~/.lore/hosts.json），默认 ["claude"] ——
// 现有纯 Claude 用户磁盘 diff 为零（不变量，测试显式守）。
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const HOSTS = {
  claude: {
    instructionFiles: ['CLAUDE.md'],
    mcp: 'repo',                 // repo 级 .mcp.json（resident.js/migrate.js 现状）
    commands: null,              // 插件自带 commands/，不生成
    promptHook: 'settings',      // lorehook.js 现状
  },
  codex: {
    instructionFiles: ['AGENTS.md'],
    mcp: 'codex-toml',           // ~/.codex/config.toml [mcp_servers.lore]
    commands: { dir: h => join(h, '.codex', 'prompts') },   // 调 /prompts:lore-*
    promptHook: null,            // codex 无 prompt 钩子机制 → 软档封顶
  },
  opencode: {
    instructionFiles: ['AGENTS.md'],
    mcp: 'opencode-json',        // ~/.config/opencode/opencode.json mcp.lore
    commands: { dir: h => join(h, '.config', 'opencode', 'commands') },   // 调 /lore-*
    promptHook: 'opencode-plugin',
  },
};

export const HOST_NAMES = Object.keys(HOSTS);

export function defaultHostsPath(home = homedir()) { return join(home, '.lore', 'hosts.json'); }

export function readEnabledHosts(hostsPath = defaultHostsPath()) {
  if (!existsSync(hostsPath)) return ['claude'];
  try {
    const hs = JSON.parse(readFileSync(hostsPath, 'utf8'))?.hosts;
    const ok = Array.isArray(hs) ? hs.filter(h => HOST_NAMES.includes(h)) : [];
    return ok.length ? ok : ['claude'];
  } catch { return ['claude']; }
}

export function writeEnabledHosts(hosts, hostsPath = defaultHostsPath()) {
  const clean = [...new Set((hosts ?? []).filter(h => HOST_NAMES.includes(h)))];
  if (!clean.length) throw new Error('lore: at least one host required');
  mkdirSync(dirname(hostsPath), { recursive: true });
  writeFileSync(hostsPath, JSON.stringify({ hosts: clean }, null, 2) + '\n');
  return clean;
}

export function instructionFilesFor(hosts) {
  return [...new Set((hosts ?? []).flatMap(h => HOSTS[h]?.instructionFiles ?? []))];
}

export function engineRoot() { return join(dirname(fileURLToPath(import.meta.url)), '..'); }

export function engineVersion(root = engineRoot()) {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '0'; } catch { return '0'; }
}

// ---- 命令生成器：commands/*.md 单一真源 → codex/opencode 全局命令 ----
// claude 不生成（插件运行时解析 ${CLAUDE_PLUGIN_ROOT}）；其余宿主烘焙引擎绝对路径（挪位置重跑 host.js install）。
export function commandSources(root = engineRoot()) {
  try { return readdirSync(join(root, 'commands')).filter(f => f.endsWith('.md')).sort(); } catch { return []; }
}

export function renderCommandFor(host, srcName, srcText, { root = engineRoot(), version = engineVersion(root) } = {}) {
  const fwd = root.replace(/\\/g, '/');
  let text = srcText.replaceAll('${CLAUDE_PLUGIN_ROOT}', fwd);
  if (host === 'codex') text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '');   // codex prompts 无 frontmatter 概念
  const marker = `<!-- lore:v${version} host:${host} src:${srcName} — 自动生成，勿手改 -->\n`;
  return { name: `lore-${srcName}`, text: marker + text };
}

export function installHostCommands(host, { home = homedir(), root = engineRoot(), version = engineVersion(root) } = {}) {
  const spec = HOSTS[host]?.commands;
  if (!spec) return [];
  const dir = spec.dir(home);
  mkdirSync(dir, { recursive: true });
  const written = [];
  for (const src of commandSources(root)) {
    const { name, text } = renderCommandFor(host, src, readFileSync(join(root, 'commands', src), 'utf8'), { root, version });
    const p = join(dir, name);
    if (!existsSync(p) || readFileSync(p, 'utf8') !== text) { writeFileSync(p, text); written.push(name); }
  }
  return written;    // 实际改写的文件（空 = 已最新）
}

const MARK_RE = /<!--\s*lore:v\S+ host:\S+ src:\S+ — 自动生成，勿手改\s*-->/;

export function uninstallHostCommands(host, { home = homedir(), root = engineRoot() } = {}) {
  const spec = HOSTS[host]?.commands;
  if (!spec) return [];
  const dir = spec.dir(home);
  const removed = [];
  for (const src of commandSources(root)) {
    const p = join(dir, `lore-${src}`);
    // 只删带 lore 标记的——用户自建同名文件不动
    if (existsSync(p) && MARK_RE.test(readFileSync(p, 'utf8'))) { rmSync(p); removed.push(`lore-${src}`); }
  }
  return removed;
}

// finalize/migrate 顺带收敛：启用宿主的命令文件版本/内容漂移即重生成（机器层资产与 repo 资产同思路）。
export function alignHostAssets({ home = homedir(), root = engineRoot() } = {}) {
  const out = [];
  for (const h of readEnabledHosts(defaultHostsPath(home))) {
    if (!HOSTS[h]?.commands) continue;
    const written = installHostCommands(h, { home, root });
    if (written.length) out.push({ host: h, action: `refreshed ${written.length} commands` });
  }
  return out;
}
