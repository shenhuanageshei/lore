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
  // 机械徽标 = 排队/同步意图（追代码 / 补缺失结构，无指令）——和带指令的「✏️ 重写这页」分开概念。
  chips.push(page.stale > 0
    ? { icon: '⚠', text: `落后 ${page.stale} commits · 点击排队同步`, kind: 'stale', action: 'queue', path: page.path }
    : { icon: '✓', text: '最新', kind: 'fresh' });
  if (page.hasDiagram === false) {
    chips.push({ icon: '🖼', text: '缺架构图 · 点击排队补', kind: 'stale', action: 'queue', path: page.path });
  }
  if (page.hasMechanism === false) {
    chips.push({ icon: '📖', text: '缺机制详解 · 点击排队补', kind: 'stale', action: 'queue', path: page.path });
  }
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

// theme 轴侧栏模型：鸟瞰页顶层 + 子页按父分组/顺序嵌套（manifest 排序单一来源；组名作子块头）。
export function buildThemeRows(pages) {
  const parents = pages.filter(p => !p.parent);
  const children = pages.filter(p => p.parent);
  const byParent = new Map();
  for (const c of children) {
    if (!byParent.has(c.parent)) byParent.set(c.parent, []);
    byParent.get(c.parent).push(c);
  }
  return parents.map(p => ({
    page: p,
    groups: (byParent.get(p.id) ?? []).reduce((acc, k) => {
      const g = k.group || '';
      const last = acc[acc.length - 1];
      if (!last || last.group !== g) acc.push({ group: g, rows: [] });
      acc[acc.length - 1].rows.push(k);
      return acc;
    }, []),
  }));
}

// ---------- 壳打开传感器（设计 §7 S7 / §4.4；不变量⑥ per-human 边界） ----------
// 壳在浏览器里跑、写不进 .lore → 必须走 server 的 localhost-only API（POST /api/human/visit）。
// 整条链路只碰本机同源 URL（wiki/.manifest.json + api/human/visit）：不引宿主依赖、不发外部网络。
// 任何一步失败都静默返回（record 自身不抛），绝不阻塞阅读——调用方 fire-and-forget。
// 去重**只有一处定义**：服务端 lib/human.js 的 DEDUPE_WINDOW_MS（appendHuman 的 windowMs 覆盖）。
// 壳侧不再自带窗口常量/参数——两处窗口必然漂移（评审 🔵#10）；壳只管「每次打开都发」，权威判定在服务端。
export const VISIT_ENDPOINT = 'api/human/visit';   // 相对 BASE：per-repo "/" · portal "/<repo>/"
export const VISIT_MANIFEST = 'wiki/.manifest.json';
const VISIT_CONSOLE_KEY = 'console';               // 控制台不是 wiki 页，不记

// 页键（axis/id）→ wiki 相对路径。必须以 manifest 为真源：HOME/HOME → HOME.md 这类不满足 `${key}.md`。
export function buildVisitPathIndex(manifest) {
  const idx = Object.create(null);
  for (const ax of manifest?.axes ?? []) {
    for (const p of ax?.pages ?? []) {
      if (ax?.id && p?.id && p?.path) idx[`${ax.id}/${p.id}`] = p.path;
    }
  }
  return idx;
}

// 落地页口径与壳 index.html 的 firstPageKey 一致：首个轴的首个页（无 hash 时打开的就是它）。
export function firstVisitKey(manifest) {
  for (const ax of manifest?.axes ?? []) {
    if (ax?.pages?.[0]?.id) return `${ax.id}/${ax.pages[0].id}`;
  }
  return '';
}

