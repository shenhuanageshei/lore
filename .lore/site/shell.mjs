// site/shell.mjs
export function stripFrontmatter(md) {
  if (!md.startsWith('---')) return md;
  const end = md.indexOf('\n---', 3);
  if (end === -1) return md;
  return md.slice(end + 4).replace(/^\r?\n/, '');
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// NOTE: inline() escapes ONLY code spans, not surrounding text. renderMarkdown
// intentionally passes raw HTML through (the synthesis emits <div> timeline markup
// that must render). Safe here: content is machine-generated and served on
// 127.0.0.1 only. If this renderer is ever reused for UNTRUSTED input, add an
// HTML-escape pass over the non-construct text in inline() and drop raw-div passthrough.
function inline(t) {
  return t
    .replace(/`([^`]+)`/g, (_, c) => `<code>${esc(c)}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

export function renderMarkdown(src) {
  const lines = src.split('\n');
  let html = '', i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    // passthrough raw <div ...> blocks (timeline markup) until matching depth 0
    if (/^<div/.test(ln)) {
      let buf = '', depth = 0;
      do {
        const l = lines[i];
        depth += (l.match(/<div/g) || []).length - (l.match(/<\/div>/g) || []).length;
        buf += l + '\n'; i++;
      } while (i < lines.length && depth > 0);
      html += buf; continue;
    }
    if (/^```/.test(ln)) {
      const lang = ln.slice(3).trim();                 // info-string after ```
      let buf = ''; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf += lines[i] + '\n'; i++; }
      i++;
      // mermaid source is HTML-escaped into the div; the browser decodes entities
      // via textContent before mermaid parses, so A--&gt;B → A-->B. Escaping also
      // prevents raw < / & in diagram labels from breaking the page HTML.
      html += lang === 'mermaid'
        ? `<div class="mermaid">${esc(buf)}</div>`
        : `<pre><code>${esc(buf)}</code></pre>`;
      continue;
    }
    if (/^### /.test(ln)) { html += `<h3>${inline(ln.slice(4))}</h3>`; i++; continue; }
    if (/^## /.test(ln))  { html += `<h2>${inline(ln.slice(3))}</h2>`; i++; continue; }
    if (/^# /.test(ln))   { html += `<h1>${inline(ln.slice(2))}</h1>`; i++; continue; }
    if (/^> /.test(ln))   { html += `<blockquote>${inline(ln.slice(2))}</blockquote>`; i++; continue; }
    if (/^---\s*$/.test(ln)) { html += '<hr>'; i++; continue; }
    if (/^[-*] /.test(ln)) {
      let buf = '<ul>';
      while (i < lines.length && /^[-*] /.test(lines[i])) { buf += `<li>${inline(lines[i].slice(2))}</li>`; i++; }
      html += buf + '</ul>'; continue;
    }
    if (/^\|/.test(ln)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const body = rows
        .filter(r => !/^\|[\s\-:|]+\|?\s*$/.test(r))
        .map((r, ri) => {
          const cells = r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
          const tag = ri === 0 ? 'th' : 'td';
          return '<tr>' + cells.map(c => `<${tag}>${inline(c)}</${tag}>`).join('') + '</tr>';
        }).join('');
      html += `<table>${body}</table>`; continue;
    }
    if (ln.trim() === '') { i++; continue; }
    html += `<p>${inline(ln)}</p>`; i++;
  }
  return html;
}

export function buildPageIndex(manifest) {
  const idx = {};
  for (const ax of manifest.axes) for (const p of ax.pages) idx[p.id] = `${ax.id}/${p.id}`;
  return idx;
}

export function preprocessWikilinks(html, pageIndex) {
  // id 允许 `.`：文件级页（如 server.js）的 wikilink；`.` 不在首尾防误吞省略号
  return html.replace(/\[\[([a-zA-Z0-9_\-][a-zA-Z0-9_.\-]*[a-zA-Z0-9_\-]|[a-zA-Z0-9_\-])\]\]/g, (_, id) => {
    const target = pageIndex[id] ?? `component/${id}`;
    return `<a class="wikilink" href="#${target}">${id}</a>`;
  });
}

export function buildNavModel(manifest) {
  return manifest.axes.map(ax => ({ id: ax.id, label: ax.label, pages: ax.pages }));
}

export function matchesSearch(page, term) {
  if (!term) return true;
  const t = term.toLowerCase();
  return (page.title + ' ' + (page.summary ?? '')).toLowerCase().includes(t);
}

export function chooseInitialLanguage(manifest, saved) {
  const cfg = manifest.language ?? { default: 'en', available: ['en'] };
  if (saved && cfg.available.includes(saved)) return saved;
  const preferred = manifest.user_preferences?.language;
  if (preferred && cfg.available.includes(preferred)) return preferred;
  return cfg.default;
}

// Pick the file to fetch for a page given the selected language. Falls back to the
// base (default-language) page when a translation is missing or stale, signalling
// which via the missing/stale flags so the shell can offer a "translate" action.
export function resolveLocalizedPage(page, selectedLang) {
  if (!page) return null;
  if (!selectedLang || selectedLang === page.lang) {
    return { path: page.path, lang: page.lang, missing: false, stale: false };
  }
  const found = (page.translations ?? []).find(t => t.lang === selectedLang);
  if (!found) return { path: page.path, lang: selectedLang, missing: true, stale: false };
  if (found.stale) return { path: page.path, lang: selectedLang, missing: false, stale: true };
  return { path: found.path, lang: selectedLang, missing: false, stale: false };
}

export function buildMeta(page) {
  if (page.axis === 'docs') {
    return { chips: [{ icon: '📄', text: `last-updated ${page.last_updated ?? '—'}`, kind: 'plain' }] };
  }
  const f = page.synthesized_from ?? { atoms: 0, commits: 0 };
  const chips = [
    { icon: '📅', text: `last-updated ${page.last_updated ?? '—'}`, kind: 'plain' },
    { icon: '🔗', text: `${f.atoms} atoms · ${f.commits} commits`, kind: 'plain' },
    { icon: '⎇', text: `code_sha ${page.code_sha ?? '—'}`, kind: 'plain' },
  ];
  chips.push(page.stale > 0
    ? { icon: '⚠', text: `落后 ${page.stale} commits · 跑 /lore:sync`, kind: 'stale' }
    : { icon: '✓', text: '最新', kind: 'fresh' });
  return { chips };
}

// 壳被 serve 在 <base>site/(index.html)：per-repo 下 <base> 为 "/"，portal 下为 "/<repo>/"。
// 从文档路径推断该前缀，让 wiki/api fetch 不写死、自动命中正确前缀。
export function baseFromPathname(pathname) {
  const i = pathname.lastIndexOf('/site');
  return i >= 0 ? pathname.slice(0, i + 1) : '/';
}

// B1 控制台模型：灯三态 + stale 聚合（spec 2026-06-09-lore-sync-console）。
// status 来自 GET /api/sync/status；python 静态 server / portal 下无 API → 传 null，降级默认。
export function buildConsoleModel(manifest, status) {
  const stalePages = [];
  for (const ax of manifest.axes ?? []) {
    for (const p of ax.pages ?? []) {
      if ((p.stale ?? 0) > 0) {
        stalePages.push({ key: `${ax.id}/${p.id}`, title: p.title ?? p.id, stale: p.stale, last_updated: p.last_updated ?? '', path: p.path });
      }
    }
  }
  stalePages.sort((a, b) => b.stale - a.stale || a.key.localeCompare(b.key));
  const mode = status?.mode ?? 'notify';
  return {
    light: mode === 'manual' ? 'off'
      : status?.runner_running ? 'busy'
      : (stalePages.length ? 'stale' : 'fresh'),
    staleTotal: stalePages.length,
    stalePages,
    mode,
    lastFinalize: status?.last_finalize ?? null,
  };
}

// manifest 轮询判定：generated 变了 → 灯/侧栏重建；当前页条目也变了 → 正文提示条（不强刷、不丢滚动位置）。
export function pollDecide(prevGenerated, nowGenerated, currentPageChanged) {
  if (!nowGenerated || nowGenerated === prevGenerated) {
    return { changed: false, rebuildSidebar: false, showUpdateBar: false };
  }
  return { changed: true, rebuildSidebar: true, showUpdateBar: !!currentPageChanged };
}

// 跨 repo 搜索索引（portal 形态）：各 repo manifest 拍平成 {repo, key, title, search}。
// 搜索域 = title + summary + id（英文 slug 可搜，同 docs 行的教训）。坏 manifest 容错跳过。
export function buildCrossRepoIndex(entries) {
  const out = [];
  for (const { repo, manifest } of entries ?? []) {
    for (const ax of manifest?.axes ?? []) {
      for (const p of ax.pages ?? []) {
        out.push({
          repo,
          key: `${ax.id}/${p.id}`,
          title: p.title ?? p.id,
          search: `${p.title ?? ''} ${p.summary ?? ''} ${p.id}`.trim().toLowerCase(),
        });
      }
    }
  }
  return out;
}

// docs 轴侧栏模型（spec 2026-06-10-lore-docs-axis-regroup）：按 manifest 给定顺序分段
// （排序单一来源在 manifest），配对行合并、被配对 plan 剔除、显示名剥模板尾巴。
export function buildDocsRows(pages) {
  const byId = new Map(pages.map(p => [p.id, p]));
  const paired = new Set(pages.filter(p => p.paired_plan && byId.has(p.paired_plan)).map(p => p.paired_plan));
  const stripTail = t => (t ?? '')
    .replace(/\s*(?:——|—|--)\s*设计\s*$/, '')
    .replace(/\s+Implementation\s+Plan\s*$/i, '')
    .trim();
  const groups = [];
  let cur = null;
  for (const p of pages) {
    if (paired.has(p.id)) continue;                       // 被配对的 plan 不占行（页本体仍可直链/搜索）
    const g = p.group || '项目状态';
    if (!cur || cur.group !== g) {
      cur = { group: g, collapsed: g !== '项目状态', rows: [] };
      groups.push(cur);
    }
    const planPage = p.paired_plan ? (byId.get(p.paired_plan) ?? null) : null;
    cur.rows.push({ page: p, planPage, displayTitle: stripTail(p.title) });
  }
  return groups;
}
