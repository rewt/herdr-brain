import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPERATOR_LANDING_WAIVER } from '../../lib/validation-declaration.mjs';
import { fixture as completionFixture, source } from './completion-fixture.mjs';
import { acquireLock } from '../../lanes/promotion-lock.mjs';
import { spawnScenarioChild, waitForExit } from '../../test/helpers/child.mjs';
import { liveNativeWorker } from '../native-context.mjs';

// Link the actual module with controlled native reads. These are refusal and
// binding controls, not a claim of native process or permission execution.
const moduleURL = new URL('../native-context.mjs', import.meta.url).href;
const original = fs.readFileSync(new URL(moduleURL), 'utf8');
const body = original.replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', 'moduleURL').replace(/^export /gm, '');
assert.doesNotMatch(body, /^import /m);
const link = new Function('fs', 'path', 'spawnSync', 'fileURLToPath', 'lookupProcess', 'OPERATOR_LANDING_WAIVER', 'moduleURL',
  `${body}\nreturn {nativeWorkerEvidence,liveNativeWorker};`);
const workerCLI = fileURLToPath(new URL('../promote.mjs', import.meta.url));
const waiver = { gateRequired: false, authority: OPERATOR_LANDING_WAIVER };

function fixture() {
  const process = { pid: 42, identity: 'actual-birth', command: `node ${workerCLI} --drain`, state: 'S' };
  const owner = { pid: 42, argv: ['node', workerCLI, '--drain'], native_process: { ...process },
    native_gate: { outcome: 'not-required', executed: false, authority: OPERATOR_LANDING_WAIVER } };
  let current = { ok: true, value: { ...process } };
  const reads = [];
  const api = link({ readFileSync(file) { assert.equal(file, path.join('/owned', 'promote/worker.lock/owner.json')); return JSON.stringify(owner); },
    openSync() { assert.fail('unused PTY probe'); } }, path,
    () => assert.fail('unused loopback probe'), fileURLToPath,
    pid => { reads.push(pid); return current; }, OPERATOR_LANDING_WAIVER, moduleURL);
  return { api, owner, reads, current: value => { current = value; } };
}

test('existing-worker reuse requires the exact canonical waiver and never upgrades a refusal', () => {
  const f = fixture();
  assert.equal(f.api.liveNativeWorker('/owned'), null);
  assert.equal(f.api.liveNativeWorker('/owned', { gateRequired: false }), null);
  assert.equal(f.api.liveNativeWorker('/owned', { ...waiver, authority: 'foreign' }), null);
  assert.deepEqual(f.reads, []);
  assert.equal(f.api.liveNativeWorker('/owned', waiver)?.pid, 42);
  for (const gate of [undefined, { ok: false }, { ...f.owner.native_gate, ok: false },
    { ...f.owner.native_gate, executed: true }, { ...f.owner.native_gate, authority: 'foreign' }]) {
    f.owner.native_gate = gate;
    assert.equal(f.api.liveNativeWorker('/owned', waiver), null);
  }
  f.owner.native_gate = { ok: true };
  assert.equal(f.api.liveNativeWorker('/owned')?.pid, 42, 'legacy genuinely probed worker remains supported');
});

test('waived unused probes preserve fresh native process birth, command, live state and drain path guards', () => {
  for (const current of [{ ok: false, error: 'native refusal' }, { ok: true, value: null },
    { ok: true, value: { pid: 42, identity: 'foreign', command: `node ${workerCLI} --drain`, state: 'S' } },
    { ok: true, value: { pid: 42, identity: 'actual-birth', command: 'foreign', state: 'S' } },
    { ok: true, value: { pid: 42, identity: 'actual-birth', command: `node ${workerCLI} --drain`, state: 'Z' } }]) {
    const f = fixture(); f.current(current);
    assert.equal(f.api.liveNativeWorker('/owned', waiver), null);
    assert.deepEqual(f.reads, [42]);
  }
  for (const mutate of [f => { f.owner.argv[1] = '/foreign/promote.mjs'; },
    f => { f.owner.argv.pop(); }, f => { f.owner.native_process.pid = 99; },
    f => { f.owner.native_process.command = 'foreign'; }]) {
    const f = fixture(); mutate(f);
    assert.equal(f.api.liveNativeWorker('/owned', waiver), null);
    assert.deepEqual(f.reads, [], 'invalid owner never reaches the native read');
  }
});

test('actual waived native drain reuses its owner for a second manual admission and closes both owned items without a gate', async t => {
  const f = completionFixture(t), declaration = path.join(f.repo, '.lane.validation.json');
  fs.writeFileSync(declaration, JSON.stringify({ promotion: `${process.execPath} ${f.checker}`, landing_waiver: OPERATOR_LANDING_WAIVER, review: 'parallel' }));
  f.git(['add', '.lane.validation.json']); f.git(['commit', '-qm', 'Actual operator landing waiver']);
  const first = f.lane('first');
  const release = acquireLock(path.join(f.queue.project.identity, 'lane-promote.lock'));
  const child = spawnScenarioChild(t, process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain', '--repo', f.repo], { cwd: f.repo, env: f.env });
  const done = waitForExit(child); let second;
  try {
    const ownerFile = path.join(f.queue.directory, 'worker.lock/owner.json');
    let owner;
    while (child.exitCode === null && !t.signal.aborted) {
      try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (owner?.native_gate && owner?.native_process) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(owner?.native_gate && owner?.native_process, 'actual native owner evidence or real child exit, without an elapsed cutoff');
    assert.deepEqual(owner.native_gate, { outcome: 'not-required', executed: false, authority: OPERATOR_LANDING_WAIVER });
    assert.equal(liveNativeWorker(f.queue.project.identity, waiver)?.pid, child.pid, 'fresh actual native process binding');
    second = f.lane('second');
    assert.ok(f.queue.load().pending.some(job => job.id === second.job.id));
    assert.equal(liveNativeWorker(f.queue.project.identity, waiver)?.pid, child.pid, 'the same actual native owner accepts manual work; autopilot stays disabled');
  } finally { release(); }
  const reply = await done;
  assert.equal(reply.code, 0, reply.stderr || reply.stdout);
  assert.equal(f.gates(), 0);
  for (const member of [first, second]) {
    const row = f.queue.load().results.findLast(result => result.id === member.job.id);
    const evidence = JSON.stringify({ item: member.item, run: member.run,
      outcome: row?.outcome, code: row?.code, reason: row?.reason, gate: row?.gate,
      reconciliation: row?.reconciliation, cleanup: row?.cleanup, warnings: row?.warnings });
    assert.equal(f.show(member.item).closed?.as, 'done', evidence);
    assert.equal(fs.existsSync(member.workspace), false, `actual supported closeout completed: ${evidence}`);
  }
  assert.ok(f.queue.load().results.every(row => row.reconciliation.state === 'complete'));
});
