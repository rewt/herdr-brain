import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { receiptDirectory } from '../../supervisor/context.mjs';
import { reconcile } from '../../supervisor/reconcile.mjs';
import { fixture, source, manualRecovery, finishManualCloseout } from './completion-fixture.mjs';

function supervisorReceipt(f, m) {
  const directory = receiptDirectory(f.org, f.queue.project.identity); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${m.run}.json`), JSON.stringify({ identity: f.queue.project.identity,
    org: f.org, run: m.run, lane: m.topic, head: m.head, phase: 'acknowledged', queue: { jobs: [m.job] } }));
}
function supervisor(f, args) {
  return spawnSync(process.execPath, [path.join(source, 'supervisor/supervisor.mjs'), ...args,
    '--repo', f.repo, '--org', f.org, '--role', 'supervisor'], { cwd: f.repo, env: f.env, encoding: 'utf8' });
}

for (const mode of ['complete', 'no-marker', 'missing-member', 'wrong-head', 'missing-exclusion', 'missing-superseded', 'reopened', 'new-run', 'missing-evidence', 'unproved-head', 'wrong-log'])
test(`legacy queue and late notices recover only inspected exact coverage: ${mode}`, async t => {
  const f = fixture(t), first = f.lane('first', false, { supersede: true }), second = f.lane('second'), bad = f.lane('broken', true);
  fs.writeFileSync(f.fault, 'refuse'); f.drain(); fs.unlinkSync(f.fault); assert.equal(f.gates(), 3);
  const rows = f.queue.load().results, receipt = rows[0].receipt;
  const train = JSON.parse(fs.readFileSync(receipt)), attempts = train.attempts;
  delete train.completion; fs.writeFileSync(receipt, JSON.stringify(train)); fs.unlinkSync(receipt + '.record.json');
  supervisorReceipt(f, first);
  f.drain(); assert.equal(f.gates(), 3); assert.equal(f.queue.load().interrupted.length, 1);
  const original = fs.readFileSync(receipt + '.record.json', 'utf8'), payload = JSON.parse(original);
  assert.equal(payload.recovery_only, true); assert.ok(payload.items.every(e => !e.expected));
  assert.equal(f.events().filter(e => e.type === 'promotion.reconciled').length, 0);
  assert.equal(f.show(first.superseded[0]).abandoned, null);
  assert.match(supervisor(f, ['handle', '--notice', `[org-report] run=${first.run} item=${first.item} outcome=done headline=Completed`]).stderr, /reconciliation pending/);
  const excludedBefore = f.show(bad.item);
  if (mode !== 'no-marker') {
    if (mode === 'missing-exclusion' || mode === 'missing-superseded') {
      // Omit coverage in the independently inspected transaction, while keeping
      // the original legacy coverage receipt immutable.
      const manifest = path.join(f.repo, '.lane/manual.json'), prepared = path.join(f.repo, '.lane/manual.json.prepared');
      fs.mkdirSync(path.dirname(manifest), { recursive: true });
      const items = payload.items.map(e => ({ ...e }));
      if (mode === 'missing-superseded') { f.recover(first, ['abandon', first.superseded[0], '--note', 'Independent disposition']); items[0].superseded = []; }
      fs.writeFileSync(manifest, JSON.stringify({ batch: 'manual-recovery', candidate: payload.tip, items,
        excluded: mode === 'missing-exclusion' ? [] : payload.excluded }));
      const args = ['--repo', f.repo, '--org', f.org, '--role', 'supervisor', '--prepared', prepared];
      reconcile(['prepare', ...args, '--manifest', manifest, '--gate-log', rows[0].log]);
      reconcile(['finish', ...args, '--gate-exit', '0', '--tip', payload.tip]);
    } else manualRecovery(f, rows, mode);
  }
  if (mode === 'reopened') f.record(['reopen', first.item, '--note', 'Further work']);
  if (mode === 'new-run') f.recover(first, ['start', first.item, '--workspace', first.workspace]);
  if (mode === 'missing-evidence') fs.unlinkSync(attempts.find(a => a.gate?.exit_code === 0).gate.log);
  if (mode === 'unproved-head') {
    train.results[first.job.id].tip = payload.tip; fs.writeFileSync(receipt, JSON.stringify(train));
  }
  const retry = supervisor(f, ['promote', first.run, '--retry', '--why', 'Independent manual inspection']);
  assert.equal(retry.status, 0, retry.stderr);
  const reply = JSON.parse(retry.stdout); assert.equal(reply.result, 'resuming_completion');
  // ENG-530: lock absence is not completion. The drain releases worker.lock
  // before its final closeout callbacks; join the exact worker before our tail.
  f.workers.remember(reply); await f.workers.wait();
  assert.equal(f.queue.load().current, null, 'resume worker finished bookkeeping');
  const recovered = ['complete', 'reopened', 'new-run'].includes(mode);
  if (recovered) finishManualCloseout(f);
  assert.equal(f.gates(), 3); assert.equal((f.queue.load().interrupted ?? []).length, recovered ? 0 : 1);
  assert.equal(fs.readFileSync(receipt + '.record.json', 'utf8'), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt)).attempts, attempts);
  assert.deepEqual(f.show(bad.item), excludedBefore); assert.ok(fs.existsSync(bad.workspace));
  for (const m of [first, second]) {
    const result = f.queue.load().results.findLast(row => row.id === m.job.id);
    assert.equal(fs.existsSync(m.workspace), !recovered || (m === first && mode !== 'complete'),
      JSON.stringify({ topic: m.topic, cleanup: result?.cleanup, reason: result?.reason }));
  }
  const before = f.events();
  for (const notice of [`[org-report] run=${first.run} item=${first.item} outcome=done headline=Completed`, `[promote-queue] id=${first.job.id} lane=${first.topic}`]) {
    const late = supervisor(f, ['handle', '--notice', notice]);
    if (mode === 'complete') { assert.equal(late.status, 0, late.stderr); assert.equal(JSON.parse(late.stdout).result, 'recorded_promotion'); }
    else { assert.equal(late.status, 1, late.stdout); assert.match(late.stderr, recovered ? /reopened|superseded/ : /reconciliation pending/); }
  }
  assert.deepEqual(f.events(), before); assert.equal(f.gates(), 3);
});
