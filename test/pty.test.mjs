import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ptyCommand, runPTY, PTY_SKIP_REASON } from './helpers/pty.mjs';
import { spawnChild, waitForExit } from './helpers/child.mjs';
import { waitForFile } from './helpers/file-wait.mjs';
import { loadTimeout } from '../lib/deadline.mjs';
import { createProcessTracker } from './helpers/processes.mjs';

process.env.ORG_ACTOR = 'pty-test-agent';

test('PTY transport uses native BSD arguments and shell-safe util-linux arguments', () => {
  const values = ['two words', "apostrophe'", '$(must-not-execute)', '--model', 'literal'];
  const bsd = ptyCommand(process.execPath, values, { platform: 'darwin', executable: 'selected-script' });
  assert.deepEqual(bsd, { file: 'selected-script', args: ['-q', '/dev/null', process.execPath, ...values] });
  const linux = ptyCommand(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...values], { platform: 'linux', executable: 'selected-script' });
  assert.deepEqual(linux.args.slice(0, 3), ['-q', '-e', '-c']);
  assert.equal(linux.args.at(-1), '/dev/null');
  const result = spawnSync('sh', ['-c', linux.args[3]], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), values);
  assert.throws(() => ptyCommand('native', [], { platform: 'unsupported', executable: 'script' }), /unsupported/u);
  assert.match(ptyCommand('owner', values, { platform: 'linux', executable: 'script', exec: true }).args[3], /^exec /);
});

