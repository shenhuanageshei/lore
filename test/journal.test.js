import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomPath } from '../lib/journal.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-journal-')); }

test('atomPath maps ISO ts to YYYY/MM/YYYY-MM-DD.ndjson', () => {
  assert.equal(atomPath('/j', '2026-06-01T08:00:00Z'), join('/j', '2026', '06', '2026-06-01.ndjson'));
  assert.equal(atomPath('/j', '2025-12-31T23:59:59+09:00'), join('/j', '2025', '12', '2025-12-31.ndjson'));
});
