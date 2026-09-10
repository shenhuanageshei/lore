// test/helpers/shell-slice.js
// 壳（site/index.html）内联 module 脚本的源码 + 「从 header 起切出整段函数」的抽取器——**全仓唯一一份**。
//
// 为什么抽到共享 helper（遗留 🔵#18）：这两个玩意儿原先在 test/shell.test.js 与 test/server.test.js
// 里**逐字复制了两份**。抽取器是「按花括号配对切源码」的白盒工具，壳里那几块被抽的函数一旦改形状
// （或抽取器本身要修边界），就得改两处；漏一处的后果不是「测试报错」而是**静默失真**——另一份
// 照旧切出旧形状、断言照旧在跑、照旧全绿，比不测更糟。
//
// 注（记账，不是问题）：Node 的 `node --test` 会把 test/ 目录下的**每个** .js 都当测试文件执行，
// 因此本文件也会被单独跑一次（无 test() → 0 断言、恒过）。这是把它放在 test/ 下的代价，
// 已记在 docs/superpowers/plans/2026-09-10-lore-shell-light-workbench.md §9.11：
// 全量 `node --test` 的文件数会 +1（用例数不变）。
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

export const SHELL_HTML = readFileSync(new URL('../../site/index.html', import.meta.url), 'utf8');

// 从 header 起按花括号配对切出整段函数（跳过字符串/模板/行注释里的花括号）。
// 抽不到就直接失败：抽取器静默失真 = 测试假装通过，比不测更糟。
export function sliceShellFn(header) {
  const at = SHELL_HTML.indexOf(header);
  assert.notEqual(at, -1, `site/index.html 里找不到「${header}」——抽取器失效，需同步更新本测试`);
  let depth = 0, quote = null, i = SHELL_HTML.indexOf('{', at);
  for (; i < SHELL_HTML.length; i++) {
    const c = SHELL_HTML[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '/' && SHELL_HTML[i + 1] === '/') { i = SHELL_HTML.indexOf('\n', i); if (i === -1) break; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { i++; break; }
  }
  return SHELL_HTML.slice(at, i);
}
