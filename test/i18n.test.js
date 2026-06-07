import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  translationPathFor,
  isTranslationSidecar,
  translationSourceHash,
  discoverTranslations,
  readPreferences,
  writePreferences,
} from '../lib/i18n.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'lore-i18n-')); }

test('translationPathFor inserts language before .md', () => {
  assert.equal(translationPathFor('component/lib.md', 'en'), 'component/lib.en.md');
  assert.equal(translationPathFor('HOME.md', 'zh'), 'HOME.zh.md');
});

test('isTranslationSidecar detects available non-default language files', () => {
  assert.equal(isTranslationSidecar('lib.en.md', ['zh', 'en'], 'zh'), true);
  assert.equal(isTranslationSidecar('lib.zh.md', ['zh', 'en'], 'zh'), false);
  assert.equal(isTranslationSidecar('lib.md', ['zh', 'en'], 'zh'), false);
});

test('translationSourceHash ignores frontmatter and normalizes line endings', () => {
  const a = '---\ntitle: A\n---\n# A\r\nbody\r\n';
  const b = '---\ntitle: B\n---\n# A\nbody\n';
  assert.equal(translationSourceHash(a), translationSourceHash(b));
  assert.match(translationSourceHash(a), /^sha256:[0-9a-f]{64}$/);
});

test('discoverTranslations reports ready and stale sidecars', () => {
  const root = tmp();
  try {
    mkdirSync(join(root, 'wiki', 'component'), { recursive: true });
    const source = '---\ntitle: Lib\n---\n# Lib\nbody\n';
    const hash = translationSourceHash(source);
    writeFileSync(join(root, 'wiki', 'component', 'lib.en.md'),
      `---\nlang: en\ntranslation_of: component/lib.md\ntranslation_source_hash: ${hash}\n---\n# Lib\n`);
    writeFileSync(join(root, 'wiki', 'component', 'lib.ja.md'),
      '---\nlang: ja\ntranslation_of: component/lib.md\ntranslation_source_hash: sha256:bad\n---\n# Lib\n');
    const found = discoverTranslations({
      wikiDir: join(root, 'wiki'),
      pagePath: 'component/lib.md',
      pageText: source,
      available: ['zh', 'en', 'ja'],
      defaultLang: 'zh',
    });
    assert.deepEqual(found.map(t => ({ lang: t.lang, path: t.path, stale: t.stale })), [
      { lang: 'en', path: 'component/lib.en.md', stale: false },
      { lang: 'ja', path: 'component/lib.ja.md', stale: true },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readPreferences and writePreferences round-trip .state/preferences.json', () => {
  const root = tmp();
  try {
    const state = join(root, '.lore', '.state');
    assert.deepEqual(readPreferences(state), {});
    writePreferences(state, { language: 'zh' });
    assert.deepEqual(JSON.parse(readFileSync(join(state, 'preferences.json'), 'utf8')), { language: 'zh' });
    assert.deepEqual(readPreferences(state), { language: 'zh' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('translationSourceHash: ignores sentinel region changes', () => {
  const mk = (status) =>
    '---\ntitle: Home\n---\n# Home\n\n<!-- LORE_HOME_STATUS:START -->\n' + status + '\n<!-- LORE_HOME_STATUS:END -->\n\n## Body\n\nprose\n';
  assert.equal(translationSourceHash(mk('v1 stuff')), translationSourceHash(mk('v2 different')));
});

test('translationSourceHash: still reflects real body changes', () => {
  const base = '---\ntitle: X\n---\n# X\n\n## Body\n\nprose one\n';
  const changed = '---\ntitle: X\n---\n# X\n\n## Body\n\nprose two\n';
  assert.notEqual(translationSourceHash(base), translationSourceHash(changed));
});
