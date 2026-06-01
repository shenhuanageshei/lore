// lib/serve.js
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = join(HERE, '..', 'server.js');

export function probeRuntime(canRun) {
  for (const cmd of ['python3', 'python']) {
    if (canRun(cmd)) {
      return {
        kind: 'python', cmd,
        buildArgs: (port, dir) =>
          ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', dir],
      };
    }
  }
  return {
    kind: 'node', cmd: process.execPath,
    buildArgs: (port, dir) => [SERVER_JS, dir, String(port)],
  };
}
