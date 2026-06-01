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
      let buf = ''; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf += lines[i] + '\n'; i++; }
      i++; html += `<pre><code>${esc(buf)}</code></pre>`; continue;
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
