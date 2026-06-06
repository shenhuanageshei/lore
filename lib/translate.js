import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, runManifestCli } from './manifest.js';
import { translationPathFor, translationSourceHash } from './i18n.js';

function safePage(loreDir, rel) {
  if (!/^[A-Za-z0-9_./-]+\.md$/.test(rel)) throw new Error(`invalid page path: ${rel}`);
  const wiki = normalize(join(loreDir, 'wiki'));
  const full = normalize(join(wiki, rel));
  if (full !== wiki && !full.startsWith(wiki + sep)) throw new Error(`page escapes wiki: ${rel}`);
  return full;
}

export function planTranslation(loreDir, pagePath, targetLang) {
  const sourceFull = safePage(loreDir, pagePath);
  if (!existsSync(sourceFull)) throw new Error(`source page not found: ${pagePath}`);
  const text = readFileSync(sourceFull, 'utf8');
  const { data, body } = parseFrontmatter(text);
  return {
    source_path: pagePath,
    target_path: translationPathFor(pagePath, targetLang),
    target_lang: targetLang,
    source_hash: translationSourceHash(text),
    title: data.title ?? '',
    summary: data.summary ?? '',
    source_body: body,
    instructions: [
      'Translate Markdown prose into the target language.',
      'Keep code fences, wikilinks, tables, frontmatter meaning, and Mermaid syntax intact.',
      'Write only the translated Markdown body to target_path before finalize.',
    ],
  };
}

export function finalizeTranslation(loreDir, pagePath, targetLang, nowIso = new Date().toISOString()) {
  const plan = planTranslation(loreDir, pagePath, targetLang);
  const targetFull = safePage(loreDir, plan.target_path);
  if (!existsSync(targetFull)) throw new Error(`translation page not found: ${plan.target_path}`);
  const target = readFileSync(targetFull, 'utf8');
  const { data, body } = parseFrontmatter(target);
  const title = data.title ?? plan.title;
  const summary = data.summary ?? plan.summary;
  const fm = [
    '---',
    `title: ${title}`,
    `summary: ${summary}`,
    `lang: ${targetLang}`,
    `translation_of: ${pagePath}`,
    `translation_source_hash: ${plan.source_hash}`,
    `last_updated: ${nowIso.slice(0, 10)}`,
    '---',
    '',
  ].join('\n');
  mkdirSync(dirname(targetFull), { recursive: true });
  writeFileSync(targetFull, fm + body);
  runManifestCli(loreDir, nowIso);
  return plan.target_path;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , sub, loreDir, pagePath, targetLang] = process.argv;
  if (!sub || !loreDir || !pagePath || !targetLang) {
    console.error('usage: node lib/translate.js <plan|finalize> <loreDir> <pagePath> <targetLang>');
    process.exit(1);
  }
  if (sub === 'plan') {
    console.log(JSON.stringify(planTranslation(loreDir, pagePath, targetLang), null, 2));
  } else if (sub === 'finalize') {
    console.log(`wrote ${finalizeTranslation(loreDir, pagePath, targetLang)}`);
  } else {
    console.error(`unknown subcommand: ${sub}`);
    process.exit(1);
  }
}
