export const HOME_STATUS_TOKEN = '{{LORE_HOME_STATUS}}';
const STATUS_START = '<!-- LORE_HOME_STATUS:START -->';
const STATUS_END = '<!-- LORE_HOME_STATUS:END -->';

export function defaultHomePage({ title = 'lore', axisPages = {} } = {}) {
  const ids = axis => (axisPages[axis] ?? []).map(p => p.id);
  const docs = ids('docs');
  // Only link pages that exist; fall back to INDEX (always present post-finalize)
  // so the mechanical scaffold never ships dangling wikilinks.
  const bullets = arr => (arr.length ? arr : ['INDEX']).map(id => `- [[${id}]]`).join('\n');
  const understand = bullets(ids('component').slice(0, 3));
  const debug = bullets(['pitfalls', 'ROADMAP', 'troubleshooting'].filter(id => docs.includes(id)));
  const decisions = bullets(docs.includes('changelog') ? ['changelog'] : []);
  return `---\ntitle: Home\nsummary: human-readable orientation map for this repository\n---\n# ${title}\n\nThis repository is documented as a living wiki: code, docs, decisions, and flows are folded into pages humans and agents can both use.\n\n${HOME_STATUS_TOKEN}\n\n## Knowledge flow\n\n\`\`\`mermaid\nflowchart LR\n  repo["Repo code/docs"] --> capture["Capture"]\n  capture --> journal[".lore/journal"]\n  journal --> sync["Sync"]\n  sync --> wiki[".lore/wiki"]\n  wiki --> human["Human reading"]\n  wiki --> agent["Agent retrieval"]\n\`\`\`\n\n## Understand the project\n\n${understand}\n\n## Debug a problem\n\n${debug}\n\n## Decisions and timeline\n\n${decisions}\n`;
}

export function buildHomeStatus({ version, codeSha, lastUpdated, axisPages, language, translationStats }) {
  const axisLine = Object.entries(axisPages)
    .filter(([, pages]) => pages && pages.length)
    .map(([axis, pages]) => `${axis} ${pages.length}`)
    .join(' · ') || 'none';
  const langs = language.available.join(', ');
  return `## Status\n\n- Version: \`${version}\`\n- Code: \`${codeSha}\`\n- Updated: \`${lastUpdated}\`\n- Axes: \`${axisLine}\`\n- Language: \`${language.default}\` default · \`${langs}\` available\n- Translations: \`${translationStats.ready} ready\` · \`${translationStats.stale} stale\` · \`${translationStats.missing} missing\``;
}

// Idempotent: the status lives inside a sentinel-delimited region so re-running
// sync swaps it in place. The {{LORE_HOME_STATUS}} token only exists on a freshly
// authored page (first finalize); after that the region carries the marker pair.
export function finalizeHomeText(text, statusMarkdown) {
  const block = `${STATUS_START}\n${statusMarkdown}\n${STATUS_END}`;
  const re = new RegExp(`${STATUS_START}[\\s\\S]*?${STATUS_END}`);
  if (re.test(text)) return text.replace(re, () => block);
  if (text.includes(HOME_STATUS_TOKEN)) return text.replace(HOME_STATUS_TOKEN, () => block);
  return `${text.replace(/\s+$/, '')}\n\n${block}\n`;
}
