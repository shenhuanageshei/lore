import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function parseConfigCodeRoots(configText) {
  const m = configText.match(/^\s*code_roots:\s*\[([^\]]*)\]/m);
  if (!m) return [];
  return m[1]
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}

export function planSync(loreDir) {
  const configPath = join(loreDir, 'config.yml');
  const codeRoots = existsSync(configPath)
    ? parseConfigCodeRoots(readFileSync(configPath, 'utf8'))
    : [];
  const worklist = codeRoots.map(codeRoot => {
    const component = codeRoot.split('/').pop();
    const path = `component/${component}.md`;
    return { component, codeRoot, path, priorExists: existsSync(join(loreDir, 'wiki', path)) };
  });
  return { codeRoots, worklist };
}
