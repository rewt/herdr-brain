import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const executable = process.env.HERDR_FIXTURE_LIFETIME_EXECUTABLE;
const waiting = "process.on('message',()=>{process.stdout.write('joined');process.disconnect()});process.send('ready')";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-owner-only-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fifo = path.join(root, 'alive');
  const made = spawnSync('/usr/bin/mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.error?.message ?? made.stderr);
  const fd = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  let open = true;
  const close = () => { if (open) { fs.closeSync(fd); open = false; } };
  t.after(close);
  return { fifo, close };
}
function observe(t, command, args, ipc = false) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
  let stdout = '', stderr = '', error;
  child.stdout.setEncoding('utf8').on('data', bytes => { stdout += bytes; });
  child.stderr.setEncoding('utf8').on('data', bytes => { stderr += bytes; });
  child.once('error', value => { error = value; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, error, stdout, stderr })));
  t.after(async () => {
    const pending = !!child.pid && child.exitCode === null && child.signalCode === null;
    if (pending) child.kill('SIGKILL');
    await closed;
    assert.equal(pending, false, 'test left an owned child pending');
  });
  return { child, closed, ready: () => Promise.race([
    new Promise(resolve => child.once('message', resolve)),
    closed.then(result => { throw Error(`child exited before readiness: ${JSON.stringify(result)}`); }),
  ]) };
}
const guarded = (t, fifo, source, ipc = false) => observe(t, executable,
  ['--exec', fifo, process.execPath, '-e', source], ipc);

test('native lifetime enforcement has no elapsed clock or command timeout', () => {
  const source = fs.readFileSync(new URL('./helpers/fixture-lifetime.c', import.meta.url), 'utf8');
  const launcher = fs.readFileSync(new URL('./helpers/fixture-lifetime.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /clock_gettime|CLOCK_|alarm\s*\(|seconds/);
  assert.doesNotMatch(launcher, /timeout\s*:|loadTimeout|LIFETIME_SECONDS/);
  assert.equal(path.basename(executable), createHash('sha256').update(source).digest('hex'));
});

test('native fixture exec preserves success and nonzero exits after joining both output pipes', async t => {
  const { fifo } = fixture(t);
  for (const code of [0, 7]) {
    const result = await guarded(t, fifo,
      `process.stdout.write('complete stdout');process.stderr.write('complete stderr');process.exitCode=${code}`).closed;
    assert.deepEqual(result, { code, signal: null, error: undefined, stdout: 'complete stdout', stderr: 'complete stderr' });
  }
});

test('a live fixture writer keeps the child pending until explicit completion', async t => {
  const { fifo } = fixture(t), run = guarded(t, fifo, waiting, true);
  assert.equal(await run.ready(), 'ready');
  assert.equal(run.child.exitCode, null);
  assert.equal(run.child.signalCode, null);
  run.child.send('finish');
  const result = await run.closed;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'joined');
});

test('owner EOF stops only the guarded target and a foreign watch parent is never adopted', async t => {
  const owner = fixture(t);
  const sentinel = observe(t, process.execPath, ['-e', waiting], true);
  assert.equal(await sentinel.ready(), 'ready');
  const foreign = observe(t, executable, ['--watch', owner.fifo, String(sentinel.child.pid)]);
  assert.equal((await foreign.closed).code, 0);
  const run = guarded(t, owner.fifo, waiting, true);
  assert.equal(await run.ready(), 'ready');
  owner.close();
  assert.equal((await run.closed).signal, 'SIGKILL');
  sentinel.child.send('finish');
  const result = await sentinel.closed;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'joined');
});

test('native fixture exec promptly exposes a real worker error', async t => {
  const { fifo } = fixture(t);
  const result = await guarded(t, fifo, "throw Error('injected worker failure')").closed;
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /Error: injected worker failure/);
});

test('native fixture usage and exec failures stay failures', async t => {
  const { fifo } = fixture(t);
  for (const args of [[], ['--watch', fifo, '1'], ['--watch', fifo, '12invalid'],
    ['--unknown', fifo, 'unused'], ['--exec', fifo, path.join(fifo, 'missing-executable')]]) {
    const result = await observe(t, executable, args).closed;
    assert.equal(result.code, 125, JSON.stringify({ args, result }));
    assert.equal(result.signal, null);
  }
});

test('a real FIFO observation error cancels the owned target', async t => {
  const { fifo } = fixture(t);
  const result = await guarded(t, `${fifo}.missing`, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)').closed;
  assert.equal(result.signal, 'SIGKILL');
});

test('explicit operator cancellation retains its actual signal with a live writer', async t => {
  const { fifo } = fixture(t), run = guarded(t, fifo, waiting, true);
  assert.equal(await run.ready(), 'ready');
  assert.equal(run.child.kill('SIGTERM'), true);
  const result = await run.closed;
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.ok(fs.statSync(fifo).isFIFO());
});
