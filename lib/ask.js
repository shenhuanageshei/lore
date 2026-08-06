// lib/ask.js
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sliceSection } from './section.js';

export function searchPages(manifest, query) {
  const terms = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const axis of manifest.axes ?? []) {
    if (axis.id === 'INDEX') continue;
    for (const p of axis.pages ?? []) {
      const hay = `${p.title ?? ''} ${p.summary ?? ''} ${p.id}`.toLowerCase();   // id 进搜索域：英文 slug 可搜
      const pageScore = terms.filter(t => hay.includes(t)).length;
      // 节级命中：heading 含词 → 直达该节（agent 链路 lore_page(section) 只取节，省整页 token）
      let bestSection = null, bestSectionScore = 0;
      for (const s of p.sections ?? []) {
        const sc = terms.filter(t => s.heading.toLowerCase().includes(t)).length;
        if (sc > bestSectionScore) { bestSectionScore = sc; bestSection = s.heading; }
      }
      const score = pageScore + bestSectionScore;
      if (score > 0) {
        const hit = { axis: axis.id, id: p.id, title: p.title, summary: p.summary, path: p.path, score };
        if (p.kind) hit.kind = p.kind;
        if (p.parent) hit.parent = p.parent;
        if (bestSection) hit.section = bestSection;
        out.push(hit);
      }
    }
  }
  return out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

// CLI 输出格式化：默认带命中节切片内容（找到页就直接给内容，免 agent 再 Read 整页——R1 贵的根因）；
// --paths 只列 path#section（脚本/管道用）。readPage 注入便于测；切片超 sliceCap 截断并提示。
export function formatHits(hits, { paths = false, limit = 5, sliceCap = 1500, readPage } = {}) {
  if (!hits.length) return 'no matching pages';
  if (paths) return hits.map(h => `${h.path}${h.section ? `#${h.section}` : ''}`).join('\n');
  return hits.slice(0, limit).map(h => {
    const head = `${h.path}${h.section ? `#${h.section}` : ''}  [${h.axis}] ${h.title} (score ${h.score})`;
    if (!h.section || !readPage) return head;
    let s = null;
    try { s = sliceSection(readPage(h.path), h.section); } catch { /* 页缺失 → 无切片 */ }
    if (!s) return head;
    const body = s.length > sliceCap ? s.slice(0, sliceCap) + '\n…（截断，完整用 lore_page section）' : s;
    return `${head}\n${body}`;
  }).join('\n\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const paths = argv.includes('--paths');
  const rest = argv.filter(a => a !== '--paths');
  const loreDir = rest[0] ?? join(process.cwd(), '.lore');
  const query = rest.slice(1).join(' ');
  const manifestPath = join(loreDir, 'wiki', '.manifest.json');
  if (!existsSync(manifestPath)) {
    console.error('lore: no .manifest.json — run /lore:sync first');
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const hits = searchPages(manifest, query);
  const readPage = p => { try { return readFileSync(join(loreDir, 'wiki', p), 'utf8'); } catch { return ''; } };
  console.log(formatHits(hits, { paths, readPage }));
  process.exit(0);
}
