import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { enqueue } from '../promote.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';
import { receiptDirectory } from '../../supervisor/context.mjs';
import { reconcile } from '../../supervisor/reconcile.mjs';
import { acquireLock } from '../../lanes/promotion-lock.mjs';

import { fixture, source, manualRecovery } from './completion-fixture.mjs';

function splitBatch(f) {
  const id = 'interrupted-split', directory = path.join(f.queue.directory, 'batches', id);
  fs.mkdirSync(directory, { recursive: true });
  const jobs = f.queue.load().pending, file = path.join(directory, 'train.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 'promotion-train/v1', id, identity: f.queue.project.identity,
    jobs, phase: 'pending', groups: [jobs.slice(0, 2).map(j => j.id), jobs.slice(2).map(j => j.id)] }));
  f.queue.transaction(data => { data.pending = []; data.current = { id, phase: 'batching', jobs }; });
  return file;
}

for (const failure of ['dirty', 'off-main', 'host-timeout']) test(`split recovery accounts for never-captured ${failure} members without another gate`, t => {
  const f = fixture(t), first = f.lane('first'), second = f.lane('second'), last = f.lane('last');
  const receipt = splitBatch(f);
  if (failure === 'host-timeout') {
    // Exit the actual train child just after the first group is durably complete;
    // the real queue must synthesize the remaining host timeout membership.
    fs.appendFileSync(f.preload, `
if(process.argv.includes('promote-batch')){const fs=require('fs'),rename=fs.renameSync;
fs.renameSync=function(a,b){const v=rename.apply(this,arguments);if(require('path').resolve(b)===${JSON.stringify(receipt)}){
const p=JSON.parse(fs.readFileSync(b));if(p.attempts?.[0]?.phase==='complete'&&Object.values(p.results??{}).filter(r=>r.outcome==='promoted').length===2){
fs.writeFileSync(${JSON.stringify(path.join(path.dirname(receipt), 'host-gate.json'))},JSON.stringify({phase:'timeout',gate_timeout:{kind:'wall'}}));process.exit(1);}}return v;};}
`);
  } else {
    const hook = path.join(f.queue.project.identity, 'hooks/post-merge');
    fs.writeFileSync(hook, failure === 'dirty' ? '#!/bin/sh\ntouch canonical-dirty\n' : '#!/bin/sh\ngit switch -qc temporary-branch\n', { mode: 0o755 });
  }
  f.drain(); assert.equal(f.gates(), 1);
  const train = JSON.parse(fs.readFileSync(receipt));
  assert.deepEqual(train.completion.refused, [last.job.id]);
  assert.equal(train.completion.jobs.length, 2);
  assert.equal(train.results[last.job.id].outcome, failure === 'host-timeout' ? 'timeout' : 'refused');
  assert.ok(!train.attempts.some(a => a.jobs.some(j => j.id === last.job.id)));
  if (failure !== 'host-timeout') {
    assert.equal(f.queue.load().interrupted.length, 1);
    for (const m of [first, second]) assert.ok(fs.existsSync(m.workspace));
    if (failure === 'dirty') fs.unlinkSync(path.join(f.repo, 'canonical-dirty'));
    else f.git(['switch', 'main']);
    // Also prove recovery of older receipts missing the refused list entry.
    train.completion.refused = []; fs.writeFileSync(receipt, JSON.stringify(train));
  }
  f.drain(); assert.equal(f.gates(), 1); assert.equal((f.queue.load().interrupted ?? []).length, 0);
  assert.ok(fs.existsSync(last.workspace)); assert.equal(f.show(last.item).closed, null);
  for (const m of [first, second]) { assert.equal(f.show(m.item).closed.as, 'done'); assert.equal(fs.existsSync(m.workspace), false); }
  assert.equal(f.events().filter(e => e.type === 'promotion.reconciled').length, 1);
});

