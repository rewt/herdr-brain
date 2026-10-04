import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { runPTY, PTY_SKIP_REASON } from './helpers/pty.mjs';

test('PTY native owner leaves the calling environment intact without an offline root', { skip: PTY_SKIP_REASON }, () => {
  const env = { ...process.env, HERDR_ENV: '1', HERDR_PANE_ID: 'fixture-pane', ORG_ACTOR: 'fixture-actor' };
  delete env.HERDR_TEST_OFFLINE_ROOT;
  const result = cp.spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    // The outer containment policy may reinstate this in a spawned child.
    // Remove it here so the standalone helper really exercises its fallback.
    delete process.env.HERDR_TEST_OFFLINE_ROOT;
    const before = { ...process.env };
    const { runPTY } = await import(${JSON.stringify(new URL('./helpers/pty.mjs', import.meta.url).href)});
    for (let i = 0; i < 2; i++) {
      const result = runPTY(process.execPath, ['-e', 'console.log(process.stdin.isTTY)']);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /true/);
      const changed = [...new Set([...Object.keys(before), ...Object.keys(process.env)])]
        .filter(key => before[key] !== process.env[key]);
      assert.deepEqual(changed, [], 'PTY compilation and cached launches must preserve every environment variable');
    }
  `], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('PTY fixtures compile unchanged native ownership code once and keep fault variants separate', { skip: PTY_SKIP_REASON }, t => {
  const native = cp.spawnSync, builds = [];
  cp.spawnSync = (command, args, options) => {
    if (command === '/usr/bin/cc') builds.push(args.at(-1));
    return native(command, args, options);
  };
  syncBuiltinESMExports();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-cache-test-'));
  t.after(() => { cp.spawnSync = native; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); });
  const run = options => {
    const result = runPTY(process.execPath, ['-e', 'console.log(process.stdin.isTTY);process.exitCode=7'], options);
    assert.equal(result.status, 7, result.stdout + result.stderr); assert.match(result.stdout, /true/);
  };
  run(); run(); assert.equal(builds.length, 1);
  const source = path.join(root, 'variant.c');
  fs.writeFileSync(source, fs.readFileSync(new URL('./helpers/pty-owner.c', import.meta.url), 'utf8') + '\n/* isolated fixture variant */\n');
  run({ ownerSource: source }); run({ ownerSource: source });
  assert.equal(builds.length, 2); assert.equal(builds[1], source);
  fs.appendFileSync(source, '\n/* source changed */\n'); run({ ownerSource: source });
  assert.equal(builds.length, 3, 'changed source cannot reuse stale executable bytes');
});
