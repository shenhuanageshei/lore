// test/backend.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { claudeBackend, codexBackend, opencodeBackend, backendFor, detectAvailableBackends, resolveBackendChain, BackendError } from '../lib/backend.js';

const okExec = (stdout = 'v1.0.0') => (cmd, args, opts, cb) => cb(null, stdout, '');
const missingExec = () => (cmd, args, opts, cb) => { const e = new Error('spawn ENOENT'); e.code = 'ENOENT'; cb(e, '', ''); };

test('claudeBackend: argv 白名单 + 从首个 frontmatter 截取 + ENOENT→unavailable', async () => {
  let seen;
  const exec = (cmd, args, opts, cb) => { seen = { cmd, args, opts }; cb(null, 'junk\n---\ntitle: t\n---\nbody', ''); };
  const b = claudeBackend({ exec });
  const text = await b.rewritePage({ page: { path: 'component/x.md', axis: 'component' }, repoRoot: '/r' });
  assert.equal(seen.cmd, 'claude');
  assert.equal(seen.args[0], '-p');
  // prompt 必须排在可变参数（--allowedTools/--disallowedTools <tools...>）之前——
  // 否则被当成工具名吞掉（claude 2.1.191 实测报 "Input must be provided..."，auto 档每页必失败）。
  const promptIdx = seen.args.findIndex(a => typeof a === 'string' && a.includes('component/x.md'));
  assert.ok(promptIdx > 0, 'prompt 应在 argv 中');
  assert.ok(promptIdx < seen.args.indexOf('--allowedTools'), 'prompt 必须在 --allowedTools 之前');
  assert.ok(promptIdx < seen.args.indexOf('--disallowedTools'), 'prompt 必须在 --disallowedTools 之前');
  const allowedIdx = seen.args.indexOf('--allowedTools');
  assert.deepEqual(seen.args.slice(allowedIdx, allowedIdx + 2), ['--allowedTools', 'Read,Grep,Glob']);
  assert.equal(seen.args[seen.args.indexOf('--disallowedTools') + 1], 'Write,Edit,Bash');
  assert.equal(seen.opts.cwd, '/r');
  assert.equal(seen.opts.timeout, 1_200_000);
  assert.equal(text, '---\ntitle: t\n---\nbody');
  await assert.rejects(claudeBackend({ exec: missingExec() }).rewritePage({ page: { path: 'x' }, repoRoot: '/r' }),
    e => e instanceof BackendError && e.unavailable === true && /claude-cli-missing/.test(e.message));
});

test('classify: killed → timeout（不可 failover）；maxBuffer 溢出不误报 timeout', async () => {
  const killedExec = (cmd, args, opts, cb) => { const e = new Error('Command failed'); e.killed = true; cb(e, '', ''); };
  await assert.rejects(claudeBackend({ exec: killedExec }).rewritePage({ page: { path: 'x' }, repoRoot: '/r' }),
    e => e instanceof BackendError && /timeout/.test(e.message) && e.unavailable === false);
  const bufExec = (cmd, args, opts, cb) => {
    const e = new Error('Command failed'); e.killed = true; e.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'; cb(e, '', '');
  };
  await assert.rejects(claudeBackend({ exec: bufExec }).rewritePage({ page: { path: 'x' }, repoRoot: '/r' }),
    e => e instanceof BackendError && /maxBuffer/.test(e.message) && !/timeout/.test(e.message) && e.unavailable === false);
});

