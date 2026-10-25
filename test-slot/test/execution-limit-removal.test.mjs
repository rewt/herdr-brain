import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

// Whole actual modules, with no source rewriting or exported test hook. Every
// other import is closed below; physical spawn/ps/kernel/lock/storage/notice and
// telemetry edges are controlled interfaces, not native completion evidence.
const root = new URL('../', import.meta.url);
const sources = new Set(['test-slot.mjs', 'watch.mjs', 'watchdog.mjs']);
const plain = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve)); // Event turn, no elapsed trigger.
const row = (pid, ppid, pgid, identity) => ({ pid, ppid, pgid, identity });

async function harness({ failedSpawn = false } = {}) {
  const h = { at: 0, timers: [], intervals: [], events: [], receipts: [], queries: [], healthy: 0 };
  h.rows = new Map([row(91, 5, 91, 'a'), row(92, 91, 92, 'b'), row(93, 5, 93, 'other')].map(r => [r.pid, r]));
  const lookup = pid => ({ ok: true, value: pid === undefined ? new Map(h.rows) : h.rows.get(pid) ?? null });
  const probe = pid => pid < 0 ? [...h.rows.values()].some(r => r.pgid === -pid) : h.rows.has(pid);
  const proc = new EventEmitter();
  Object.assign(proc, { pid: 5, env: {}, cwd: () => '/fixture', hrtime: { bigint: () => BigInt(Math.round(h.at * 1e9)) },
    stdout: { write: data => h.events.push(['stdout', String(data)]) },
    stderr: { write: data => h.events.push(['stderr', String(data)]) },
    kill(pid, signal) {
      h.events.push(['signal', pid, signal]);
      for (const [id, r] of h.rows) if (pid < 0 ? r.pgid === -pid : id === pid) h.rows.delete(id);
    } });
  const stream = name => Object.assign(new EventEmitter(), { destroy: () => h.events.push(['destroy', name]) });
  h.child = Object.assign(new EventEmitter(), { pid: failedSpawn ? undefined : 91,
    stdout: stream('stdout'), stderr: stream('stderr'), unref: () => h.events.push(['unref']) });
  h.process = proc;
  const slot = { nested: false, token: null, class: 'shared', occupancyPath: '/presence',
    setGroup: (...args) => h.events.push(['group', ...args]), release: () => { h.events.push(['release']); return true; } };
  const never = () => assert.fail('unexpected injected edge');
  const missing = () => { throw Object.assign(Error('absent'), { code: 'ENOENT' }); };
  const limits = { wall_seconds: 0, idle_seconds: 9, frozen_seconds: 199.580020875 };
  const edges = {
    'node:child_process': { spawn: (file, args, options) => { h.events.push(['spawn', file, args, options]); return h.child; },
      spawnSync: (file, args, options) => {
        h.queries.push({ file, args, options });
        return { status: 0, stderr: '', stdout: args.at(-1).split(',').map(pid => `${pid} 00:00.00 S`).join('\n') };
      } },
    'node:path': { default: path }, 'node:os': { default: os },
    'node:fs': { default: { readFileSync: missing } },
    'node:crypto': { randomBytes: never, randomUUID: () => 'controlled-run' },
    'node:timers/promises': { setTimeout: never },
    './limits.mjs': { resolveGateLimits: () => limits, projectCommon: () => null,
      recordHealthyGate: () => { h.healthy++; }, historyFile: () => null, gateHistoryKey: () => ({}),
      TIMEOUT_EXIT: 124, RELEASE_TIMEOUT_ENV: 'MONITOR_RELEASE_TIMEOUT_SECONDS',
      frozenSeconds: () => limits.frozen_seconds, FROZEN_SECONDS_ENV: 'MONITOR_TEST_SLOT_FROZEN_SECONDS',
      FROZEN_SECONDS: limits.frozen_seconds, SILENCE_SECONDS: 9 },
    './watch-notice.mjs': { silenceNotice: () => ({ id: 'controlled-notice' }) },
    './timings.mjs': { TIMINGS_ENV: 'MONITOR_TEST_TIMINGS_PATH', readTimings: () => [] },
    './resources.mjs': { resolveResource: () => ({ declaration: {}, admission_class: 'SHARED' }) },
    './load.mjs': { testLoadFactor: () => 1 },
    './measurement.mjs': { boundedTelemetry: never, measureFamily: never },
    './retention.mjs': { EXECUTIONS_PER_PROFILE: 1, RETENTION_SCHEMA: 'controlled', pruneExecutions: never },
    './lock-support.mjs': { probe, processStartRecord: () => ({ start: 'start', birth: 'birth' }),
      processState: never, removeStaleLock: never },
    './ticket-queue.mjs': { readTestSlotQueue: never, testSlotTicket: never },
    './occupancy.mjs': { occupancyState: never, readTestSlotOccupancy: () => [], sharedOccupancy: () => slot },
    './reservations.mjs': { publishProvingReservation: never, MAX_RESERVATION_MS: 1 },
    './memory-floor.mjs': { waitForMemoryFloor: never, MEMORY_CODE: 'TEST_SLOT_MEMORY' },
    './paths.mjs': { TEST_SLOT_PATH: '/slot', PATH_ENV: 'MONITOR_TEST_SLOT_PATH',
      COMPAT_PATH_ENV: 'MONITOR_TEST_SLOT_COMPAT_PATH', LOCK_PATH_INVALID_CODE: 'INVALID',
      slotPathOf: () => '/slot', validateSlotPath: () => {} },
    '../lib/processes.mjs': { lookupProcess: lookup },
    '../lib/files.mjs': { writeFileAtomic: (file, text) => { if (file === '/receipt') h.receipts.push(JSON.parse(text)); } },
    '../lib/cli-help.mjs': { cliHelp: () => {}, isMain: () => false },
  };
  const context = createContext({ process: proc, AbortController, Error,
    setTimeout: (callback, ms) => { const timer = { callback, ms }; h.timers.push(timer); return timer; },
    clearTimeout: never,
    setInterval: (callback, ms) => { const timer = { callback, ms }; h.intervals.push(timer); return timer; },
    clearInterval: timer => { if (timer) timer.stopped = true; } });
  const cache = new Map();
  const load = name => {
    if (!cache.has(name)) cache.set(name, new SourceTextModule(fs.readFileSync(new URL(name, root), 'utf8'), {
      context, identifier: new URL(name, root).href, initializeImportMeta: meta => { meta.url = new URL(name, root).href; },
    }));
    return cache.get(name);
  };
  const controller = load('test-slot.mjs');
  await controller.link(specifier => {
    const name = path.basename(specifier);
    if (sources.has(name) && specifier.startsWith('./')) return load(name);
    assert.ok(Object.hasOwn(edges, specifier), `unbound import ${specifier}`);
    const exports = edges[specifier];
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await controller.evaluate();
  h.watch = cache.get('watch.mjs').namespace; h.dog = cache.get('watchdog.mjs').namespace;
  h.start = () => {
    h.pending = true;
    h.done = controller.namespace.run({ positional: ['controlled'], options: {
      lockPath: '/slot', compatPath: '/slot', resultPath: '/receipt',
      onCapture: rows => { h.captured = rows; if (h.captureError) throw h.captureError; },
    }, child: ['/payload', 'argument'] }).then(status => { h.pending = false; return status; });
  };
  h.exit = (code = 0, signal = null) => { h.rows.delete(91); h.rows.delete(92); h.child.emit('exit', code, signal); };
  return h;
}

for (const code of [0, 7]) test(`actual controller awaits close and trailing output after exit ${code}`, async () => {
  const h = await harness(); h.start();
  const spawn = h.events.find(e => e[0] === 'spawn');
  assert.equal(spawn[1], '/payload'); assert.deepEqual(plain(spawn[2]), ['argument']); assert.equal(spawn[3].detached, true);
  h.child.stdout.emit('data', 'before'); h.exit(code); await turn();
  assert.equal(h.pending, true); assert.equal(h.timers.length, 0, 'no pipe-drain cutoff requested');
  assert.equal(h.events.some(e => ['destroy', 'release'].includes(e[0])), false);
  h.child.stderr.emit('data', 'trailing'); h.child.emit('close', code, null);
  assert.equal(await h.done, code); assert.equal(h.healthy, code === 0 ? 1 : 0);
  const destroys = h.events.filter(e => e[0] === 'destroy');
  assert.deepEqual(destroys, [['destroy', 'stdout'], ['destroy', 'stderr']]);
  assert.ok(h.events.findIndex(e => e[0] === 'stderr' && e[1] === 'trailing') < h.events.findIndex(e => e[0] === 'destroy'));
  assert.ok(h.events.findIndex(e => e[0] === 'destroy') < h.events.findIndex(e => e[0] === 'release'));
  const count = h.events.length; h.child.emit('exit', 9, null); h.child.emit('close', 9, null); await turn();
  assert.equal(h.events.length, count); assert.equal(h.process.listenerCount('SIGTERM'), 0);
  assert.equal(h.receipts.at(-1).exit_code, code); assert.ok(h.intervals.every(t => t.stopped));
});

test('spawn error remains 127 and waits for close', async () => {
  const h = await harness({ failedSpawn: true }); h.start();
  h.child.emit('error', Error('spawn ENOENT')); await turn();
  assert.equal(h.pending, true); assert.equal(h.timers.length, 0);
  h.child.emit('close', -2, null); assert.equal(await h.done, 127); assert.equal(h.healthy, 0);
  assert.ok(h.events.some(e => e[0] === 'stderr' && /spawn ENOENT/.test(e[1])));
  assert.equal(h.events.some(e => e[0] === 'signal'), false);
});

test('actual child signal result survives stream closure', async () => {
  const h = await harness(); h.start(); h.exit(null, 'SIGTERM'); await turn();
  assert.equal(h.pending, true); h.child.emit('close', null, 'SIGTERM');
  assert.equal(await h.done, 143); assert.equal(h.receipts.at(-1).signal, 'SIGTERM');
  assert.equal(h.healthy, 0); assert.equal(h.timers.length, 0);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) test(`explicit ${signal} preserves owned cleanup and swallowed-signal status`, async () => {
  const h = await harness(); h.start(); h.process.emit(signal, signal); h.process.emit(signal, signal); await turn();
  assert.deepEqual(h.events.filter(e => e[0] === 'signal'), [['signal', -91, signal], ['signal', 92, signal]]);
  assert.deepEqual([...h.captured.keys()], [91, 92]); assert.ok(h.rows.has(93), 'unrelated sibling survives');
  h.exit(); await turn(); assert.equal(h.pending, true); h.child.emit('close', 0, null);
  assert.equal(await h.done, 128 + os.constants.signals[signal]); assert.equal(h.healthy, 0);
  assert.equal(h.timers.length, 0); assert.equal(h.process.listenerCount(signal), 0);
});

test('controller surfaces actual capture failure after owned watchdog cleanup', async () => {
  const h = await harness(); h.captureError = Error('capture write refused'); h.start();
  const rejected = assert.rejects(h.done, error => error === h.captureError);
  h.process.emit('SIGTERM', 'SIGTERM'); await rejected;
  assert.equal(h.rows.has(91), false); assert.equal(h.rows.has(92), false); assert.ok(h.rows.has(93));
  assert.equal(h.healthy, 0); assert.equal(h.process.listenerCount('SIGTERM'), 0);
});

test('actual watchdog preserves unknown/reused identities and cleanup error delivery', async () => {
  const h = await harness(), sent = [];
  await assert.rejects(h.dog.stopGateGroup(91, { ownsGroup: false,
    lookup: () => ({ ok: false, error: 'unknown identity' }), signal: (...args) => sent.push(args) }), /unknown identity/);
  await h.dog.stopGateGroup(91, { rootIdentity: 'old',
    lookup: () => ({ ok: true, value: h.rows }), signal: (...args) => sent.push(args) });
  let reads = 0;
  await h.dog.stopGateGroup(99, { ownsGroup: false, tracked: new Map([[92, h.rows.get(92)]]),
    lookup: pid => ({ ok: true, value: pid === undefined ? new Map() : row(92, 91, 92, ++reads === 1 ? 'b' : 'replacement') }),
    signal: (...args) => sent.push(args) });
  assert.deepEqual(sent, [], 'fresh per-PID check rejects a replacement immediately before signal');
  const error = Error('capture refused');
  await assert.rejects(h.dog.stopGateGroup(91, { ownedChild: true, onCapture: () => { throw error; } }), actual => actual === error);
  assert.equal(h.rows.has(91), false); assert.equal(h.rows.has(92), false); assert.ok(h.rows.has(93));
  assert.equal(h.timers.length, 0, 'no elapsed escalation exercised');
});

test('actual activity query has no deadline and retains real-error and identity controls', async () => {
  const h = await harness();
  const result = h.watch.activitySnapshot(91);
  assert.deepEqual(plain(result).map(r => r.pid), [91, 92]);
  const query = h.queries[0]; assert.equal(query.file, '/bin/ps');
  assert.equal(Object.hasOwn(query.options, 'timeout'), false); assert.equal(query.options.maxBuffer, 4 * 1024 * 1024);
  const rows = new Map(h.rows), lookup = () => ({ ok: true, value: rows });
  const good = { status: 0, stderr: '', stdout: '91 00:00.00 S\n92 00:00.00 S' };
  for (const bad of [{ error: Error('ps spawn') }, { signal: 'SIGTERM' }, { status: 1 }, { stderr: 'error' },
    { stdout: 'bad' }, { stdout: '91 00:00.00 S' }, { stdout: good.stdout + '\n91 00:00.00 S' }])
    assert.equal(h.watch.activitySnapshot(91, { lookup, execute: () => ({ ...good, ...bad }) }), null);
  assert.equal(h.watch.activitySnapshot(91, { lookup: () => ({ ok: false }), execute: () => assert.fail('no query on unknown owner') }), null);
  let snapshots = 0;
  assert.equal(h.watch.activitySnapshot(91, { lookup: () => ({ ok: true, value: ++snapshots === 1 ? rows : new Map() }),
    execute: () => good }), null, 'identity change after ps remains unknown');
});

test('actual watch preserves measured AND semantics, notices and unknown/runnable evidence', async () => {
  const h = await harness(), stops = [], notices = [];
  let at = 0, rows = [{ pid: 91, identity: 'a', state: 'S', cpu: '00:00.00' }];
  const frozen = 199.580020875;
  const watch = h.watch.watchRun({ now: () => at, sample: () => rows, frozen, idleSeconds: 9, startTimer: false,
    onFrozen: observation => stops.push(observation), onSilence: observation => notices.push(observation) });
  at = frozen; watch.output(); watch.tick(); assert.equal(stops.length, 0, 'output prevents a stop');
  at += frozen; rows = [{ ...rows[0], state: 'R' }]; watch.tick(); assert.equal(stops.length, 0, 'runnable means activity');
  at += frozen; rows = null; watch.tick(); assert.equal(stops.length, 0, 'unknown is not inactivity');
  at += frozen; rows = [{ pid: 91, identity: 'a', state: 'S', cpu: '00:00.01' }]; watch.tick();
  assert.equal(stops.length, 0, 'changed CPU restarts inactivity');
  at += frozen + 1; watch.tick(); watch.tick(); assert.equal(stops.length, 1);
  assert.equal(stops[0].limit_seconds, frozen); assert.equal(notices.length, 1);
  assert.equal(watch.snapshot().activity_audits.unavailable, 1); watch.stop();
});
