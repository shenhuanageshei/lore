import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathComponent, parseGitLog } from '../lib/mine.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'lore-mine-')); }

test('pathComponent: prefix match → last segment', () => {
  assert.equal(pathComponent('lib/sync.js', ['lib', 'site']), 'lib');
  assert.equal(pathComponent('site/shell.mjs', ['lib', 'site']), 'site');
});

test('pathComponent: longest match wins, last segment name', () => {
  assert.equal(pathComponent('src/pkg/core.py', ['src', 'src/pkg']), 'pkg');
});

test('pathComponent: no match → null (and prefix-of-name does not falsely match)', () => {
  assert.equal(pathComponent('README.md', ['lib', 'site']), null);
  assert.equal(pathComponent('libfoo/x.js', ['lib']), null);
});

test('parseGitLog parses commits with multi-line body and files', () => {
  const RS = '\x1e', US = '\x1f';
  const stdout =
    `${RS}abc123${US}2026-06-01T08:00:00Z${US}fix bug${US}body line1\nbody line2${US}\n\nlib/a.js\nlib/b.js\n` +
    `${RS}def456${US}2026-05-30T10:00:00+09:00${US}add feature${US}${US}\n\nsite/x.mjs\n`;
  const commits = parseGitLog(stdout);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0], {
    sha: 'abc123', ts: '2026-06-01T08:00:00Z', subject: 'fix bug',
    body: 'body line1\nbody line2', files: ['lib/a.js', 'lib/b.js'],
  });
  assert.deepEqual(commits[1], {
    sha: 'def456', ts: '2026-05-30T10:00:00+09:00', subject: 'add feature',
    body: '', files: ['site/x.mjs'],
  });
});

test('parseGitLog: empty stdout → []', () => {
  assert.deepEqual(parseGitLog(''), []);
});
