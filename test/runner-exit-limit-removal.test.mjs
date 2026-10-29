// Source-bound coordinator evidence; native descendant reaping is separate.
// Ordinary selection owns its VM capability; no caller flag is required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnChild, waitForExit } from './helpers/child.mjs';

const { createContext, SourceTextModule, SyntheticModule } = vm;

const runner = new URL('./helpers/run.mjs', import.meta.url);
const source = readFileSync(runner, 'utf8');
const tracker = readFileSync(new URL('./helpers/processes.mjs', import.meta.url), 'utf8');
const limits = readFileSync(new URL('./helpers/runner-limits.mjs', import.meta.url), 'utf8');
const unused = () => assert.fail('unselected worker/native interface executed');

async function coordinator({ failedSink } = {}) {
  const trace = [], exits = [], errors = [], signals = [], timers = [], timings = [];
  const leader = { pid: 4242, ppid: 202, pgid: 4242, state: 'S', identity: 'birth-1', command: 'suite-worker' };
  const guard = { pid: 4241, ppid: 4242, pgid: 4242, state: 'S', identity: 'guard-birth',
    command: '/fixture-guard --watch /fixture/alive 60 4242' };
  const state = { current: leader, auditError: false, survivors: [], holdOutput: false };
  const writes = [];
  const child = Object.assign(new EventEmitter(), {
    pid: leader.pid, exitCode: null, signalCode: null, connected: true,
    stdout: Object.assign(new EventEmitter(), { readableEnded: false, destroy: () => trace.push('stdout.destroy') }),
    stderr: Object.assign(new EventEmitter(), { readableEnded: false, destroy: () => trace.push('stderr.destroy') }),
    send: message => trace.push(`send:${message}`),
    disconnect() { this.connected = false; trace.push('disconnect'); },
    unref: () => trace.push('unref'),
  });
  const proc = Object.assign(new EventEmitter(), {
    argv: [process.execPath, fileURLToPath(runner), 'controlled.test.mjs'], env: {},
    pid: 202, execPath: process.execPath, platform: process.platform,
    ...Object.fromEntries(['stdout', 'stderr'].map(name => [name, Object.assign(new EventEmitter(), { write: (data, callback) => {
      trace.push(`${name}:${data}`);
      if (state.holdOutput) writes.push(callback); else callback();
    } })])),
    exit: code => { trace.push('exit'); exits.push(code); },
    kill: (pid, signal) => { trace.push('signal'); signals.push([pid, signal]); },
  });
  if (failedSink) proc[failedSink] = new Writable({
    write(data, encoding, callback) {
      trace.push(`${failedSink}:${data}`);
      callback(Object.assign(Error('consumer pipe closed'), { code: 'EPIPE' }));
    },
  });
  let watch;
  const context = createContext({
    process: proc, URL, Map, console: { error: value => errors.push(value) },
    // Only a post-exit drain may arm a timer; controls fire it explicitly.
    setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout: timer => timers.splice(timers.indexOf(timer), 1),
    setInterval: unused,
  });
  const dependencies = {
    '../../lib/deadline.mjs': { loadTimeout: value => value },
    '../../test-slot/load.mjs': { testLoadFactor: () => 1 },
    'node:child_process': { spawn: (executable, args, options) => {
      assert.equal(executable, process.execPath);
      assert.equal(args[1], '--worker');
      assert.equal(options.detached, true);
      assert.equal(options.stdio.at(-1), 'ipc');
      assert.match(options.env.NODE_OPTIONS, /fixture-policy\.mjs/);
      return child;
    } },
    'node:test': { run: unused }, 'node:test/reporters': { tap: unused },
    'node:stream/promises': { pipeline: unused }, 'node:url': { fileURLToPath },
    '../../lib/processes.mjs': { parseProcessLookup: unused, lookupProcess: pid => {
      if (pid !== undefined) {
        if (pid === guard.pid) return { ok: true, value: guard };
        assert.equal(pid, leader.pid);
        trace.push('lookup');
        return { ok: true, value: state.current };
      }
      trace.push('audit');
      return state.auditError ? { ok: false, error: 'injected audit failure' }
        : { ok: true, value: new Map([state.current, ...state.survivors].filter(Boolean).map(row => [row.pid, row])) };
    } },
    './offline-herdr.mjs': { offlineHerdr: () => () => trace.push('cleanupHerdr') },
    './fixture-lifetime.mjs': { exitedLifetimeGuardCommands: () => new Set(), ownFixtureLifetime: () => {
      Object.assign(proc.env, { HERDR_FIXTURE_LIFETIME_EXECUTABLE: '/fixture-guard',
        HERDR_FIXTURE_LIFETIME_FIFO: '/fixture/alive', HERDR_FIXTURE_LIFETIME_SECONDS: '60' });
      return null;
    } },
    'node:path': { default: path },
    '../../test-slot/watch.mjs': { watchRun: options => {
      watch = options;
      return { stop: () => trace.push('watch.stop'), output: () => trace.push('watch.output'), snapshot: () => ({}) };
    } },
    '../../test-slot/watch-notice.mjs': { silenceNotice: () => 'controlled notice' },
    '../../test-slot/timings.mjs': { TIMINGS_ENV: 'MONITOR_TEST_TIMINGS_PATH',
      startTiming: () => Object.assign(result => timings.push(result), { id: 'controlled-suite' }),
      timing: observation => trace.push(observation.kind) },
  };
  const actual = { './processes.mjs': tracker, './runner-limits.mjs': limits };
  const module = new SourceTextModule(source, {
    context, identifier: runner.href, initializeImportMeta: meta => { meta.url = runner.href; },
  });
  // Node 20 clears its linker cache before evaluation. Keep the JS wrappers
  // alive too: V8's graph alone does not retain SyntheticModule callbacks.
  const linked = [];
  await module.link(specifier => {
    let dependency;
    if (Object.hasOwn(actual, specifier)) dependency = new SourceTextModule(actual[specifier], { context, identifier: new URL(specifier, runner).href });
    else {
      assert.ok(Object.hasOwn(dependencies, specifier), `unreconciled import: ${specifier}`);
      const values = dependencies[specifier];
      dependency = new SyntheticModule(Object.keys(values), function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      }, { context });
    }
    linked.push(dependency);
    return dependency;
  });
  global.gc?.();
  await module.evaluate();
  assert.ok(linked.every(dependency => dependency.status === 'evaluated'));
  const ready = () => { child.emit('message', { ready: true, lifetimeGuard: guard }); assert.deepEqual(trace.slice(-2), ['lookup', 'send:start']); };
  const complete = (code = 0) => child.emit('message', { complete: true, code });
  const pending = () => {
    assert.deepEqual(timers, [], 'elapsed fallback must not be armed for a pending child');
    assert.deepEqual(exits, []);
    for (const action of ['cleanupHerdr', 'stdout.destroy', 'stderr.destroy', 'unref']) assert.ok(!trace.includes(action), action);
    assert.equal(child.connected, false);
    assert.equal(child.listenerCount('exit'), 2, 'finish must subscribe to actual child exit');
  };
  const closePipe = (name, ended = true) => {
    child[name].readableEnded = ended;
    if (ended) child[name].emit('end');
    child[name].emit('close');
  };
  const exit = (code = null, signal = 'SIGKILL', close = true) => {
    child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal);
    if (close) { closePipe('stdout'); closePipe('stderr'); }
  };
  const finished = code => {
    assert.deepEqual(exits, [code]);
    assert.deepEqual(trace.slice(-5), ['cleanupHerdr', 'stdout.destroy', 'stderr.destroy', 'unref', 'exit']);
    assert.equal(timings.length, 1);
    assert.equal(timings[0].exit_code, code);
    assert.deepEqual(timers, []);
  };
  return { child, proc, state, trace, exits, errors, signals, timers, writes, timings, ready, complete, pending, exit, closePipe, finished, watch: () => watch };
}

