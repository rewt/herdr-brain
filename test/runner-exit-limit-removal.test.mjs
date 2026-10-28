// Source-bound coordinator evidence; native descendant reaping is separate.
// Ordinary selection owns its VM capability; no caller flag is required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
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

async function coordinator() {
  const trace = [], exits = [], errors = [], signals = [], timers = [], timings = [];
  const leader = { pid: 4242, ppid: 202, pgid: 4242, state: 'S', identity: 'birth-1', command: 'suite-worker' };
  const state = { current: leader, auditError: false, survivors: [] };
  const child = Object.assign(new EventEmitter(), {
    pid: leader.pid, exitCode: null, signalCode: null, connected: true,
    stdout: Object.assign(new EventEmitter(), { destroy: () => trace.push('stdout.destroy') }),
    stderr: Object.assign(new EventEmitter(), { destroy: () => trace.push('stderr.destroy') }),
    send: message => trace.push(`send:${message}`),
    disconnect() { this.connected = false; trace.push('disconnect'); },
    unref: () => trace.push('unref'),
  });
  const proc = Object.assign(new EventEmitter(), {
    argv: [process.execPath, fileURLToPath(runner), 'controlled.test.mjs'], env: {},
    pid: 202, execPath: process.execPath, platform: process.platform,
    stdout: { write: data => trace.push(`stdout:${data}`) },
    stderr: { write: data => trace.push(`stderr:${data}`) },
    exit: code => { trace.push('exit'); exits.push(code); },
    kill: (pid, signal) => { trace.push('signal'); signals.push([pid, signal]); },
  });
  let watch;
  const context = createContext({
    process: proc, URL, Map, console: { error: value => errors.push(value) },
    // Observation only: never fire a clock. Every request fails pending().
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
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
        assert.equal(pid, leader.pid);
        trace.push('lookup');
        return { ok: true, value: state.current };
      }
      trace.push('audit');
      return state.auditError ? { ok: false, error: 'injected audit failure' }
        : { ok: true, value: new Map([state.current, ...state.survivors].filter(Boolean).map(row => [row.pid, row])) };
    } },
    './offline-herdr.mjs': { offlineHerdr: () => () => trace.push('cleanupHerdr') },
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
  await module.link(specifier => {
    if (Object.hasOwn(actual, specifier)) return new SourceTextModule(actual[specifier], { context, identifier: new URL(specifier, runner).href });
    assert.ok(Object.hasOwn(dependencies, specifier), `unreconciled import: ${specifier}`);
    const values = dependencies[specifier];
    return new SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  const ready = () => { child.emit('message', { ready: true }); assert.deepEqual(trace.slice(-2), ['lookup', 'send:start']); };
  const complete = (code = 0) => child.emit('message', { complete: true, code });
  const pending = () => {
    assert.deepEqual(timers, [], 'elapsed fallback must not be armed for a pending child');
    assert.deepEqual(exits, []);
    for (const action of ['cleanupHerdr', 'stdout.destroy', 'stderr.destroy', 'unref']) assert.ok(!trace.includes(action), action);
    assert.equal(child.connected, false);
    assert.equal(child.listenerCount('exit'), 2, 'finish must subscribe to actual child exit');
  };
  const exit = (code = null, signal = 'SIGKILL') => {
    child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal);
  };
  const finished = code => {
    assert.deepEqual(exits, [code]);
    assert.deepEqual(trace.slice(-5), ['cleanupHerdr', 'stdout.destroy', 'stderr.destroy', 'unref', 'exit']);
    assert.equal(timings.length, 1);
    assert.equal(timings[0].exit_code, code);
    assert.deepEqual(timers, []);
  };
  return { child, proc, state, trace, exits, errors, signals, timings, ready, complete, pending, exit, finished, watch: () => watch };
}

if (typeof SourceTextModule !== 'function') {
  test('ordinary suite selection executes every runner witness with its VM capability', async t => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnChild(t, process.execPath,
      ['--experimental-vm-modules', '--test', fileURLToPath(import.meta.url)], { env });
    const result = await waitForExit(child);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# tests 8\b/);
    assert.match(result.stdout, /# pass 8\b/);
    assert.match(result.stdout, /# fail 0\b/);
  });
} else {
test('actual runner source removes only the elapsed exit fallback boundary', () => {
  assert.doesNotMatch(source, /loadTimeout|setTimeout/);
  assert.match(source, /child\.exitCode !== null \|\| child\.signalCode !== null/);
  assert.match(source, /else child\.once\('exit', exit\)/);
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
  spawnError.child.emit('error', Error('injected ENOENT')); spawnError.finished(1);
  assert.deepEqual(spawnError.signals, []);
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
}
