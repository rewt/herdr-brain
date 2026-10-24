import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { watchRun, activitySnapshot, frozenSeconds, FROZEN_SECONDS_ENV } from '../watch.mjs';
import { timingAverages } from '../timing-averages.mjs';
import { testSlotEnvironment } from '../../test/helpers/test-slot-env.mjs';

function clockFixture(extra = {}) {
  let at = 0, cpu = '00:00.00', state = 'S', available = true;
  const notices = [], stops = [];
  const watcher = watchRun({ now: () => at, idleSeconds: 9, frozen: 40, startTimer: false,
    sample: () => available ? [{ pid: 123, identity: 'birth', state, cpu }] : null,
    onSilence: row => notices.push(row), onFrozen: row => stops.push(row), ...extra });
  return { watcher, notices, stops, tick(value, changes = {}) { at = value; cpu = changes.cpu ?? cpu; state = changes.state ?? state; available = changes.available ?? available; watcher.tick(); } };
}

test('silence is observed once, keeps running and includes the final silent interval', () => {
  const f = clockFixture();
  f.tick(8); assert.equal(f.notices.length, 0);
  f.tick(9); f.tick(10); f.watcher.output(); f.tick(25);
  assert.equal(f.notices.length, 1); assert.equal(f.stops.length, 0);
  assert.equal(f.watcher.snapshot().longest_silence_s, 15);
});
test('a load retry shares the same one-notice observation boundary', () => {
  const silenceState = { notified: false }, notices = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const f = clockFixture({ silenceState, onSilence: row => notices.push(row) }); f.tick(10);
  }
  assert.equal(notices.length, 1);
});
for (const kind of ['cpu', 'process', 'runnable', 'unknown', 'output']) test(`${kind} activity prevents the frozen stop beyond four scaled hours`, () => {
  const f = clockFixture();
  for (let at = 10; at <= 200; at += 10) {
    if (kind === 'output') f.watcher.output();
    f.tick(at, kind === 'cpu' ? { cpu: String(at) } : kind === 'process' ? { state: at % 20 ? 'S' : 'I' } : kind === 'runnable' ? { state: 'R' } : kind === 'unknown' ? { available: false } : {});
  }
  assert.equal(f.stops.length, 0);
});
test('only uninterrupted silence and confirmed inactivity past the threshold stop once', () => {
  const f = clockFixture();
  f.tick(39); assert.equal(f.stops.length, 0);
  f.tick(40); f.tick(100);
  assert.equal(f.stops.length, 1);
  assert.equal(f.stops[0].silence_s, 40); assert.equal(f.stops[0].inactivity_s, 40);
  assert.equal(f.stops[0].processes[0].identity, 'birth');
});
test('unknown audit restarts the full inactivity window and the stop can be disabled', () => {
  const f = clockFixture();
  f.tick(39, { available: false }); f.tick(40, { available: true });
  f.tick(79); assert.equal(f.stops.length, 0);
  f.tick(80); assert.equal(f.stops.length, 1);
  const off = clockFixture({ frozen: 0 }); off.tick(100000); assert.equal(off.stops.length, 0);
  assert.equal(frozenSeconds({}), 14400); assert.equal(frozenSeconds({ [FROZEN_SECONDS_ENV]: '0' }), 0);
  for (const value of ['-1', 'NaN', 'Infinity']) assert.throws(() => frozenSeconds({ [FROZEN_SECONDS_ENV]: value }));
});
test('activity audit reads only owned births and treats an incomplete CPU or identity lookup as unknown', () => {
  const row = (pid, ppid, pgid, identity = String(pid)) => ({ pid, ppid, pgid, identity, state: 'S' });
  const rows = new Map([row(1, 0, 1), row(2, 1, 2), row(3, 0, 1), row(99, 0, 99)].map(row => [row.pid, row]));
  const requested = [];
  const execute = (_, args) => { requested.push(args.at(-1)); return { status: 0, stdout: '1 00:00.01 S\n2 00:00.02 S\n3 00:00.00 S\n', stderr: '' }; };
  const lookup = () => ({ ok: true, value: rows });
  const owned = activitySnapshot(1, { lookup, execute });
  assert.deepEqual(owned.map(row => row.pid), [1, 2, 3]); assert.deepEqual(requested, ['1,2,3']);
  assert.equal(activitySnapshot(1, { lookup, execute: () => ({ status: 0, stdout: '1 00:00.01 S\n', stderr: '' }) }), null);
  let calls = 0;
  assert.equal(activitySnapshot(1, { lookup: () => ({ ok: true, value: ++calls === 1 ? rows : new Map([[1, row(1, 0, 1, 'replacement')]]) }), execute }), null);
});

test('a progressing file exceeds old scaled caps and records passing and failing file and suite durations in the execution receipt', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-timings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../test-slot.mjs', import.meta.url));
  const runner = fileURLToPath(new URL('../../test/helpers/run.mjs', import.meta.url));
  const receipt = path.join(root, 'proof.execution.json');
  fs.writeFileSync(path.join(root, 'slow.test.mjs'), `import test from 'node:test';test('working',async()=>{for(let n=0;n<5;n++){console.log('progress');await new Promise(r=>setTimeout(r,40));}});`);
  const env = { ...testSlotEnvironment(), MONITOR_TEST_SLOT_FROZEN_SECONDS: '0' };
  const run = file => spawnSync(process.execPath, [cli, 'run', 'proof', '--no-slot', '--result-path', receipt, '--timeout-seconds', '.001', '--',
    process.execPath, runner, '--fixed-deadlines', '--file-timeout=1', '--suite-timeout=1', file], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  const pass = run('slow.test.mjs'); assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  const passed = JSON.parse(fs.readFileSync(receipt));
  const file = passed.timings.find(row => row.kind === 'file' && row.event === 'finish');
  assert.equal(file.name, 'slow.test.mjs'); assert.equal(file.exit_code, 0); assert.ok(file.duration_s >= .2);
  const suite = passed.timings.find(row => row.kind === 'suite' && row.event === 'finish');
  assert.equal(suite.exit_code, 0); assert.ok(suite.duration_s >= file.duration_s);
  assert.ok(passed.longest_silence_s >= 0); assert.equal(passed.limits.wall_seconds, 0);
  fs.writeFileSync(path.join(root, 'red.test.mjs'), `import test from 'node:test';test('red',()=>{throw Error('expected failure');});`);
  const red = run('red.test.mjs'); assert.equal(red.status, 1, red.stdout + red.stderr);
  const failed = JSON.parse(fs.readFileSync(receipt));
  assert.equal(failed.timings.find(row => row.kind === 'file' && row.name === 'red.test.mjs' && row.event === 'finish').exit_code, 1);
  assert.equal(failed.timings.findLast(row => row.kind === 'suite' && row.event === 'finish').exit_code, 1);
  const averages = timingAverages([passed, failed, passed]);
  assert.equal(averages.find(row => row.kind === 'file' && row.name === 'slow.test.mjs').samples, 1, 'shared journals are deduplicated');
  assert.ok(averages.every(row => Number.isFinite(row.average_s)));
});
