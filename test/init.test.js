import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold } from '../lib/init.js';

function tmpRepo() { return mkdtempSync(join(tmpdir(), 'lore-init-')); }

test('scaffold creates journal/wiki/site/.state and is idempotent', () => {
  const root = tmpRepo();
  try {
    const lore = join(root, '.lore');
    scaffold(lore);
    for (const d of ['journal', 'wiki', 'site', '.state'])
      assert.equal(statSync(join(lore, d)).isDirectory(), true);
    scaffold(lore);   // re-run must not throw
  } finally { rmSync(root, { recursive: true, force: true }); }
});
