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

for (const cancellation of ['SIGKILL', 'suite timeout']) {
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
    // No containment preload for the direct case: this exercises exactly the
    // node --test entry used by test:slot and previously leaking lane commands.
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
    const args = cancellation === 'SIGKILL' ? ['--test', file] :
      [local('./helpers/run.mjs'), '--fixed-deadlines', '--suite-timeout=8000', file];
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
    const result = await waitForExit(child);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    if (cancellation === 'suite timeout') assert.match(result.stderr, /Test suite exceeded 8000ms/);
    await until(() => !alive(owned).length, () => `fixtures survived ${cancellation}: ${JSON.stringify(alive(owned))}`);
    // Report-only root enumeration catches a late spawn after the receipt.
    assert.deepEqual([...snapshot().values()].filter(row => !/^Z/.test(row.state) &&
      evidence.roots.some(root => row.command.includes(root))), []);
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0), 'an unrelated fixture was signalled');
    sentinel.kill('SIGKILL'); await waitForExit(sentinel);
    for (const scratch of evidence.roots) fs.rmSync(scratch, { recursive: true, force: true });
  });
}
