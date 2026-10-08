// Focused offline verification; every product call uses disposable history and
// a disposable slot. Plain execution and an inherited outer holder are supported.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { projectCommon } from '../../../../test-slot/limits.mjs';
import { testSlotEnvironment } from '../../../../test/helpers/test-slot-env.mjs';
import { gateHistories } from '../../../../test/helpers/gate-history.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const mode = process.argv[2] ?? 'plain';
assert.ok(['plain', 'outer', 'lane-check'].includes(mode));
const root = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'eng274-check-'));
const common = projectCommon(repo), real = path.join(common, 'gate-watchdog');
console.log(`Real history absent before ${mode}: ${!fs.existsSync(real)}`);
const slot = path.join(root, 'slot'), receipt = path.join(root, 'outer.json');
const env = { ...testSlotEnvironment(), MONITOR_GATE_HISTORY_ROOT: path.join(root, 'history'),
  MONITOR_TEST_SLOT_PATH: slot, MONITOR_TEST_SLOT_COMPAT_PATH: slot,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(path.join(repo, 'test/helpers/memory-fixture.mjs'))}` };
const files = ['test-slot/test', 'promote/test', 'release/test'].flatMap(dir =>
  fs.readdirSync(path.join(repo, dir)).filter(name => name.endsWith('.test.mjs')).sort().map(name => `${dir}/${name}`));
files.push('lanes/test/validation.test.mjs', 'test/release-suites.test.mjs');
const tests = [process.execPath, '--test', '--test-concurrency=4', ...files];
let result;
try {
  if (mode === 'outer') {
    Object.assign(env, { MONITOR_TEST_SLOT_WAIT_SECONDS: '7200', BCH_CLOAK_TEST_SLOT_WAIT_SECONDS: '7200', MONITOR_TEST_SLOT_TIMEOUT_RETRIED: '1' });
    result = spawnSync(process.execPath, ['test-slot/test-slot.mjs', 'run', 'outer scratch verification',
      '--project-common', common, '--timeout-seconds', '900', '--result-path', receipt, '--', ...tests],
    { cwd: repo, env, stdio: 'inherit', timeout: 960000 });
    const execution = JSON.parse(fs.readFileSync(receipt));
    assert.equal(execution.command_started, true);
    assert.equal(execution.gate_timeout, null);
    assert.equal(execution.attempts, 1);
    assert.equal(fs.existsSync(slot), false, 'outer scratch slot released');
    console.log(`Outer scratch gate exit=${result.status}, attempts=1; slot released`);
  } else if (mode === 'lane-check') {
    // Required final check proves containment and policy on the committed tree;
    // the full focused files were already exercised in both environments.
    result = spawnSync(process.execPath, ['lanes/lane.mjs', 'check', '--cmd',
      "node --test --test-name-pattern='fixture gates cannot|history origin guard|three sane samples|observed healthy full gates' test-slot/test/watchdog.test.mjs"],
    { cwd: repo, env, stdio: 'inherit', timeout: 120000 });
  } else {
    result = spawnSync(tests[0], tests.slice(1), { cwd: repo, env, stdio: 'inherit', timeout: 900000 });
  }
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${mode} focused verification failed`);
} finally {
  assert.ok(gateHistories(real).every(history => history.runs.every(run => run.origin !== env.MONITOR_GATE_HISTORY_ORIGIN)),
    'this verification process tree must not write real history');
  console.log(`Real history absent after ${mode}: ${!fs.existsSync(real)} (${real})`);
  fs.rmSync(root, { recursive: true, force: true });
}
