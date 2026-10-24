import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnScenarioChild, spawnChild, waitForExit } from './helpers/child.mjs';
import { createProcessTracker } from './helpers/processes.mjs';
import { loadTimeout } from '../lib/deadline.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const local = file => fileURLToPath(new URL(file, import.meta.url));
const tracker = createProcessTracker();
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(fn, message) {
  const end = Date.now() + loadTimeout(10000);
  while (!fn()) { assert.ok(Date.now() < end, typeof message === 'function' ? message() : message); await pause(); }
}
const snapshot = () => {
  const result = tracker.snapshot();
  assert.ok(result.ok, result.error);
  return result.value;
};
const alive = entries => {
  const current = snapshot();
  return entries.filter(entry => {
    const row = current.get(entry.pid);
    return row && !/^Z/.test(row.state) && row.identity === entry.identity && row.command === entry.command;
  });
};

test('a stale PID-named FIFO in the shared offline root does not block a new lifetime owner', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-lifetime-pid-reuse-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = `import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import {spawnSync} from 'node:child_process';
import {ownFixtureLifetime} from ${JSON.stringify(local('./helpers/fixture-lifetime.mjs'))};
const root=process.env.HERDR_TEST_OFFLINE_ROOT;
const stale=path.join(root,'lifetime-'+process.pid,'alive');
fs.mkdirSync(path.dirname(stale));
const made=spawnSync('/usr/bin/mkfifo',[stale],{encoding:'utf8'});
assert.equal(made.status,0,made.stderr);
const before=fs.statSync(stale);
ownFixtureLifetime();
const fifo=process.env.HERDR_FIXTURE_LIFETIME_FIFO;
assert.notEqual(fifo,stale);
assert.equal(path.dirname(path.dirname(fifo)),fs.realpathSync(root));
assert.ok(fs.statSync(fifo).isFIFO());
assert.ok(fs.statSync(stale).isFIFO());
assert.equal(fs.statSync(stale).ino,before.ino,'stale evidence must not be replaced');
const keys=['HERDR_FIXTURE_LIFETIME_EXECUTABLE','HERDR_FIXTURE_LIFETIME_FIFO','HERDR_FIXTURE_LIFETIME_SECONDS'];
const expected=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
ownFixtureLifetime();
assert.equal(process.env.HERDR_FIXTURE_LIFETIME_FIFO,fifo,'ownership stays idempotent in one process');
const child=spawnSync(process.execPath,['-e','console.log(JSON.stringify(Object.fromEntries('+JSON.stringify(keys)+'.map(key=>[key,process.env[key]]))))'],{env:{PATH:process.env.PATH},encoding:'utf8'});
assert.equal(child.status,0,child.stderr);
assert.deepEqual(JSON.parse(child.stdout),expected,'minimal-env children inherit the new owner contract');`;
  const child = spawnChild(t, process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, HERDR_TEST_OFFLINE_ROOT: fs.realpathSync(root) } });
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stderr);
});

test('concurrent lifetime owners reuse one source-digest cached guard and keep separate writers', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-lifetime-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = `import fs from 'node:fs';
import {ownFixtureLifetime} from ${JSON.stringify(local('./helpers/fixture-lifetime.mjs'))};
ownFixtureLifetime();
const executable=process.env.HERDR_FIXTURE_LIFETIME_EXECUTABLE;
const stat=fs.statSync(executable,{bigint:true});
console.log(JSON.stringify({executable,fifo:process.env.HERDR_FIXTURE_LIFETIME_FIFO,ino:String(stat.ino),mtime:String(stat.mtimeNs)}));`;
  const run = async () => {
    const child = spawnChild(t, process.execPath, ['--input-type=module', '-e', script],
      { env: { ...process.env, HERDR_TEST_OFFLINE_ROOT: root } });
    const result = await waitForExit(child);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const owners = await Promise.all([run(), run(), run()]);
  owners.push(await run());
  const digest = createHash('sha256').update(fs.readFileSync(local('./helpers/fixture-lifetime.c'))).digest('hex');
  const cache = path.join(root, 'fixture-lifetime-cache');
  for (const owner of owners) {
    assert.equal(owner.executable, path.join(cache, digest));
    assert.equal(owner.ino, owners[0].ino, 'cache was replaced by another compilation');
    assert.equal(owner.mtime, owners[0].mtime, 'cache was rebuilt');
  }
  assert.equal(new Set(owners.map(owner => owner.fifo)).size, owners.length);
  assert.deepEqual(fs.readdirSync(cache), [digest], 'only the published binary remains');
});

