// test/fingerprint.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFingerprints, writeFingerprints, proseHash, fingerprintsPath } from '../lib/fingerprint.js';

function tmpState() { return mkdtempSync(join(tmpdir(), 'lore-fp-')); }

test('writeFingerprints → readFingerprints round-trips', () => {
  const s = tmpState();
  try {
    const map = { 'component/lib.md': { prose_hash: 'sha256:abc', prose_sha: 'c8f0721' } };
    writeFingerprints(s, map);
    assert.deepEqual(readFingerprints(s), map);
  } finally { rmSync(s, { recursive: true, force: true }); }
});

test('readFingerprints: missing file → {}', () => {
  const s = tmpState();
  try { assert.deepEqual(readFingerprints(s), {}); }
  finally { rmSync(s, { recursive: true, force: true }); }
});

test('readFingerprints: corrupt JSON → {}', () => {
  const s = tmpState();
  try {
    writeFileSync(fingerprintsPath(s), '{bad json');
    assert.deepEqual(readFingerprints(s), {});
  } finally { rmSync(s, { recursive: true, force: true }); }
});

test('proseHash ignores frontmatter + sentinel regions, tracks prose body', () => {
  const withFm = `---\ntitle: X\nlast_updated: 2026-06-01\ncode_sha: aaa\n---\n# h\n架构正文\n## Decision history\n<!-- LORE_JOURNAL:START -->\n- old atom\n<!-- LORE_JOURNAL:END -->\n`;
  // 只改 frontmatter（日期/sha）+ 决策史哨兵区内容 → hash 不变
  const fmChanged = `---\ntitle: X\nlast_updated: 2026-06-08\ncode_sha: zzz\n---\n# h\n架构正文\n## Decision history\n<!-- LORE_JOURNAL:START -->\n- NEW atom different\n<!-- LORE_JOURNAL:END -->\n`;
  assert.equal(proseHash(withFm), proseHash(fmChanged));
  // 改架构正文 → hash 变
  const proseChanged = withFm.replace('架构正文', '架构正文（重写）');
  assert.notEqual(proseHash(withFm), proseHash(proseChanged));
  assert.match(proseHash(withFm), /^sha256:[0-9a-f]{64}$/);
});
