// test/integration.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runManifestCli } from '../lib/manifest.js';
import { start, stop } from '../lib/serve.js';
import { init } from '../lib/init.js';

test('e2e: fixtures -> manifest -> serve -> fetch page -> stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lore-e2e-'));
  try {
    // build a git repo containing .lore with fixture wiki + shell
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    const lore = join(root, '.lore');
    // scaffold .lore + copy the browser shell via the REAL /lore:init path
    // (was hand-rolled cpSync, which masked the missing init command — spec §7)
    init({ repoRoot: root, srcSiteDir: join(process.cwd(), 'site') });
    // overlay the fixture wiki (test data; init does not synthesize wiki content — /lore:sync does)
    cpSync(join(process.cwd(), 'test', 'fixtures', 'wiki'), join(lore, 'wiki'), { recursive: true });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });

    // 1. manifest
    const { manifestPath } = runManifestCli(lore, '2026-05-31T00:00:00Z');
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(m.axes.find(a => a.id === 'component').pages[0].id, 'm3_nlp');

    // 2. determinism: nuke + rebuild → byte-identical (same clock)
    const first = readFileSync(manifestPath, 'utf8');
    rmSync(manifestPath);
    runManifestCli(lore, '2026-05-31T00:00:00Z');
    assert.equal(readFileSync(manifestPath, 'utf8'), first);

    // 3. serve (force node fallback for determinism)
    const info = await start({ loreDir: lore, port: 0, canRun: () => false, now: 't' });

    // 4. fetch shell, manifest, a page
    assert.equal((await fetch(info.url + 'index.html')).status, 200);
    assert.equal((await fetch(info.url + '../wiki/.manifest.json')).status, 200);
    const page = await fetch(info.url + '../wiki/component/m3_nlp.md');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /component: M3 NLP/);

    // 5. stop
    const res = await stop({ loreDir: lore });
    assert.equal(res.stopped, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
