import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireLock } from '../../lanes/promotion-lock.mjs';
import { fixture, source, manualRecovery, finishManualCloseout } from './completion-fixture.mjs';

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
  } else {
    // ENG-530 finishes authorized delayed CAS before recording generation. The
    // second lane actually needs replacement; drift on the first cannot hold it.
    f.recover(second, ['note', second.item, 'Inspected native fingerprint drift']);
  }
  const heads = [first, second].map(m => f.git(['rev-parse', 'HEAD'], m.workspace));
  f.drain(); assert.equal(f.gates(), 1);
  const original = fs.readFileSync(receipt + '.record.json', 'utf8');
  assert.equal(!!JSON.parse(original).recovery_only, variant === 'legacy');
  assert.equal(f.queue.load().interrupted.length, 1);
  for (const m of [first, second]) {
    const pending = f.queue.load().results.findLast(r => r.id === m.job.id);
    assert.equal(pending.reconciliation.state, 'pending');
    assert.equal(f.show(m.item).closed, null);
    assert.match(pending.reconciliation.reason, variant === 'prepared' ? /record changed since lane replacement preparation/ : /lacks original record preparation/);
  }
  assert.deepEqual([first, second].map(m => f.git(['rev-parse', 'HEAD'], m.workspace)), heads);
  assert.equal(f.events().some(e => e.type === 'promotion.reconciled' || e.type === 'closeout.handoff'), false);
  assert.throws(() => manualRecovery(f, rows), /head\/workspace differs/);
  assert.equal(fs.existsSync(path.join(f.repo, '.lane/manual-prepared.json')), false);
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
  const manual = f.events().find(e => e.type === 'promotion.reconciled');
  if (failTelemetry) fs.appendFileSync(f.preload, `\nif(process.argv[1]?.endsWith('org.mjs')&&process.argv.includes('note')&&process.argv.some(a=>a.startsWith('Promotion: report-to-main'))){console.error('injected telemetry refusal');process.exit(1);}`);
  f.drain(); assert.equal(f.gates(), 1);
  for (const m of [first, second]) assert.ok(fs.existsSync(m.workspace), 'native bookkeeping awaits the manual owner\'s post-return tail');
  assert.equal(f.events().some(e => e.type === 'closeout.handoff'), false);
  finishManualCloseout(f);
  const handoff = f.events().find(e => e.type === 'closeout.handoff');
  assert.equal(handoff.source.seq, manual.seq);
  assert.deepEqual([...handoff.keys].sort(), manual.closeout_targets.map(target => target.key).sort());
  assert.equal((f.queue.load().interrupted ?? []).length, 0);
  assert.equal(fs.readFileSync(receipt + '.record.json', 'utf8'), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt)).attempts, attempts);
  for (const m of [first, second]) {
    assert.equal(f.show(m.item).closed.as, 'done'); assert.equal(fs.existsSync(m.workspace), false);
    assert.equal(f.queue.load().results.findLast(r => r.id === m.job.id).cleanup.state, 'complete');
  }
  if (failTelemetry) assert.ok(f.queue.load().results.slice(-2).every(r => r.warnings.some(w => w.includes('velocity record'))));
});