for (const failure of ['dirty', 'off-main']) test(`bisected canonical ${failure} refusal preserves captured historical exclusions`, t => {
  const f = fixture(t), first = f.lane('first'), second = f.lane('second'), bad = f.lane('broken', true);
  const hook = path.join(f.queue.project.identity, 'hooks/post-merge');
  fs.writeFileSync(hook, failure === 'dirty' ? '#!/bin/sh\ntouch canonical-dirty\n' : '#!/bin/sh\ngit switch -qc temporary-branch\n', { mode: 0o755 });
  f.drain(); assert.equal(f.gates(), 2); assert.equal(f.queue.load().interrupted.length, 1);
  const receipt = f.queue.load().results[0].receipt, train = JSON.parse(fs.readFileSync(receipt));
  assert.equal(train.completion.jobs.length, 3); assert.deepEqual(train.completion.refused, []);
  if (failure === 'dirty') fs.unlinkSync(path.join(f.repo, 'canonical-dirty')); else f.git(['switch', 'main']);
  f.record(['start', bad.item, '--workspace', bad.workspace]); const excluded = f.show(bad.item);
  f.drain(); assert.equal(f.gates(), 2); assert.equal((f.queue.load().interrupted ?? []).length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt)).completion, train.completion);
  assert.deepEqual(f.show(bad.item), excluded); assert.ok(fs.existsSync(bad.workspace));
  for (const m of [first, second]) assert.equal(fs.existsSync(m.workspace), false);
  assert.equal(f.events().find(e => e.type === 'promotion.reconciled').historical_exclusions[0].run, bad.run);
});

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
  assert.equal(retry.status, 0, retry.stderr); assert.equal(JSON.parse(retry.stdout).result, 'resuming_completion');
  const deadline = Date.now() + loadTimeout(10000);
  // Pending batches stay interrupted, but the worker must finish this drain.
  while (fs.existsSync(path.join(f.queue.directory, 'worker.lock'))) {
    assert.ok(Date.now() < deadline, 'resume worker finished'); await new Promise(r => setTimeout(r, 20));
  }
  const recovered = ['complete', 'reopened', 'new-run'].includes(mode);
  assert.equal(f.gates(), 3); assert.equal((f.queue.load().interrupted ?? []).length, recovered ? 0 : 1);
  assert.equal(fs.readFileSync(receipt + '.record.json', 'utf8'), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt)).attempts, attempts);
  assert.deepEqual(f.show(bad.item), excludedBefore); assert.ok(fs.existsSync(bad.workspace));
  for (const m of [first, second]) assert.equal(fs.existsSync(m.workspace), !recovered || (m === first && mode !== 'complete'));
  const before = f.events();
  for (const notice of [`[org-report] run=${first.run} item=${first.item} outcome=done headline=Completed`, `[promote-queue] id=${first.job.id} lane=${first.topic}`]) {
    const late = supervisor(f, ['handle', '--notice', notice]);
    if (mode === 'complete') { assert.equal(late.status, 0, late.stderr); assert.equal(JSON.parse(late.stdout).result, 'recorded_promotion'); }
    else { assert.equal(late.status, 1, late.stdout); assert.match(late.stderr, recovered ? /reopened|superseded/ : /reconciliation pending/); }
  }
  assert.deepEqual(f.events(), before); assert.equal(f.gates(), 3);
});

