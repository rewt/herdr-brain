import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, hold } from './helpers/retire-fixture.mjs';
import { initOrg } from '../lib/store.mjs';
import { handoffCloseout } from '../lib/closeout-handoff.mjs';
import { publishCloseoutEvents, readCloseoutEntries, retryCloseout, retirementOwnerLock } from '../lib/closeout.mjs';
import { reconcile } from '../supervisor/reconcile.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { closer, lanes, events, waitForChange, setup, evaluations, effects, assertRemoved, child } from './helpers/closeout-fixture.mjs';

test('two concurrent ready enqueues bind one entry; a shutdown retry preserves a missing-producer HOLD wait', async t => {
  const f = setup(t), stop = hold(f); f.report(); f.land();
  f.state.delayWorkspace = 25; f.save();
  const results = await Promise.all([1, 2].map(() => child(process.execPath, [lanes, 'ready', 'topic'], { cwd: f.repo, env: f.env })));
  for (const result of results) assert.equal(result.status, 0, result.stdout + result.stderr);
  await waitForChange([f.eventFile], () => evaluations(f).length && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), { timeoutMs: 60000 });
  assert.equal(readCloseoutEntries(f.common).filter(e => e.signal === 'ready').length, 1);
  // A retry arrives at the atomic empty-exit handoff. It must get either this
  // consumer or a newly claimed consumer; it cannot disappear between them.
  let wake;
  f.drain({ beforeExit: () => { stop(); wake = child(process.execPath, [closer, 'retry', 'topic', '--why', 'hold-removed'], { cwd: f.repo, env: f.env }); } });
  const result = await wake; assert.equal(result.status, 0, result.stdout + result.stderr);
  await waitForChange([f.eventFile], () => events(f).some(e => e.type === 'closeout.retry') && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), { timeoutMs: 60000 });
  assert.equal(fs.existsSync(f.lane), true); assert.deepEqual(f.read().actions, []);
  assert.equal(readCloseoutEntries(f.common).filter(e => e.signal === 'ready').length, 1);
  assert.ok(evaluations(f).some(e => /HOLD/.test(e.reason) && e.waiting.defect && !e.waiting.producers.length));
});

