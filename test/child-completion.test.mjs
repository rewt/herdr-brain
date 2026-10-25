import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createProcessTracker } from './helpers/processes.mjs';

const moduleURL = new URL('./helpers/child.mjs', import.meta.url).href;
const source = fs.readFileSync(new URL(moduleURL), 'utf8');
// Link the complete actual module, changing only ESM declarations/meta syntax.
// Process identity, signals, spawn and timers are controlled below; this does
// not prove native process/IPC/pipe behavior or the retained drain contract.
const imports = [
  "import { loadTimeout } from '../../lib/deadline.mjs';",
  "import { spawn } from 'node:child_process';",
  "import { fileURLToPath } from 'node:url';",
  "import { registerProcess, killProcess } from './processes.mjs';",
];
let body = source;
for (const declaration of imports) body = body.replace(declaration, '');
assert.doesNotMatch(body, /^import /m, 'every import must have an explicit binding');
body = body.replaceAll('import.meta.url', 'moduleURL').replace(/^export /gm, '');
const link = new Function('loadTimeout', 'spawn', 'fileURLToPath', 'registerProcess', 'killProcess',
  'setTimeout', 'clearTimeout', 'moduleURL', `${body}\nreturn {spawnChild,spawnScenarioChild,waitForExit,killChild,childProcessEntry};`);

function controlled({ autoDestroy = true } = {}) {
  const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, signalCode: null,
    stdout: new PassThrough({ autoDestroy }), stderr: new PassThrough({ autoDestroy }), unref() { this.unreferenced = true; } });
  const row = { pid: 42, ppid: 1, pgid: 17, state: 'S', identity: 'owned birth', command: 'fixture' };
  const reads = [], signals = [], spawns = [], allowances = [], hooks = [], reports = [], timers = new Map();
  let lookup = { ok: true, value: row };
  const tracker = createProcessTracker({
    readIdentity: pid => { reads.push(pid); return lookup; },
    readIdentities: () => ({ ok: true, value: new Map([[42, row]]) }),
    sendSignal: (pid, signal) => signals.push({ pid, signal }), report: message => reports.push(message),
  });
  const api = link(ms => { allowances.push(ms); return ms; },
    (...args) => { spawns.push(args); return child; }, fileURLToPath,
    tracker.registerProcess, tracker.killProcess,
    (callback, ms) => { const token = {}; timers.set(token, { callback, ms }); return token; },
    token => timers.delete(token), moduleURL);
  const controller = new AbortController();
  const context = { name: 'controlled fixture', signal: controller.signal, after: hook => hooks.push(hook) };
  return { api, child, context, controller, row, reads, signals, spawns, allowances, hooks, reports, timers,
    lookup: value => { lookup = value; },
    exit(code = 0, signal = null) { child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal); },
    close() { child.emit('close', child.exitCode, child.signalCode); },
  };
}
const launch = (f, name = 'spawnChild', legacy) => f.api[name](f.context, 'fixture', ['--work'], {}, legacy);

test('IPC drain requires actual exit, observed disconnect and every owned pipe close; EOF is insufficient', async () => {
  // Include the genuine stdio shape before spawn so the writable input pipe
  // cannot be overlooked by the actual linked helper.
  const owned = controlled({ autoDestroy: false });
  owned.child.stdin = new PassThrough({ autoDestroy: false });
  owned.child.stdio = [owned.child.stdin, owned.child.stdout, owned.child.stderr, null];
  const target = launch(owned);
  let settled = false;
  const result = owned.api.waitForExit(target); result.then(() => { settled = true; });
  owned.exit(7); target.emit('disconnect');
  target.stdout.write('trailing output'); target.stderr.write('trailing error');
  await Promise.resolve(); assert.equal(settled, false, 'exit plus IPC disconnect cannot discard open streams');
  const stdoutEnded = new Promise(resolve => target.stdout.once('end', resolve));
  target.stdout.end(); await stdoutEnded;
  assert.equal(settled, false, 'stderr is still open');
  const stderrEnded = new Promise(resolve => target.stderr.once('end', resolve));
  target.stderr.end(); await stderrEnded;
  await Promise.resolve(); assert.equal(settled, false, 'both EOFs still do not prove pipe closure');
  for (const pipe of [target.stdout, target.stderr]) {
    const closed = new Promise(resolve => pipe.once('close', resolve)); pipe.destroy(); await closed;
  }
  assert.equal(settled, false, 'the owned writable input pipe is still open');
  const stdinClosed = new Promise(resolve => target.stdin.once('close', resolve)); target.stdin.destroy(); await stdinClosed;
  assert.deepEqual(await result, { code: 7, status: 7, signal: null,
    stdout: 'trailing output', stderr: 'trailing error' });
  await owned.hooks[0]();
  assert.equal(owned.timers.size, 0); assert.deepEqual(owned.signals, []);
});