for (const variant of ["legacy", "prepared"]) for (const failTelemetry of [false, true]) test(`${variant} replacement recovery cleans completed lanes with telemetry failure: ${failTelemetry}`, t => {
  const f = fixture(t), first = f.lane('first'), second = f.lane('second');
  fs.writeFileSync(path.join(f.queue.project.identity, 'hooks/post-merge'), '#!/bin/sh\ntouch canonical-dirty\n', { mode: 0o755 });
  f.drain(); assert.equal(f.gates(), 1);
  const rows = f.queue.load().results, receipt = rows[0].receipt;
  assert.ok(rows.some(r => r.replacement_pending && f.git(['rev-parse', 'HEAD'], r.workspace) !== r.tip));
  fs.unlinkSync(path.join(f.repo, 'canonical-dirty'));
  const train = JSON.parse(fs.readFileSync(receipt)), attempts = train.attempts;
  if (variant === 'legacy') {
    delete train.completion; fs.writeFileSync(receipt, JSON.stringify(train));
    if (fs.existsSync(receipt + '.record.json')) fs.unlinkSync(receipt + '.record.json');
  } else f.recover(first, ['note', first.item, 'Inspected native fingerprint drift']);
  f.drain(); assert.equal(f.gates(), 1);
  const original = fs.readFileSync(receipt + '.record.json', 'utf8');
  assert.equal(!!JSON.parse(original).recovery_only, variant === 'legacy');
  assert.equal(f.queue.load().interrupted.length, 1);
  for (const m of [first, second]) {
    const pending = f.queue.load().results.findLast(r => r.id === m.job.id);
    assert.equal(pending.reconciliation.state, 'pending');
    assert.equal(f.show(m.item).closed, null);
    assert.match(pending.reconciliation.reason, variant === 'prepared' ? /changed since batch preparation/ : /lacks original record preparation/);
  }
  assert.throws(() => manualRecovery(f, rows), /head\/workspace differs/);
  for (const row of rows) {
    if (f.git(['rev-parse', 'HEAD'], row.workspace) === row.tip) continue;
    const release = acquireLock(path.join(f.queue.project.identity, 'lane-promote.lock'));
    try {
      const plan = { workspace: row.workspace, repo: f.repo, common: f.queue.project.identity,
        branch: `refs/heads/lane/${row.topic}`, from: row.source_head, to: row.tip,
        main: 'main', mainHead: f.git(['rev-parse', 'HEAD']) };
      const r = spawnSync(process.execPath, [path.join(source, 'settle/replace-lane-head.mjs'), JSON.stringify(plan)],
        { cwd: f.repo, env: f.env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    } finally { release(); }
  }
  // The refused prepare wrote no receipt; inspection and clean CAS allow it.
  manualRecovery(f, rows);
  if (failTelemetry) fs.appendFileSync(f.preload, `\nif(process.argv[1]?.endsWith('org.mjs')&&process.argv.includes('note')&&process.argv.some(a=>a.startsWith('Promotion: report-to-main'))){console.error('injected telemetry refusal');process.exit(1);}`);
  f.drain(); assert.equal(f.gates(), 1);
  assert.equal((f.queue.load().interrupted ?? []).length, 0);
  assert.equal(fs.readFileSync(receipt + '.record.json', 'utf8'), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt)).attempts, attempts);
  for (const m of [first, second]) { assert.equal(f.show(m.item).closed.as, 'done'); assert.equal(fs.existsSync(m.workspace), false); }
  if (failTelemetry) assert.ok(f.queue.load().results.slice(-2).every(r => r.warnings.some(w => w.includes('velocity record'))));
});

for (const mode of ['pass-review', 'fail-review', 'no-verdict-review', 'open-question', 'review-question'])
for (const relation of mode === 'open-question' ? ['linked'] : ['linked', 'child-only']) test(`a ${relation} ${mode} recorded after enqueue is checked by the native worker`, t => {
  const f = fixture(t), m = f.lane(mode), base = f.git(['rev-parse', 'main']);
  if (mode === 'open-question') f.recover(m, ['ask', 'Allow this change?', '--parent', m.item, '--category', 'security', '--recommend', 'no', '--why', 'Raised after enqueue', '--wait']);
  else {
    // The no-verdict case uses a role alias: every spelling of the reviewer role counts.
    const rev = f.recover(m, ['add', 'Review', '--role', mode === 'no-verdict-review' ? 'Review' : 'reviewer', '--parent', m.item]).match(/^REV-\d+/)[0];
    if (relation === 'linked') f.recover(m, ['block', m.item, '--by', rev]);
    for (const verdict of { 'pass-review': ['PASS'], 'fail-review': ['PASS', 'FAIL'], 'no-verdict-review': [null], 'review-question': ['PASS'] }[mode]) {
      const report = path.join(f.root, `review-${verdict}.md`);
      const run = f.recover(m, ['start', rev, '--workspace', f.root, '--report', report]).match(/^R-\d+/)[0];
      fs.writeFileSync(report, `---\nrun: ${run}\noutcome: done\n${verdict ? `verdict: ${verdict}\n` : ''}summary: Review ${verdict}\nheadline: Review ${verdict}\n---\n`);
      f.record(['ingest', report]);
    }
    // A done review without a verdict releases status; promotion still requires explicit PASS.
    if (mode === 'no-verdict-review') assert.equal(f.show(m.item).status, 'done');
    // A question filed under the blocking review, not the work, after its PASS.
    if (mode === 'review-question') f.recover(m, ['ask', 'Ship despite this?', '--parent', rev, '--category', 'security', '--recommend', 'no', '--why', 'Raised under the review', '--wait']);
  }
  f.drain();
  const result = f.queue.load().results[0];
  if (mode === 'pass-review') {
    assert.equal(result.outcome, 'promoted', result.reason); assert.equal(f.show(m.item).closed.as, 'done');
    return;
  }
  assert.equal(result.outcome, 'refused');
  assert.match(result.reason, { 'fail-review': /review REV-\d+ has no recorded PASS verdict/, 'no-verdict-review': /review REV-\d+ has no recorded PASS verdict/, 'open-question': /open operator question HUM-\d+/, 'review-question': /open operator question HUM-\d+/ }[mode]);
  assert.equal(f.gates(), 0); assert.equal(f.git(['rev-parse', 'main']), base);
  assert.equal(f.show(m.item).closed, null); assert.ok(fs.existsSync(m.workspace));
});

