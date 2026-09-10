// site/shell.mjs
export function stripFrontmatter(md) {
  if (!md.startsWith('---')) return md;
  const end = md.indexOf('\n---', 3);
  if (end === -1) return md;
  return md.slice(end + 4).replace(/^\r?\n/, '');
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 注：inline() 只转义代码 span，**不转义周边文本**——renderMarkdown 刻意放行裸 HTML
// （合成产物里的 <div> 时间线标记必须原样渲染）。此处安全的前提是「内容由机器生成、
// 且只经 127.0.0.1 提供服务」。若此渲染器将来复用于**不可信输入**，要补的是这几处：
//   ① inline() 里非构造文本的 HTML 转义 + 去掉裸 div 放行；
//   ② 链接的 href 属性值——属性里一个裸 `"` 就能闭掉引号，把后面的文本变成标签。
// ②这条**当下就修**（遗留 🔵#12），不等「将来复用于不可信输入」：它是属性逃逸的**唯一**字符，
// 转义成本是一行；其余字符（`<` `>` `&`）落在带引号的属性值里不构成逃逸，仍归上面的清单。
function inline(t) {
  return t
    .replace(/`([^`]+)`/g, (_, c) => `<code>${esc(c)}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) =>
      `<a href="${String(href).replace(/"/g, '&quot;')}">${text}</a>`);
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
    // 连续多行引用合成为**一个** blockquote：逐行产出会把一段引用切成多个各自带左边框 /
    // 圆角 / 底色的独立盒子（引用被切碎）。与紧邻的 ul 分支同构：while 累积，再一次性包壳。
    // 判定用 `/^> ?/`（标准引用标记允许省掉标记后那个空格）：否则引用中间的 `>` 空行会把
    // 盒子重新切断，「多行引用不再被切碎」这个修复就漏掉最常见的一半。
    if (/^> ?/.test(ln)) {
      const parts = [];
      while (i < lines.length && /^> ?/.test(lines[i])) { parts.push(inline(lines[i].replace(/^> ?/, ''))); i++; }
      html += `<blockquote>${parts.join('\n')}</blockquote>`; continue;
    }
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
// queued **刻意没有默认值**（D13）：调用点「取不到」与「没给」是同一件事——undefined。
// 若给默认 0，调用方一旦拿不到已排队条数（API 挂了、字段改名、还没轮询到），提示语就会
// 理直气壮地报「0 条排队请求」：0 是「测出来是零」，这里是「测不出来」，混同就是把最危险的
// 失败模式藏起来。真正的 0 必须由调用方**显式**传 0。
export function buildStatusLine({ status = null, manifest = null, queued, now = new Date() } = {}) {
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
  // D13：排队条数取不到时**不许冒充 0**——「0 条排队请求」是一句假读数（0 是「测出来是零」，
  // 取不到是「测不出」，混同就是把最危险的失败模式藏起来）。故读不到时整句改报 unknown；
  // 真正的 0（读得到、就是 0 条）仍原样报 0。
  // 现实缓解（不是修复理由）：目前唯一调用方 site/index.html 总传 `QUEUED_PAGES.size`（有限数），
  // 今天不会真显示错；但语义漏洞要在这儿堵死——下一个调用方不该继承一个会撒谎的默认值。
  const queued_text = isFiniteNum(queued) ? `${queued} 条排队请求` : `排队请求 ${STATUS_UNKNOWN}`;

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
      : `打开同步面板：${queueCount} 页待重写 · ${queued_text}`,
    budget_text: budgetNotice(status),   // 超限才有字；未配置/未超限为 ''（遥测位不塞噪音）
    // §5.3 的规范一行（不含预算读数——预算在 #statusline 里是独立读数，超限才出现）
    text: [capture_text, rate_text, gap_text, pages_text, queue_text, stamp_text].join(' · '),
  };
}

