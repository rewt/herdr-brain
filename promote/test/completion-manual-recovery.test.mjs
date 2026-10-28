import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { recordedBatchCompletion } from '../completion.mjs';
import { receiptDirectory } from '../../supervisor/context.mjs';
import { reconcile } from '../../supervisor/reconcile.mjs';
import { fixture, source, manualRecovery, finishManualCloseout } from './completion-fixture.mjs';

function rewriteJob(f, member, changes) {
  f.queue.transaction(data => Object.assign(data.pending.find(j => j.id === member.job.id), changes));
}

for (const mode of ['complete', 'missing-member', 'wrong-head', 'reopened', 'new-run']) test(`manual reconciliation recovery ${mode} retains proof and handles cleanup`, async t => {
  const f = fixture(t), first = f.lane('first'), second = f.lane('second');
  fs.writeFileSync(f.fault, 'refuse'); f.drain(); fs.unlinkSync(f.fault);
  const rows = f.queue.load().results, receipt = rows[0].receipt;
  const attempts = JSON.parse(fs.readFileSync(receipt)).attempts;
  const original = fs.readFileSync(receipt + '.record.json', 'utf8');
  f.recover(first, ['note', first.item, 'Inspected change requires a newly prepared receipt']);
  f.drain(); assert.equal((f.queue.load().interrupted ?? []).length, 1);
  manualRecovery(f, rows, mode);
  if (mode === 'missing-member' || mode === 'wrong-head') {
    f.drain(); assert.equal(f.gates(), 1); assert.equal((f.queue.load().interrupted ?? []).length, 1);
    assert.equal(fs.readFileSync(receipt + '.record.json', 'utf8'), original);
    for (const m of [first, second]) assert.ok(fs.existsSync(m.workspace));
    return;
  }
  if (mode === 'reopened') f.record(['reopen', first.item, '--note', 'Further work']);
  if (mode === 'new-run') f.recover(first, ['start', first.item, '--workspace', first.workspace]);
  if (mode === 'complete') {
    const directory = receiptDirectory(f.org, f.queue.project.identity); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${first.run}.json`), JSON.stringify({ identity: f.queue.project.identity,
      org: f.org, run: first.run, lane: first.topic, head: first.head, phase: 'acknowledged', queue: { jobs: [first.job] } }));
    const retry = spawnSync(process.execPath, [path.join(source, 'supervisor/supervisor.mjs'), 'promote', first.run,
      '--repo', f.repo, '--org', f.org, '--role', 'supervisor', '--retry', '--why', 'Inspected manual reconciliation'],
      { cwd: f.repo, env: f.env, encoding: 'utf8' });
    assert.equal(retry.status, 0, retry.stderr);
    const reply = JSON.parse(retry.stdout);
    assert.equal(reply.result, 'resuming_completion');
    f.workers.remember(reply);
    await f.workers.wait();
    assert.equal(f.queue.load().current, null, 'normal resume worker completes bookkeeping');
  } else f.drain();
  assert.ok(fs.existsSync(second.workspace), 'native bookkeeping cannot tail the separate manual completion');
  finishManualCloseout(f);
  assert.equal(f.gates(), 1); assert.equal((f.queue.load().interrupted ?? []).length, 0);
  assert.equal(fs.readFileSync(receipt + '.record.json', 'utf8'), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt)).attempts, attempts);
  for (const m of [first, second]) {
    const row = f.queue.load().results.findLast(r => r.id === m.job.id);
    assert.equal(row.reconciliation.recovered.batch, 'manual-recovery');
    assert.equal(recordedBatchCompletion({ result: row, project: { ...f.queue.project, org: f.org }, run: { id: m.run, item: m.item } }), true);
    if (mode === 'complete') assert.equal(row.cleanup.state, 'complete', row.reason);
    assert.equal(fs.existsSync(m.workspace), m === first && mode !== 'complete');
  }
  const before = f.events(); f.drain(); assert.equal(f.gates(), 1); assert.deepEqual(f.events(), before);
});


test('native admission refuses omitted superseded attempts without wedging valid work', t => {
  const f = fixture(t), bad = f.lane('omitted', false, { supersede: true }), good = f.lane('good');
  rewriteJob(f, bad, { superseded: [] });
  f.drain(); assert.equal(f.gates(), 1); assert.equal((f.queue.load().interrupted ?? []).length, 0);
  assert.equal(f.queue.load().results.find(r => r.id === bad.job.id).outcome, 'refused');
  assert.equal(f.show(bad.superseded[0]).abandoned, null); assert.ok(fs.existsSync(bad.workspace));
  assert.equal(f.show(good.item).closed.as, 'done');
});

for (const mode of ['covered', 'missing-exclusion']) test(`bisected manual recovery ${mode} accounts for newer excluded work`, t => {
  const f = fixture(t), first = f.lane('first', false, { supersede: true }), second = f.lane('second'), bad = f.lane('broken', true);
  fs.writeFileSync(f.fault, 'refuse'); f.drain(); fs.unlinkSync(f.fault); assert.equal(f.gates(), 3);
  f.recover(first, ['note', first.item, 'Inspected pending native completion']);
  f.record(['start', bad.item, '--workspace', bad.workspace]);
  const excludedBefore = f.show(bad.item), rows = f.queue.load().results;
  const original = JSON.parse(fs.readFileSync(rows[0].receipt + '.record.json'));
  const manifest = path.join(f.repo, '.lane/recovery.json'), prepared = path.join(f.repo, '.lane/recovery-prepared.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ batch: 'bisected-recovery', candidate: original.tip,
    items: original.items, excluded: mode === 'covered' ? original.excluded : [] }));
  const args = ['--repo', f.repo, '--org', f.org, '--role', 'supervisor', '--prepared', prepared];
  reconcile(['prepare', ...args, '--manifest', manifest, '--gate-log', rows[0].log]);
  reconcile(['finish', ...args, '--gate-exit', '0', '--tip', original.tip]);
  f.drain(); assert.equal(f.gates(), 3); assert.deepEqual(f.show(bad.item), excludedBefore);
  if (mode === 'covered') finishManualCloseout(f, prepared + '.record.json');
  assert.ok(fs.existsSync(bad.workspace));
  assert.equal((f.queue.load().interrupted ?? []).length, mode === 'covered' ? 0 : 1);
  for (const m of [first, second]) assert.equal(fs.existsSync(m.workspace), mode !== 'covered');
  assert.ok(f.show(first.superseded[0]).abandoned);
});


test('a refused questioned dependency cannot let another member integrate before completion refuses', t => {
  const f = fixture(t), dependent = f.lane('dependent'), bad = f.lane('questioned', false, { questions: true }), good = f.lane('good');
  f.recover([dependent, bad], ['block', dependent.item, '--by', bad.item]);
  f.drain(); assert.equal(f.gates(), 1); assert.equal((f.queue.load().interrupted ?? []).length, 0);
  for (const m of [dependent, bad]) {
    assert.equal(f.queue.load().results.find(r => r.id === m.job.id).outcome, 'refused');
    assert.equal(f.show(m.item).closed, null); assert.ok(fs.existsSync(m.workspace));
  }
  assert.equal(f.show(good.item).closed.as, 'done');
  assert.deepEqual(new Set(f.events().find(e => e.type === 'promotion.reconciled').excluded), new Set([dependent.item, bad.item]));
});

// A persisted split group is a real train resume input. Only the first half
// has been captured when the canonical/host failure arrives.
