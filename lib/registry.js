// ~/.lore/servers.json 中央登记（活跃 lore server）。path 可注入便于测。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export function registryPath(home = homedir()) {
  return join(home, '.lore', 'servers.json');
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

export function listServers(path = registryPath()) { return read(path); }

export function registerServer(entry, path = registryPath()) {
  const arr = read(path).filter(e => e.loreDir !== entry.loreDir);
  arr.push(entry);
  write(path, arr);
  return arr;
}

export function unregisterServer(loreDir, path = registryPath()) {
  const arr = read(path).filter(e => e.loreDir !== loreDir);
  write(path, arr);
  return arr;
}