test('codexBackend: 错误路径同样清理 last-message 残留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lore-codex-err-'));
  try {
    const failing = (cmd, args, opts, cb) => {
      const outFile = args[args.indexOf('--output-last-message') + 1];
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, 'stale-from-previous-run');
      cb(new Error('exit 1'), '', 'boom');
    };
    await assert.rejects(codexBackend({ exec: failing }).rewritePage({ page: { path: 'x' }, repoRoot: dir }));
    assert.ok(!existsSync(join(dir, '.lore', '.state', 'codex-last-message.md')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('codexBackend: --sandbox read-only 必含 + last-message 文件优先 + auth 错误→unavailable', async () => {
  let seen;
  const exec = (cmd, args, opts, cb) => { seen = { cmd, args }; cb(null, '---\ntitle: s\n---\nstdout-body', ''); };
  const b = codexBackend({ exec });
  const text = await b.rewritePage({ page: { path: 'component/x.md', axis: 'component' }, repoRoot: '/r' });
  assert.equal(seen.cmd, 'codex');
  assert.ok(seen.args.includes('exec'));
  const si = seen.args.indexOf('--sandbox');
  assert.equal(seen.args[si + 1], 'read-only');
  assert.ok(seen.args.includes('--output-last-message'));
  assert.equal(text, '---\ntitle: s\n---\nstdout-body');   // last-message 文件读不到 → stdout 回落
  const authExec = (cmd, args, opts, cb) => { const e = new Error('exit 1'); cb(e, '', 'Not logged in. Please run codex login'); };
  await assert.rejects(codexBackend({ exec: authExec }).rewritePage({ page: { path: 'x' }, repoRoot: '/r' }),
    e => e.unavailable === true);
});

test('opencodeBackend: opencode run + stderr 截断', async () => {
  let seen;
  const exec = (cmd, args, opts, cb) => { seen = { cmd, args }; cb(null, '---\ntitle: o\n---\nbody', ''); };
  const b = opencodeBackend({ exec });
  await b.rewritePage({ page: { path: 'component/x.md', axis: 'component' }, repoRoot: '/r' });
  assert.equal(seen.cmd, 'opencode');
  assert.equal(seen.args[0], 'run');
  const errExec = (cmd, args, opts, cb) => { const e = new Error('exit 1'); e.killed = false; cb(e, '', 'x'.repeat(500)); };
  await assert.rejects(opencodeBackend({ exec: errExec }).rewritePage({ page: { path: 'x' }, repoRoot: '/r' }),
    e => e.message.length <= 320 && e.unavailable === false);
});

test('detectAvailableBackends: binary 缺/provider 挂都跳过', async () => {
  const allOk = okExec();
  assert.deepEqual(await detectAvailableBackends({ exec: allOk }), ['claude', 'codex', 'opencode']);
  const noCodexLogin = (cmd, args, opts, cb) => {
    if (cmd === 'codex' && args[0] === 'login') return cb(new Error('exit 1'), '', 'not logged in');
    cb(null, 'v1', '');
  };
  assert.deepEqual(await detectAvailableBackends({ exec: noCodexLogin }), ['claude', 'opencode']);
  assert.deepEqual(await detectAvailableBackends({ exec: missingExec() }), []);
  let seenTimeout = 0;
  await detectAvailableBackends({ exec: (cmd, args, opts, cb) => { seenTimeout = opts.timeout; cb(null, 'v1', ''); } });
  assert.ok(seenTimeout >= 20000, `探测预算需容 CLI 冷启动（实测 7.5s），实为 ${seenTimeout}`);
});

test('resolveBackendChain: 配置指定短路；auto 按探测序', async () => {
  const chain = await resolveBackendChain('codex', { exec: okExec() });
  assert.equal(chain.length, 1);
  assert.equal(chain[0].name, 'codex');
  const auto = await resolveBackendChain('auto', { exec: okExec() });
  assert.deepEqual(auto.map(b => b.name), ['claude', 'codex', 'opencode']);
  assert.equal(backendFor('vim'), null);
});

test('codexBackend: --output-last-message 文件存在时优先于 stdout，且读后清理', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lore-codex-'));
  try {
    const exec = (cmd, args, opts, cb) => {
      const outFile = args[args.indexOf('--output-last-message') + 1];
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, '---\ntitle: file\n---\nfrom-file');
      cb(null, '---\ntitle: stdout\n---\nfrom-stdout', '');
    };
    const b = codexBackend({ exec });
    const text = await b.rewritePage({ page: { path: 'component/x.md', axis: 'component' }, repoRoot: dir });
    assert.equal(text, '---\ntitle: file\n---\nfrom-file');                          // 文件优先
    assert.ok(!existsSync(join(dir, '.lore', '.state', 'codex-last-message.md')));    // 读后已清理
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
