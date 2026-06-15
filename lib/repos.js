// lib/repos.js — ~/.lore/repos.json 仓库登记（portal 发现本机各 repo）。
// 复用 registry.js 模式：纯函数 + 路径注入（reposPath 参数）便于测试。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';

export function defaultReposPath(home = homedir()) {
  return join(home, '.lore', 'repos.json');
}

function read(path) {
  if (!existsSync(path)) return [];
  try { const a = JSON.parse(readFileSync(path, 'utf8')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function write(path, arr) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(arr, null, 2) + '\n');
}

// 读 repos.json，过滤掉 loreDir 已不存在的条目（best-effort 自愈）。
export function listRepos(reposPath = defaultReposPath()) {
  return read(reposPath).filter(e => e && e.loreDir && existsSync(e.loreDir));
}

// 登记本 repo。name = repo 根目录名（loreDir 的父目录 basename）；同 loreDir 幂等返回原条目；
// 同名不同 loreDir 加后缀 -2/-3…。写回 repos.json，返回写入的条目。
export function registerRepo(reposPath, { loreDir }) {
  // Windows path.join 产反斜杠，与既有正斜杠条目字符串不等会重复登记（实测 mal-analyze-cli + -2）。
  // 归一为正斜杠后再比对/存储——比较两边都归一，旧反斜杠条目也能正确去重。
  const norm = s => String(s).replace(/\\/g, '/');
  const target = norm(loreDir);
  const arr = read(reposPath);
  const existing = arr.find(e => norm(e.loreDir) === target);
  if (existing) return existing;
  const base = basename(dirname(target));
  const taken = new Set(arr.map(e => e.name));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  const entry = { name, loreDir: target };
  arr.push(entry);
  write(reposPath, arr);
  return entry;
}
