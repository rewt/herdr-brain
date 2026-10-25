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
import { provingResource } from './helpers/proving.mjs';
import { silenceNotice } from '../watch-notice.mjs';

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
for (const kind of ['cpu', 'process', 'runnable', 'unknown', 'output']) test(`${kind} activity prevents the frozen stop beyond the configured window`, () => {
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
  assert.equal(frozenSeconds({}), 199.580020875); assert.equal(frozenSeconds({ [FROZEN_SECONDS_ENV]: '0' }), 0);
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

function journalFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-journal-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../test-slot.mjs', import.meta.url));
  const runner = fileURLToPath(new URL('../../test/helpers/run.mjs', import.meta.url));
  const receipt = path.join(root, 'stable.execution.json'), env = testSlotEnvironment();
  for (const file of ['first.test.mjs', 'second.test.mjs'])
    fs.writeFileSync(path.join(root, file), `import test from 'node:test';test(${JSON.stringify(file)},()=>{});`);
  const run = (file, extraEnv = {}) => {
    const result = spawnSync(process.execPath, [cli, 'run', 'journal', '--no-slot', '--result-path', receipt, '--', process.execPath, runner, file],
      { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(fs.readFileSync(receipt));
  };
  return { root, runner, receipt, env, run };
}

test('ungated timing spans and a standalone runner create no unpaired journal or inherited timing path', t => {
  const f = journalFixture(t);
  const git = spawnSync('git', ['init', '-q'], { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const library = new URL('../timings.mjs', import.meta.url).href;
  const spans = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';import {startTiming,TIMINGS_ENV} from ${JSON.stringify(library)};
    assert.equal(process.env[TIMINGS_ENV],undefined);
    for(const kind of ['tier','suite','file'])startTiming(kind,'ungated')({exit_code:0});
    assert.equal(process.env[TIMINGS_ENV],undefined);`], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(spans.status, 0, spans.stdout + spans.stderr);
  const runner = spawnSync(process.execPath, [f.runner, 'first.test.mjs'], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(runner.status, 0, runner.stdout + runner.stderr);
  assert.equal(fs.existsSync(path.join(f.root, '.git', 'lane-validation')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'lane-validation')), false);
});

test('an ungated runner can enqueue one silence notice without allocating a timing receipt', t => {
  const f = journalFixture(t), inbox = path.join(f.root, 'supervisor', 'inbox.log'), notices = [];
  const env = { MONITOR_GATE_NOTICE_CONTEXT: JSON.stringify({ to: 'owning-supervisor', inbox }) };
  const clock = clockFixture({ onSilence: observation => notices.push(silenceNotice(observation, { label: 'ungated', runId: 'suite-span', env })) });
  clock.tick(10); clock.tick(20); clock.tick(30);
  assert.equal(notices.length, 1); assert.equal(notices[0].error, undefined);
  const entries = fs.readFileSync(inbox, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.type === 'notice');
  assert.equal(entries.length, 1); assert.equal(entries[0].to, 'owning-supervisor');
  assert.match(entries[0].message, /test continues/); assert.doesNotMatch(entries[0].message, /receipt=undefined/);
  assert.equal(fs.existsSync(`${f.receipt}.timings.jsonl`), false);
});

test('a reused result path starts a fresh gate-owned timing journal for each run', t => {
  const f = journalFixture(t), first = f.run('first.test.mjs'), second = f.run('second.test.mjs');
  assert.notEqual(first.run_id, second.run_id);
  assert.equal(first.timings_path, second.timings_path);
  assert.ok(first.timings.some(row => row.kind === 'file' && row.name === 'first.test.mjs' && row.event === 'finish'));
  assert.deepEqual(second.timings.filter(row => row.kind === 'file' && row.event === 'finish').map(row => row.name), ['second.test.mjs']);
  const firstIds = new Set(first.timings.map(row => row.id));
  assert.ok(second.timings.every(row => !firstIds.has(row.id)), 'no earlier spans leak into the replacement receipt');
  assert.deepEqual(fs.readFileSync(second.timings_path, 'utf8').trim().split('\n').map(JSON.parse), second.timings);
});

test('nested gates preserve an inherited timing journal across reused result paths', t => {
  const f = journalFixture(t), journal = path.join(f.root, 'parent.timings.jsonl');
  const parent = { id: 'parent', kind: 'tier', name: 'parent', event: 'start' };
  fs.writeFileSync(journal, JSON.stringify(parent) + '\n');
  f.run('first.test.mjs', { MONITOR_TEST_TIMINGS_PATH: journal });
  const second = f.run('second.test.mjs', { MONITOR_TEST_TIMINGS_PATH: journal });
  assert.equal(second.timings_path, journal);
  assert.deepEqual(second.timings[0], parent);
  assert.deepEqual(second.timings.filter(row => row.kind === 'file' && row.event === 'finish').map(row => row.name), ['first.test.mjs', 'second.test.mjs']);
  assert.equal(fs.existsSync(`${f.receipt}.timings.jsonl`), false, 'nested gates never allocate their own journal');
});

for (const floor of [undefined, 0]) test(`uncapped EXCLUSIVE execution remains reserved beyond its expected end and the former expiry${floor === 0 ? ' after a floor grant' : ''}`, t => {
  const f = journalFixture(t), cli = fileURLToPath(new URL('../test-slot.mjs', import.meta.url));
  const command = [process.execPath, '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {readProvingReservations,MAX_RESERVATION_MS,waitForProvingHold,RESERVATION_WAIT_EXPIRED_CODE} from ${JSON.stringify(new URL('../reservations.mjs', import.meta.url).href)};
    await new Promise(resolve=>setTimeout(resolve,40));
    const lock=process.env.MONITOR_TEST_SLOT_COMPAT_PATH,record=readProvingReservations(lock)[0].record;
    assert.equal(record.pgid,process.pid);
    const acquired=Date.parse(record.acquiredAt),now=acquired+4531*1000;
    assert(Date.now()>Date.parse(record.expectedEnd),'payload progressed past its scaled expected end');
    assert.equal(Date.parse(record.expiresAt),acquired+MAX_RESERVATION_MS);
    assert.equal(readProvingReservations(lock,{now})[0].state,'overdue');
    assert.throws(()=>waitForProvingHold({deadline:performance.now(),now:()=>now,notify:()=>{}}),error=>error.code===RESERVATION_WAIT_EXPIRED_CODE);
    assert.equal(readProvingReservations(lock,{now:acquired+MAX_RESERVATION_MS})[0].state,'expired','shared six-hour authority remains bounded');
    console.log('overdue execution still reserves launches');`];
  const resource = { ...provingResource(command), ...(floor === undefined ? {} : { memory_floor_bytes: floor }) };
  const lock = path.join(f.root, 'slot');
  const result = spawnSync(process.execPath, [cli, 'run', 'uncapped-proof', '--lock-path', lock, '--expected-seconds', '.001',
    '--resource', JSON.stringify(resource), '--', ...command], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /overdue execution still reserves launches/);
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(fs.readdirSync(`${lock}.occupancy`), [], 'completed proving releases its reservation');
});
