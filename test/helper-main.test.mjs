import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PTY_SKIP_REASON } from './helpers/pty.mjs';

function linkedHelper(t, name) {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'helper-main-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  fs.symlinkSync(fs.realpathSync(new URL('../', import.meta.url)), path.join(scratch, 'project'), 'dir');
  return path.join(scratch, 'project/test/helpers', name);
}

for (const [name, args, error] of [
  ['tier.mjs', ['unknown'], /unknown test tier: unknown/],
  ['suite.mjs', ['--unsupported'], /unsupported suite option/],
  ['release-suites.mjs', ['--unsupported'], /unsupported release suite option/],
]) test(`${name} executes its CLI through a symlinked directory`, t => {
  const result = spawnSync(process.execPath, [linkedHelper(t, name), ...args], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, error);
});

test('the PTY helper executes its CLI through a symlinked directory', { skip: PTY_SKIP_REASON }, t => {
  const result = spawnSync(process.execPath, [linkedHelper(t, 'pty.mjs'), '--run', process.execPath,
    '-e', "console.log('linked PTY main'); process.exitCode = 7"], { encoding: 'utf8' });
  assert.equal(result.status, 7, result.stdout + result.stderr);
  assert.match(result.stdout, /linked PTY main/);
});