const pause = () => new Promise(resolve => setTimeout(resolve, 20));
const runner = fileURLToPath(new URL('./helpers/run.mjs', import.meta.url));
const boundedTest = new URL('./helpers/bounded-test.mjs', import.meta.url).href;
const ptyHelper = new URL('./helpers/pty.mjs', import.meta.url).href;
function fixture(t, { block = true } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pty-cancellation-'));
  const receipt = path.join(root, 'ready.json'), leaf = path.join(root, 'leaf.json');
  const leafCode = `const fs=require('fs');process.on('SIGHUP',()=>{});
fs.writeFileSync(${JSON.stringify(leaf + '.tmp')},JSON.stringify({pid:process.pid}));
fs.renameSync(${JSON.stringify(leaf + '.tmp')},${JSON.stringify(leaf)});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); // ${root}`;
  const program = path.join(root, 'command.cjs');
  fs.writeFileSync(program, `const fs=require('fs'),{spawn}=require('child_process');
process.on('SIGHUP',()=>{});
const child=spawn(process.execPath,['-e',${JSON.stringify(leafCode)}],{stdio:'ignore'});child.unref();
const timer=setInterval(async()=>{if(!fs.existsSync(${JSON.stringify(leaf)}))return;clearInterval(timer);
const value={pid:process.pid,leaf:child.pid,session:Number(process.env.HERDR_TEST_PTY_SESSION),suite:Number(process.env.HERDR_TEST_SUITE_PID),pgid:(await import(${JSON.stringify(new URL('./helpers/processes.mjs', import.meta.url).href)})).lookupProcess(process.pid).value.pgid,tty:process.stdin.isTTY};
fs.writeFileSync(${JSON.stringify(receipt + '.tmp')},JSON.stringify(value));fs.renameSync(${JSON.stringify(receipt + '.tmp')},${JSON.stringify(receipt)});
${block ? 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);' : 'setTimeout(()=>process.exit(0),100);'}
},10);`);
  t.after(async () => {
    // Report-only, including startup before a receipt. Native cleanup must finish
    // before removing fixture directories; receipts never authorize a signal.
    await waitForCleanup(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, program, receipt };
}
async function waitForCleanup(root, receipt = {}) {
  const tracker = createProcessTracker(), deadline = Date.now() + loadTimeout(6500);
  const pids = [receipt.pid, receipt.leaf, receipt.session];
  const groups = [receipt.pgid, receipt.session];
  for (;;) {
    const snapshot = tracker.snapshot(); assert.ok(snapshot.ok, snapshot.error);
    const live = [...snapshot.value.values()].filter(row => !/^Z/.test(row.state) &&
      (pids.includes(row.pid) || groups.includes(row.pgid) || row.command.includes(root)));
    if (!live.length) return;
    assert.ok(Date.now() < deadline, `PTY cleanup left survivors: ${live.map(row => `${row.pid} ${row.command}`).join(', ')}`);
    await pause();
  }
}
function readReceipt(f) {
  assert.ok(fs.existsSync(f.receipt), 'PTY fixture reached its blocked loop');
  const receipt = JSON.parse(fs.readFileSync(f.receipt));
  assert.equal(receipt.tty, true, 'command keeps its terminal');
  assert.notEqual(receipt.pgid, receipt.suite, 'command really escaped the suite group');
  assert.notEqual(receipt.session, receipt.suite, 'native owner has an independent session');
  return receipt;
}
test('PTY completion retains TTY, arguments, output and exit status', { skip: PTY_SKIP_REASON }, () => {
  const args = ['two words', "apostrophe'", '$(must-not-execute)'];
  const result = runPTY(process.execPath, ['-e', 'console.log(JSON.stringify({tty:process.stdin.isTTY,args:process.argv.slice(1)}));process.exitCode=7', ...args]);
  assert.equal(result.status, 7, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.match(/\{"tty"[^\r\n]+/)[0]), { tty: true, args });
});
test('PTY native owner accepts the measured-load allowance above its fifteen-second base', { skip: PTY_SKIP_REASON }, t => {
  const load = os.loadavg, capacity = os.availableParallelism;
  os.loadavg = () => [24, 24, 24]; os.availableParallelism = () => 4;
  t.after(() => { os.loadavg = load; os.availableParallelism = capacity; });
  // An immediate nonzero exit distinguishes a successful native launch from
  // rejecting the scaled 90-second bound with status 125 before exec.
  const result = runPTY(process.execPath, ['-e', 'console.log(process.stdin.isTTY);process.exitCode=7']);
  assert.equal(result.status, 7, result.stdout + result.stderr);
  assert.match(result.stdout, /true/);
});

function instrumentCleanup(t, implementation) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-cleanup-delay-'));
  const source = path.join(root, 'owner.c');
  const original = fs.readFileSync(new URL('./helpers/pty-owner.c', import.meta.url), 'utf8');
  // Alter only the enumeration timing/failure at the native boundary. Session
  // membership, audit tokens/pidfds and the actual signal sweeps remain intact.
  fs.writeFileSync(source, original.replaceAll('static int sweep(', 'static int native_sweep(')
    .replace('static volatile sig_atomic_t stopped;', `${implementation}\nstatic volatile sig_atomic_t stopped;`));
  const load = os.loadavg, capacity = os.availableParallelism;
  os.loadavg = () => [24, 24, 24]; os.availableParallelism = () => 4;
  t.after(() => {
    os.loadavg = load; os.availableParallelism = capacity;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return source;
}
test('PTY cleanup completes when native enumeration exceeds its former three-second allowance', { skip: PTY_SKIP_REASON }, t => {
  const ownerSource = instrumentCleanup(t, `static int sweep(int sig) {
    static int delayed;
    if (!delayed++) { struct timespec delay = {3, 300000000}; nanosleep(&delay, NULL); }
    return native_sweep(sig);
  }`);
  const started = Date.now();
  const result = runPTY(process.execPath, ['-e', 'console.log(process.stdin.isTTY);process.exitCode=7'], { ownerSource });
  assert.equal(result.status, 7, result.stdout + result.stderr);
  assert.match(result.stdout, /true/);
  assert.ok(Date.now() - started >= 3300, 'the real native cleanup crossed the former limit');
});
test('PTY cleanup refusal still returns unconfirmed status with a loaded allowance', { skip: PTY_SKIP_REASON }, t => {
  const ownerSource = instrumentCleanup(t, 'static int sweep(int sig) { (void)sig; return -1; }');
  const result = runPTY(process.execPath, ['-e', 'process.exitCode=0'], { ownerSource });
  assert.equal(result.status, 125, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /PTY session cleanup unconfirmed/);
});
test('PTY command timeout clears its separate group, including SIGHUP handlers with blocked loops', { skip: PTY_SKIP_REASON }, async t => {
  const f = fixture(t), start = Date.now();
  const result = runPTY(process.execPath, [f.program], { timeout: 1500 });
  assert.ok(result.error?.code === 'ETIMEDOUT' || result.status === 124, result.stdout + result.stderr);
  const receipt = readReceipt(f);
  await waitForCleanup(f.root, receipt);
  assert.ok(Date.now() - start < loadTimeout(8000), 'command and descendant cleanup have an independent bound');
});
for (const kind of ['normal exit', 'SIGTERM', 'SIGKILL', 'SIGKILL shell job', 'suite deadline']) {
  test(`${kind} of the outer suite clears the independently owned PTY session`, { skip: PTY_SKIP_REASON }, async t => {
    const f = fixture(t, { block: kind !== 'normal exit' }), file = path.join(f.root, 'culprit.test.mjs');
    // The success case exits its main command while leaving a blocked background
    // descendant. The owner must audit/clean before reporting ordinary success.
    const shellJob = kind === 'SIGKILL shell job';
    const binary = shellJob ? '/bin/sh' : process.execPath;
    const args = shellJob ? ['-ic', 'set -m; "$1" "$2" </dev/tty & wait', 'pty-job', process.execPath, f.program] : [f.program];
    fs.writeFileSync(file, `import test from ${JSON.stringify(boundedTest)};
import {runPTY} from ${JSON.stringify(ptyHelper)};
import assert from 'node:assert/strict';
test('blocked PTY culprit',()=>{const result=runPTY(${JSON.stringify(binary)},${JSON.stringify(args)},{timeout:5000});assert.equal(result.status,0,result.stdout+result.stderr);});`);
    const outer = spawnChild(t, process.execPath, [runner, '--fixed-deadlines', ...(kind === 'suite deadline' ? ['--suite-timeout=3000'] : []), file]);
    const sentinel = spawnChild(t, process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    await waitForFile(f.receipt, text => text.length > 0);
    const receipt = readReceipt(f);
    if (kind !== 'normal exit') {
      const snapshot = createProcessTracker().snapshot(); assert.ok(snapshot.ok, snapshot.error);
      assert.equal(snapshot.value.get(receipt.pid)?.pgid, receipt.pgid);
      assert.equal(snapshot.value.get(receipt.leaf)?.pgid, receipt.pgid);
      assert.equal(snapshot.value.get(receipt.session)?.pgid, receipt.session, 'owner remains the separate session leader');
      if (shellJob) assert.notEqual(receipt.pgid, receipt.session, 'interactive shell creates a separate job group inside the owned session');
    }
    if (kind === 'SIGTERM' || kind.startsWith('SIGKILL')) outer.kill(kind === 'SIGTERM' ? 'SIGTERM' : 'SIGKILL');
    const result = await waitForExit(outer);
    if (kind === 'normal exit') assert.equal(result.code, 0, result.stdout + result.stderr);
    if (kind === 'suite deadline') {
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /Test suite exceeded 3000ms/);
      assert.ok(result.stderr.includes(file), 'timeout names the culprit');
    }
    await waitForCleanup(f.root, receipt);
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0), 'PTY cleanup preserves an unrelated child');
    sentinel.kill('SIGKILL'); await waitForExit(sentinel);
  });
}