if (typeof SourceTextModule !== 'function') {
  test('ordinary suite selection executes every runner witness with its VM capability', async t => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnChild(t, process.execPath,
      ['--experimental-vm-modules', '--expose-gc', '--test', fileURLToPath(import.meta.url)], { env });
    const result = await waitForExit(child);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# tests 16\b/);
    assert.match(result.stdout, /# pass 16\b/);
    assert.match(result.stdout, /# fail 0\b/);
  });
} else {
test('actual runner source keeps execution uncapped and bounds only post-exit output drain', () => {
  assert.doesNotMatch(source, /loadTimeout/);
  assert.match(source, /child\.exitCode !== null \|\| child\.signalCode !== null/);
  assert.match(source, /else child\.once\('exit', drain\)/);
});

test('successful completion remains pending until child exit and finishes exactly once', async () => {
  const h = await coordinator(); h.ready();
  h.watch().onSilence({ kind: 'silence' }); assert.deepEqual(h.exits, []);
  h.child.stdout.emit('data', 'tap'); h.child.stderr.emit('data', 'diagnostic');
  assert.deepEqual(h.trace.slice(-4), ['watch.output', 'stdout:tap', 'watch.output', 'stderr:diagnostic']);
  h.complete(); h.pending();
  assert.deepEqual(h.trace.slice(-5), ['watch.stop', 'audit', 'lookup', 'signal', 'disconnect']);
  assert.deepEqual(h.signals, [[-4242, 'SIGKILL']]);
  h.complete(9); h.child.emit('error', Error('late child error')); h.proc.emit('SIGTERM');
  h.pending();
  h.exit(); h.finished(0);
  h.child.emit('exit', null, 'SIGKILL'); h.proc.emit('SIGHUP'); h.finished(0);
});

test('an already-exited or signaled child uses the existing fast finish path', async () => {
  for (const [code, signal] of [[0, null], [null, 'SIGTERM']]) {
    const h = await coordinator(); h.ready(); h.exit(code, signal); h.finished(1);
    assert.equal(h.child.listenerCount('exit'), 0);
    assert.ok(!h.trace.includes('audit'));
  }
});

test('worker failure and child error events retain their error outcomes', async () => {
  const failure = await coordinator(); failure.ready(); failure.complete(7); failure.pending();
  failure.exit(); failure.finished(7);
  for (const owned of [true, false]) {
    const h = await coordinator(); if (owned) h.ready();
    const error = Error('injected child process error'); h.child.emit('error', error); h.pending();
    assert.equal(h.errors[0], error);
    assert.equal(h.signals.length, owned ? 1 : 0);
    h.exit(127, null); h.finished(1);
  }
  const spawnError = await coordinator(); spawnError.child.exitCode = -2;
  spawnError.child.emit('error', Error('injected ENOENT'));
  spawnError.closePipe('stdout'); spawnError.closePipe('stderr'); spawnError.finished(1);
  assert.deepEqual(spawnError.signals, []);
  const flushError = await coordinator(); flushError.ready();
  flushError.child.emit('message', { complete: true, code: 0, outputFlushed: false }); flushError.pending();
  flushError.exit(); flushError.finished(1);
  assert.match(flushError.errors.join('\n'), /Worker output flush failed/);
});

test('failed ownership registration retains its error without signaling an unknown child', async () => {
  const h = await coordinator(); h.state.current = null;
  h.child.emit('message', { ready: true }); h.pending();
  assert.match(h.errors.join('\n'), /cannot establish ownership/);
  assert.ok(!h.trace.includes('send:start')); assert.deepEqual(h.signals, []);
  h.exit(); h.finished(1);
});

test('failed audit and reported survivors still use freshly confirmed owned teardown', async () => {
  for (const kind of ['audit error', 'survivor']) {
    const h = await coordinator(); h.ready();
    if (kind === 'audit error') h.state.auditError = true;
    else h.state.survivors = [{ ...h.state.current, pid: 4243, ppid: 4242, command: 'controlled-descendant' }];
    h.complete(); h.pending();
    const teardown = ['watch.stop', 'audit', ...(kind === 'survivor' ? ['fixture-survivor'] : []), 'lookup', 'signal', 'disconnect'];
    assert.deepEqual(h.trace.slice(-teardown.length), teardown);
    assert.deepEqual(h.signals, [[-4242, 'SIGKILL']]);
    assert.match(h.errors.join('\n'), kind === 'audit error' ? /injected audit failure/ : /Surviving fixture: PID 4243, command controlled-descendant\. Files: controlled\.test\.mjs/);
    h.exit(); h.finished(1);
  }
});

test('changed or absent ownership never authorizes a signal or successful completion', async () => {
  for (const replacement of [{ identity: 'birth-2' }, { command: 'replacement' }, { pgid: 9999 }, null]) {
    const h = await coordinator(); h.ready();
    h.state.current = replacement && { ...h.state.current, ...replacement };
    h.complete(); h.pending(); assert.deepEqual(h.signals, []);
    assert.deepEqual(h.trace.slice(-4), ['watch.stop', 'audit', 'lookup', 'disconnect']);
    h.exit(); h.finished(1);
  }
});

test('explicit cancellation preserves owned teardown and waits for actual exit', async () => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const h = await coordinator(); h.ready(); h.proc.emit(signal); h.pending();
    assert.deepEqual(h.signals, [[-4242, 'SIGKILL']]);
    assert.ok(!h.trace.includes('audit')); h.exit(); h.finished(1);
  }
});

