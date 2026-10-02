import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnChild, waitForExit, killChild } from '../../test/helpers/child.mjs';
import { startFocusMonitor, assertFocus } from '../focus.mjs';
import { HarnessLimit } from '../limits.mjs';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-focus-'));
  const socketPath = path.join(root, 'server.sock');
  const serverFile = path.join(root, 'server.mjs');
  fs.writeFileSync(serverFile, `import net from 'node:net';import fs from 'node:fs';
const subscriptions=new Set();let pane='operator:p7';
const server=net.createServer(socket=>{let buffer='';socket.setEncoding('utf8');socket.on('error',()=>{});
socket.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\\n')){const i=buffer.indexOf('\\n'),r=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);
if(r.method==='events.subscribe'){if(JSON.stringify(r.params.subscriptions)!==JSON.stringify([{type:'pane.focused'}]))throw Error('invalid native subscription shape');subscriptions.add(socket);socket.write(JSON.stringify({id:r.id,result:{type:'subscription_started'}})+'\\n');}
else if(r.method==='pane.list')socket.write(JSON.stringify({id:r.id,result:{panes:[{pane_id:pane,focused:true}]}})+'\\n');
else socket.write(JSON.stringify({id:r.id,error:{code:'forbidden',message:'monitor attempted a mutation'}})+'\\n');}});
socket.on('close',()=>subscriptions.delete(socket));});
server.listen(${JSON.stringify(socketPath)},()=>console.log('ready'));
setInterval(()=>{const file=${JSON.stringify(path.join(root, 'change'))};if(!fs.existsSync(file))return;fs.unlinkSync(file);
for(const next of ['scratch:p2','operator:p7']){pane=next;for(const socket of subscriptions)socket.write(JSON.stringify({event:'pane.focused',data:{pane_id:pane}})+'\\n');}},10);
`);
  let monitor, server;
  t.after(async () => {
    if (monitor) await monitor.stop().catch(() => {});
    if (server) { killChild(server); await waitForExit(server); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  server = spawnChild(t, process.execPath, [serverFile]);
  await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); });
  monitor = await startFocusMonitor({ socketPath, evidence: root, intervalMs: 25 });
  return { root, monitor };
}

test('focus sampling continues while the acceptance parent blocks and spans cleanup', async (t) => {
  const { root, monitor } = await fixture(t);
  fs.writeFileSync(path.join(root, 'focus-phase.json'), JSON.stringify({ key: 'scope-cleanup' }));
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200)']);
  const summary = await monitor.stop();
  assert.equal(summary.baseline, 'operator:p7');
  assert.ok(summary.samples >= 5, `${summary.samples} samples during blocked parent`);
  assert.equal(summary.changes.length, 0);
  assert.match(assertFocus(summary), /zero focus changes/);
  const rows = fs.readFileSync(path.join(root, 'focus-trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some((row) => row.phase?.key === 'scope-cleanup'));
  assert.equal(rows.at(-1).phase.key, 'scope-cleanup');
});

test('a transient focus change fails even between samples and names the actual and requested calls', async (t) => {
  const { root, monitor } = await fixture(t);
  fs.writeFileSync(path.join(root, 'focus-phase.json'), JSON.stringify({ key: 'configured-cycle' }));
  fs.writeFileSync(path.join(root, 'focus-calls.jsonl'), JSON.stringify({ type: 'start', id: 'call-1', at: Date.now(),
    args: ['pane', 'run', 'scratch:p2', 'worker'], requested: ['agent', 'start', 'worker', '--pane', 'scratch:p2'] }) + '\n');
  fs.writeFileSync(path.join(root, 'change'), '');
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)']);
  const summary = await monitor.stop();
  assert.equal(summary.changes[0].type, 'event');
  assert.ok(summary.events >= 2);
  assert.throws(() => assertFocus(summary), /configured-cycle; pane run scratch:p2 worker \(requested agent start worker/);
  assert.equal(summary.changes[0].panes[0], 'scratch:p2');
});

test('changes outside harness calls remain failures and incomplete monitoring never passes', () => {
  const summary = { baseline: 'operator:p7', samples: 20, errors: [], changes: [{ at: 1, panes: ['external:p1'], calls: [] }] };
  assert.throws(() => assertFocus(summary), /outside a recorded harness call/);
  summary.errors = ['subscription disconnected'];
  assert.throws(() => assertFocus(summary), /operator focus changed/);
  summary.changes = [];
  assert.throws(() => assertFocus(summary), HarnessLimit);
  assert.throws(() => assertFocus({ ...summary, errors: [], samples: 1 }), HarnessLimit);
});

test('an unreachable read-only focus socket is an explicit harness limitation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-focus-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(startFocusMonitor({ socketPath: path.join(root, 'absent.sock'), evidence: root }), HarnessLimit);
});
