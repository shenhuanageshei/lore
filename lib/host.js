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

// ---- 全局 MCP 合并（机器层一次性；改前写一次性 .lore.bak 备份）----
export function backupOnce(p) {
  if (existsSync(p) && !existsSync(p + '.lore.bak')) { try { copyFileSync(p, p + '.lore.bak'); } catch { /* best-effort */ } }
}

export function codexTomlPath(home = homedir()) { return join(home, '.codex', 'config.toml'); }

// 零依赖不引 TOML 解析器：[mcp_servers.lore] 是 lore 全权管理的封闭节，按节标题正则纯文本手术，不碰他节。
// 节体按行匹配「行首非 [ 的行」——不能用 [^\[]*：TOML 数组值（args = ["..."]）本身含 [，会在节内提前截断。
// 节头 \n?：EOF 裸节头（空节、无尾换行）也要命中，否则 append 出重复节头、TOML 非法。
const CODEX_SECTION_RE = /^\[mcp_servers\.lore\][^\n]*\n?(?:(?!\[)[^\n]*\n?)*/m;

export function mergeCodexMcp(tomlPath, mcpJsPath) {
  const block = `[mcp_servers.lore]\ncommand = "node"\nargs = ["${mcpJsPath.replace(/\\/g, '/')}"]\n`;
  backupOnce(tomlPath);
  const cur = existsSync(tomlPath) ? readFileSync(tomlPath, 'utf8') : '';
  const had = CODEX_SECTION_RE.test(cur);
  // replacer 用函数形态：路径含 $ 也不会触发 $& 等特殊替换；空文件不垫 \n\n（新建文件不该以两空行开头）
  const next = had ? cur.replace(CODEX_SECTION_RE, () => block) : (cur ? cur.replace(/\n*$/, '\n\n') + block : block);
  mkdirSync(dirname(tomlPath), { recursive: true });
  writeFileSync(tomlPath, next);
  return { path: tomlPath, action: had ? 'replaced' : 'appended' };
}

export function removeCodexMcp(tomlPath) {
  if (!existsSync(tomlPath)) return false;
  const cur = readFileSync(tomlPath, 'utf8');
  if (!CODEX_SECTION_RE.test(cur)) return false;
  backupOnce(tomlPath);
  writeFileSync(tomlPath, cur.replace(CODEX_SECTION_RE, '').replace(/\n{3,}/g, '\n\n'));
  return true;
}

export function opencodeConfigPath(home = homedir()) {
  const dir = join(home, '.config', 'opencode');
  if (existsSync(join(dir, 'opencode.jsonc'))) return join(dir, 'opencode.jsonc');
  return join(dir, 'opencode.json');
}

// JSONC → JSON：单遍状态机去 // 与 块注释、去尾逗号；字符串内一律不动。
export function stripJsonc(text) {
  let out = '', i = 0, inStr = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    if (c === ',') {                       // 尾逗号：下一个非空白字符是 } 或 ] → 丢
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') { i++; continue; }
    }
    out += c; i++;
  }
  return out;
}

export function mergeOpencodeMcp(configPath, mcpJsPath) {
  backupOnce(configPath);
  let cfg = {};
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf8');
    try { cfg = configPath.endsWith('.jsonc') ? JSON.parse(stripJsonc(raw)) : JSON.parse(raw); }
    catch { throw new Error(`lore: 无法解析 ${configPath}——请手动加入 mcp.lore = {type:'local', command:['node','${mcpJsPath.replace(/\\/g, '/')}'], enabled:true}`); }
  }
  cfg.mcp = { ...(cfg.mcp ?? {}), lore: { type: 'local', command: ['node', mcpJsPath.replace(/\\/g, '/')], enabled: true } };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
  return { path: configPath };
}