// location.hash / 裸页键 → 页键。'#component/lib' → 'component/lib'；'' → 落地页；'console' → ''（不记）。
export function visitKey(hash, manifest) {
  const key = String(hash ?? '').replace(/^#/, '').replace(/^\/+/, '').trim();
  if (key === VISIT_CONSOLE_KEY) return '';
  return key || firstVisitKey(manifest);
}

// 传感器：record(hash) → {sent, reason, page?}（返回值只为测试/诊断，阅读路径不必 await）。
// 每次都发：同页短窗重复由服务端 appendHuman 的窗口判定（唯一真源），壳不再做第二次去重。
export function createVisitSensor({
  base = '/',
  manifestUrl = VISIT_MANIFEST,
  endpoint = VISIT_ENDPOINT,
  fetchFn = (...args) => globalThis.fetch(...args),
} = {}) {
  let cachedManifest = null;

  // manifest 成功才缓存：取不到（未 init / 静态服务 / 服务端重启中）返回 null 且不缓存，
  // 下次打开再试——一次瞬时失败不该把传感器整个会话静音。
  const loadManifest = async ({ fresh = false } = {}) => {
    if (!fresh && cachedManifest) return cachedManifest;
    try {
      const res = await fetchFn(base + manifestUrl, { cache: 'no-store' });
      if (!res?.ok) return null;
      const m = await res.json();
      cachedManifest = m;
      return m;
    } catch { return null; }   // 无 manifest → 降级：不记、不抛
  };

  async function record(hash) {
    try {
      const manifest = await loadManifest();
      if (!manifest) return { sent: false, reason: 'no-manifest' };
      const key = visitKey(hash, manifest);
      if (!key) return { sent: false, reason: 'not-a-page' };
      let page = buildVisitPathIndex(manifest)[key];
      if (!page) {
        // 缓存里没有该页键（壳常驻期间新生成 / 改名的页）→ 失效重取一次再试，别静默丢一次阅读
        const fresh = await loadManifest({ fresh: true });
        if (!fresh) return { sent: false, reason: 'no-manifest' };
        page = buildVisitPathIndex(fresh)[key];
      }
      if (!page) return { sent: false, reason: 'unknown-page' };
      try {
        const res = await fetchFn(base + endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ page }),
        });
        if (!res?.ok) return { sent: false, reason: 'api-unavailable', page };
        return { sent: true, page };
      } catch {
        return { sent: false, reason: 'api-unavailable', page };   // 无 .lore / 静态服务 → 静默降级
      }
    } catch {
      return { sent: false, reason: 'error' };                     // 传感器绝不把异常抛给阅读路径
    }
  }

  return { record };
}

// 浏览器自装配：壳（site/index.html）import 本模块即生效——打开落地页 + 每次 hash 切换各记一次。
// Node（测试 / CLI）没有 location 与 addEventListener → 直接不装配，纯函数语义不变。
export function installVisitSensor({ win = globalThis, ...opts } = {}) {
  if (!win || typeof win.addEventListener !== 'function' || !win.location) return null;
  // 自装配必须自己推导前缀：portal 形态壳在 /<repo>/site/index.html，写死 '/' 会把请求打到
  // /wiki/… 而不是 /<repo>/wiki/… → 恒 no-manifest、零 visit、零告警（审计 D5 已实测复现）。
  // 显式传 base 仍优先——调用方/测试的既有语义不变。
  const base = opts.base ?? baseFromPathname(win.location.pathname ?? '');
  const sensor = createVisitSensor({ ...opts, base });
  const onOpen = () => { sensor.record(win.location.hash); };   // fire-and-forget：不 await、不阻塞渲染
  win.addEventListener('hashchange', onOpen);
  onOpen();
  return sensor;
}

installVisitSensor();

// ---------- 预算闸读数（设计 §7 ⓪ 期 S6 / §5.5 状态行） ----------
// 只报「超限」这一种状态：状态行是遥测位不是仪表盘——未配置（configured:false）/ 未超限都返回 ''，
// 不往状态行塞噪音。超限时 auto 档不启动，这条读数就是「为什么没跑」的唯一可见出口。
export function budgetNotice(status) {
  const b = status?.budget;
  if (!b || b.configured !== true || b.exceeded !== true) return '';
  const num = v => (Number.isFinite(v) ? v : '?');
  return `预算超限（${num(b.used)}/${num(b.budget)} ${b.dimension ?? 'calls'}）`;
}

