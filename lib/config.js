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
  // 块级作用域：只认 axes 块内 docs: 子块的 sources:/docs_glob:。
  // 否则 theme.deep 子记录的 `sources:` 行（多行写法）会劫持 docs 检测
  // （config.js 原 ASSUMPTION「无其他块用 sources:」已被本功能打破）。
  const lines = configText.split(/\r?\n/);
  let inAxes = false, axesIndent = -1, docsIndent = -1;
  const docsLines = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const indent = line.match(/^\s*/)[0].length;
    const content = line.slice(indent);
    if (!inAxes) {
      if (content === 'axes:') { inAxes = true; axesIndent = indent; }
      continue;
    }
    if (indent <= axesIndent) break;                       // 出 axes 块
    if (docsIndent === -1) {
      if (/^docs:\s*(?:#.*)?$/.test(content)) docsIndent = indent;
      continue;
    }
    if (indent <= docsIndent) break;                       // 出 docs 子块
    docsLines.push(line);
  }
  const block = docsLines.join('\n');
  const srcM = block.match(/^[ \t]*sources:[ \t]*\[([^\]]*)\]/m);
  if (!srcM) return null;
  const sources = srcM[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '').trim()).filter(Boolean);
  if (!sources.length) return null;
  const globM = block.match(/^[ \t]*docs_glob:[ \t]*(\S+)/m);
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

// resident: false 关闭 CLAUDE.md 注入与 MCP 注册（默认开——resident 的全部意义）。
export function parseConfigResident(configText) {
  const m = (configText ?? '').match(/^resident:\s*(\S+)/m);
  return m ? m[1] !== 'false' : true;
}

// 解析 component.deep —— 支持两种形态：
//   flat:   lib: [a, b]            → { lib: { order:[a,b], groups:[] } }
//   分组:   lib:\n  捕获: [a,b]    → { lib: { order:[a,b,…], groups:[{name:'捕获',mods:[a,b]},…] } }
// 缺 deep → {}。遇到缩进 <= deep: 的行即出块（不泄漏同级轴）。
export function parseConfigDeep(configText) {
  const lines = configText.split(/\r?\n/);
  const list = raw => raw.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '').trim()).filter(Boolean);
  const deep = {};
  let inBlock = false, baseIndent = 0, curRoot = null, rootIndent = 0;
  for (const line of lines) {
    if (!inBlock) {
      const m = line.match(/^(\s*)deep:\s*(?:#.*)?$/);
      if (m) { inBlock = true; baseIndent = m[1].length; }
      continue;
    }
    if (line.trim() === '') continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= baseIndent) break;                          // 出 deep 块
    // 分组组行：在某 root 之下、且缩进更深、且形如 `<name>: [list]`
    if (curRoot && indent > rootIndent) {
      const gm = line.match(/^\s*([^:\s][^:]*):\s*\[([^\]]*)\]/);
      if (gm) {
        const mods = list(gm[2]);
        if (mods.length) { deep[curRoot].groups.push({ name: gm[1].trim(), mods }); deep[curRoot].order.push(...mods); }
      }
      continue;
    }
    // root 行（缩进回到 root 层）：flat `root: [list]` 或 group-head `root:`
    const flatM = line.match(/^\s*([A-Za-z0-9_.\/-]+):\s*\[([^\]]*)\]/);
    if (flatM) {
      const mods = list(flatM[2]);
      if (mods.length) deep[flatM[1].trim()] = { order: mods, groups: [] };
      curRoot = null;
    } else {
      const headM = line.match(/^\s*([A-Za-z0-9_.\/-]+):\s*(?:#.*)?$/);
      if (headM) { curRoot = headM[1].trim(); rootIndent = indent; deep[curRoot] = { order: [], groups: [] }; }
    }
  }
  return deep;
}