test('watch guard whose spawning parent exits immediately never adopts or signals the reaper', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-lifetime-reparent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'reparent.c'), executable = path.join(root, 'reparent');
  const receipt = path.join(root, 'result'), fifo = path.join(root, 'alive');
  // Delay entry until the spawning parent is gone. Intercept kill in the real
  // guard source so a regression records the attempt and never signals a reaper.
  fs.writeFileSync(source, `#include <stdio.h>
#include <signal.h>
#include <stdlib.h>
#include <unistd.h>
static const char *receipt;
static int capture_signal(pid_t pid, int signal) {
  FILE *file = fopen(receipt, "w");
  if (!file) _exit(126);
  fprintf(file, "signal %ld %d", (long)pid, signal);
  fclose(file);
  return 0;
}
#define kill capture_signal
#define main lifetime_main
#include ${JSON.stringify(local('./helpers/fixture-lifetime.c'))}
#undef main
#undef kill
int main(int argc, char **argv) {
  if (argc != 6) return 125;
  receipt = argv[5];
  pid_t owner = (pid_t)atoi(argv[4]);
  for (int i = 0; getppid() == owner; i++) {
    if (i == 10000) return 124;
    usleep(1000);
  }
  int result = lifetime_main(argc, argv);
  FILE *file = fopen(receipt, "w");
  if (!file) return 126;
  fprintf(file, "exit %d", result);
  fclose(file);
  return result;
}`);
  const built = spawnSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-o', executable, source]);
  assert.equal(built.status, 0, built.stderr?.toString());
  assert.equal(spawnSync('/usr/bin/mkfifo', [fifo]).status, 0);
  // No FIFO writer remains: the old implementation would signal the adopted
  // owner as soon as it entered guard(), which the interceptor records safely.
  const parent = spawnChild(t, process.execPath, ['-e', `
require('child_process').spawn(${JSON.stringify(executable)},
  ['--watch',${JSON.stringify(fifo)},'1',String(process.pid),${JSON.stringify(receipt)}],
  {stdio:'ignore'}).unref();`]);
  const result = await waitForExit(parent);
  assert.equal(result.code, 0, result.stderr);
  await until(() => fs.existsSync(receipt) && fs.readFileSync(receipt, 'utf8').length,
    'reparented guard did not report its outcome');
  assert.equal(fs.readFileSync(receipt, 'utf8'), 'exit 0');
});

test('native lifetime guard observes EOF and its finite deadline with the caller still alive', async t => {
  for (const eof of [true, false]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-lifetime-native-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fifo = path.join(root, 'alive');
    assert.equal(spawnSync('/usr/bin/mkfifo', [fifo]).status, 0);
    const writer = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    let closed = false;
    t.after(() => { if (!closed) fs.closeSync(writer); });
    const child = spawnChild(t, process.env.HERDR_FIXTURE_LIFETIME_EXECUTABLE,
      ['--exec', fifo, eof ? '10' : '1', process.execPath, '-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)']);
    const started = Date.now();
    if (eof) { await new Promise(resolve => setTimeout(resolve, 100)); fs.closeSync(writer); closed = true; }
    assert.equal((await waitForExit(child)).signal, 'SIGKILL');
    if (eof) assert.ok(Date.now() - started < loadTimeout(3000), 'EOF must stop the child before its ten-second fallback');
  }
});

