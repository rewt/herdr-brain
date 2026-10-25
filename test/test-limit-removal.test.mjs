import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { spawnFixtureExec } from './helpers/fixture-lifetime.mjs';
import net from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const executable = process.env.HERDR_FIXTURE_LIFETIME_EXECUTABLE;
const legacySeconds = process.env.HERDR_FIXTURE_LIFETIME_SECONDS;
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
async function observe(t, command, args, ipc = false, env = process.env) {
  const options = { env, stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] };
  const run = args[0] === '--exec' ? await spawnFixtureExec(command, args, options) : null;
  const child = run?.child ?? spawn(command, args, options);
  let stdout = '', stderr = '', error;
  child.stdout.setEncoding('utf8').on('data', bytes => { stdout += bytes; });
  child.stderr.setEncoding('utf8').on('data', bytes => { stderr += bytes; });
  child.once('error', value => { error = value; });
  const targetClosed = run?.targetClosed ?? new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, error, stdout, stderr })));
  const closed = run?.complete ?? targetClosed;
  t.after(async () => {
    const pending = !!child.pid && child.exitCode === null && child.signalCode === null;
    if (pending) child.kill('SIGKILL');
    await closed;
    assert.equal(pending, false, 'test left an owned child pending');
  });
  return { child, closed, targetClosed, joinClosed: run?.joinClosed, ready: () => Promise.race([
    new Promise(resolve => child.once('message', resolve)),
    targetClosed.then(result => { throw Error(`child exited before readiness: ${JSON.stringify(result)}`); }),
  ]) };
}
const guarded = (t, fifo, source, ipc = false) => observe(t, executable,
  ['--exec', fifo, legacySeconds, process.execPath, '-e', source], ipc);

test('native lifetime enforcement has no elapsed clock or command timeout', () => {
  const source = fs.readFileSync(new URL('./helpers/fixture-lifetime.c', import.meta.url), 'utf8');
  const launcher = fs.readFileSync(new URL('./helpers/fixture-lifetime.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /clock_gettime|CLOCK_|alarm\s*\(/);
  assert.doesNotMatch(source.slice(source.indexOf('static void guard'), source.indexOf('static int launch')), /seconds/);
  assert.doesNotMatch(launcher, /timeout\s*:/);
  assert.equal(path.basename(executable), createHash('sha256').update(source).digest('hex'));
});

test('native fixture exec preserves success and nonzero exits after joining both output pipes', async t => {
  const { fifo } = fixture(t);
  for (const code of [0, 7]) {
    const result = await (await guarded(t, fifo,
      `process.stdout.write('complete stdout');process.stderr.write('complete stderr');process.exitCode=${code}`)).closed;
    assert.deepEqual(result, { code, signal: null, error: undefined, stdout: 'complete stdout', stderr: 'complete stderr' });
  }
});

test('a live fixture writer keeps the child pending until explicit completion', async t => {
  const { fifo } = fixture(t), run = await guarded(t, fifo, waiting, true);
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
  const sentinel = await observe(t, process.execPath, ['-e', waiting], true);
  assert.equal(await sentinel.ready(), 'ready');
  const foreign = await observe(t, executable, ['--watch', owner.fifo, legacySeconds, String(sentinel.child.pid)]);
  assert.equal((await foreign.closed).code, 0);
  const run = await guarded(t, owner.fifo, waiting, true);
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
  const result = await (await guarded(t, fifo, "throw Error('injected worker failure')")).closed;
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /Error: injected worker failure/);
});

test('native fixture usage and exec failures stay failures', async t => {
  const { fifo } = fixture(t);
  for (const args of [[], ['--watch', fifo, legacySeconds, '1'], ['--watch', fifo, legacySeconds, '12invalid'],
    ['--unknown', fifo, legacySeconds, 'unused'], ['--exec', fifo, '0', process.execPath],
    ['--exec', fifo, legacySeconds, path.join(fifo, 'missing-executable')]]) {
    const run = await observe(t, executable, args), result = await run.closed;
    assert.equal(result.code, 125, JSON.stringify({ args, result }));
    assert.equal(result.signal, null);
    if (run.joinClosed) assert.equal((await run.joinClosed).code, args[2] === '0' ? 126 : 0);
  }
});

test('a real FIFO observation error cancels the owned target', async t => {
  const { fifo } = fixture(t);
  const result = await (await guarded(t, `${fifo}.missing`, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)')).closed;
  assert.equal(result.signal, 'SIGKILL');
});

test('explicit operator cancellation retains its actual signal with a live writer', async t => {
  const { fifo } = fixture(t), run = await guarded(t, fifo, waiting, true);
  assert.equal(await run.ready(), 'ready');
  assert.equal(run.child.kill('SIGTERM'), true);
  const result = await run.closed;
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.ok(fs.statSync(fifo).isFIFO());
});

test('target close cannot complete a held actual guard, and real reap plus join releases completion', async t => {
  const { fifo } = fixture(t), root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-completion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const witness = path.join(root, 'witness'), barrier = path.join(root, 'barrier');
  const built = spawnSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-o', witness,
    fileURLToPath(new URL('./helpers/fixture-completion-witness.c', import.meta.url))], { encoding: 'utf8' });
  assert.equal(built.error, undefined); assert.equal(built.status, 0, built.stderr);
  let connection;
  const server = net.createServer();
  const held = new Promise(resolve => server.once('connection', socket => {
    connection = socket;
    createInterface({ input: socket }).once('line', line => resolve(line.split(' ').map(Number)));
  }));
  t.after(async () => { connection?.destroy(); if (server.listening) await new Promise(resolve => server.close(resolve)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(barrier, resolve); });
  const program = "process.on('message',()=>{process.stdout.write('joined');process.disconnect()});process.send({pid:process.pid,private:process.env.HERDR_FIXTURE_COMPLETION_FD??null})";
  const run = await observe(t, witness, ['--exec', fifo, legacySeconds, process.execPath, '-e', program], true,
    { ...process.env, FIXTURE_COMPLETION_BARRIER: barrier });
  assert.deepEqual(await run.ready(), { pid: run.child.pid, private: null });
  run.child.send('finish');
  const target = await run.targetClosed, [guardPid, code] = await held;
  assert.deepEqual(target, { code: 0, signal: null, error: undefined, stdout: 'joined', stderr: '' });
  assert.equal(code, 0); assert.notEqual(guardPid, run.child.pid);
  async function mustRemainPending(completion) {
    let settled = false;
    completion.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, 'completion accepted a guard held before actual exit');
  }
  await assert.rejects(mustRemainPending(run.targetClosed), /completion accepted a guard/);
  await mustRemainPending(run.closed);
  connection.end('R');
  assert.deepEqual(await run.closed, target);
  const join = await run.joinClosed, event = join.stdout.trim().split(' ').map(Number);
  assert.equal(join.code, 0); assert.equal(join.signal, null); assert.equal(join.error, undefined);
  assert.deepEqual(event, [guardPid, -5, 0x10000000], 'actual matching EVFILT_PROC NOTE_REAP');
  const broken = await spawnFixtureExec(witness, ['--exec', fifo, legacySeconds, process.execPath, '-e', "process.stdout.write('kept')"],
    { env: { ...process.env, FIXTURE_COMPLETION_JOIN_ERROR: '1' } });
  await assert.rejects(broken.complete, error => error.join.code === 125 && error.target.code === 0 && error.target.stdout === 'kept');
});