test('completion retains late output until both pipes physically close in either order', async () => {
  for (const order of [['stdout', 'stderr'], ['stderr', 'stdout']]) {
    const h = await coordinator(); h.ready(); h.complete(); h.pending();
    h.exit(null, 'SIGKILL', false);
    assert.equal(h.timers.length, 1); assert.equal(h.timers[0].delay, 5_000);
    h.child.stdout.emit('data', 'late TAP totals');
    h.child.stderr.emit('data', 'late diagnostics');
    h.child.emit('close'); // Aggregate close is not evidence of drained pipes.
    h.closePipe(order[0]); assert.deepEqual(h.exits, []); assert.deepEqual(h.timings, []);
    h.child[order[1]].emit('end'); assert.deepEqual(h.exits, []);
    h.closePipe(order[1]); h.finished(0);
    assert.ok(h.trace.includes('stdout:late TAP totals'));
    assert.ok(h.trace.includes('stderr:late diagnostics'));
  }
});

test('early pipe closure does not release occupancy before the actual leader exit', async () => {
  const h = await coordinator(); h.ready(); h.closePipe('stdout'); h.closePipe('stderr');
  h.complete(); h.pending(); h.exit(); h.finished(0);
});

test('both forwarded output queues must flush before completion and retain worker failure', async () => {
  for (const code of [0, 7]) {
    const h = await coordinator(); h.ready(); h.state.holdOutput = true;
    h.child.stdout.emit('data', 'totals'); h.child.stderr.emit('data', 'diagnostic');
    h.complete(code); h.exit(); assert.deepEqual(h.exits, []);
    h.writes.shift()(); assert.deepEqual(h.exits, []);
    h.writes.shift()(); h.finished(code);
  }
});