for (const cancellation of ['SIGKILL', 'SIGTERM']) {
  test(`${cancellation} of an enclosing suite leaves no settle inbox or gate-profile fixture`, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-lifetime-regression-')));
    const owned = [], scratchRoots = [];
    // Even the unfixed negative control can signal only birth identities this
    // reproducer captured while its own suite/fixture ancestry was still live.
    t.after(async () => {
      for (const entry of owned.toReversed()) assert.ok(tracker.killProcess(entry).ok);
      await until(() => !alive(owned).length, 'owned negative-control fixtures did not stop');
      for (const scratch of scratchRoots) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      fs.rmSync(root, { recursive: true, force: true });
    });
    const receipt = path.join(root, 'ready.json'), gateReady = path.join(root, 'gate.json');
    const file = path.join(root, 'victim.test.mjs');
    const preparation = `node -e 'require("fs").writeFileSync(${JSON.stringify(gateReady)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)'`;
    fs.writeFileSync(file, `import test from ${JSON.stringify(cancellation === 'SIGKILL' ? 'node:test' : local('./helpers/bounded-test.mjs'))};
import fs from 'node:fs';
import path from 'node:path';
import {fixture as settleFixture} from ${JSON.stringify(local('../settle/test/fixture.mjs'))};
import {fixture as gateFixture} from ${JSON.stringify(local('../test-slot/test/helpers/gate-profile.mjs'))};
import {resumeInbox} from ${JSON.stringify(local('../supervisor/prompt-supervisor.mjs'))};
import {waitForExit} from ${JSON.stringify(local('./helpers/child.mjs'))};
test('live fixture victim',async t=>{
  const settle=settleFixture(t), gate=gateFixture(t,{prepare:[{run:${JSON.stringify(preparation)}}]});
  const inbox=path.join(settle.org,'supervisor/inbox.log');fs.mkdirSync(path.dirname(inbox),{recursive:true});
  fs.writeFileSync(inbox,JSON.stringify({type:'notice',id:'lifetime',to:'offline',message:'pending',herdr:'/usr/bin/false',attempts:1,retrySeconds:0})+'\\n');
  const owner=await resumeInbox(inbox,{waitSeconds:1,pollSeconds:.02,confirmSeconds:.02});
  const nestedInbox=inbox+'.nested';fs.copyFileSync(inbox,nestedInbox);
  const launched=settle.exec(process.execPath,['--input-type=module','-e',
    'import {resumeInbox} from '+${JSON.stringify(JSON.stringify(local('../supervisor/prompt-supervisor.mjs')))}+';console.log(await resumeInbox('+JSON.stringify(nestedInbox)+',{waitSeconds:1,pollSeconds:.02,confirmSeconds:.02}));']);
  if(launched.status!==0)throw Error(launched.stderr);
  const nestedOwner=Number(launched.stdout.trim());
  const nestedMetadata=JSON.parse(fs.readFileSync(nestedInbox+'.owner.lock/owner.json'));
  const host=gate.asyncRun();
  while(!fs.existsSync(${JSON.stringify(gateReady)})){
    if(host.exitCode!==null||host.signalCode!==null)throw Error(JSON.stringify(await waitForExit(host)));
    await new Promise(r=>setTimeout(r,20));
  }
  const temporary=${JSON.stringify(receipt + '.tmp')};
  fs.writeFileSync(temporary,JSON.stringify({suite:process.pid,owner,nestedOwner,nestedMetadata,host:host.pid,leaf:JSON.parse(fs.readFileSync(${JSON.stringify(gateReady)})).pid,roots:[settle.root,gate.root]}));
  fs.renameSync(temporary,${JSON.stringify(receipt)});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
});`);
    // The outer lifetime patch restores its containment preload. The direct
    // node --test victim acquires its own writer when fixtureFleet runs.
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
    const args = cancellation === 'SIGKILL' ? ['--test', file] :
      [local('./helpers/run.mjs'), file];
    const child = spawnScenarioChild(t, process.execPath, args, { env });
    let finished;
    waitForExit(child).then(result => { finished = result; });
    await until(() => fs.existsSync(receipt) || finished, 'nested suite did not publish its live fixtures');
    assert.ok(fs.existsSync(receipt), finished?.stdout + finished?.stderr);
    const evidence = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    scratchRoots.push(...evidence.roots);
    const rows = snapshot();
    assert.equal(rows.get(evidence.nestedOwner)?.command, evidence.nestedMetadata.argv.join(' '));
    // resumeInbox acknowledged this exact owner before its launcher exited.
    // Its receipt and command establish ownership even after reparenting.
    const descendants = new Set([evidence.suite, evidence.nestedOwner]);
    let count;
    do {
      count = descendants.size;
      for (const row of rows.values()) if (descendants.has(row.ppid)) descendants.add(row.pid);
    } while (descendants.size !== count);
    for (const pid of descendants) {
      const row = rows.get(pid);
      if (row && !/^Z/.test(row.state)) owned.push({ pid, identity: row.identity, command: row.command, group: false });
    }
    assert.ok(rows.get(evidence.owner)?.command.includes('--owner-worker'));
    assert.ok(rows.get(evidence.host)?.command.includes('promote/host-gate.mjs'));
    assert.ok(rows.get(evidence.leaf)?.command.includes('setInterval'));
    assert.ok(descendants.has(evidence.owner) && descendants.has(evidence.host) && descendants.has(evidence.leaf));
    const sentinel = spawnChild(t, process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    if (cancellation === 'SIGKILL') {
      const suite = owned.find(entry => entry.pid === evidence.suite);
      assert.equal(tracker.killProcess(suite).signaled, true);
    }
    if (cancellation === 'SIGTERM') child.kill('SIGTERM');
    const result = await waitForExit(child);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    await until(() => !alive(owned).length, () => `fixtures survived ${cancellation}: ${JSON.stringify(alive(owned))}`);
    // Report-only root enumeration catches a late spawn after the receipt.
    assert.deepEqual([...snapshot().values()].filter(row => !/^Z/.test(row.state) &&
      evidence.roots.some(root => row.command.includes(root))), []);
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0), 'an unrelated fixture was signalled');
    sentinel.kill('SIGKILL'); await waitForExit(sentinel);
    for (const scratch of evidence.roots) fs.rmSync(scratch, { recursive: true, force: true });
  });
}