// ---------- §5.4 视觉①：源码锚点 = 引出线注记（壳阶段 C；两形态见 D15） ----------
// 纯函数（无 DOM，Node 可直测）：从**正文 HTML**里认出锚点 → 在正文对应位置插上标角标 `[n]`，
// 并给出右栏注记模型 `notes:[{n, anchor, line}]`。
// 点角标的交互（高亮对应注记、再点取消）在 site/index.html——本函数只答「标什么、标几号」，不碰 DOM。
//
// D7（本期锚点漂移口径，计划 §2）：锚点**按生成时刻的 file:line 原样渲染**——正则只做识别与编号，
// 不重解析源码、不校验符号是否还在、**绝不静默改写行号**；notes 里的 anchor 就是正文里那串字面量。
// （行号变动 → 标 stale 还是重解析，是 ② 期的语义定案，本期明确不做。）
//
// D15（2026-09-10 审计后新增）：**两种形态都收**，但**必须区别渲染**。
//   · `fn @ file:line`（例 `runAuto @ lib/runner.js:77`）→ `line` 是行号，按 D7 原样显示；
//   · `fn @ file`（例 `finalizeSync @ lib/sync.js`）→ `line` 是 null，**绝不硬凑行号**，
//     右栏由 renderNoteHtml 显式标注「源未给行号」。
//   为什么两形态都收：文档教读者写的是 `func @ file`——`AGENTS.md`/`CLAUDE.md` 的 resident 区块
//   给的锚点示例正是这个形态，而旧正则只认 `fn @ file:line`：文档教读者写 A、工具只认 B，是工具在骗人。
//   注意理由**不是覆盖率**：两形态都收之后仍有 **87% 页面无注记**（收尾轮实测 99 页里 13 页有注记；
//   `file` 形态 223 处/9 页、`file:line` 113 处/7 页——D15 行内写的「23 页 / 23%」在渲染管线上复现不了，
//   差异口径与实测明细见计划 §9.5）。那是 wiki 内容形态决定的，**不是缺陷**——不得为了凑覆盖率去认
//   不完整的文件名。
//   为什么必须区别渲染：引出线的本义是「指向**确切**源码位置」，文件级锚点更像「出处」；
//   把 file 形态渲染成带行号，就是把「不知道」渲染成「确定」，违反不变量⑧。
//
// 收紧正则（D15 同时要求）：文件名必须带**完整扩展名（≥2 字符）**，两形态**共用同一个 ANCHOR_FILE
// 片段**（不可能只堵一边）。实测反例：markdown 硬换行把 `finalizeSync @ lib/sync.js` 截成
// `finalizeSync @ lib/sync.j`——旧正则（扩展名 ≥1）会把这个截断碎片渲染成一条看起来确定的注记，
// 比不渲染更坏。
//
// 编号：按**正文首次出现顺序**从 1 发号；同一锚点（字符串逐字相等）**复用同一编号**——
// 既不一号多义，也不一义多号。**两形态共用同一个编号空间**（同一个 Map / 同一个 notes 数组），
// 故混合出现时号序连续、不重复。重复出现处同样插角标（同一号有多处角标正是引出线的语义：
// 一个注记可以被正文多处引用）。确定性：只看输入字符串，不读挂钟；Map 只按 key 取号，
// 发号顺序由 notes 数组钉死，与 Map 迭代顺序无关。
//
// 不插角标的位置：
//   · HTML 标签内部（属性里的 `@` 不是 anchors）；
//   · `<pre>` 代码块（字面代码样本，插进去是污染）；
//   · mermaid 图源（`div.mermaid` 的 textContent 会被 route() 读回去当图源渲染，插角标直接画坏图）。
const ANCHOR_FILE = String.raw`[A-Za-z0-9_][\w./-]*\.[A-Za-z0-9]{2,}`;
const ANCHOR_RE = new RegExp(
  String.raw`(?<![\w$./-])(\/?[A-Za-z_$][\w$]*(?:[./][\w$]+)*(?:\(\))?) @ (${ANCHOR_FILE})(?::(\d+))?`, 'g');

