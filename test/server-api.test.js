import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-api-')); }

async function withServer(root, fn) {
  const server = createServer(root);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try { await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('POST /api/preferences writes .state/preferences.json', async () => {
  const root = tmp();
  try {
    mkdirSync(join(root, 'site'), { recursive: true });
    await withServer(root, async base => {
      const res = await fetch(base + '/api/preferences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ language: 'zh' }),
      });
      assert.equal(res.status, 200);
    });
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.state', 'preferences.json'), 'utf8')), { language: 'zh' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('POST /api/translation-requests appends ndjson request', async () => {
  const root = tmp();
  try {
    mkdirSync(join(root, 'wiki', 'component'), { recursive: true });
    writeFileSync(join(root, 'wiki', 'component', 'lib.md'), '---\ntitle: Lib\n---\n# Lib\nbody\n');
    await withServer(root, async base => {
      const res = await fetch(base + '/api/translation-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page: 'component/lib.md', target_lang: 'en' }),
      });
      assert.equal(res.status, 200);
    });
    const lines = readFileSync(join(root, '.state', 'translation-requests.ndjson'), 'utf8').trim().split('\n');
    const request = JSON.parse(lines[0]);
    assert.equal(request.page, 'component/lib.md');
    assert.equal(request.target_lang, 'en');
    assert.match(request.source_hash, /^sha256:/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('POST /api/translation-requests rejects path traversal', async () => {
  const root = tmp();
  try {
    mkdirSync(join(root, 'wiki'), { recursive: true });
    await withServer(root, async base => {
      const res = await fetch(base + '/api/translation-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page: '../../etc/passwd.md', target_lang: 'en' }),
      });
      assert.equal(res.status, 400);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
