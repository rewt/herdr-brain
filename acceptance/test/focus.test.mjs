import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnChild, waitForExit, killChild } from '../../test/helpers/child.mjs';
import { startFocusMonitor, assertFocus } from '../focus.mjs';
import { HarnessLimit } from '../limits.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';

function readRows(file) {
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, 'utf8');
  // The monitor may be appending its next row while the parent reads.
  return content.slice(0, content.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse);
}

async function waitFor(check, description) {
  const deadline = Date.now() + loadTimeout(3000);
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture(t, { panes = [], workspaces = [], startupPanes = [], replayEvents = 0, replayIntervalMs = 0, continuousFocusMs = 0, serverVersion = '0.8.2' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-focus-'));
  const socketPath = path.join(root, 'server.sock');
  const serverFile = path.join(root, 'server.mjs');
  const changePath = path.join(root, 'change');
  const readsPath = path.join(root, 'pane-reads.jsonl');
  const tracePath = path.join(root, 'focus-trace.jsonl');
  fs.writeFileSync(serverFile, `import net from 'node:net';import fs from 'node:fs';
const subscriptions=new Set();let pane='operator:p7';
const workspace=id=>id==='unlisted:p3'?'scratch':id.split(':')[0];
const event=(id,includeWorkspace=true)=>({event:'pane_focused',data:{type:'pane_focused',pane_id:id,...(includeWorkspace?{workspace_id:workspace(id)}:{})}});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const writes=new WeakMap();
function send(socket,message){
  const pending=(writes.get(socket)||Promise.resolve()).then(()=>{
    if(socket.destroyed)return false;
    if(socket.write(JSON.stringify(message)+'\\n'))return true;
    return new Promise(resolve=>{
      const done=()=>{socket.off('drain',done);socket.off('close',done);resolve(!socket.destroyed);};
      socket.once('drain',done);socket.once('close',done);
    });
  });
  writes.set(socket,pending);return pending;
}
async function stream(socket){
  for(const id of ${JSON.stringify(startupPanes)}){await pause(100);if(!await send(socket,event(id)))return;}
  // Replay is finite; subsequent live traffic is paced after each write drains.
  for(let i=0;i<${replayEvents};i++){
    if(${replayIntervalMs})await pause(${replayIntervalMs});
    pane=i%2?'operator:p7':'external:p1';
    if(!await send(socket,event(pane)))return;
  }
  while(${continuousFocusMs}&&!socket.destroyed){
    await pause(${continuousFocusMs || 100});
    if(socket.destroyed)return;
    pane=pane==='operator:p7'?'external:p1':'operator:p7';
    if(!await send(socket,event(pane)))return;
  }
}
const server=net.createServer(socket=>{let buffer='';socket.setEncoding('utf8');socket.on('error',()=>{});
socket.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\\n')){const i=buffer.indexOf('\\n'),r=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);
if(r.method==='events.subscribe'){if(JSON.stringify(r.params.subscriptions)!==JSON.stringify([{type:'pane.focused'}]))throw Error('invalid native subscription shape');subscriptions.add(socket);void send(socket,{id:r.id,result:{type:'subscription_started'}}).then(()=>stream(socket));}
else if(r.method==='ping')void send(socket,{id:r.id,result:{type:'pong',version:${JSON.stringify(serverVersion)},protocol:20}});
else if(r.method==='pane.current'){if(JSON.stringify(r.params)!=='{}')throw Error('sampler must read global focus without caller context');void send(socket,{id:r.id,result:{type:'pane_current',pane:{pane_id:pane,workspace_id:workspace(pane),focused:true}}});}
else if(r.method==='pane.get'){
  fs.appendFileSync(${JSON.stringify(readsPath)},JSON.stringify({pane:r.params.pane_id})+'\\n');
  void send(socket,{id:r.id,result:{pane:{pane_id:r.params.pane_id,workspace_id:workspace(r.params.pane_id)}}});
}
else void send(socket,{id:r.id,error:{code:'forbidden',message:'monitor attempted a mutation'}});}});
socket.on('close',()=>subscriptions.delete(socket));});
server.listen(${JSON.stringify(socketPath)},()=>console.log('ready'));
let consuming=false;
setInterval(async()=>{const file=${JSON.stringify(changePath)};if(consuming||!fs.existsSync(file))return;consuming=true;
const change=JSON.parse(fs.readFileSync(file,'utf8'));
for(const next of change.panes){pane=next;if(change.events)await Promise.all([...subscriptions].map(socket=>send(socket,event(pane,change.includeWorkspace))));}
fs.renameSync(file,${JSON.stringify(changePath)}+'.'+change.id+'.consumed');consuming=false;},10);
`);
  let monitor, server;
  t.after(async () => {
    if (monitor) await monitor.stop().catch(() => {});
    if (server) { killChild(server); await waitForExit(server); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  server = spawnChild(t, process.execPath, [serverFile]);
  await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); });
  const ownership = path.join(root, 'ownership.json');
  fs.writeFileSync(ownership, JSON.stringify({ panes, workspaces }));
  monitor = await startFocusMonitor({ socketPath, evidence: root, ownership, intervalMs: 25 });
  let sequence = 0, pending = false;
  const change = (panes, events = true, { includeWorkspace = true } = {}) => {
    assert.equal(pending, false, 'observe the previous command before publishing another');
    assert.equal(fs.existsSync(changePath), false, 'the previous command must be consumed');
    if (!events) assert.equal(panes.length, 1, 'a silent command needs a stable sample destination');
    const id = ++sequence, start = readRows(tracePath).length, readsStart = readRows(readsPath).length;
    const temporary = `${changePath}.${id}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ id, panes, events, includeWorkspace }), { flag: 'wx' });
    fs.renameSync(temporary, changePath);
    pending = true;
    const consumed = () => waitFor(() => fs.existsSync(`${changePath}.${id}.consumed`), `command ${id} consumption`);
    return {
      async observed() {
        await consumed();
        await waitFor(() => {
          const rows = readRows(tracePath).slice(start);
          if (!events) return rows.some(row => row.type === 'sample' && row.panes[0] === panes[0]);
          let next = 0;
          for (const row of rows) if (row.type === 'event' && row.panes[0] === panes[next]) next++;
          return next === panes.length;
        }, `monitor observations for command ${id}: ${panes.join(', ')}`);
        pending = false;
      },
      async queried(pane) {
        await consumed();
        // A creation event cannot finish classification until its later result
        // receipt. This read-only lookup proves the monitor captured the event.
        await waitFor(() => readRows(readsPath).slice(readsStart).some(row => row.pane === pane), `monitor lookup of ${pane}`);
      },
    };
  };
  return { root, monitor, ownership, change };
}

test('focus sampling continues while the acceptance parent blocks and spans cleanup', async (t) => {
  const { root, monitor } = await fixture(t);
  fs.writeFileSync(path.join(root, 'focus-phase.json'), JSON.stringify({ key: 'scope-cleanup' }));
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200)']);
  const summary = await monitor.stop();
  assert.equal(summary.baseline, 'operator:p7');
  assert.ok(summary.samples >= 5, `${summary.samples} samples during blocked parent`);
  assert.equal(summary.changes.length, 0);
  assert.match(assertFocus(summary), /zero harness focus changes/);
  const rows = fs.readFileSync(path.join(root, 'focus-trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some((row) => row.phase?.key === 'scope-cleanup'));
  assert.equal(rows.at(-1).phase.key, 'scope-cleanup');
});

test('native pane_focused events catch a transient change between unchanged samples and name both calls', async (t) => {
  const { root, monitor, change } = await fixture(t);
  fs.writeFileSync(path.join(root, 'focus-phase.json'), JSON.stringify({ key: 'configured-cycle' }));
  fs.writeFileSync(path.join(root, 'focus-calls.jsonl'), JSON.stringify({ type: 'start', id: 'call-1', at: Date.now(),
    args: ['pane', 'run', 'scratch:p2', 'worker'], requested: ['agent', 'start', 'worker', '--pane', 'scratch:p2'] }) + '\n');
  const changed = change(['scratch:p2', 'operator:p7']);
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']);
  await changed.observed();
  const summary = await monitor.stop();
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.externalChanges.length, 0);
  assert.equal(summary.baseline, 'operator:p7');
  assert.equal(summary.currentBaseline, 'operator:p7');
  const rows = fs.readFileSync(path.join(root, 'focus-trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.filter((row) => row.type === 'sample').every((row) => row.panes.length === 1 && row.panes[0] === 'operator:p7'));
  assert.equal(summary.events, 2);
  assert.equal(summary.changes.length, 1);
  assert.equal(summary.changes[0].type, 'event');
  assert.throws(() => assertFocus(summary), /configured-cycle; pane run scratch:p2 worker \(requested agent start worker/);
  assert.equal(summary.changes[0].panes[0], 'scratch:p2');
});

test('native startup replay settles before the baseline and subsequent transient owned moves still fail', async (t) => {
  const { root, monitor, change } = await fixture(t, { workspaces: ['scratch'], startupPanes: ['scratch:p1', 'operator:p7'] });
  const changed = change(['scratch:p2', 'operator:p7']);
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']);
  await changed.observed();
  const summary = await monitor.stop();
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.baseline, 'operator:p7');
  assert.equal(summary.externalChanges.length, 0);
  assert.equal(summary.startupEvents.length, 2);
  assert.equal(summary.startupDrain.reason, 'quiet');
  assert.ok(summary.monitoringStartedAt - summary.startupEvents.at(-1).at >= 400);
  assert.equal(summary.events, 2);
  assert.equal(summary.changes.length, 1);
  assert.deepEqual(summary.changes[0].workspaces, ['scratch']);
  const rows = fs.readFileSync(path.join(root, 'focus-trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.slice(0, 2), summary.startupEvents);
  assert.ok(rows.filter((row) => row.type === 'sample').every((row) => row.panes[0] === 'operator:p7'));
  assert.throws(() => assertFocus(summary), /harness-owned destination \(scratch\)/);
});

test('continuous operator focus starts without silence and an immediate transient harness move still fails', async (t) => {
  // A 512-event replay at 12ms spans more than five seconds without silence.
  // Live traffic continues every 100ms through readiness and the owned move.
  const { root, monitor, change } = await fixture(t, {
    workspaces: ['scratch'], replayEvents: 512, replayIntervalMs: 12, continuousFocusMs: 100,
  });
  fs.writeFileSync(path.join(root, 'focus-calls.jsonl'), JSON.stringify({ type: 'start', id: 'busy-call', at: Date.now(),
    args: ['pane', 'run', 'scratch:p2', 'worker'], requested: ['agent', 'start', 'worker', '--pane', 'scratch:p2'] }) + '\n');
  const changed = change(['scratch:p2', 'operator:p7']);
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150)']);
  await changed.observed();
  await waitFor(() => readRows(path.join(root, 'focus-trace.jsonl')).some(row =>
    row.type === 'event' && row.classification === 'external'), 'live operator activity after the immediate owned move');
  const summary = await monitor.stop();
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.startupDrain.reason, 'replay-bound');
  assert.equal(summary.startupDrain.server.version, '0.8.2');
  assert.ok(summary.startupDrain.elapsedMs > 5000);
  assert.ok(summary.startupEvents.length >= 512);
  assert.ok(summary.events > 2);
  assert.ok(summary.externalChanges.length > 0);
  assert.equal(summary.changes.length, 1);
  assert.equal(summary.changes[0].type, 'event');
  assert.ok(summary.changes[0].at >= summary.monitoringStartedAt);
  assert.equal(summary.changes[0].calls[0].id, 'busy-call');
  assert.throws(() => assertFocus(summary), /pane run scratch:p2 worker/);
});

test('continuous operator activity alone passes after bounded replay', async (t) => {
  const { root, monitor } = await fixture(t, { replayEvents: 512, continuousFocusMs: 100 });
  await waitFor(() => readRows(path.join(root, 'focus-trace.jsonl')).some(row =>
    row.type === 'event' && row.classification === 'external'), 'live operator activity after replay');
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']);
  const summary = await monitor.stop();
  assert.equal(summary.startupDrain.reason, 'replay-bound');
  assert.ok(summary.startupEvents.length >= 512);
  assert.ok(summary.externalChanges.length > 0);
  assert.match(assertFocus(summary), /zero harness focus changes/);
});

test('a busy stream from an unknown server never assumes the verified replay bound', async (t) => {
  await assert.rejects(fixture(t, { replayEvents: 512, continuousFocusMs: 100, serverVersion: '0.9.0' }),
    error => error instanceof HarnessLimit && /replay bound unavailable for Herdr 0.9.0/.test(error.message));
});

test('owned changes need no correlated call and incomplete monitoring never passes', () => {
  const summary = { baseline: 'operator:p7', samples: 20, errors: [], changes: [{ at: 1, panes: ['scratch:p1'], workspaces: ['scratch'], calls: [] }] };
  assert.throws(() => assertFocus(summary), /harness-owned destination \(scratch\)/);
  summary.errors = ['subscription disconnected'];
  assert.throws(() => assertFocus(summary), /operator focus changed/);
  summary.changes = [];
  assert.throws(() => assertFocus(summary), HarnessLimit);
  assert.throws(() => assertFocus({ ...summary, errors: [], samples: 1 }), HarnessLimit);
});

test('external sampled and transient event moves are recorded and re-baseline without failing', async (t) => {
  const { root, monitor, change } = await fixture(t);
  const sampled = change(['external:p1'], false);
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']);
  await sampled.observed();
  const transient = change(['external:p2', 'external:p1']);
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']);
  await transient.observed();
  const summary = await monitor.stop();
  assert.equal(summary.baseline, 'operator:p7');
  assert.equal(summary.currentBaseline, 'external:p1');
  assert.equal(summary.changes.length, 0);
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.externalChanges.length, 3);
  assert.deepEqual(summary.externalChanges.map((r) => r.from), ['operator:p7', 'external:p1', 'external:p2']);
  assert.ok(summary.externalChanges.every((r) => r.classification === 'external' && r.rebaseline === r.panes[0]));
  assert.match(assertFocus(summary), /zero harness focus changes; 3 external changes recorded/);
  const rows = fs.readFileSync(path.join(root, 'focus-trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter((r) => r.classification === 'external').length, 3);
});

test('an unlisted owned pane retains a warning during operator activity, even through cleanup', async (t) => {
  const { root, monitor, change, ownership } = await fixture(t, { workspaces: ['scratch'] });
  const external = change(['external:p1']);
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']);
  await external.observed();
  // Cleanup removes the ledger. The lifetime creation receipts still count.
  fs.unlinkSync(ownership);
  const unlisted = change(['unlisted:p3', 'external:p1']);
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']);
  await unlisted.observed();
  const summary = await monitor.stop();
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.externalChanges.length, 2);
  assert.equal(summary.changes.length, 0);
  const warning = summary.notAttributableChanges[0];
  assert.equal(warning.from, 'external:p1');
  assert.equal(warning.owned, true);
  assert.deepEqual(warning.workspaces, ['scratch']);
  assert.equal(warning.calls.length, 0);
  assert.deepEqual(warning.operatorActivity.from, 'operator:p7');
  assert.match(assertFocus(summary), /WARNING: 1 NOT-ATTRIBUTABLE/);
  const rows = fs.readFileSync(path.join(root, 'focus-trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.filter(row => row.classification === 'not-attributable'), [warning]);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'focus-summary.json')));
  assert.deepEqual(saved.notAttributableChanges, [warning]);
});

test('a delayed product focus move to a sibling owned pane still fails during observed operator activity', async t => {
  const { root, monitor, change } = await fixture(t, { workspaces: ['scratch'] });
  const external = change(['external:p1']);
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']);
  await external.observed();
  const at = Date.now() - 3000;
  fs.writeFileSync(path.join(root, 'focus-calls.jsonl'), [
    { type: 'start', id: 'delayed-send', at: at - 100, origin: 'product',
      args: ['pane', 'send-keys', 'scratch:p2', 'Enter'], requested: ['agent', 'prompt', 'worker', 'continue'] },
    { type: 'end', id: 'delayed-send', at },
  ].map(JSON.stringify).join('\n') + '\n');
  const owned = change(['scratch:p3', 'external:p1']);
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']);
  await owned.observed();
  const summary = await monitor.stop();
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.changes.length, 1);
  assert.equal(summary.notAttributableChanges.length, 0);
  assert.equal(summary.changes[0].classification, 'harness');
  assert.deepEqual(summary.changes[0].panes, ['scratch:p3']);
  assert.equal(summary.changes[0].calls[0].id, 'delayed-send');
  assert.throws(() => assertFocus(summary), /pane send-keys scratch:p2 Enter/);
});

test('external moves during unrelated active and completed calls re-baseline without failing', async (t) => {
  const { root, monitor, change } = await fixture(t);
  const external = change(['external:p1']);
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']);
  await external.observed();
  fs.writeFileSync(path.join(root, 'focus-calls.jsonl'), JSON.stringify({ type: 'start', id: 'call', at: Date.now(),
    args: ['workspace', 'close', 'scratch'], requested: ['workspace', 'close', 'scratch'] }) + '\n');
  const active = change(['foreign:p9']);
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']);
  await active.observed();
  fs.appendFileSync(path.join(root, 'focus-calls.jsonl'), JSON.stringify({ type: 'end', id: 'call', at: Date.now() }) + '\n');
  const completed = change(['external:p1']);
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']);
  await completed.observed();
  const summary = await monitor.stop();
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.externalChanges.length, 3);
  assert.equal(summary.changes.length, 0);
  assert.equal(summary.currentBaseline, 'external:p1');
  assert.ok(summary.externalChanges.every((row) => row.calls.length === 0));
  assert.equal(summary.externalChanges[1].nearbyCalls[0].args[2], 'scratch');
  assert.equal(summary.externalChanges[2].nearbyCalls[0].completedAt > 0, true);
  assert.match(assertFocus(summary), /zero harness focus changes; 3 external changes recorded/);
});

test('a move to the pane targeted by a concurrent call fails after an external re-baseline', async (t) => {
  const { root, monitor, change } = await fixture(t);
  const external = change(['external:p1']);
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']);
  await external.observed();
  fs.writeFileSync(path.join(root, 'focus-calls.jsonl'), JSON.stringify({ type: 'start', id: 'call', at: Date.now(),
    args: ['pane', 'run', 'foreign:p9', 'worker'], requested: ['agent', 'start', 'worker', '--pane', 'foreign:p9'] }) + '\n');
  const targeted = change(['foreign:p9', 'external:p1']);
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']);
  await targeted.observed();
  const summary = await monitor.stop();
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.externalChanges.length, 1);
  assert.equal(summary.changes.length, 1);
  assert.equal(summary.changes[0].owned, false);
  assert.throws(() => assertFocus(summary), /from external:p1 to foreign:p9.*pane run foreign:p9 worker \(requested agent start worker/);
});

test('workspace destinations correlate only with their matching call despite a newer unrelated completion', async (t) => {
  const { root, monitor, change } = await fixture(t);
  const calls = path.join(root, 'focus-calls.jsonl');
  const at = Date.now() - 10;
  const call = { type: 'start', id: 'workspace-call', at,
    args: ['worktree', 'open', '--workspace', 'foreign', '--path', '/scratch/lane'],
    requested: ['worktree', 'open', '--workspace', 'foreign', '--path', '/scratch/lane'] };
  fs.writeFileSync(calls, JSON.stringify(call) + '\n');
  fs.appendFileSync(calls, JSON.stringify({ type: 'end', id: call.id, at: at + 1 }) + '\n');
  fs.appendFileSync(calls, JSON.stringify({ ...call, id: 'unrelated', at: at + 2,
    args: ['workspace', 'close', 'scratch'], requested: ['workspace', 'close', 'scratch'] }) + '\n');
  fs.appendFileSync(calls, JSON.stringify({ type: 'end', id: 'unrelated', at: at + 3 }) + '\n');
  const changed = change(['foreign:p9', 'operator:p7']);
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']);
  await changed.observed();
  const summary = await monitor.stop();
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.changes.length, 1);
  assert.equal(summary.changes[0].owned, false);
  assert.equal(summary.changes[0].calls[0].id, call.id);
  assert.throws(() => assertFocus(summary), /worktree open --workspace foreign/);
});

test('a resolved agent target receipt correlates a named call without guessing pane IDs', async (t) => {
  const { root, monitor, change } = await fixture(t);
  fs.writeFileSync(path.join(root, 'focus-calls.jsonl'), JSON.stringify({ type: 'start', id: 'named-agent', at: Date.now(),
    args: ['agent', 'send-keys', 'worker', 'Enter'], requested: ['agent', 'send-keys', 'worker', 'Enter'],
    targets: { panes: ['foreign:p9'], workspaces: [] } }) + '\n');
  const changed = change(['foreign:p9', 'operator:p7']);
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']);
  await changed.observed();
  const summary = await monitor.stop();
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.changes.length, 1);
  assert.equal(summary.changes[0].owned, false);
  assert.throws(() => assertFocus(summary), /agent send-keys worker Enter/);
});

test('a creation receipt attributes a transient move before ownership is registered', async (t) => {
  const { root, monitor, change } = await fixture(t);
  const calls = path.join(root, 'focus-calls.jsonl');
  const call = { type: 'start', id: 'creation', at: Date.now(),
    args: ['workspace', 'create', '--cwd', '/scratch/project', '--no-focus'],
    requested: ['workspace', 'create', '--cwd', '/scratch/project'] };
  fs.writeFileSync(calls, JSON.stringify(call) + '\n');
  // Omit the optional workspace so the monitor's native pane.get proves it
  // observed this event before we publish the creation result.
  const changed = change(['unlisted:p3', 'operator:p7'], true, { includeWorkspace: false });
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']);
  await changed.queried('unlisted:p3');
  assert.equal(readRows(path.join(root, 'focus-trace.jsonl')).some(row => row.type === 'event'), false,
    'classification must still be waiting for the creation receipt');
  fs.appendFileSync(calls, JSON.stringify({ type: 'end', id: call.id, at: Date.now(), created: { panes: [], workspaces: ['scratch'] } }) + '\n');
  await changed.observed();
  const summary = await monitor.stop();
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.changes.length, 1);
  assert.equal(summary.changes[0].owned, true);
  assert.equal(summary.changes[0].calls[0].id, call.id);
  assert.throws(() => assertFocus(summary), /workspace create --cwd.*requested workspace create/);
});

test('a focus event after a slow completed call names that call using its completion time', async (t) => {
  const { root, monitor, change } = await fixture(t);
  const calls = path.join(root, 'focus-calls.jsonl');
  const call = { type: 'start', id: 'slow-call', at: Date.now(),
    args: ['pane', 'run', 'scratch:p2', 'worker'], requested: ['agent', 'start', 'worker', '--pane', 'scratch:p2'] };
  fs.writeFileSync(calls, JSON.stringify(call) + '\n');
  // A later-started overlapping call finishes first. Attribution must follow
  // the most recent completion, rather than the most recent start.
  fs.appendFileSync(calls, JSON.stringify({ ...call, id: 'quick-call', at: Date.now(), args: ['tab', 'create'], requested: ['tab', 'create'] }) + '\n');
  fs.appendFileSync(calls, JSON.stringify({ type: 'end', id: 'quick-call', at: Date.now() }) + '\n');
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1100)']);
  const completedAt = Date.now();
  fs.appendFileSync(calls, JSON.stringify({ type: 'end', id: call.id, at: completedAt }) + '\n');
  const changed = change(['scratch:p2', 'operator:p7']);
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']);
  await changed.observed();
  const summary = await monitor.stop();
  assert.ok(completedAt - call.at > 1000);
  assert.equal(summary.changes[0].calls[0].id, call.id);
  assert.equal(summary.changes[0].calls[0].completedAt, completedAt);
  assert.throws(() => assertFocus(summary), /pane run scratch:p2 worker \(requested agent start worker/);
});

test('an unreachable read-only focus socket is an explicit harness limitation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-focus-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(startFocusMonitor({ socketPath: path.join(root, 'absent.sock'), evidence: root }), HarnessLimit);
});

test('the monitor retains forbidden attempts even when every sample remains unchanged', async (t) => {
  const { root, monitor } = await fixture(t);
  const receipt = { type: 'forbidden-focus', at: Date.now(), requested: ['worktree', 'remove', '--workspace', 'scratch'], error: 'changes focus' };
  fs.writeFileSync(path.join(root, 'focus-calls.jsonl'), JSON.stringify(receipt) + '\n');
  const summary = await monitor.stop();
  assert.equal(summary.changes.length, 0);
  assert.equal(summary.errors.length, 0);
  assert.deepEqual(summary.forbiddenAttempts, [receipt]);
  assert.throws(() => assertFocus(summary), /forbidden focus attempt.*worktree remove/);
});

test('unattributed owned focus failures retain the previous operator pane and nearest harness and product calls', async t => {
  const { root, monitor, change } = await fixture(t, { panes: ['scratch:p2'], workspaces: ['scratch'] });
  const at = Date.now() - 5000;
  const calls = [
    { type: 'start', id: 'harness', at, origin: 'harness', args: ['tab', 'create', '--workspace', 'other'], requested: ['tab', 'create', '--workspace', 'other'] },
    { type: 'end', id: 'harness', at: at + 10 },
    { type: 'start', id: 'product', at: at + 20, origin: 'product', args: ['tab', 'close', 'other:t1'], requested: ['tab', 'close', 'other:t1'] },
    { type: 'end', id: 'product', at: at + 30 },
  ];
  fs.writeFileSync(path.join(root, 'focus-calls.jsonl'), calls.map(JSON.stringify).join('\n') + '\n');
  const changed = change(['scratch:p2', 'operator:p7']);
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']);
  await changed.observed();
  const summary = await monitor.stop(), first = summary.changes[0];
  assert.deepEqual(first.calls, [], 'nearest diagnostics must not create correlation');
  assert.equal(first.previousPane, 'operator:p7'); assert.equal(first.previousOwnership, 'operator');
  assert.equal(first.nearestCalls.harness.id, 'harness'); assert.equal(first.nearestCalls.product.id, 'product');
  assert.throws(() => assertFocus(summary), /previous pane operator:p7 \(operator-owned\).*nearest harness: tab create.*nearest product: tab close/);
});
