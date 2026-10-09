import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const evidence = path.dirname(new URL(import.meta.url).pathname);
const files = ['discovery/test/host-suites.test.mjs', 'lanes/test/validation.test.mjs',
  'test-slot/test/watchdog.test.mjs', 'test-slot/test/gate-profile.test.mjs'];
if (process.argv[2] === 'inside') {
  const env = process.env;
  assert.equal(env.MONITOR_TEST_SLOT_PATH, path.join(env.R361_SCRATCH, 'workspace-slot'));
  assert.equal(env.MONITOR_TEST_SLOT_COMPAT_PATH, path.join(env.R361_SCRATCH, 'legacy-slot'));
  assert.equal(env.MONITOR_TEST_SLOT_WAIT_SECONDS, '600');
  assert.equal(env.BCH_CLOAK_TEST_SLOT_WAIT_SECONDS, '600');
  assert.ok(env.MONITOR_TEST_SLOT_TOKEN);
  assert.equal(env.MONITOR_TEST_SLOT_TOKEN, env.BCH_CLOAK_TEST_SLOT_TOKEN);
  for (const lock of [env.MONITOR_TEST_SLOT_PATH, env.MONITOR_TEST_SLOT_COMPAT_PATH])
    assert.equal(JSON.parse(fs.readFileSync(lock)).token, env.MONITOR_TEST_SLOT_TOKEN);
  console.log('Outer scratch slot paths, batch waits, inherited tokens and held lock records verified.');
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'R361-checks-')));
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(ORG_|HERDR_AGENT_|LANE_|GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE)|MONITOR_PROMOTION_|MONITOR_TEST_SLOT_|BCH_CLOAK_TEST_SLOT_)/.test(key)) delete env[key];
}
Object.assign(env, {
  HERDR_MONITOR_FLEET: path.join(scratch, 'fleet.json'), MONITOR_GATE_HISTORY_ROOT: path.join(scratch, 'history'),
  MONITOR_TEST_SLOT_PATH: path.join(scratch, 'workspace-slot'), MONITOR_TEST_SLOT_COMPAT_PATH: path.join(scratch, 'legacy-slot'),
  MONITOR_TEST_SLOT_WAIT_SECONDS: '600', BCH_CLOAK_TEST_SLOT_WAIT_SECONDS: '600', R361_SCRATCH: scratch,
});
const argv = ['test-slot/test-slot.mjs', 'run', 'R-361 focused checks', '--project-common', path.join(scratch, 'common'),
  '--tier', 'promotion-host', '--timeout-seconds', '1800', '--idle-timeout-seconds', '0',
  '--wait-receipt-path', path.join(evidence, 'outer-wait.json'), '--result-path', path.join(evidence, 'outer-execution.json'),
  '--', process.execPath, new URL(import.meta.url).pathname, 'inside'];
const fd = fs.openSync(path.join(evidence, 'nested.tap'), 'w'), started = Date.now();
let result;
try { result = spawnSync(process.execPath, argv, { env, stdio: ['ignore', fd, fd] }); }
finally { fs.closeSync(fd); }
assert.equal(fs.existsSync(env.MONITOR_TEST_SLOT_PATH), false, 'scratch workspace slot released');
assert.equal(fs.existsSync(env.MONITOR_TEST_SLOT_COMPAT_PATH), false, 'scratch legacy slot released');
const output = fs.readFileSync(path.join(evidence, 'nested.tap'), 'utf8');
const summary = { files, argv, exit_code: result.status, signal: result.signal, duration_s: (Date.now() - started) / 1000,
  scratch_slots_released: true, totals: output.split('\n').filter(line => /^# (tests|pass|fail|cancelled|skipped|duration_ms) /.test(line)) };
fs.writeFileSync(path.join(evidence, 'nested.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(result.status ?? 1);
