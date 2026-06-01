// lib/manifest.js
const NUMERIC_KEYS = new Set(['atoms', 'commits', 'stale']);

export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text };
  const block = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  const data = {};
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;                       // skip malformed
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (!key) continue;
    const n = Number(val);
    data[key] = NUMERIC_KEYS.has(key) ? (Number.isNaN(n) ? 0 : n) : val;
  }
  return { data, body };
}

const AXIS_ORDER = ['INDEX', 'component', 'flow', 'theme'];

export function deriveAxes(subdirNames) {
  const known = AXIS_ORDER.filter(id => subdirNames.includes(id));
  const rest = subdirNames.filter(id => !AXIS_ORDER.includes(id));
  return [...known, ...rest].map(id => ({
    id,
    label: id === 'INDEX' ? 'INDEX' : id.charAt(0).toUpperCase() + id.slice(1),
  }));
}