// ---------- 底部状态行读数（设计 §5.3 结构 / §5.5 验收；壳阶段 B） ----------
// 纯函数（无 DOM，Node 可直测）：site/index.html 把结果逐字段填进已落地的 #statusline。
//
// 数据源只有两个，**不新增数据源**：
//   · fuel  —— GET /api/sync/status 的顶层 fuel 字段（派生唯一在 lib/doctor.js 的 fuelReadout，计划 D3）；
//   · manifest / status —— 既有 buildConsoleModel（页数、待重写队列）。
//
// 纪律（D13 / lib/doctor.js:40-41）：取不到的数字一律渲染 'unknown'，**绝不用 0 冒充**——
// 0 是「测出来是零」，unknown 是「测不出来」，两者混同就是把最危险的失败模式藏起来。
// 三态必须分列，且 none ≠ unknown：
//   ok       → `CAPTURE OK`（绿：捕获路径活着）
//   none     → `CAPTURE 未捕获`（琥珀：能测、但从未捕获过 —— 正是「hook 断流 3 个月」那种最危险形态）
//   unknown  → `CAPTURE unknown`（弱色：测不出，含 API 不可用 / 未 init）
//
// 降级（§5.5）：status 为 null（SYNC_STATUS 不可用：python serve / portal / 未 init）时，
// 燃料三项显示 unknown，但页数与队列仍取 manifest 的静态读数——不报错、不空白。
// 预算超限走既有 budgetNotice()（不与超限/未配置混淆），单独成字段：状态行把它当独立读数渲染。
export const STATUS_UNKNOWN = 'unknown';

const isFiniteNum = v => typeof v === 'number' && Number.isFinite(v);
const numText = v => (isFiniteNum(v) ? String(v) : STATUS_UNKNOWN);   // 真实的 0 原样输出，非有限数才 unknown

// 页数 = manifest 全部轴的页数和；manifest 形状不对 → null（未知），不拿 0 冒充「0 页」。
function manifestPageCount(manifest) {
  if (!manifest || !Array.isArray(manifest.axes)) return null;
  return manifest.axes.reduce((n, ax) => n + (Array.isArray(ax?.pages) ? ax.pages.length : 0), 0);
}

const pad2 = n => String(n).padStart(2, '0');

// now 可注入：HH:MM 是读数（截取时刻），测试必须能给定时钟，读挂钟的纯函数不可测。
export function buildStatusLine({ status = null, manifest = null, queued = 0, now = new Date() } = {}) {
  const fuel = status?.fuel ?? null;
  const state = fuel?.capture_state === 'ok' || fuel?.capture_state === 'none' ? fuel.capture_state : STATUS_UNKNOWN;
  const hasManifest = !!manifest && Array.isArray(manifest.axes);
  const queueCount = hasManifest ? buildConsoleModel(manifest, status).staleTotal : null;
  const pageCount = manifestPageCount(manifest);

  const capture_text = state === 'ok' ? 'CAPTURE OK' : state === 'none' ? 'CAPTURE 未捕获' : 'CAPTURE unknown';
  const rate_text = `决策捕获率 ${isFiniteNum(fuel?.capture_pct) ? `${fuel.capture_pct}%` : STATUS_UNKNOWN}`;
  const gap_text = `断流 ${isFiniteNum(fuel?.days_since_capture) ? `${fuel.days_since_capture} 天` : STATUS_UNKNOWN}`;
  const pages_text = `${pageCount === null ? STATUS_UNKNOWN : pageCount} 页`;
  const queue_text = `队列 ${queueCount === null ? STATUS_UNKNOWN : queueCount}`;
  const stamp_text = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const queuedCount = isFiniteNum(queued) ? queued : 0;

  return {
    capture_state: state,
    capture_text,
    // 复用已落地的状态行 CSS：ok → .live（绿点）、none → .cap-none（琥珀）、unknown → .cap-unknown（弱色）
    capture_class: state === 'ok' ? 'live' : state === 'none' ? 'cap-none' : 'cap-unknown',
    rate_text,
    gap_text,
    pages_text,
    queue_text,
    stamp_text,
    // 队列是**可操作**读数（§5.5 硬项）：null = 连 manifest 都读不到 → 不可点（静态 markup 的禁用态）
    queue_count: queueCount,
    queue_hint: queueCount === null
      ? '同步面板：页面索引未就绪'
      : `打开同步面板：${queueCount} 页待重写 · ${queuedCount} 条排队请求`,
    budget_text: budgetNotice(status),   // 超限才有字；未配置/未超限为 ''（遥测位不塞噪音）
    // §5.3 的规范一行（不含预算读数——预算在 #statusline 里是独立读数，超限才出现）
    text: [capture_text, rate_text, gap_text, pages_text, queue_text, stamp_text].join(' · '),
  };
}