export function removeOpencodeMcp(configPath) {
  if (!existsSync(configPath)) return false;
  let cfg;
  try { cfg = configPath.endsWith('.jsonc') ? JSON.parse(stripJsonc(readFileSync(configPath, 'utf8'))) : JSON.parse(readFileSync(configPath, 'utf8')); }
  catch { console.error(`lore: 无法解析 ${configPath}——请手工检查/移除 mcp.lore 条目`); return false; }   // 不 throw 击落卸载流程，但必须留诊断（否则 CLI 谎报「MCP 条目无」）
  if (!cfg?.mcp?.lore) return false;
  backupOnce(configPath);
  delete cfg.mcp.lore;
  if (!Object.keys(cfg.mcp).length) delete cfg.mcp;
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
  return true;
}

// ---- CLI：机器层安装/卸载/状态 ----
function mcpJsAbs(root = engineRoot()) { return join(root, 'lib', 'mcp.js').replace(/\\/g, '/'); }

export function installHost(name, { home = homedir(), root = engineRoot() } = {}) {
  if (!HOSTS[name]) throw new Error(`lore: unknown host "${name}" (${HOST_NAMES.join('|')})`);
  const out = { host: name, commands: [], mcp: null };
  out.commands = installHostCommands(name, { home, root });
  if (name === 'codex') out.mcp = mergeCodexMcp(codexTomlPath(home), mcpJsAbs(root));
  if (name === 'opencode') out.mcp = mergeOpencodeMcp(opencodeConfigPath(home), mcpJsAbs(root));
  const hostsPath = defaultHostsPath(home);
  writeEnabledHosts([...new Set([...readEnabledHosts(hostsPath), name])], hostsPath);
  return out;
}

export function uninstallHost(name, { home = homedir(), root = engineRoot() } = {}) {
  if (!HOSTS[name]) throw new Error(`lore: unknown host "${name}" (${HOST_NAMES.join('|')})`);
  const out = { host: name, commands: uninstallHostCommands(name, { home, root }), mcpRemoved: false };
  if (name === 'codex') out.mcpRemoved = removeCodexMcp(codexTomlPath(home));
  if (name === 'opencode') out.mcpRemoved = removeOpencodeMcp(opencodeConfigPath(home));
  const hostsPath = defaultHostsPath(home);
  const rest = readEnabledHosts(hostsPath).filter(h => h !== name);
  writeEnabledHosts(rest.length ? rest : ['claude'], hostsPath);   // 永不空集
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sub, ...names] = process.argv.slice(2);
  try {
    if (sub === 'install' && names.length) {
      for (const n of names) {
        const r = installHost(n);
        console.log(`✓ ${n}: 命令 ${r.commands.length ? `写入 ${r.commands.length} 个` : '已最新/无'}；MCP ${r.mcp ? '已注册' : '无需注册（repo 级现状）'}`);
      }
      console.log(`启用宿主：${readEnabledHosts().join(', ')}`);
    } else if (sub === 'uninstall' && names.length) {
      for (const n of names) {
        const r = uninstallHost(n);
        console.log(`✓ ${n}: 删命令 ${r.commands.length} 个；MCP 条目${r.mcpRemoved ? '已移除' : '无'}`);
      }
      console.log(`启用宿主：${readEnabledHosts().join(', ')}`);
    } else if (sub === 'status') {
      const enabled = readEnabledHosts();
      for (const n of HOST_NAMES) {
        const spec = HOSTS[n];
        const dir = spec.commands?.dir(homedir());
        const cmds = dir && existsSync(dir) ? readdirSync(dir).filter(f => f.startsWith('lore-') && f.endsWith('.md')).length : 0;
        console.log(`${n}: ${enabled.includes(n) ? '启用' : '未启用'} · 命令 ${cmds} · instructionFiles ${spec.instructionFiles.join('+')} · promptHook ${spec.promptHook ?? '无（软档）'}`);
      }
    } else {
      console.error('usage: node lib/host.js install <claude|codex|opencode>... | uninstall <name>... | status');
      process.exit(1);
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
