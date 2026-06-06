import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planTranslation, finalizeTranslation } from '../lib/translate.js';
import { translationSourceHash } from '../lib/i18n.js';

// finalizeTranslation regenerates the manifest, which needs a real git sha,
// so each fixture is a tiny git repo (mirrors test/sync.test.js gitRepo()).
function tmp() {
  const root = mkdtempSync(join(tmpdir(), 'lore-translate-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  writeFileSync(join(root, 'f.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  return root;
}

test('planTranslation returns source, target path, and hash', () => {
  const root = tmp();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki', 'component'), { recursive: true });
    writeFileSync(join(lore, 'wiki', 'component', 'lib.md'), '---\ntitle: Lib\nsummary: core\n---\n# Lib\nbody');
    const plan = planTranslation(lore, 'component/lib.md', 'en');
    assert.equal(plan.source_path, 'component/lib.md');
    assert.equal(plan.target_path, 'component/lib.en.md');
    assert.equal(plan.target_lang, 'en');
    assert.match(plan.source_hash, /^sha256:/);
    assert.match(plan.source_body, /# Lib/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('finalizeTranslation stamps sidecar frontmatter', () => {
  const root = tmp();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki', 'component'), { recursive: true });
    const source = '---\ntitle: Lib\nsummary: core\n---\n# Lib\nbody';
    writeFileSync(join(lore, 'wiki', 'component', 'lib.md'), source);
    writeFileSync(join(lore, 'wiki', 'component', 'lib.en.md'), '# Lib\ntranslated');
    finalizeTranslation(lore, 'component/lib.md', 'en', '2026-06-06T00:00:00Z');
    const out = readFileSync(join(lore, 'wiki', 'component', 'lib.en.md'), 'utf8');
    assert.match(out, /lang: en/);
    assert.match(out, /translation_of: component\/lib.md/);
    assert.match(out, new RegExp(`translation_source_hash: ${translationSourceHash(source)}`));
    assert.match(out, /last_updated: 2026-06-06/);
    assert.match(out, /# Lib\ntranslated/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('planTranslation refuses paths that escape the wiki', () => {
  const root = tmp();
  try {
    const lore = join(root, '.lore');
    mkdirSync(join(lore, 'wiki'), { recursive: true });
    assert.throws(() => planTranslation(lore, '../../etc/passwd.md', 'en'), /escapes wiki/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