for (const under of ['work', 'review']) test(`an operator question raised under the ${under} after the fast-forward holds batch completion until it is answered`, t => {
  const f = fixture(t), m = f.lane('asked'), other = f.lane('other');
  let parent = m.item;
  if (under === 'review') {
    parent = f.recover(m, ['add', 'Review', '--role', 'reviewer', '--parent', m.item]).match(/^REV-\d+/)[0];
    f.recover(m, ['block', m.item, '--by', parent]);
    const report = path.join(f.root, 'review.md'), run = f.recover(m, ['start', parent, '--workspace', f.root, '--report', report]).match(/^R-\d+/)[0];
    fs.writeFileSync(report, `---\nrun: ${run}\noutcome: done\nverdict: PASS\nsummary: Review PASS\nheadline: Review PASS\n---\n`);
    f.record(['ingest', report]);
  }
  fs.writeFileSync(f.fault, 'refuse'); f.drain();
  assert.equal(f.gates(), 1); assert.equal((f.queue.load().interrupted ?? []).length, 1);
  const question = f.recover(m, ['ask', 'Hold this?', '--parent', parent, '--category', 'security', '--recommend', 'no', '--why', 'Raised after the fast-forward', '--wait']).match(/^HUM-\d+/)[0];
  fs.unlinkSync(f.fault); f.drain();
  assert.equal(f.gates(), 1); assert.equal((f.queue.load().interrupted ?? []).length, 1);
  for (const x of [m, other]) { assert.equal(f.show(x.item).closed, null); assert.ok(fs.existsSync(x.workspace)); }
  f.recover(m, ['answer', question, 'yes']); f.drain();
  assert.equal(f.gates(), 1); assert.equal((f.queue.load().interrupted ?? []).length, 0);
  for (const x of [m, other]) assert.equal(f.show(x.item).closed.as, 'done');
});

for (const [blocking, resolved] of [[false, false], [true, false], [true, true]]) test(`ordinary promotion ${resolved ? 'completes with a resolved blocking' : blocking ? 'refuses a blocking' : 'completes with a non-blocking'} engineer report proposal`, t => {
  const f = fixture(t), m = f.lane('follow-up', false, { proposals: [{ role: 'engineer', title: 'Optional improvement', why: 'Separate follow-up', blocking }] });
  const child = f.events().find(e => e.type === 'item.added' && e.from_run === m.run);
  assert.ok(child); assert.equal(child.role, 'engineer'); assert.ok(m.job.id);
  assert.ok(f.queue.load().pending[0].admittedSeq >= child.seq);
  if (resolved) {
    const run = f.recover(m, ['start', child.id]).match(/^R-\d+/)[0], report = path.join(f.root, 'child-done.md');
    fs.writeFileSync(report, `---\nrun: ${run}\noutcome: done\nsummary: Follow-up complete\n---\n`);
    f.record(['ingest', report]);
  }
  const base = f.git(['rev-parse', 'main']); f.drain();
  const result = f.queue.load().results[0];
  const refused = blocking && !resolved;
  assert.equal(result.outcome, refused ? 'refused' : 'promoted', result.reason);
  assert.equal(f.show(child.id).closed, null);
  assert.equal(f.show(m.item).closed?.as ?? null, refused ? null : 'done');
  if (refused) assert.equal(f.git(['rev-parse', 'main']), base);
});

