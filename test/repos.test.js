// test/repos.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRepo, listRepos } from '../lib/repos.js';

function tmpReposPath() { return join(mkdtempSync(join(tmpdir(), 'lore-repos-')), 'repos.json'); }

// 造一个真实的 <base>/<repoName>/.lore 目录；返回 loreDir。删 join(loreDir,'..','..') 清整个 base。
function makeLore(repoName) {
  const base = mkdtempSync(join(tmpdir(), 'lore-repo-'));
  const loreDir = join(base, repoName, '.lore');
  mkdirSync(loreDir, { recursive: true });
  return loreDir;
}

test('registerRepo: 取 repo 根目录名为 name，并持久化', () => {
  const p = tmpReposPath();
  const loreDir = makeLore('myrepo');
  try {
    const entry = registerRepo(p, { loreDir });
    assert.equal(entry.name, 'myrepo');
    assert.equal(entry.loreDir, loreDir);
    assert.deepEqual(listRepos(p).map(e => e.name), ['myrepo']);
  } finally {
    rmSync(join(p, '..'), { recursive: true, force: true });
    rmSync(join(loreDir, '..', '..'), { recursive: true, force: true });
  }
});

test('registerRepo: 同 loreDir 幂等（不重复登记）', () => {
  const p = tmpReposPath();
  const loreDir = makeLore('repoA');
  try {
    const a = registerRepo(p, { loreDir });
    const b = registerRepo(p, { loreDir });
    assert.deepEqual(a, b);
    assert.equal(listRepos(p).length, 1);
  } finally {
    rmSync(join(p, '..'), { recursive: true, force: true });
    rmSync(join(loreDir, '..', '..'), { recursive: true, force: true });
  }
});

test('registerRepo: 同名不同 loreDir → 加 -2 后缀', () => {
  const p = tmpReposPath();
  const a = makeLore('lore');   // <tmpA>/lore/.lore
  const b = makeLore('lore');   // <tmpB>/lore/.lore（同 basename，不同路径）
  try {
    assert.equal(registerRepo(p, { loreDir: a }).name, 'lore');
    assert.equal(registerRepo(p, { loreDir: b }).name, 'lore-2');
  } finally {
    rmSync(join(p, '..'), { recursive: true, force: true });
    rmSync(join(a, '..', '..'), { recursive: true, force: true });
    rmSync(join(b, '..', '..'), { recursive: true, force: true });
  }
});

test('listRepos: 过滤掉 loreDir 已不存在的条目', () => {
  const p = tmpReposPath();
  const a = makeLore('alive');
  const b = makeLore('gone');
  try {
    registerRepo(p, { loreDir: a });
    registerRepo(p, { loreDir: b });
    rmSync(join(b, '..', '..'), { recursive: true, force: true });   // 删掉 repo b
    assert.deepEqual(listRepos(p).map(e => e.name), ['alive']);
  } finally {
    rmSync(join(p, '..'), { recursive: true, force: true });
    rmSync(join(a, '..', '..'), { recursive: true, force: true });
  }
});

test('listRepos: 文件不存在 → []', () => {
  assert.deepEqual(listRepos(join(tmpdir(), 'lore-repos-nope', 'repos.json')), []);
});
