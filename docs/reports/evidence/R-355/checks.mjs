import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

const root = process.cwd();
const evidence = path.dirname(new URL(import.meta.url).pathname);
const files = ['test-slot/test/watchdog.test.mjs', 'test-slot/test/test-slot.test.mjs',
  'test-slot/test/gate-profile.test.mjs', 'test/memory.test.mjs',
  ...fs.readdirSync(path.join(root, 'promote/test')).filter(f => f.endsWith('.test.mjs')).sort().map(f => `promote/test/${f}`)];

if (process.argv[2] === 'inside') {
  const env = process.env;
  assert.equal(env.MONITOR_TEST_SLOT_PATH, path.join(env.R355_SCRATCH, 'workspace-slot'));
  assert.equal(env.MONITOR_TEST_SLOT_COMPAT_PATH, path.join(env.R355_SCRATCH, 'legacy-slot'));
  assert.equal(env.MONITOR_TEST_SLOT_WAIT_SECONDS, '600');
  assert.equal(env.BCH_CLOAK_TEST_SLOT_WAIT_SECONDS, '600');
  assert.ok(env.MONITOR_TEST_SLOT_TOKEN);
  assert.equal(env.MONITOR_TEST_SLOT_TOKEN, env.BCH_CLOAK_TEST_SLOT_TOKEN);
  for (const lock of [env.MONITOR_TEST_SLOT_PATH, env.MONITOR_TEST_SLOT_COMPAT_PATH]) {
    assert.equal(JSON.parse(fs.readFileSync(lock)).token, env.MONITOR_TEST_SLOT_TOKEN);
  }
  process.stdout.write('Outer scratch slot paths, batch wait variables and both inherited tokens verified.\n');
  const result = spawnSync(process.execPath, ['--test', ...files], { env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

const mode = process.argv[2];
assert.ok(['plain', 'nested'].includes(mode));
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'R355-checks-')));
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(ORG_|HERDR_AGENT_|LANE_|GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE)|MONITOR_PROMOTION_|MONITOR_TEST_SLOT_|BCH_CLOAK_TEST_SLOT_)/.test(key)) delete env[key];
}
Object.assign(env, {
  HERDR_MONITOR_FLEET: path.join(scratch, 'fleet.json'),
  MONITOR_GATE_HISTORY_ROOT: path.join(scratch, 'history'),
  MONITOR_TEST_SLOT_PATH: path.join(scratch, 'workspace-slot'),
  MONITOR_TEST_SLOT_COMPAT_PATH: path.join(scratch, 'legacy-slot'),
  MONITOR_TEST_SLOT_WAIT_SECONDS: '600', BCH_CLOAK_TEST_SLOT_WAIT_SECONDS: '600',
  NODE_OPTIONS: `--import=${path.join(root, 'test/helpers/memory-fixture.mjs')}`,
  R355_SCRATCH: scratch,
});
const argv = mode === 'plain' ? ['--test', ...files] : [
  'test-slot/test-slot.mjs', 'run', 'R-355 focused checks',
  '--project-common', path.join(scratch, 'common'), '--tier', 'promotion-host',
  '--timeout-seconds', '1800', '--idle-timeout-seconds', '0',
  '--wait-receipt-path', path.join(evidence, 'outer-wait.json'),
  '--result-path', path.join(evidence, 'outer-execution.json'),
  '--', process.execPath, new URL(import.meta.url).pathname, 'inside',
];
const log = path.join(scratch, `${mode}.tap`), fd = fs.openSync(log, 'wx');
const started = Date.now();
let result;
try { result = spawnSync(process.execPath, argv, { env, stdio: ['ignore', fd, fd] }); }
finally { fs.closeSync(fd); }
const output = fs.readFileSync(log);
fs.writeFileSync(path.join(evidence, `${mode}.tap.gz`), gzipSync(output));
assert.equal(fs.existsSync(env.MONITOR_TEST_SLOT_PATH), false, 'scratch workspace slot released');
assert.equal(fs.existsSync(env.MONITOR_TEST_SLOT_COMPAT_PATH), false, 'scratch legacy slot released');
const summary = { mode, argv, files, exit_code: result.status, signal: result.signal,
  duration_s: (Date.now() - started) / 1000, scratch_slots_released: true,
  totals: output.toString().split('\n').filter(line => /^# (tests|pass|fail|cancelled|skipped|duration_ms) /.test(line)) };
fs.writeFileSync(path.join(evidence, `${mode}.json`), JSON.stringify(summary, null, 2) + '\n');
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(result.status ?? 1);