const anchorBadge = n =>
  `<sup class="anchor-ref" data-anchor-n="${n}" role="button" tabindex="0" aria-label="引出线注记 ${n}">[${n}]</sup>`;

// html → { html, notes:[{n, anchor, line}] }。零锚点时 notes 为空数组且 **html 原样返回**（不插任何角标、
// 不产生空注记栏——空态判定交给调用方看 notes.length）。
export function renderAnchors(html) {
  if (typeof html !== 'string' || html === '') return { html, notes: [] };
  const notes = [];
  const numbered = new Map();
  // 按标签切成「文本 / 标签」交替段（偶数下标文本、奇数下标标签）——只在文本段里替换，
  // 标签属性里的 `@`（如 title="a @ b.js:1"）永远碰不到。
  const parts = html.split(/(<[^>]*>)/);
  let preDepth = 0, mermaidDepth = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {                                  // 标签：只维护「字面区」深度
      const tag = parts[i];
      if (/^<pre\b/i.test(tag)) preDepth++;
      else if (/^<\/pre\s*>$/i.test(tag)) preDepth = Math.max(0, preDepth - 1);
      else if (/^<div\b/i.test(tag) && /\bmermaid\b/.test(tag)) mermaidDepth++;
      else if (/^<\/div\s*>$/i.test(tag)) mermaidDepth = Math.max(0, mermaidDepth - 1);
      continue;
    }
    if (!parts[i] || preDepth > 0 || mermaidDepth > 0) continue;
    // 捕获组：(1) 符号 (2) 文件 (3) 行号（**可缺省**——缺省即 D15 的 file 形态，line 记 null）
    parts[i] = parts[i].replace(ANCHOR_RE, (match, _fn, _file, line) => {
      if (!numbered.has(match)) {
        numbered.set(match, notes.length + 1);          // 首次出现才发号（号序 = 正文顺序）
        notes.push({ n: notes.length + 1, anchor: match, line: line === undefined ? null : Number(line) });
      }
      return match + anchorBadge(numbered.get(match));
    });
  }
  if (notes.length === 0) return { html, notes: [] };   // 零锚点：返回原串，连重建都不做
  return { html: parts.join(''), notes };
}

// 文件级锚点（源未给行号）的显式标注语（D15）——导出成常量供测试与调用方共用同一串字面量。
export const ANCHOR_NO_LINE = '源未给行号';

const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 单条注记的**纯**渲染器（无 DOM，Node 可直测）——D15 的「区别渲染」是硬要求，必须能断言其行为，
// 而不是只去 grep site/index.html 里有没有那四个字（计划 §9.3 的教训：验字样只给虚假的通过感）。
//   · line 是有限数 → 行号已在 anchor 字面量里原样显示（D7），此外不加任何东西；
//   · line 为 null（file 形态）→ **不显示行号**，改为显式标注「源未给行号」：文件级锚点的确定性
//     低于行级锚点，渲染成一样就是伪造确定性（不变量⑧）。
export function renderNoteHtml(note) {
  const { n, anchor, line = null } = note;
  const hasLine = typeof line === 'number' && Number.isFinite(line);
  return `<div class="note" id="note-${n}" data-note-n="${n}">`
    + `<span class="note-n">[${n}]</span>`
    + `<code class="note-anchor">${escHtml(anchor)}</code>`
    + (hasLine ? '' : `<span class="note-src">${ANCHOR_NO_LINE}</span>`)
    + `</div>`;
}

