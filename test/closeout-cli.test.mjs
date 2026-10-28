import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { fixture } from './helpers/retire-fixture.mjs';
import { fold } from '../lib/state.mjs';
import { handoffCloseout } from '../lib/closeout-handoff.mjs';
import { completionFingerprint, digest } from '../lib/completion.mjs';
import { readCloseoutEntries, readyLane, closeoutPolicy, recoverLane } from '../lib/closeout.mjs';
import { enqueue, queueFor } from '../promote/promote.mjs';
import { stopFixtureInbox } from './helpers/inbox.mjs';
import { cli, lanes, retirementCLI, events, waitForChange, setup, evaluations, effects, assertRemoved, child } from './helpers/closeout-fixture.mjs';

test('a report on disk is inert; the actual ingest CLI closes the finished session and saves its unlanded branch', async t => {
  const f = setup(t), file = path.join(f.scratch, 'report.md');
  fs.writeFileSync(file, '---\nrun: R-1\noutcome: done\nsummary: Complete.\nheadline: The change is complete.\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\ndecisions: []\nquestions: []\nchallenges: []\n---\n');
  assert.deepEqual(readCloseoutEntries(f.common), []);
  readyLane({ cwd: f.repo, org: f.org, topic: 'topic', start: false });
  const result = spawnSync(process.execPath, [cli, 'ingest', file], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await waitForChange([f.eventFile], () => evaluations(f).some(e => e.reportCloseout && e.completed) && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), { timeoutMs: 60000 });
  assert.equal(readCloseoutEntries(f.common).length, 1);
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t'], ['workspace', 'close', 'w']]);
  assert.equal(fs.existsSync(f.lane), false); assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
  assert.equal(events(f).filter(e => e.type === 'report.ingested').length, 1);
});

test('complete-batch binds but cannot start landing; its successful caller tail closes once', async t => {
  const f = setup(t, { merged: true });
  assert.equal(closeoutPolicy(f.repo), true); f.report();
  const gate = path.join(f.scratch, 'gate.log'); fs.writeFileSync(gate, 'offline accepted gate\n');
  const plan = { version: 1, org: f.org, batch: 'bch-eng-1661', identity: f.common, base: f.head, tip: f.head,
    prepared_seq: events(f).at(-1).seq,
    gate: { exit_code: 0, log: gate, sha256: createHash('sha256').update(fs.readFileSync(gate)).digest('hex') },
    items: [{ item: 'ENG-1', run: 'R-1', head: f.head, expected: completionFingerprint(fold(events(f)), 'ENG-1'), why: 'accepted', superseded: [] }], excluded: [] };
  const file = path.join(f.scratch, 'completion.json'); fs.writeFileSync(file, JSON.stringify(plan));
  const result = spawnSync(process.execPath, [cli, 'complete-batch', '--file', file], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), false);
  assert.equal(evaluations(f).length, 0);
  handoffCloseout({ cwd: f.repo, org: f.org, receipt: file, env: f.env });
  f.drain();
  assertRemoved(f);
  assert.equal(events(f).find(e => e.type === 'item.closed').as, 'done');
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t'], ['workspace', 'close', 'w']]);
});

