// test/section.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSections, sliceSection, agentView } from '../lib/section.js';

const PAGE = `---
title: X
summary: s
---
# component: x

## 概览

**一句话**：比喻给人看的。

一个场景看懂。

## 机制详解

<details>
<summary><b>① 接口 / 能力面</b> —— 导出与签名</summary>

| 导出 | 签名 |
|---|---|
| f | (a) → b |

</details>

<details>
<summary><b>⑤ 边界 / 坑</b> —— 查 BUG 必看</summary>

- 坑一：撕裂读由 notify 兜底。

</details>

## 依赖 / 邻居

- 依赖：a · b

## Decision history

<!-- LORE_JOURNAL:START -->
- old
<!-- LORE_JOURNAL:END -->
`;

test('extractSections: ##/### 标题 + ①-⑧ <summary> 都算节（带行号）', () => {
  const s = extractSections(PAGE);
  const headings = s.map(x => x.heading);
  assert.ok(headings.includes('概览'));
  assert.ok(headings.includes('机制详解'));
  assert.ok(headings.includes('① 接口 / 能力面'));
  assert.ok(headings.includes('⑤ 边界 / 坑'));
  assert.ok(headings.includes('依赖 / 邻居'));
  for (const x of s) assert.equal(typeof x.line, 'number');
  assert.deepEqual(extractSections('no headings at all'), []);
});

test('sliceSection: 切到下一同级/更高级标题；<summary> 节切到 </details>；未知节 → null', () => {
  const gai = sliceSection(PAGE, '概览');
  assert.match(gai, /比喻给人看的/);
  assert.doesNotMatch(gai, /机制详解/);
  const pit = sliceSection(PAGE, '⑤ 边界 / 坑');
  assert.match(pit, /撕裂读由 notify 兜底/);
  assert.doesNotMatch(pit, /接口 \/ 能力面/);
  assert.equal(sliceSection(PAGE, '不存在的节'), null);
});

test('agentView: 剥「## 概览」到「## 机制详解」之间的人读内容；非两档页原样', () => {
  const v = agentView(PAGE);
  assert.doesNotMatch(v, /比喻给人看的/);
  assert.match(v, /机制详解/);
  assert.match(v, /撕裂读由 notify 兜底/);          // 机制档保留
  assert.match(v, /LORE_JOURNAL:START/);             // 决策史保留
  assert.match(v, /^---\ntitle: X/);                 // frontmatter 保留
  const plain = '# 普通页\n\n没有两档结构。\n';
  assert.equal(agentView(plain), plain);             // 容错：原样
});