test('a retained pipe or blocked forwarded write fails the bounded post-exit drain once', async () => {
  for (const blocked of ['pipe', 'write']) {
    const h = await coordinator(); h.ready();
    if (blocked === 'write') { h.state.holdOutput = true; h.child.stdout.emit('data', 'tail'); }
    h.complete(); h.pending(); h.exit(null, 'SIGKILL', blocked === 'write');
    assert.deepEqual(h.exits, []); assert.equal(h.timers.length, 1);
    h.timers[0].callback(); h.finished(1);
    assert.match(h.errors.join('\n'), /output drain exceeded 5000ms/);
    h.closePipe('stdout'); h.closePipe('stderr'); h.writes.shift()?.(); h.finished(1);
  }
});

test('premature pipe close, pipe error and forwarded sink errors cannot claim success', async () => {
  for (const fault of ['close', 'read', 'write', 'stdout', 'stderr']) {
    const h = await coordinator(); h.ready();
    if (fault === 'read') h.child.stderr.emit('error', Error('read failed'));
    if (fault === 'write') {
      h.state.holdOutput = true; h.child.stderr.emit('data', 'tail');
      h.writes.shift()(Error('write failed'));
    }
    h.complete(); h.exit(null, 'SIGKILL', false);
    if (fault === 'stdout' || fault === 'stderr') h.proc[fault].emit('error', Error('sink failed'));
    h.closePipe('stdout', fault !== 'close'); h.closePipe('stderr'); h.finished(1);
  }
});