test('ordinary enqueue admits a non-blocking engineer child filed after intake but before admission', t => {
  const f = fixture(t), m = f.lane('supervised', false, { childBeforeAdmission: true });
  const child = f.events().find(e => e.type === 'item.added' && e.parent === m.item);
  assert.ok(child); assert.equal(child.from_run, undefined);
  assert.ok(child.seq > f.show(m.run).report.seq);
  assert.ok(child.seq <= f.queue.load().pending[0].admittedSeq);
  f.drain();
  assert.equal(f.queue.load().results[0].outcome, 'promoted');
  assert.equal(f.show(m.item).closed.as, 'done'); assert.equal(f.show(child.id).closed, null);
});

test('an engineer child created after queue admission refuses before train capture', t => {
  const f = fixture(t), m = f.lane('guarded'), base = f.git(['rev-parse', 'main']);
  f.recover(m, ['add', 'New engineering scope', '--role', 'engineering', '--parent', m.item]);
  f.drain();
  assert.equal(f.queue.load().results[0].outcome, 'refused');
  assert.match(f.queue.load().results[0].reason, /open engineer children/);
  assert.equal(f.gates(), 0); assert.equal(f.git(['rev-parse', 'main']), base);
});

for (const change of ['engineer-child', 'dependency', 'question', 'hold', 'new-run', 'review-PASS'])
test(`final integration refuses a gate-time ${change} change`, t => {
  const f = fixture(t), m = f.lane('guarded'), base = f.git(['rev-parse', 'main']);
  const commands = [];
  if (change === 'engineer-child') commands.push(['add', 'Unfinished child', '--role', 'engineering', '--parent', m.item]);
  if (change === 'dependency') {
    const dependency = f.record(['add', 'Dependency', '--role', 'engineer']);
    f.record(['close', dependency]); f.recover(m, ['block', m.item, '--by', dependency]);
    commands.push(['reopen', dependency]);
  }
  if (change === 'question') commands.push(['ask', 'May this integrate?', '--parent', m.item, '--category', 'security', '--recommend', 'no', '--why', 'Changed during validation', '--wait']);
  if (change === 'new-run') commands.push(['start', m.item, '--workspace', m.workspace]);
  if (change === 'review-PASS') {
    const review = f.recover(m, ['add', 'Review', '--role', 'reviewer', '--parent', m.item]);
    const run = f.recover(m, ['start', review]).match(/^R-\d+/)[0], report = path.join(f.root, 'review.md');
    fs.writeFileSync(report, `---\nrun: ${run}\noutcome: done\nsummary: Reviewed\nverdict: PASS\n---\n`); f.record(['ingest', report]);
    commands.push(['reopen', review]);
  }
  let extra = '';
  if (change === 'hold') extra = `fs.mkdirSync(${JSON.stringify(path.join(f.repo, '.lane/supervisor'))},{recursive:true});fs.writeFileSync(${JSON.stringify(path.join(f.repo, '.lane/supervisor/STOP'))},'STOP');`;
  fs.appendFileSync(f.checker, `const cp=require('child_process');for(const args of ${JSON.stringify(commands)})cp.execFileSync(process.execPath,[${JSON.stringify(path.join(source, 'bin/org.mjs'))},...args],{env:{...process.env,ORG_DIR:${JSON.stringify(f.org)},ORG_GUARD_OVERRIDE:JSON.parse(fs.readFileSync(${JSON.stringify(f.queue.file)},'utf8')).current.id}});${extra}`);
  f.drain(); assert.equal(f.gates(), 1); assert.equal(f.git(['rev-parse', 'main']), base);
  const result = f.queue.load().results[0]; assert.equal(result.outcome, 'refused'); assert.equal(f.show(m.item).closed, null);
  if (change === 'engineer-child') assert.match(result.reason, /open engineer children/);
  assert.equal(f.events().some(e => e.type === 'promotion.reconciled'), false);
});
