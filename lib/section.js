// lib/section.js —— wiki 页节级操作（spec 2026-06-11-lore-agent-residency）。
// manifest（节索引）/ ask（节命中+切片）/ mcp（view=agent / section 参数）三消费者共享。
// 全部机械文本操作：无标题/非两档页退化原样，不崩。

const MD_HEADING = /^(#{2,3})\s+(.+?)\s*$/;                       // ## / ### 标题
const SUMMARY_HEADING = /<summary><b>([①②③④⑤⑥⑦⑧][^<]*)<\/b>/;   // 机制档折叠节

// 提取节列表 [{heading, line}]（line 从 0 计，指标题所在行）。
export function extractSections(text) {
  const lines = (text ?? '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(MD_HEADING);
    if (m) { out.push({ heading: m[2], line: i }); continue; }
    const s = lines[i].match(SUMMARY_HEADING);
    if (s) out.push({ heading: s[1].trim(), line: i });
  }
  return out;
}

// 取单节内容：md 标题切到下一同级/更高级标题；<summary> 节切到 </details>。未知节 → null。
export function sliceSection(text, heading) {
  const lines = (text ?? '').split('\n');
  const sections = extractSections(text);
  const hit = sections.find(s => s.heading === heading);
  if (!hit) return null;
  const startLine = lines[hit.line];
  const md = startLine.match(MD_HEADING);
  let end = lines.length;
  if (md) {
    const level = md[1].length;
    for (let i = hit.line + 1; i < lines.length; i++) {
      const m = lines[i].match(MD_HEADING);
      if (m && m[1].length <= level) { end = i; break; }
    }
  } else {
    for (let i = hit.line + 1; i < lines.length; i++) {
      if (lines[i].includes('</details>')) { end = i + 1; break; }
    }
  }
  return lines.slice(hit.line, end).join('\n');
}

// agent 视图：剥「人读概览档」+「决策史物化区」，只留机制骨架——读厚页不烧概览/决策史。
// 决策史从「读页默认带」变「按需取」（lore_page section="Decision history"）——benchmark R1 贵的根因优化。
const DH_POINTER = '> 决策史按需取：lore_page section="Decision history"（或 ask "<主题> 为什么"）。';
export function agentView(text) {
  let lines = (text ?? '').split('\n');
  // 1. 剥概览档（## 概览 → ## 机制详解 之间；无两档结构则跳过此步）
  let start = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+概览\s*$/.test(lines[i]) && start === -1) start = i;
    else if (/^##\s+机制详解\s*$/.test(lines[i])) { end = i; break; }
  }
  if (start !== -1 && end !== -1 && end > start) lines = [...lines.slice(0, start), ...lines.slice(end)];
  // 2. 剥决策史物化区（## Decision history → 下一 ## 或文末）→ 替换为指针行
  const di = lines.findIndex(l => /^##\s+Decision history\s*$/.test(l));
  if (di !== -1) {
    let dEnd = lines.length;
    for (let i = di + 1; i < lines.length; i++) if (/^##\s+/.test(lines[i])) { dEnd = i; break; }
    lines = [...lines.slice(0, di + 1), '', DH_POINTER, '', ...lines.slice(dEnd)];
  }
  return lines.join('\n');
}
