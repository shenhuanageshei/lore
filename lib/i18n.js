import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseFrontmatter } from './manifest.js';

export function translationPathFor(pagePath, lang) {
  return pagePath.replace(/\.md$/i, `.${lang}.md`);
}

export function isTranslationSidecar(fileName, available, defaultLang) {
  const m = fileName.match(/\.([A-Za-z]{2}(?:-[A-Za-z0-9]+)?)\.md$/);
  return Boolean(m && available.includes(m[1]) && m[1] !== defaultLang);
}

export function translationSourceHash(text) {
  const body = parseFrontmatter(text).body.replace(/\r\n/g, '\n').trimEnd();
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

function slash(p) {
  return p.replace(/\\/g, '/');
}

export function discoverTranslations({ wikiDir, pagePath, pageText, available, defaultLang }) {
  const hash = translationSourceHash(pageText);
  const out = [];
  for (const lang of available) {
    if (lang === defaultLang) continue;
    const rel = translationPathFor(pagePath, lang);
    const abs = join(wikiDir, rel);
    if (!existsSync(abs)) continue;
    const { data } = parseFrontmatter(readFileSync(abs, 'utf8'));
    out.push({
      lang,
      path: slash(rel),
      stale: data.translation_source_hash !== hash,
      source_hash: hash,
    });
  }
  return out;
}

export function readPreferences(stateDir) {
  const p = join(stateDir, 'preferences.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch { return {}; }
}

export function writePreferences(stateDir, prefs) {
  const p = join(stateDir, 'preferences.json');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(prefs, null, 2) + '\n');
}