test('the opted-in native train lands and delegates closeout', async t => {
  let f;
  // After hooks run in registration order. Stop the owner and its lifetime
  // watcher before fixture() removes the scratch directory and owner receipt.
  t.after(async () => {
    if (!f) return;
    assert.ok(fs.existsSync(f.scratch), 'inbox teardown must precede fixture scratch removal');
    await stopFixtureInbox(path.join(f.org, 'supervisor/inbox.log'), {
      script: fileURLToPath(new URL('../supervisor/prompt-supervisor.mjs', import.meta.url)) });
  });
  f = setup(t, { occupied: false }); f.report();
  const queue = queueFor(f.repo);
  enqueue(queue, ['topic'], { org: f.org, run: 'R-1', expectedHead: f.head,
    validate: 'true', laneCLI: lanes, herdr: f.job.herdr, to: 'fixture-supervisor', attempts: 1, retry: 0 });
  const drained = await child(process.execPath, ['--input-type=module', '-e', `
    import { drain, queueFor } from ${JSON.stringify(new URL('../promote/promote.mjs', import.meta.url).href)};
    await drain(queueFor(process.cwd()));
  `], { cwd: f.repo, env: f.env });
  assert.equal(drained.status, 0, drained.stdout + drained.stderr);
  const result = queue.load().results[0];
  assert.equal(result.outcome, 'promoted', JSON.stringify(result));
  assert.equal(result.cleanup.owner, 'closeout-queue');
  await waitForChange([f.eventFile], () => effects(f).some(e => e.action === 'lane-removed') && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')));
  assertRemoved(f);
  const landed = events(f).find(e => e.type === 'promotion.reconciled');
  assert.equal(landed.closeout_targets[0].signal, 'landed');
  assert.equal(closeoutPolicy(f.repo), true);
});

test('named manual recovery records a fresh bound request for a legacy lane without a landed queue entry', async t => {
  const f = setup(t, { merged: true }); f.report(); f.append([{ type: 'item.closed', id: 'ENG-1', as: 'done' }]);
  assert.equal(readCloseoutEntries(f.common).some(e => e.signal === 'landed'), false);
  const result = spawnSync(process.execPath, [retirementCLI, 'sweep', '--lane', f.lane, '--repo', f.repo, '--org', f.org], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await waitForChange([f.eventFile], () => effects(f).some(e => e.action === 'lane-removed') && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), { timeoutMs: 60000 });
  assertRemoved(f);
  assert.equal(events(f).find(e => e.type === 'lane.recovery-requested').closeout_targets[0].signal, 'landed');
});

function manualContentFixture(t, kind) {
  const f = setup(t, { occupied: false, merged: kind === 'integrated' });
  const original = events(f); original[0].parent = 'G-1';
  fs.writeFileSync(f.eventFile, original.map(e => JSON.stringify(e) + '\n').join(''));
  f.append([{ type: 'item.added', id: 'G-1', kind: 'goal' }]); f.report();
  if (kind === 'archival-retirement') {
    fs.writeFileSync(path.join(f.repo, 'main-only'), 'independent main work');
    f.git(['add', 'main-only']); f.git(['commit', '-qm', 'diverge main']);
    f.git(['cherry-pick', f.head]);
    assert.match(f.git(['cherry', 'main', f.head]), /^- /);
    assert.notEqual(f.git(['rev-parse', 'main']), f.head);
  }
  if (kind === 'archive-tagged') {
    f.git(['tag', 'archive/lane/topic', f.head]);
    f.append([{ type: 'run.abandoned', id: 'R-1', note: 'Explicitly superseded attempt' }]);
  }
  return f;
}

function manualSweep(f) {
  // The CLI and its detached consumer use the same deterministic native cwd/
  // file inventory as the in-process adapter fixtures. Git and Herdr stay real
  // disposable fixtures; no host process inventory is needed for these cases.
  const preload = path.join(f.scratch, 'native-inventory.cjs');
  fs.writeFileSync(preload, `const cp = require('node:child_process'), run = cp.spawnSync;
cp.spawnSync = (exe, args, options) => {
  if (exe === '/usr/sbin/lsof') return { status: 0, stderr: '', stdout:
    'p' + process.pid + '\\0' + (args.includes('-Fpfn0') ? 'fcwd\\0' : '') + 'n' + ${JSON.stringify(f.repo)} + '\\0\\n' };
  return run(exe, args, options);
};
require('node:module').syncBuiltinESMExports();\n`);
  return spawnSync(process.execPath, [retirementCLI, 'sweep', '--lane', f.lane, '--repo', f.repo, '--org', f.org], {
    cwd: f.repo, env: { ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(preload)}` }, encoding: 'utf8' });
}

for (const kind of ['integrated', 'archival-retirement', 'archive-tagged']) test(`opted-in sweep CLI releases a ${kind} legacy lane with an open item and parent`, async t => {
  const f = manualContentFixture(t, kind);
  assert.equal(readCloseoutEntries(f.common).some(e => ['landed', 'parked'].includes(e.signal)), false);
  fs.mkdirSync(path.join(f.lane, '.lane'));
  fs.writeFileSync(path.join(f.lane, '.lane/report.md'), 'durable legacy evidence\n');
  const result = manualSweep(f);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const source = events(f).find(e => e.type === 'lane.recovery-requested');
  assert.equal(source.content.kind, kind); assert.equal(source.content.head, f.head);
  assert.deepEqual(source.closeout_targets[0].content, source.content);
  await waitForChange([f.eventFile], () => evaluations(f).some(e => e.source.seq === source.seq) &&
    !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')));
  assert.equal(evaluations(f).findLast(e => e.source.seq === source.seq).completed, true, JSON.stringify(evaluations(f)));
  assertRemoved(f);
  const state = fold(events(f));
  assert.equal(state.items.get('ENG-1').closed, null); assert.equal(state.items.get('G-1').closed, null);
  const proof = effects(f).find(e => e.action === 'lane-preflight');
  assert.equal(fs.readFileSync(path.join(proof.evidence.directory, 'files/.lane/report.md'), 'utf8'), 'durable legacy evidence\n');
  if (kind !== 'integrated') {
    assert.equal(proof.integrated, false);
    assert.equal(f.git(['rev-parse', 'archive/lane/topic^{commit}']), f.head);
  }
  if (kind === 'archival-retirement') {
    assert.equal(proof.eligibility, kind); assert.equal(proof.archival.matchedPatchCount, 1);
    assert.equal(proof.mainTip, source.content.mainTip);
  }
});

for (const changed of ['patch history', 'patch policy', 'archive removed', 'archive moved']) test(`the closeout consumer rechecks named recovery after ${changed} changes`, t => {
  const kind = changed.startsWith('patch') ? 'archival-retirement' : 'archive-tagged';
  const f = manualContentFixture(t, kind);
  const source = recoverLane({ cwd: f.repo, org: f.org, lane: f.lane, env: f.env, start: false });
  assert.equal(source.content.kind, kind);
  assert.deepEqual(readCloseoutEntries(f.common).find(e => e.signal === 'landed').content, source.content);
  if (changed === 'patch history') f.git(['reset', '--hard', 'HEAD^']);
  if (changed === 'patch policy') fs.writeFileSync(path.join(f.repo, '.lane.json'), '{"retirement":{"closeout_queue":true,"archival_retirement":false}}');
  if (changed === 'archive removed') f.git(['tag', '-d', 'archive/lane/topic']);
  if (changed === 'archive moved') f.git(['tag', '-f', 'archive/lane/topic', 'main']);
  f.drain();
  const evaluated = evaluations(f).find(e => e.source.seq === source.seq);
  assert.equal(evaluated.completed, false); assert.match(evaluated.reason, /not integrated|does not match/);
  assert.equal(fs.existsSync(f.lane), true); assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
  assert.deepEqual(f.read().actions, []);
  assert.equal(effects(f).some(e => ['archive-created', 'lane-preflight', 'lane-removed'].includes(e.action)), false);
  if (!changed.startsWith('archive moved')) assert.equal(f.git(['tag', '--list', 'archive/lane/topic']), '');
});

test('opted-in sweep CLI keeps unintegrated untagged work with an open item', t => {
  const f = manualContentFixture(t, 'unintegrated'), result = manualSweep(f);
  assert.equal(result.status, 1); assert.match(result.stderr, /not integrated or exactly archived/);
  assert.equal(events(f).some(e => e.type === 'lane.recovery-requested'), false);
  assert.equal(fs.existsSync(f.lane), true); assert.equal(f.git(['tag', '--list', 'archive/lane/topic']), '');
  assert.deepEqual(f.read().actions, []);
});
