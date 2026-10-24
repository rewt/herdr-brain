import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { captureCompletionMember, reconcileBatchCompletion } from '../completion.mjs';
import { acquireLock } from '../../lanes/promotion-lock.mjs';
import { digest } from '../../lib/completion.mjs';
import { fixture, manualRecovery, source } from './completion-fixture.mjs';

// Exercise completion bookkeeping against a saved, independently constructed
// integration checkpoint. No native worker, gate or process inventory runs.
function checkpoint(t, variant = 'prepared') {
  const f = fixture(t), first = f.lane('first'), second = f.lane('second');
  const jobs = f.queue.load().pending, base = f.git(['rev-parse', 'main']);
  const completion = { version: 1, identity: f.queue.project.identity, canonical: f.repo,
    branch: 'main', base, jobs: [], refused: [] };
  for (const job of jobs) captureCompletionMember({ canonical: f.repo, identity: f.queue.project.identity,
    job, prepared: completion });
  f.git(['merge', '--ff-only', first.head]);
  const tree = f.git(['merge-tree', '--write-tree', first.head, second.head]).split('\n')[0];
  const tip = f.git(['commit-tree', tree, '-p', first.head, '-m', 'Integrated second']);
  f.git(['reset', '--hard', tip]);
  const id = 'replacement-checkpoint', directory = path.join(f.queue.directory, 'batches', id);
  fs.mkdirSync(directory, { recursive: true });
  const receipt = path.join(directory, 'train.json'), log = path.join(directory, 'gate.log');
  const bytes = 'retained successful gate evidence\n'; fs.writeFileSync(log, bytes);
  const gate = { exit_code: 0, signal: null, head: tip, tree, log,
    log_hash: createHash('sha256').update(JSON.stringify(bytes)).digest('hex') };
  const members = [first, second], tips = [first.head, tip];
  const results = jobs.map((job, index) => ({ job, result: { outcome: 'promoted', batch: id,
    source_head: job.expectedHead, tip: tips[index], workspace: members[index].workspace,
    receipt, log, ...(index ? { replacement_pending: true } : {}) } }));
  const train = { schema: 'promotion-train/v1', id, identity: f.queue.project.identity, phase: 'complete', jobs,
    ...(variant === 'legacy' ? {} : { completion }),
    attempts: [{ base, tip, phase: 'complete', integrated_at: '2026-01-01T00:00:00Z', gate,
      ids: jobs.map(job => job.id), tips: Object.fromEntries(jobs.map((job, index) => [job.id, tips[index]])),
      jobs: jobs.map((job, index) => ({ ...job, sourceHead: job.expectedHead, workspace: members[index].workspace })) }],
    results: Object.fromEntries(results.map(({ job, result }) => [job.id, result])) };
  fs.writeFileSync(receipt, JSON.stringify(train));
  f.queue.transaction(data => { data.pending = []; data.current = { id, phase: 'batching', jobs }; });
  if (variant === 'changed') f.recover(second, ['note', second.item, 'Independent inspection required']);
  const resume = () => reconcileBatchCompletion({ project: f.queue.project, jobs, results });
  return { ...f, first, second, jobs, results, train, receipt, resume };
}

test('prepared completion finishes the original replacement before recording the landed generation', t => {
  const f = checkpoint(t), result = f.resume();
  assert.equal(result.pending, false, result.reason);
  assert.equal(result.results[1].result.replacement_pending, false);
  assert.equal(f.git(['rev-parse', 'HEAD'], f.second.workspace), f.results[1].result.tip);
  const marker = f.events().find(e => e.type === 'promotion.reconciled');
  assert.ok(marker.closeout_targets.some(target => target.run === f.second.run && target.head === f.results[1].result.tip));
  for (const member of [f.first, f.second]) {
    assert.equal(f.show(member.item).closed.as, 'done'); assert.ok(fs.existsSync(member.workspace));
  }
  assert.equal(f.events().some(e => e.type === 'closeout.handoff'), false, 'the completion caller still owns its post-return tail');
  assert.equal(f.gates(), 0);
});

for (const variant of ['legacy', 'changed']) test(`${variant} replacement refusal retains exact coverage for independently inspected recovery`, t => {
  const f = checkpoint(t, variant), result = f.resume();
  assert.equal(result.pending, true);
  assert.match(result.reason, variant === 'legacy' ? /lacks original record preparation/ : /record changed since lane replacement preparation/);
  const original = fs.readFileSync(f.receipt + '.record.json', 'utf8'), payload = JSON.parse(original);
  assert.equal(!!payload.recovery_only, variant === 'legacy');
  assert.deepEqual(payload.items.map(({ run, head }) => ({ run, head })),
    f.results.map(({ job, result }) => ({ run: job.run, head: result.tip })));
  assert.equal(f.git(['rev-parse', 'HEAD'], f.second.workspace), f.second.head, 'missing or changed authority never replaces the lane');
  assert.equal(f.events().some(e => e.type === 'promotion.reconciled' || e.type === 'closeout.handoff'), false);
  assert.throws(() => manualRecovery(f, f.results.map(({ result }) => result)), /head\/workspace differs/);
  assert.equal(fs.existsSync(path.join(f.repo, '.lane/manual-prepared.json')), false);
  const release = acquireLock(path.join(f.queue.project.identity, 'lane-promote.lock'));
  try {
    const replacement = spawnSync(process.execPath, [path.join(source, 'settle/replace-lane-head.mjs'), JSON.stringify({
      workspace: f.second.workspace, repo: f.repo, common: f.queue.project.identity, branch: 'refs/heads/lane/second',
      from: f.second.head, to: f.results[1].result.tip, main: 'main', mainHead: f.git(['rev-parse', 'main']) })],
    { cwd: f.repo, env: f.env, encoding: 'utf8' });
    assert.equal(replacement.status, 0, replacement.stderr);
  } finally { release(); }
  manualRecovery(f, f.results.map(({ result }) => result));
  const marker = f.events().find(e => e.type === 'promotion.reconciled'), recovered = f.resume();
  assert.equal(recovered.pending, false, recovered.reason);
  for (const { result } of recovered.results) assert.deepEqual(result.reconciliation.recovered,
    { batch: marker.batch, fingerprint: marker.fingerprint });
  assert.equal(marker.fingerprint, digest(JSON.parse(fs.readFileSync(f.manualReceipt))));
  assert.equal(fs.readFileSync(f.receipt + '.record.json', 'utf8'), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.receipt)).attempts, f.train.attempts);
  assert.equal(f.events().filter(e => e.type === 'promotion.reconciled').length, 1);
  assert.equal(f.events().some(e => e.type === 'closeout.handoff'), false, 'native bookkeeping cannot supply the manual caller\'s tail');
  for (const member of [f.first, f.second]) assert.ok(fs.existsSync(member.workspace));
  assert.equal(f.gates(), 0);
});

test('unproved integration cannot publish replacement recovery coverage', t => {
  const f = checkpoint(t, 'legacy');
  f.results[1].result.source_head = f.first.head;
  const result = f.resume();
  assert.equal(result.pending, true); assert.match(result.reason, /integrated proof differs/);
  assert.equal(fs.existsSync(f.receipt + '.record.json'), false);
  assert.equal(f.git(['rev-parse', 'HEAD'], f.second.workspace), f.second.head);
  assert.equal(f.events().some(e => e.type === 'promotion.reconciled'), false);
});
