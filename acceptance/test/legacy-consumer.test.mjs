import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { copiedSandbox } from '../security.mjs';
import { inventory } from './cutover-fixture.mjs';
import { startLegacyConsumer } from '../legacy-consumer.mjs';
import { waitUntil } from '../load.mjs';

function setup(t) {
  const handles = [];
  const f = inventory({ after: cleanup => t.after(async () => {
    for (const handle of handles) await handle.stop();
    cleanup();
  }) }), { root, copy, spec } = f;
  const bin = path.join(root, 'bin'), org = path.join(root, 'record');
  fs.mkdirSync(bin); fs.mkdirSync(org);
  fs.writeFileSync(path.join(org, 'events.jsonl'), '');
  const report = path.join(root, 'legacy-report.md'), received = path.join(root, 'received.jsonl');
  fs.writeFileSync(report, '---\noutcome: done\nverdict: PASS\n---\nOffline report.\n');
  fs.writeFileSync(path.join(bin, 'org'), `#!/bin/sh
case "$1" in
  show) echo '{"run":{"item":"ENG-offline","meta":{"agent":"offline"},"report_path":"${report}"}}' ;;
  check) echo 'ok: checked' ;;
  *) exit 91 ;;
esac
`, { mode: 0o755 });
  const herdr = path.join(bin, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}
import fs from 'node:fs';
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(root, 'calls.jsonl'))}, JSON.stringify(a)+'\\n');
if (a[0] === 'agent' && a[1] === 'wait') {}
else if (a[0] === 'agent' && a[1] === 'get') console.log(JSON.stringify({result:{agent:{agent_status:'idle'}}}));
else if (a[0] === 'agent' && a[1] === 'list') console.log(JSON.stringify({result:{agents:[{name:'foreign',pane_id:'foreign:p1'},{name:${JSON.stringify(spec.legacyTarget)},pane_id:'scratch:p1'}]}}));
else if (a[0] === 'pane' && a[1] === 'read' && a[2] === 'scratch:p1') console.log('────\\n❯ '+(fs.existsSync(${JSON.stringify(path.join(root, 'busy'))}) ? 'operator text' : '')+'\\n────');
else if (a[0] === 'agent' && a[1] === 'prompt' && a[2] === 'scratch:p1') { fs.appendFileSync(${JSON.stringify(received)}, JSON.stringify({pane:a[2],line:a[3]})+'\\n'); console.log('{}'); }
else process.exit(92);
`, { mode: 0o755 });
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH };
  for (const key of Object.keys(env)) if (/^(NW_|SE_|HERDR_(PANE|TAB|WORKSPACE)_ID)/.test(key)) delete env[key];
  const options = { root, copy, org, herdr, target: spec.legacyTarget, env: { ...env }, evidence: path.join(root, 'evidence'),
    onStart: handle => handles.push(handle) };
  const notify = () => {
    const r = spawnSync('/bin/bash', [path.join(copy, '.lane/supervisor/notify-watch.sh'), 'R-1', '--to', spec.legacyTarget], { cwd: copy, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /queued for legacy-target/);
  };
  return { ...f, options, notify, received, rows: () => fs.existsSync(received) ? fs.readFileSync(received, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

test('rollback done report reaches the scratch supervisor exactly once through the real outbox consumer', async (t) => {
  const f = setup(t);
  f.notify();
  const outbox = path.join(f.copy, '.lane/supervisor/outbox');
  assert.equal(fs.readdirSync(outbox).filter(n => n.endsWith('.msg')).length, 1);
  assert.deepEqual(f.rows(), []);
  const consumer = await startLegacyConsumer(f.options);
  t.after(() => consumer.stop());
  await waitUntil(() => f.rows().length === 1, 'scratch supervisor receipt', 1500);
  await waitUntil(() => fs.readdirSync(outbox).filter(n => n.endsWith('.msg')).length === 0, 'outbox drained', 1500);
  // Reconciliation after delivery must not prompt again.
  fs.writeFileSync(path.join(outbox, 'RETRY'), '');
  await consumer.stop();
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].pane, 'scratch:p1');
  assert.match(f.rows()[0].line, /\[org-report\] run=R-1 item=ENG-offline outcome=done verdict=PASS .*delivered by notify-watch/);
  assert.match(fs.readFileSync(path.join(f.copy, '.lane/supervisor/notify-log.tsv'), 'utf8'), /supervisor-events\tsent\t\[org-report\]/);
  const receipt = JSON.parse(fs.readFileSync(consumer.receiptFile));
  assert.deepEqual(receipt.states.map(s => s.state), ['starting', 'spawned', 'ready', 'stopping', 'exited', 'stopped']);
  assert.equal(receipt.requestedPort, 0); assert.ok(receipt.port > 0);
  assert.equal(fs.existsSync(path.join(f.copy, '.lane/supervisor/watch-logs/supervisor-events.pid')), false);
  const port = net.createServer();
  port.listen(receipt.port, '127.0.0.1'); await once(port, 'listening');
  port.close(); await once(port, 'close');
});

test('legacy consumer defers a queued report while the scratch supervisor input is busy', async (t) => {
  const f = setup(t), busy = path.join(f.root, 'busy');
  fs.writeFileSync(busy, '');
  const consumer = await startLegacyConsumer(f.options); t.after(() => consumer.stop());
  f.notify();
  const log = path.join(f.copy, '.lane/supervisor/watch-logs/supervisor-events.log');
  await waitUntil(() => fs.readFileSync(log, 'utf8').includes('input box busy'), 'busy delivery deferred', 2000);
  assert.deepEqual(f.rows(), []);
  assert.equal(fs.readdirSync(path.join(f.copy, '.lane/supervisor/outbox')).filter(n => n.endsWith('.msg')).length, 1);
  await consumer.stop();
});

test('inherited live consumer settings cannot select its queues, target or fixed port', async (t) => {
  const f = setup(t), untouched = path.join(f.root, 'untouched'); fs.mkdirSync(untouched);
  const sentinel = path.join(untouched, 'sentinel'); fs.writeFileSync(sentinel, 'unchanged');
  const foreign = net.createServer(); foreign.listen(0, '127.0.0.1'); await once(foreign, 'listening');
  t.after(() => foreign.close());
  Object.assign(f.options.env, { SE_ROOT: untouched, SE_SUP: untouched, SE_WAITERS: untouched,
    SE_GATE_REQ: untouched, SE_SLOT_LOCK: sentinel, SE_ORG_EVENTS: sentinel, SE_HERDR: '/forbidden/herdr',
    SE_SUPERVISOR: 'foreign', SE_LOCK_PORT: String(foreign.address().port), NW_OUTBOX: untouched,
    HERDR_PANE_ID: 'foreign:p1' });
  const consumer = await startLegacyConsumer(f.options); t.after(() => consumer.stop());
  f.notify(); await waitUntil(() => f.rows().length === 1, 'scoped delivery', 2000);
  await consumer.stop();
  assert.equal(f.rows()[0].pane, 'scratch:p1');
  assert.deepEqual(fs.readdirSync(untouched), ['sentinel']);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
  assert.notEqual(JSON.parse(fs.readFileSync(consumer.receiptFile)).port, foreign.address().port);
});

test('an exited or unready consumer fails startup and remains receipted for cleanup', async (t) => {
  const f = setup(t), script = path.join(f.copy, '.lane/supervisor/supervisor-events.mjs');
  for (const text of ['process.exit(0);', 'setInterval(() => {}, 1000);', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"]) {
    fs.writeFileSync(script, text);
    let owned;
    await assert.rejects(startLegacyConsumer({ ...f.options, timeoutMs: 500, onStart: handle => { owned = handle; } }), /exited before ready|timeout: legacy consumer ready/);
    assert.ok(owned);
    await owned.stop(); await owned.stop();
    const states = JSON.parse(fs.readFileSync(owned.receiptFile)).states.map(s => s.state);
    assert.ok(states.includes('startup-failed')); assert.ok(states.includes('exited')); assert.equal(states.at(-1), 'stopped');
    if (text.includes('SIGTERM')) assert.ok(states.includes('killing'));
    assert.throws(() => process.kill(owned.pid, 0), { code: 'ESRCH' });
  }
});

test('failed lifecycle writes still stop the owned consumer before reporting cleanup failure', async (t) => {
  const f = setup(t);
  const consumer = await startLegacyConsumer({ ...f.options, onStart() {} });
  fs.rmSync(f.options.evidence, { recursive: true });
  await assert.rejects(consumer.stop(), /stopped but lifecycle receipt failed/);
  assert.throws(() => process.kill(consumer.pid, 0), { code: 'ESRCH' });
  let child;
  await assert.rejects(startLegacyConsumer({ ...f.options, onStart() {},
    launch(command, args, options) {
      child = spawn(command, args, options);
      fs.rmSync(f.options.evidence, { recursive: true });
      return child;
    },
  }), /stopped but lifecycle receipt failed/);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});

test('consumer refuses outside or symlinked scratch paths before spawning', async (t) => {
  const f = setup(t);
  const link = path.join(f.root, 'linked-copy'); fs.symlinkSync(f.copy, link);
  for (const options of [{ copy: link }, { evidence: path.dirname(f.root) }, { org: path.dirname(f.root) }, { herdr: '/bin/echo' }]) {
    await assert.rejects(startLegacyConsumer({ ...f.options, ...options, launch() { assert.fail('must refuse before launch'); } }), /outside scratch/);
  }
});

test('the real queued transport delivers inside the independent copied-code sandbox', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = setup(t), policy = path.join(f.root, 'copied.sb');
  fs.writeFileSync(policy, copiedSandbox(f.root, [fs.realpathSync(path.join(path.dirname(process.execPath), '..'))]));
  const consumer = await startLegacyConsumer({ ...f.options,
    launch(command, args, options) { return spawn('/usr/bin/sandbox-exec', ['-f', policy, command, ...args], options); },
  });
  t.after(() => consumer.stop());
  f.notify(); await waitUntil(() => f.rows().length === 1, 'sandboxed scratch receipt', 2500);
  await consumer.stop(); assert.equal(f.rows().length, 1);
});
