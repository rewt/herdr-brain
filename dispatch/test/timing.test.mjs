import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendTiming, readTiming, timingEvent, timingJournal, timingMetadata, timedMemoryWait, observeProcessEnd,
  appendAdmissionTiming, readAdmissionTiming, admissionTimingEvent, admissionTimingJournal, admissionTimingMetadata } from '../../lib/run-timing.mjs';
import { runMetrics, collectRunMetrics, renderRunMetrics } from '../metrics.mjs';
import { ownFixtureLifetime } from '../../test/helpers/fixture-lifetime.mjs';

const RECORD = fileURLToPath(new URL('../../bin/org.mjs', import.meta.url));
const WATCH = fileURLToPath(new URL('../../watch/watch.mjs', import.meta.url));
const at = second => `2026-10-08T12:00:${String(second).padStart(2, '0')}.000Z`;
const identity = { run: 'R-1', item: 'ENG-1', lane: 'timing' };
const event = (second, kind, outcome) => ({ ...identity, at: at(second), kind, outcome });
function fixture(t) {
  ownFixtureLifetime();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-timing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const org = path.join(root, 'org'), journal = path.join(root, 'request.json');
  const env = { ...process.env, ORG_DIR: org, ORG_ACTOR: 'timing-fixture', HERDR_MONITOR_FLEET: path.join(root, 'fleet.json') };
  const record = args => {
    const r = spawnSync(process.execPath, [RECORD, ...args], { env, cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout;
  };
  return { root, org, journal, env, record };
}

test('timing allowlist keeps a synthetic secret out of the journal and real run metadata', t => {
  const f = fixture(t), secret = 'sk-fixture-SECRET-should-never-be-written';
  f.record(['init']); f.record(['add', 'Timing fixture', '--role', 'engineer']);
  f.record(['start', 'ENG-1', '--meta', 'lane=timing']);
  const malicious = { ...event(1, 'memory_open', 'entry'), prompt: secret, path: `/tmp/${secret}`,
    screen: secret, env: { API_KEY: secret }, memory: { warning: secret } };
  appendTiming(f.journal, malicious);
  const admission = { ...malicious, kind: 'admission_lock' };
  appendAdmissionTiming(f.journal, admission);
  f.record(['set', 'R-1', `dispatch_waits=${timingMetadata([malicious], 'R-1')}`]);
  f.record(['set', 'R-1', `dispatch_admission_waits=${admissionTimingMetadata([admission], 'R-1')}`]);
  const journal = fs.readFileSync(timingJournal(f.journal), 'utf8'), record = fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8');
  const separate = fs.readFileSync(admissionTimingJournal(f.journal), 'utf8');
  assert.ok(!journal.includes(secret)); assert.ok(!record.includes(secret));
  assert.ok(!separate.includes(secret));
  assert.deepEqual(JSON.parse(journal), event(1, 'memory_open', 'entry'));
  assert.deepEqual(JSON.parse(separate), event(1, 'admission_lock', 'entry'));
  assert.throws(() => timingEvent(admission), /invalid run timing kind/);
  for (const key of ['kind', 'outcome', 'run', 'item', 'at', 'lane']) {
    assert.throws(() => timingEvent({ ...malicious, [key]: `/tmp/${secret}` }));
    assert.throws(() => admissionTimingEvent({ ...admission, [key]: `/tmp/${secret}` }));
  }
});

test('memory entry is durable while blocked, grants and stopped retries have exact splits', t => {
  const f = fixture(t); let clock = 1, syncs = 0;
  const wait = (kind, body) => timedMemoryWait({ ...identity, journal: f.journal, kind,
    now: () => at(clock), persist: () => syncs++, wait: body });
  wait('memory_open', () => {
    assert.equal(readTiming(f.journal).at(-1).outcome, 'entry'); clock = 5;
  });
  assert.throws(() => wait('memory_worker', () => { clock = 8; throw Object.assign(Error('secret error'), { code: 'DISPATCH_STOPPED' }); }));
  clock = 10; wait('memory_worker', () => { clock = 17; });
  wait('admission_lock', () => { clock = 19; });
  assert.equal(syncs, 8);
  const current = { id: 'R-1', item: 'ENG-1', started: { at: at(5) }, meta: { lane: 'timing',
    dispatch_waits: timingMetadata(readTiming(f.journal), 'R-1'),
    dispatch_admission_waits: admissionTimingMetadata(readAdmissionTiming(f.journal), 'R-1') } };
  observeProcessEnd({ current, state: 'done', eligible: true, journal: f.journal, now: () => at(25),
    record: args => { current.meta.process_end = args[2].slice('process_end='.length); } });
  const m = runMetrics([current]);
  assert.equal(m.runs[0].waits.memory_open.seconds, 4);
  assert.equal(m.runs[0].waits.memory_worker.seconds, 10);
  assert.equal(m.runs[0].waits.memory_worker.stopped, 1);
  assert.equal(m.runs[0].waits.admission_lock.seconds, 2);
  assert.equal(m.runs[0].dispatch_wait_s, 16);
  assert.equal(m.runs[0].process_end_after_run_start_s, 20);
  assert.equal(m.summary.dispatch_wait_s.missing, 0);
});

for (const mode of ['legacy', 'reuse']) test(`${mode} dispatch totals remain measured without an admission attempt`, () => {
  const events = [event(1, 'memory_open', 'entry'), event(3, 'memory_open', 'granted'),
    event(4, 'memory_worker', 'entry'), event(9, 'memory_worker', 'granted')];
  const run = { id: 'R-1', item: 'ENG-1', started: { at: at(1) }, meta: { lane: 'timing',
    ...(mode === 'reuse' ? { same_session: 'true', continuation_of: 'R-0' } : {}), dispatch_waits: timingMetadata(events, 'R-1') } };
  const measured = runMetrics([run]);
  assert.equal(measured.runs[0].dispatch_wait_s, 7);
  assert.equal(measured.summary.dispatch_wait_s.samples, 1);
  assert.equal(measured.summary.dispatch_wait_s.missing, 0);
  assert.equal(measured.summary.invalid_metadata, 0);
  assert.equal(measured.runs[0].waits.admission_lock.entries, 0);
  for (const admission of [admissionTimingMetadata([event(9, 'admission_lock', 'entry')], 'R-1'),
    admissionTimingMetadata([event(9, 'admission_lock', 'entry'), event(10, 'admission_lock', 'failed')], 'R-1'),
    admissionTimingMetadata([event(9, 'admission_lock', 'entry')], 'R-2'), 'not-json']) {
    const attempted = runMetrics([{ ...run, meta: { ...run.meta, dispatch_admission_waits: admission } }]);
    assert.equal(attempted.runs[0].dispatch_wait_s, null, 'an attempted or malformed acquisition remains missing');
  }
});

test('unfinished admission clocks resume separately and never enter the strict journal', t => {
  const f = fixture(t);
  appendAdmissionTiming(f.journal, event(1, 'admission_lock', 'entry'));
  timedMemoryWait({ ...identity, journal: f.journal, kind: 'admission_lock', now: () => at(6), wait: () => {} });
  assert.deepEqual(readAdmissionTiming(f.journal).map(e => [e.at, e.outcome]), [[at(1), 'entry'], [at(6), 'granted']]);
  assert.deepEqual(readTiming(f.journal), []);
  appendTiming(f.journal, event(7, 'process_end', 'done'));
  assert.deepEqual(readTiming(f.journal), [event(7, 'process_end', 'done')]);
});

test('unfinished memory entries survive restart and legacy runs are missing rather than zero', t => {
  const f = fixture(t);
  appendTiming(f.journal, event(1, 'memory_open', 'entry'));
  timedMemoryWait({ ...identity, journal: f.journal, kind: 'memory_open', now: () => at(6), wait: () => {} });
  assert.equal(readTiming(f.journal).length, 2);
  const legacy = { id: 'R-2', item: 'ENG-1', started: { at: at(1) }, meta: { lane: 'timing' } };
  const partial = { ...legacy, id: 'R-1', meta: { ...legacy.meta,
    dispatch_waits: timingMetadata([...readTiming(f.journal), event(7, 'memory_worker', 'entry')], 'R-1') } };
  const m = runMetrics([legacy, partial]);
  assert.equal(m.summary.waits_s.memory_open.total, 5);
  assert.equal(m.summary.waits_s.memory_open.missing, 1);
  assert.equal(m.summary.waits_s.memory_worker.samples, 0);
  assert.equal(m.summary.waits_s.memory_worker.total, null);
  assert.equal(m.summary.dispatch_wait_s.missing, 2);
  assert.equal(m.summary.process_end_missing, 2);
  assert.equal(m.runs[1].waits.memory_worker.pending, true);
  assert.match(renderRunMetrics(m), /memory_worker: median unavailable; total unavailable; 0 measured; 2 missing/);
});

test('admission lock exhaustion and STOP never fabricate granted wait samples', t => {
  const f = fixture(t); let clock = 1;
  for (const code of ['DISPATCH_SESSION_CAP_LOCKED', 'DISPATCH_STOPPED']) {
    const error = Object.assign(Error('admission unavailable'), { code });
    assert.throws(() => timedMemoryWait({ ...identity, journal: f.journal, kind: 'admission_lock',
      now: () => at(clock), wait: () => { clock += 2; throw error; } }), value => value === error);
  }
  const run = { id: 'R-1', item: 'ENG-1', started: { at: at(1) },
    meta: { lane: 'timing', dispatch_admission_waits: admissionTimingMetadata(readAdmissionTiming(f.journal), 'R-1') } };
  const measured = runMetrics([run]);
  assert.equal(measured.runs[0].waits.admission_lock.seconds, null);
  assert.equal(measured.runs[0].waits.admission_lock.failed, 1);
  assert.equal(measured.runs[0].waits.admission_lock.stopped, 1);
  assert.equal(measured.summary.waits_s.admission_lock.missing, 1);
  assert.match(measured.limitations.join('\n'), /60000 ms.*loadTimeout/);
});

test('timing persistence and journal failures preserve the wait result and original errors', t => {
  const f = fixture(t);
  for (const brokenJournal of [false, true]) {
    const journal = brokenJournal ? path.join(f.root, 'missing', 'request.json') : f.journal;
    let failures = 0, waits = 0;
    const options = { ...identity, journal, kind: 'memory_worker',
      persist: () => { throw Error('record set failed'); }, onError: () => failures++ };
    assert.equal(timedMemoryWait({ ...options, wait: () => { waits++; return 'granted'; } }), 'granted');
    for (const code of ['DISPATCH_STOPPED', 'WAIT_FAILED']) {
      const error = Object.assign(Error('original wait failure'), { code });
      assert.throws(() => timedMemoryWait({ ...options, wait: () => { waits++; throw error; } }), e => e === error);
    }
    assert.equal(waits, 3); assert.ok(failures >= 6);
  }
  fs.writeFileSync(timingJournal(f.journal), 'corrupt timing journal\n');
  const error = Error('original error');
  assert.throws(() => timedMemoryWait({ ...identity, journal: f.journal, kind: 'memory_open',
    onError: () => { throw Error('diagnostic failed'); }, wait: () => { throw error; } }), e => e === error);
});

test('a resumed worker supersedes the previous terminal attempt and replays its latest lost reply', t => {
  const f = fixture(t), current = { id: 'R-1', item: 'ENG-1', meta: { lane: 'timing', dispatch_journal: f.journal } };
  const record = args => { current.meta.process_end = args[2].slice('process_end='.length); };
  observeProcessEnd({ current, state: 'idle', eligible: true, now: () => at(10), record });
  observeProcessEnd({ current, state: 'working', eligible: true, lastWorkingAt: at(20), record });
  assert.throws(() => observeProcessEnd({ current, state: 'done', eligible: true, lastWorkingAt: at(20), now: () => at(30),
    record: () => { throw Error('lost reply'); } }));
  observeProcessEnd({ current, state: 'done', eligible: true, lastWorkingAt: at(20), now: () => at(40), record });
  assert.equal(JSON.parse(current.meta.process_end).at, at(30));
  assert.equal(JSON.parse(current.meta.process_end).outcome, 'done');
  assert.deepEqual(readTiming(f.journal).map(e => e.outcome), ['idle', 'done']);
  const m = runMetrics([{ ...current, started: { at: at(1) } }]);
  assert.equal(m.runs[0].process_end_after_run_start_s, 29);
});

test('process end ignores startup idle, blocked and unavailable, and replays a lost record reply without changing the timestamp', t => {
  const f = fixture(t), current = { id: 'R-1', item: 'ENG-1', meta: { lane: 'timing', dispatch_journal: f.journal } };
  const calls = [], record = args => calls.push(args);
  for (const [state, eligible] of [['idle', false], ['blocked', true], ['unavailable', true], ['working', true], ['unknown', true]]) {
    observeProcessEnd({ current, state, eligible, record });
  }
  assert.equal(calls.length, 0); assert.ok(!fs.existsSync(timingJournal(f.journal)));
  assert.throws(() => observeProcessEnd({ current, state: 'idle', eligible: true, now: () => at(10), record: () => { throw Error('lost reply'); } }));
  observeProcessEnd({ current, state: null, eligible: true, now: () => at(30), record });
  assert.equal(readTiming(f.journal).length, 1);
  const end = JSON.parse(calls[0][2].slice('process_end='.length));
  assert.equal(end.at, at(10)); assert.equal(end.outcome, 'idle');
  current.meta.process_end = JSON.stringify(end);
  observeProcessEnd({ current, state: 'done', eligible: true, now: () => at(40), record });
  assert.equal(calls.length, 1);
});

test('malformed, mismatched, reversed and duplicate clocks do not fabricate wait measurements', () => {
  const run = waits => ({ id: 'R-1', item: 'ENG-1', started: { at: at(1) }, meta: { lane: 'timing', dispatch_waits: waits } });
  for (const waits of ['not-json', JSON.stringify({}), timingMetadata([event(5, 'memory_open', 'entry'), event(2, 'memory_open', 'granted')], 'R-1'),
    timingMetadata([event(1, 'memory_open', 'entry'), event(2, 'memory_open', 'entry'), event(4, 'memory_open', 'granted')], 'R-1'),
    timingMetadata([event(1, 'memory_open', 'entry'), event(4, 'memory_open', 'granted')], 'R-2')]) {
    const m = runMetrics([run(waits)]);
    assert.equal(m.summary.invalid_metadata, 1); assert.equal(m.runs[0].waits.memory_open.seconds, null);
  }
});

test('only measured immediate grants count as zero; legacy clocks remain missing', () => {
  const events = ['memory_open', 'memory_worker'].flatMap(kind => [event(1, kind, 'entry'), event(1, kind, 'granted')]);
  const run = { id: 'R-1', item: 'ENG-1', started: { at: at(1) }, meta: { lane: 'timing', dispatch_waits: timingMetadata(events, 'R-1'),
    dispatch_admission_waits: admissionTimingMetadata([event(1, 'admission_lock', 'entry'), event(1, 'admission_lock', 'granted')], 'R-1') } };
  const m = runMetrics([run, { ...run, id: 'R-2', meta: { lane: 'timing' } }]);
  assert.equal(m.runs[0].dispatch_wait_s, 0); assert.equal(m.runs[1].dispatch_wait_s, null);
  assert.deepEqual(m.summary.dispatch_wait_s, { samples: 1, missing: 1, total: 0, median: 0, max: 0 });
});

test('watch writes terminal observation through the record CLI and metrics reads it separately from report time', t => {
  const f = fixture(t);
  f.record(['init']); f.record(['add', 'Timing fixture', '--role', 'engineer']);
  f.record(['start', 'ENG-1', '--meta', 'lane=timing', '--meta', 'agent=worker', '--meta', `dispatch_journal=${f.journal}`]);
  f.record(['claim', 'R-1', '--controller', 'brain']);
  const current = JSON.parse(f.record(['show', 'R-1', '--json']));
  fs.writeFileSync(current.report_path, '---\nrun: R-1\noutcome: done\nsummary: Timing fixture done.\nheadline: Timing fixture done\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n');
  const herdr = path.join(f.root, 'herdr');
  fs.writeFileSync(herdr, `#!/bin/sh\ncase "$1 $2 $3" in\n'agent get supervisor-fixture') printf '%s\\n' '{"result":{"agent":{"agent_status":"idle","agent":"claude","pane_id":"fake:supervisor"}}}' ;;\n'agent get worker') printf '%s\\n' '{"result":{"agent":{"agent_status":"done"}}}' ;;\n'pane read fake:supervisor') printf '%s\\n' '────────────────────' '❯ ' '────────────────────' ;;\n*) printf '%s\\n' '{"result":{}}' ;;\nesac\n`, { mode: 0o755 });
  // Timing owns diagnostic persistence; native supervisor delivery has its own fixtures.
  const r = spawnSync(process.execPath, [WATCH, 'R-1', '--org', f.org, '--herdr', herdr, '--record-only'],
    { env: { ...f.env, SUPERVISOR_INPUT_CONFIRM_SECONDS: '0.01', SUPERVISOR_INPUT_POLL_SECONDS: '0.01', SUPERVISOR_INPUT_WAIT_SECONDS: '1' }, cwd: f.root, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.error, undefined, r.stderr);
  assert.equal(r.status, 0, r.stderr);
  const end = JSON.parse(JSON.parse(f.record(['show', 'R-1', '--json'])).meta.process_end);
  assert.equal(end.kind, 'process_end'); assert.equal(end.outcome, 'done');
  assert.deepEqual(readTiming(f.journal), [end]);
  f.record(['ingest', current.report_path]);
  const m = collectRunMetrics({ org: f.org });
  assert.deepEqual(m.runs[0].process_end, end);
  assert.equal(m.summary.process_end_missing, 0);
  assert.equal(m.summary.dispatch_wait_s.missing, 1);
  const CLI = fileURLToPath(new URL('../metrics.mjs', import.meta.url));
  const view = spawnSync(process.execPath, [CLI, '--org', f.org, '--json'], { env: f.env, cwd: f.root, encoding: 'utf8' });
  assert.equal(view.status, 0, view.stderr); assert.equal(JSON.parse(view.stdout).summary.process_end_missing, 0);
  assert.equal(collectRunMetrics({ org: f.org, since: '2027-01-01' }).summary.runs, 0);
});

for (const idleGrace of ['0', '1']) {
test(`watch idle → working → done records the final terminal attempt with idle grace ${idleGrace}`, t => {
  const f = fixture(t);
  f.record(['init']); f.record(['add', 'Timing fixture', '--role', 'engineer']);
  f.record(['start', 'ENG-1', '--meta', 'lane=timing', '--meta', 'agent=worker', '--meta', `dispatch_journal=${f.journal}`]);
  f.record(['claim', 'R-1', '--controller', 'brain']);
  const current = JSON.parse(f.record(['show', 'R-1', '--json']));
  const report = '---\nrun: R-1\noutcome: done\nsummary: Resumed worker done.\nheadline: Resumed worker done\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n';
  const herdr = path.join(f.root, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}
import fs from 'node:fs';
const a = process.argv.slice(2), counter = ${JSON.stringify(path.join(f.root, 'counter'))};
if (a[0] === 'agent' && a[1] === 'get' && a[2] === 'worker') {
  const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
  fs.writeFileSync(counter, String(n));
  if (n === 3 && ${idleGrace === '1'} && fs.existsSync(${JSON.stringify(timingJournal(f.journal))})) throw Error('mid-run idle was recorded before grace resolved');
  if (n >= 4) fs.writeFileSync(${JSON.stringify(current.report_path)}, ${JSON.stringify(report)});
  console.log(JSON.stringify({ result: { agent: { agent_status: ['working', 'idle', 'working', 'done'][Math.min(n - 1, 3)] } } }));
} else if (a[0] === 'agent' && a[1] === 'get') {
  console.log(JSON.stringify({ result: { agent: { agent_status: 'idle', agent: 'claude', pane_id: 'fake:supervisor' } } }));
} else if (a[0] === 'pane' && a[1] === 'read') {
  console.log('────────────────────\\n❯ \\n────────────────────');
} else console.log('{}');
`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [WATCH, 'R-1', '--org', f.org, '--herdr', herdr, '--record-only', '--idle-grace', idleGrace],
    { env: { ...f.env, SUPERVISOR_INPUT_CONFIRM_SECONDS: '0.01', SUPERVISOR_INPUT_POLL_SECONDS: '0.01', SUPERVISOR_INPUT_WAIT_SECONDS: '1' }, cwd: f.root, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.error, undefined, r.stderr); assert.equal(r.status, 0, r.stdout + r.stderr);
  if (idleGrace === '1') assert.match(r.stdout, /report or resume/);
  const end = JSON.parse(JSON.parse(f.record(['show', 'R-1', '--json'])).meta.process_end);
  assert.equal(end.outcome, 'done');
  const events = readTiming(f.journal);
  assert.deepEqual(events.map(e => e.outcome), idleGrace === '1' ? ['done'] : ['idle', 'done']);
  assert.deepEqual(events.at(-1), end);
});
}

test('an already recorded process end does not reserve another effect', () => {
  let reservations = 0, writes = 0;
  const current = { id: 'R-1', item: 'ENG-1', meta: { process_end: JSON.stringify(event(2, 'process_end', 'idle')) } };
  observeProcessEnd({ current, state: 'idle', eligible: true, beforeWrite: () => reservations++, record: () => writes++ });
  assert.equal(reservations, 0); assert.equal(writes, 0);
});