// ---------- §5.4 视觉②：决策史 = 修改记录表（壳阶段 C） ----------
// 列表格式的**唯一真源**是 lib/sync.js 的 renderDecisionHistory：`- **title** — why (sha, date)`；
// 无 sha 的原子是 `(date)`（并在壳阶段 C 起附加 atom id 载体）。本段只做「识别 + 排版」：
// 绝不改写语义、绝不重算版本、绝不丢行。
//
// 版本列规则（计划 D6，设计评审 🔴 的修复项，严格执行）：
//   · 有 sha → 用短 sha（生成侧已截 7 位，这里原样取用）；
//   · 无 sha 的原子 → **用 atom id 兜底**。理由已实测：525 原子 / 513 提交，commit 型原子每个 sha
//     恰好 1 条（天然唯一），唯一的多原子提交是 13 条**没有 sha** 的原子——只靠日期它们会互相撞车。
//     兜底顺序：atom id（生成侧附的载体）→ 日期（仅当页面是改造前的旧物化内容、载体还不存在时；
//     这是能力边界不是设计选择，重物化一次即消失）。
//   · 解析失败（没有 `(…)` 元信息 / 元信息形态不认识）→ **降级：整行进「变更与原因」、日期列 `—`，
//     绝不丢行**（版本列同样 `—`：既然身份没解析出来，就不猜）。
export const DECISION_EMPTY = '暂无 journal 原子（跑 /lore:mine 补全）。';

// 决策史小节标题的**唯一口径**（遗留 🔵#10 的三处统一）——下列三处判定必须给出同一个答案：
//   · lib/sync.js 的 DH_HEADING_RE（生成侧定位，判整行 md）；
//   · site/index.html 的 decisionSection()（壳侧 F3 可用性，判 h2 的**文本**）；
//   · 本文件 renderDecisionTable（壳侧转表，判整行 md）。
// 统一后的口径 = 变体集（英文 `Decision history` + 决策史 / 决策历史 / 决策与时间线）
//   + **大小写不敏感** + 标题名后必须是**空白或行尾**。
// 为什么要大小写不敏感：此前只有 index.html 带 `/i`——小写 `## decision history` 会让 F3 亮起，
//   而 renderDecisionTable 认不出来、不转表：同一个标题在两处得到相反答案，而 shell.mjs 那句
//   「与 site/index.html 的 F3 判定同口径」正是假注释（本次连注释一起修正）。
// 为什么要边界：纯前缀匹配会把 `## 决策历史附录` / `## Decision history中文` 也认成决策史小节
//   （前者还会被整段换成表格），而生成侧 lib/sync.js 一直按「不是」处理（test/sync.test.js 把
//   这两个 lookalike 钉住了）——一边严一边松就不叫统一口径。
// 为什么 lib/sync.js 不 import 这里的常量：分层方向是 壳 → lib（site/ 是物化产物），lib 反向依赖
//   site/ 会缠住初始化；两处一致性改由 test/shell.test.js 的**交叉断言**守住——同一样本集分别喂
//   foldJournal（生成侧）与本文件的判定，逐条比对结论，谁改歪了都会红。
const DECISION_HEADING_NAMES = 'Decision history|决策史|决策历史|决策与时间线';
// 标题**文本**口径（供 h2 的 textContent 判定；也是其余两个正则的唯一样本集来源）
export const DECISION_HEADING_TEXT_RE = new RegExp(`^(?:${DECISION_HEADING_NAMES})(?:[ \\t\\r]|$)`, 'i');
// 整行 md 口径：由上面那份变体集拼出，**不另写一套**（两个正则各写各的正是本 bug 的成因）。
// `[ \t\r]` 里带上 `\r`：CRLF 页面按 '\n' 切行后行尾会留一个 `\r`。
const DECISION_HEADING_RE = new RegExp(`^##[ \\t]+(?:${DECISION_HEADING_NAMES})(?:[ \\t\\r]|$)`, 'i');

// 标题文本是否是决策史小节标题（site/index.html 的 F3 判定与 renderDecisionTable 共用同一判据）。
export function isDecisionHeading(text) {
  return DECISION_HEADING_TEXT_RE.test(String(text ?? '').trim());
}

