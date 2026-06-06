// lib/config.js
export function parseConfigCodeRoots(configText) {
  const m = configText.match(/^\s*code_roots:\s*\[([^\]]*)\]/m);
  if (!m) return [];
  return m[1]
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}

export function parseConfigThemes(configText) {
  const themes = [];
  for (const line of configText.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('- {') || !/\bmatch:/.test(t)) continue;
    const idM = t.match(/\bid:\s*([A-Za-z0-9_-]+)/);
    const matchM = t.match(/\bmatch:\s*\[([^\]]*)\]/);
    if (!idM || !matchM) continue;
    const match = matchM[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '').trim()).filter(Boolean);
    themes.push({ id: idM[1], match });
  }
  return themes;
}

export function parseConfigFlows(configText) {
  const flows = [];
  for (const line of configText.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('- {') || !/\bspans:/.test(t)) continue;
    const idM = t.match(/\bid:\s*([A-Za-z0-9_-]+)/);
    const spansM = t.match(/\bspans:\s*\[([^\]]*)\]/);
    if (!idM || !spansM) continue;
    const spans = spansM[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '').trim()).filter(Boolean);
    flows.push({ id: idM[1], spans });
  }
  return flows;
}

export function parseConfigDocsAxis(configText) {
  // Detect the axes.docs block via its `sources:` line — the unique signal.
  // ASSUMPTION: no other config block uses a `sources:` key (true today; the other
  // axes use code_roots: / match: / spans:). If that changes, scope this to the docs block.
  const srcM = configText.match(/^\s*sources:\s*\[([^\]]*)\]/m);
  if (!srcM) return null;
  const sources = srcM[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '').trim()).filter(Boolean);
  if (!sources.length) return null;
  const globM = configText.match(/^\s*docs_glob:\s*(\S+)/m);
  const docsGlob = globM ? globM[1].trim().replace(/^['"]|['"]$/g, '') : 'docs/**/*.md';
  return { sources, docsGlob };
}

function parseList(raw) {
  return raw
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}

function validLang(s) {
  return /^[a-z]{2}(?:-[A-Za-z0-9]+)?$/.test(s);
}

export function parseConfigLanguage(configText) {
  // Normalize CRLF first: JS `.` doesn't match `\r`, so the block-capture below
  // would stop after the first line on Windows configs and miss `available:`.
  configText = configText.replace(/\r\n/g, '\n');
  // Scope to the `language:` block so a stray `default:`/`available:` in another
  // axis can't leak in (same single-block discipline as parseConfigDocsAxis).
  // Tolerate an inline comment on the `language:` line (the init template emits one).
  const blockM = configText.match(/^language:[ \t]*(?:#[^\n]*)?\n((?:[ \t]+.*\n?)*)/m);
  const block = blockM ? blockM[1] : '';

  const defM = block.match(/^\s*default:\s*([^\n#]+)/m);
  let defaultLang = defM ? defM[1].trim().replace(/^['"]|['"]$/g, '').trim() : 'en';
  if (!validLang(defaultLang)) defaultLang = 'en';

  const availM = block.match(/^\s*available:\s*\[([^\]]*)\]/m);
  const rawAvailable = availM ? parseList(availM[1]).filter(validLang) : [defaultLang];
  const available = [];
  for (const lang of [defaultLang, ...rawAvailable]) {
    if (!available.includes(lang)) available.push(lang);
  }
  return { default: defaultLang, available };
}
