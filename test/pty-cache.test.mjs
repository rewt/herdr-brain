import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { runPTY, PTY_SKIP_REASON } from './helpers/pty.mjs';

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
