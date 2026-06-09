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
  // Scope to the `language:` block so a stray `default:`/`available:` in another
  // axis can't leak in (same single-block discipline as parseConfigDocsAxis).
  // Tolerate a trailing comment and CRLF on the `language:` line (init-generated
  // configs carry a comment there; Windows checkouts use CRLF).
  const blockM = configText.match(/^language:[ \t]*(?:#[^\n]*)?\r?\n((?:[ \t]+.*\r?\n?)*)/m);
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

// 解析 component.deep —— `<code_root>: [子模块…]` 映射（源文件级深度页声明）。
// 缺 deep: → {}。块内每行 `root: [a, b]`；遇到缩进 <= deep: 的行即出块（不泄漏同级轴）。
export function parseConfigDeep(configText) {
  const lines = configText.split(/\r?\n/);
  const deep = {};
  let inBlock = false, baseIndent = 0;
  for (const line of lines) {
    if (!inBlock) {
      const m = line.match(/^(\s*)deep:\s*(?:#.*)?$/);
      if (m) { inBlock = true; baseIndent = m[1].length; }
      continue;
    }
    if (line.trim() === '') continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= baseIndent) break;                       // 回到同级/更浅 → 出块
    const m = line.match(/^\s*([A-Za-z0-9_.\/-]+):\s*\[([^\]]*)\]/);
    if (!m) continue;
    const mods = m[2].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '').trim()).filter(Boolean);
    if (mods.length) deep[m[1].trim()] = mods;
  }
  return deep;
}