const DECISION_SHA_DATE = /^([0-9a-f]{4,40}),\s*(\d{4}-\d{2}-\d{2})$/i;
const DECISION_DATE_ONLY = /^(\d{4}-\d{2}-\d{2})$/;
// 生成侧只对**无 sha** 原子附加的 atom id 载体（lib/sync.js renderDecisionHistory）
const DECISION_ID_SPAN = / ?<span class="atom-id" title="([^"]*)"[^>]*>[\s\S]*?<\/span>\s*$/;

function unescapeAttrValue(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

// 单行 → 三列。行首 `- ` 是列表语法不是内容，剥掉；atom id 载体是元数据载体，剥掉后单独返回。
function parseDecisionRow(line) {
  let text = line.replace(/^[-*]\s+/, '').trim();
  let atom_id = null;
  const idm = DECISION_ID_SPAN.exec(text);
  if (idm) { atom_id = unescapeAttrValue(idm[1]); text = text.slice(0, idm.index).trim(); }
  const meta = /\(([^()]*)\)\s*$/.exec(text);                 // 末尾元信息 `(sha, date)` / `(date)`
  const fields = meta ? meta[1].trim() : '';
  const shaDate = DECISION_SHA_DATE.exec(fields);
  const dateOnly = DECISION_DATE_ONLY.exec(fields);
  if (meta && (shaDate || dateOnly)) {
    const change = text.slice(0, meta.index).trim();           // `**title** — why`（保留 md 标记，交 inline() 渲染）
    if (shaDate) return { version: shaDate[1], date: shaDate[2], change, atom_id };
    return { version: atom_id ?? dateOnly[1], date: dateOnly[1], change, atom_id };
  }
  return { version: '—', date: '—', change: text, atom_id };   // 降级（整行进 change 列，绝不丢行）
}

// 决策史列表 md → [{version, date, change, atom_id}]。空态提示串 → 空数组（不是一条"行"）。
export function parseDecisionLog(md) {
  const rows = [];
  for (const raw of String(md ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;                                       // 空行
    if (line.startsWith('<!--')) continue;                     // LORE_JOURNAL 哨兵注释
    if (/^#{1,6}\s/.test(line)) continue;                      // 标题行不是条目
    if (line === DECISION_EMPTY) continue;                     // 空态提示不是条目（→ 空数组）
    rows.push(parseDecisionRow(line));
  }
  return rows;
}

// 单元格文本里只中和 `|`（表格分隔符）——不转义 `&`/`<`：change 列要留给 renderMarkdown 的 inline()
// 处理 `**粗体**` / `` `代码` `` / 链接与生成侧附加的 HTML（模块顶部的 raw-passthrough 口径不变）。
// 已知角落（遗留 🔵#15，**刻意不改行为**，只记在案）：`&#124;` 落进**代码 span** 会被二次转义——
// inline() 的 esc() 再把 `&` 变成 `&amp;`，于是 `` `|| true` `` 这类样本显示成字面的 `&#124;&#124; true`。
// 触发条件是「why/title 里同时有反引号与竖线」，本仓 journal 实测 542 行里已有 1 条（why 含
// `` `|| true` `` 的那个 commit 原子）——不是纯理论角落，但仍属显示瑕疵：要根治得让 decisionCell
// 感知反引号区间（在代码 span 内不中和 `|`），代价是它得复制一份 markdown 行内语法知识，
// 收益小于「表格被裸 `|` 撕成多格」的风险，故本轮只留痕。
const decisionCell = s => String(s ?? '').replace(/\|/g, '&#124;');
const decisionAttr = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// D6 的交叉引用落点：atom id 必须**能在渲染结果里取到**——挂进版本格的 title 属性，
// 用户据此对照 `lore confirm <atom-id>`。没有载体（有 sha 的原子 / 旧内容）就不加属性，不编造。
const decisionVersionCell = r => (r.atom_id
  ? `<span class="dh-ver" title="${decisionAttr(r.atom_id)}">${decisionCell(r.version)}</span>`
  : decisionCell(r.version));

function decisionTableMd(rows) {
  return [
    '| 版本 | 日期 | 变更与原因 |',
    '|---|---|---|',
    ...rows.map(r => `| ${decisionVersionCell(r)} | ${decisionCell(r.date)} | ${decisionCell(r.change)} |`),
  ];
}

// 整页 md → 决策史小节里的列表换成三列表格 md（其余字节原样）。喂给既有 renderMarkdown 的表格渲染。
// 不渲染的情形（**都返回原串**，避免每页挂一堆空壳）：
//   · 没有决策史小节（无决策史的页 → 不得出现空表）；
//   · 小节里没有列表（空态提示 / 手写自管内容 → 不得渲染出空表头）。
// **版式语义（这里写死，test/shell.test.js 逐行钉住）**：表格落在**第一条列表行**的位置；
// 段内非列表行（散文 / 分节语）一行不丢，但会被移到整张表格**之后**——相对彼此的顺序不变，
// 相对条目的位置变了。例：`- A` / `散文` / `- B` → `[表格(A,B)]` / `散文`，
// 也就是说那句本意是 B 的引言会挂在整张表后面，**不是「原位保留」**（旧注释就是这么说错的）。
// 为什么不做真·原位分段插表把它夹回两张表之间：那张表会有多个表头，而壳侧的
// tagDecisionTable 只认小节里的第一张表（版本/日期的 mono 排版挂在它身上），拆表得连调用点一起改，
// 超出这个渲染器的职责。
export function renderDecisionTable(md) {
  if (typeof md !== 'string' || md === '') return md;
  const lines = md.split('\n');
  // 全篇围栏位图：三处扫描（找小节 / 收集条目 / 拼回输出）必须**同一口径**。
  // 中间那段收集列表行的循环原先漏了围栏追踪——手写决策史小节里夹代码块时，
  // 块内 `- ` 开头的样本会被当条目抽进表格，反而把代码块本身抽掉一行。
  const inFence = new Array(lines.length).fill(false);
  {
    let f = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^```/.test(lines[i])) { f = !f; continue; }   // 围栏行自身既不是条目也不是标题
      inFence[i] = f;
    }
  }
  let head = -1;
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;                            // 围栏代码块里的 `## …` 不是标题
    if (DECISION_HEADING_RE.test(lines[i])) { head = i; break; }
  }
  if (head === -1) return md;
  let end = lines.length;
  for (let i = head + 1; i < lines.length; i++) {
    if (inFence[i]) continue;
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  let first = -1, last = -1;
  for (let i = head + 1; i < end; i++) {
    if (inFence[i]) continue;
    if (/^[-*]\s/.test(lines[i])) { if (first === -1) first = i; last = i; }
  }
  if (first === -1) return md;
  // 只把列表行喂给 parseDecisionLog（段内非列表行跳过）：手工维护的决策史小节里，
  // 两列表项之间常夹着一段散文（说明 / 分节语），原先 `slice(first, last+1)` 把整段散文也喂了进去
  // → 散文被当成「解析失败的降级行」塞进表格（version/date 均为 —），不丢数据但版式误导。
  // 「不丢行」原则不变：真正的列表行一条都不丢（含被散文隔开的下半段），只是散文不进表格。
  const seg = [];
  for (let i = first; i <= last; i++) {
    if (!inFence[i] && /^[-*]\s/.test(lines[i])) seg.push(lines[i]);
  }
  const rows = parseDecisionLog(seg.join('\n'));
  if (rows.length === 0) return md;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === first) out.push(...decisionTableMd(rows));                 // 表格落在第一条列表行处
    if (i >= first && i <= last && !inFence[i] && /^[-*]\s/.test(lines[i])) continue;   // 已并入表格
    out.push(lines[i]);                                                  // 其余字节（含散文、含围栏内样本）原样保留
  }
  return out.join('\n');
}
