// lib/lint.js
function rootName(codeRoot) {
  return codeRoot.split('/').pop();
}

export function lintOrphans(pageIds, codeRoots) {
  const names = new Set(codeRoots.map(rootName));
  return pageIds.filter(id => !names.has(id));
}

export function lintMissing(pageIds, codeRoots) {
  const pages = new Set(pageIds);
  return [...new Set(codeRoots.map(rootName))].filter(c => !pages.has(c));
}
