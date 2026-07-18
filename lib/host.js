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