test('actual child helpers accept legacy allowances without arming an execution timer', async t => {
  t.diagnostic(`child.mjs SHA256 ${createHash('sha256').update(source).digest('hex')}; controlled linkage, not native execution`);
  for (const name of ['spawnChild', 'spawnScenarioChild']) for (const legacy of [undefined, 1, 55001]) {
    const f = controlled();
    const options = { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { FIXTURE: 'owned' } };
    const child = f.api[name](f.context, 'fixture', ['--work'], options, legacy);
    assert.equal(child, f.child);
    assert.deepEqual(f.spawns, [['fixture', ['--work'], { ...options, detached: false }]]);
    assert.deepEqual(f.api.childProcessEntry(child), { pid: 42, group: false, identity: f.row.identity, command: f.row.command });
    assert.equal(f.timers.size, 0);
    assert.deepEqual(f.allowances, []);
    let settled = false, message;
    const result = f.api.waitForExit(child); result.then(() => { settled = true; });
    child.on('message', value => { message = value; }); child.emit('message', { ready: true });
    assert.deepEqual(message, { ready: true });
    await Promise.resolve(); assert.equal(settled, false);
    child.stdout.write('head'); child.stderr.write('error');
    const code = legacy === 55001 ? 7 : 0;
    f.exit(code);
    assert.equal(f.timers.size, 0, 'exit must not install a drain cutoff');
    assert.deepEqual(f.allowances, []);
    assert.equal(child.stdout.destroyed, false);
    assert.equal(child.stderr.destroyed, false);
    assert.equal(child.unreferenced, undefined);
    assert.deepEqual(f.signals, []);
    child.stdout.write(' tail'); child.stderr.write(' tail');
    await Promise.resolve(); assert.equal(settled, false, 'parent exit is not stream close');
    f.close();
    assert.deepEqual(await result, { code, status: code, signal: null, stdout: 'head tail', stderr: 'error tail' });
    assert.equal(await f.api.waitForExit(child), await result, 'late waiter retains the original result');
    assert.equal(f.timers.size, 0);
    const reads = f.reads.length;
    assert.equal(child.kill('SIGKILL'), false);
    await f.hooks[0]();
    assert.equal(f.reads.length, reads, 'completed teardown never queries a historical PID');
    assert.deepEqual(f.signals, []);
  }
});

test('an early real spawn error reaches late waiters and teardown unchanged', async () => {
  const f = controlled(); f.child.pid = undefined;
  const child = launch(f), error = Object.assign(Error('spawn failed'), { code: 'ENOENT' });
  child.emit('error', error);
  await Promise.resolve();
  await assert.rejects(f.api.waitForExit(child), value => value === error);
  await assert.rejects(f.hooks[0](), value => value === error);
  assert.deepEqual(f.reads, []); assert.deepEqual(f.signals, []);
  assert.throws(() => f.api.waitForExit(new EventEmitter()), /requires a child registered at spawn time/);
});

test('explicit child cancellation confirms the current birth and preserves signal bookkeeping', async () => {
  const f = controlled(), child = launch(f);
  assert.equal(child.kill('SIGTERM'), true);
  assert.equal(child.killed, true);
  assert.deepEqual(f.reads, [42, 42]);
  assert.deepEqual(f.signals, [{ pid: 42, signal: 'SIGTERM' }]);
  f.exit(null, 'SIGTERM'); f.close();
  assert.equal((await f.api.waitForExit(child)).signal, 'SIGTERM');
  await f.hooks[0]();
  const aborted = controlled(), target = launch(aborted);
  aborted.controller.abort();
  assert.deepEqual(aborted.signals, [{ pid: 42, signal: 'SIGKILL' }]);
  aborted.exit(null, 'SIGKILL'); aborted.close();
  assert.equal((await aborted.api.waitForExit(target)).signal, 'SIGKILL');
  await aborted.hooks[0]();
});

test('live-child cleanup awaits close and retains the real leak failure', async () => {
  const f = controlled(), child = launch(f);
  let finished = false;
  const cleanup = f.hooks[0](); cleanup.then(() => { finished = true; }, () => { finished = true; });
  const failure = assert.rejects(cleanup, /controlled fixture: left child running: fixture --work/);
  assert.deepEqual(f.signals, [{ pid: 42, signal: 'SIGKILL' }]);
  f.exit(null, 'SIGKILL');
  await Promise.resolve(); assert.equal(finished, false);
  f.close(); await failure;
  assert.equal((await f.api.waitForExit(child)).signal, 'SIGKILL');
});

for (const state of ['changed', 'refused']) test(`${state} ownership never authorizes a teardown signal`, async () => {
  const f = controlled(), child = launch(f);
  f.lookup(state === 'changed' ? { ok: true, value: { ...f.row, identity: 'replacement birth' } }
    : { ok: false, error: 'identity source refused' });
  assert.equal(child.kill('SIGTERM'), false);
  await assert.rejects(f.hooks[0](), /child cleanup unconfirmed; no signal sent to 42/);
  assert.deepEqual(f.signals, []);
  assert.match(f.reports.join('\n'), new RegExp(state));
  assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
  assert.equal(child.unreferenced, true);
  f.exit(7); f.close(); assert.equal((await f.api.waitForExit(child)).code, 7);
});

test('registration refusal retains rollback and never invents signal authority', async () => {
  const f = controlled(); f.lookup({ ok: false, error: 'registration refused' });
  assert.throws(() => launch(f), /cannot establish ownership of PID 42: registration refused/);
  assert.deepEqual(f.signals, []);
  assert.match(f.reports.join('\n'), /registration refused/);
  await assert.rejects(f.hooks[0](), /child cleanup unconfirmed; no signal sent to 42/);
  f.exit(1); f.close(); assert.equal((await f.api.waitForExit(f.child)).code, 1);
});

test('a real child error after exit rejects pending output completion', async () => {
  const f = controlled(), child = launch(f), error = Error('post-exit child failure');
  f.exit(7);
  child.emit('error', error);
  await assert.rejects(f.api.waitForExit(child), value => value === error);
  await assert.rejects(f.hooks[0](), value => value === error);
  assert.deepEqual(f.signals, []);
});

test('real stream errors are surfaced without manufacturing completion', async () => {
  const f = controlled(), child = launch(f), error = Error('stream failure');
  for (const stream of [child.stdout, child.stderr])
    assert.throws(() => stream.emit('error', error), value => value === error);
  let settled = false;
  f.api.waitForExit(child).then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  f.exit(1); f.close();
  assert.equal((await f.api.waitForExit(child)).code, 1);
  await f.hooks[0]();
});