test('real writable failures emit EPIPE without bypassing timing and owned cleanup', async () => {
  for (const failedSink of ['stdout', 'stderr']) {
    const h = await coordinator({ failedSink }); h.ready();
    h.child[failedSink].emit('data', 'tail');
    h.complete(); h.pending(); h.exit(null, 'SIGKILL', false);
    // Node delivers both the write callback and a later stream error event.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.proc[failedSink].errored.code, 'EPIPE');
    assert.deepEqual(h.exits, []);
    h.closePipe('stdout'); h.closePipe('stderr'); h.finished(1);
    assert.deepEqual(h.signals, [[-4242, 'SIGKILL']]);
  }
});

test('cancellation and frozen-watch failure retain output drain and their error outcomes', async () => {
  for (const cancel of [h => h.proc.emit('SIGTERM'), h => h.watch().onFrozen({ limit_seconds: 1, elapsed_s: 2 })]) {
    const h = await coordinator(); h.ready(); cancel(h); h.pending();
    h.exit(null, 'SIGKILL', false); h.child.stderr.emit('data', 'cancelled tail');
    h.closePipe('stdout'); assert.deepEqual(h.exits, []);
    h.closePipe('stderr'); h.finished(1); assert.deepEqual(h.signals, [[-4242, 'SIGKILL']]);
  }
});

test('native runner captures large TAP and stderr tails with complete success and failure totals', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runner-drain-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'output.test.mjs'), preload = path.join(root, 'output.mjs');
  const tapTail = `TAP-BEGIN${'x'.repeat(1024 * 1024)}TAP-END`;
  const stderrTail = `STDERR-BEGIN${'y'.repeat(1024 * 1024)}STDERR-END\n`;
  // The empty stdout barrier runs only after the worker's output pipeline
  // resolves. Queue raw stderr there, before its own flush barrier, so this
  // payload exercises the end of the run rather than worker startup.
  writeFileSync(preload, `if (process.argv[2] === '--worker') {
    const write = process.stdout.write;
    process.stdout.write = function (data, ...args) {
      if (data === '') {
        process.stdout.write = write;
        process.stderr.write(${JSON.stringify(stderrTail)});
      }
      return write.call(this, data, ...args);
    };
  }`);
  writeFileSync(file, `import test from 'node:test'; test('large output', t => { t.diagnostic(${JSON.stringify(tapTail)}); if (process.env.RUNNER_FIXTURE_FAIL === '1') throw Error('expected runner fixture failure'); });`);
  for (const fail of [false, true]) {
    const env = { ...process.env, RUNNER_FIXTURE_FAIL: fail ? '1' : '0' };
    delete env.NODE_TEST_CONTEXT;
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}`;
    const child = spawnChild(t, process.execPath, [fileURLToPath(runner), file], { env });
    const result = await waitForExit(child);
    assert.equal(result.signal, null, result.stderr.slice(-1000));
    assert.equal(result.code, fail ? 1 : 0, result.stdout.slice(-3000) + result.stderr.slice(-1000));
    assert.ok(result.stdout.includes(tapTail), 'entire TAP diagnostic must survive');
    assert.ok(result.stderr.includes(stderrTail), 'entire worker stderr must survive');
    assert.match(result.stdout, /1\.\.1\n# tests 1\n# suites 0\n/);
    assert.match(result.stdout, new RegExp(`# pass ${fail ? 0 : 1}\\n# fail ${fail ? 1 : 0}\\n`));
  }
});
}