test('an active consumer skips an unhanded landing and explicit event replay cannot execute it', async t => {
  const f = setup(t, { occupied: false, merged: true }); f.report(); f.autoTail = false;
  let source;
  const first = f.drain({ onClaim: () => {
    source = f.land().find(e => e.type === 'promotion.reconciled');
    publishCloseoutEvents({ cwd: f.repo, org: f.org, added: [source], env: f.env });
  } });
  assert.equal(first.evaluated.some(e => e.source.type === 'promotion.reconciled'), false);
  assert.equal(fs.existsSync(f.lane), true);
  const entry = readCloseoutEntries(f.common).find(e => e.source.seq === source.seq);
  assert.equal(entry.handoff, undefined);
  assert.equal(effects(f).some(e => e.action === 'lane-removed'), false);
  await waitForChange([f.eventFile], () => !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')));
  const keys = handoffCloseout({ cwd: f.repo, org: f.org, receipt: f.receipts.get(source.batch), env: f.env });
  const result = f.drain({ keys });
  assert.equal(result.evaluated.filter(e => e.completed && e.source.type === 'promotion.reconciled').length, 1, JSON.stringify(result));
  assertRemoved(f);
  f.drain(); // Finish the earlier ready request's separate lane-removed revision.
  const before = events(f); handoffCloseout({ cwd: f.repo, org: f.org, receipt: f.receipts.get(source.batch), env: f.env });
  f.drain(); assert.deepEqual(events(f), before);
});

test('native observation, exit and preservation preflight hold only consumer/retirement claims; Git removal alone excludes promotion', t => {
  const f = setup(t), command = f.options.command, log = f.options.log;
  f.report(); initOrg(f.org);
  const manifest = path.join(f.scratch, 'replay-manifest.json'), prepared = path.join(f.scratch, 'replay-prepared.json'), gate = path.join(f.scratch, 'replay-gate.log');
  fs.writeFileSync(manifest, JSON.stringify({ batch: 'native-lock-witness', candidate: f.head,
    items: [{ item: 'ENG-1', run: 'R-1', head: f.head, superseded: [], why: 'accepted offline witness' }], excluded: [] }));
  const args = ['--repo', f.repo, '--org', f.org, '--role', 'supervisor', '--prepared', prepared];
  reconcile(['prepare', ...args, '--manifest', manifest, '--gate-log', gate]);
  f.git(['merge', '--ff-only', f.head]); fs.writeFileSync(gate, 'one successful offline gate\n');
  const finish = () => reconcile(['finish', ...args, '--gate-exit', '0', '--tip', f.head]);
  finish(); handoffCloseout({ cwd: f.repo, org: f.org, receipt: prepared + '.record.json', env: f.env });
  const phases = new Set();
  const checkUnlocked = phase => {
    assert.ok(fs.existsSync(path.join(f.common, 'closeout/consumer.lock')));
    assert.ok(fs.existsSync(retirementOwnerLock(f.common)));
    assert.equal(fs.existsSync(path.join(f.org, 'lock')), false, phase);
    assert.equal(fs.existsSync(path.join(f.common, 'lane-promote.lock')), false, phase);
    if (!phases.has(phase)) assert.equal(finish().replayed, true);
    phases.add(phase);
  };
  f.options.command = (exe, args, opt) => {
    if (exe === f.job.herdr && args[0] === 'workspace' && args[1] === 'list') checkUnlocked('native');
    if (exe === f.job.herdr && args[0] === 'agent' && args[1] === 'prompt') checkUnlocked('exit');
    if (exe === 'git' && args.includes('remove')) {
      assert.ok(fs.existsSync(path.join(f.common, 'lane-promote.lock')));
      assert.throws(finish, /locked:.*lane-promote.lock/);
      phases.add('Git');
    }
    return command(exe, args, opt);
  };
  f.options.log = row => { log(row); if (row.action === 'lane-preflight') checkUnlocked('preflight'); };
  f.drain(); assertRemoved(f); assert.equal(finish().replayed, true);
  assert.deepEqual([...phases].sort(), ['Git', 'exit', 'native', 'preflight']);
});

test('closer lock contention discards preparation; only a named safe turn retries removal', t => {
  const f = setup(t, { occupied: false, terminal: true }), release = acquireLock(path.join(f.common, 'lane-promote.lock'));
  const log = f.options.log, preparation = [], discarded = [];
  f.options.log = row => {
    log(row);
    if (row.action === 'lane-preflight') preparation.push(row);
    if (row.action === 'lane-evidence-discarded') discarded.push(row.directory);
  };
  const read = fs.readFileSync; let producerReads = 0;
  fs.readFileSync = function(file, ...args) {
    if (file === path.join(f.common, 'promote/queue.json')) producerReads++;
    return read.call(this, file, ...args);
  };
  t.after(() => { fs.readFileSync = read; });
  let blocked;
  try {
    f.drain();
    blocked = evaluations(f).find(e => /^locked:/.test(e.reason));
    assert.ok(blocked, JSON.stringify(evaluations(f)));
    assert.equal(blocked.completed, false);
    assert.equal(blocked.condition.kind, 'contention');
    assert.equal(blocked.condition.continuation.kind, 'pre-effect-observation');
    assert.equal(blocked.failure, undefined);
    assert.deepEqual(blocked.waiting, { owner: 'lane-closeout', next: 'pre-effect-observation', producers: [] });
    assert.equal(events(f).some(e => e.type === 'closeout.waiting' && e.key === blocked.key), false);
    assert.equal(preparation.length, 1);
    assert.deepEqual(discarded, [preparation[0].evidence.directory]);
    assert.equal(fs.existsSync(preparation[0].evidence.directory), false);
    assert.equal(fs.existsSync(f.lane), true);
    assert.equal(effects(f).some(e => ['git-removal-started', 'worktree-removed'].includes(e.action)), false);
  } finally { release(); }
  const old = evaluations(f).length, native = f.herdrCalls().length;
  f.drain(); assert.equal(evaluations(f).length, old, 'lock release is not a polling signal');
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'lifecycle-lock-released', start: false });
  assert.deepEqual(f.drain().evaluated, []);
  assert.equal(fs.existsSync(f.lane), true); assert.equal(f.herdrCalls().length, native);
  const before = events(f), next = f.drain({ keys: [blocked.key], retrySafe: true });
  assert.equal(next.evaluated.length, 1);
  assert.equal(next.evaluated[0].completed, true, JSON.stringify(next));
  assert.equal(preparation.length, 2, 'the named turn prepares removal again');
  assert.notEqual(preparation[1].evidence.directory, preparation[0].evidence.directory);
  assert.equal(effects(f).find(e => e.action === 'worktree-removed').evidence.directory, preparation[1].evidence.directory);
  assert.equal(producerReads, 0, 'pre-effect contention needs no outside promotion-job producer');
  assert.deepEqual(events(f).slice(0, before.length), before, 'the original contention evidence stays immutable');
  assertRemoved(f);
});

for(const change of ['activity','owner','reference','HOLD'])test(`retirement housekeeping final CAS ${change==='activity'?'allows unrelated activity':'retains '+change+' changes'}`,t=>{
  const f=setup(t,{occupied:false,terminal:true}),command=f.options.command,log=f.options.log,job=path.join(f.org,'housekeeping/default'),lock=path.join(job,'lock');fs.mkdirSync(lock,{recursive:true});
  const owner=path.join(lock,'owner.json');fs.writeFileSync(owner,JSON.stringify({pid:40001,cwd:f.repo,retirement_queue_protocol:2}));let prepared=false,changed=false;
  f.options.log=row=>{log(row);if(row.action==='lane-preflight')prepared=true;};
  f.options.command=(exe,args,opt)=>{
    if(prepared&&!changed&&exe==='git'&&fs.existsSync(path.join(f.common,'lane-promote.lock'))){
      changed=true;
      if(change==='activity'){fs.writeFileSync(path.join(job,'state.json'),'another ordinary pass');fs.appendFileSync(path.join(job,'activity.jsonl'),'unrelated heartbeat\n');}
      if(change==='owner')fs.writeFileSync(owner,JSON.stringify({pid:40002,cwd:f.repo,retirement_queue_protocol:2}));
      if(change==='reference'){fs.mkdirSync(path.join(f.org,'references'),{recursive:true});fs.writeFileSync(path.join(f.org,'references/live.json'),JSON.stringify({schema:'herdr-reference/v1',owner:'fixture',kind:'live',run:'R-1',cwd:f.lane,state:'running',created_at:'2020-01-01',expires_at:'2099-01-01'}));}
      if(change==='HOLD')hold(f);
    }
    return command(exe,args,opt);
  };
  const result=f.drain();assert.equal(changed,true,'changed input reaches the final locked removal boundary');
  if(change==='activity')assertRemoved(f);
  else{assert.equal(fs.existsSync(f.lane),true);assert.equal(effects(f).some(e=>e.action==='lane-removed'),false);assert.ok(evaluations(f).some(e=>!e.completed),JSON.stringify(result));}
});
