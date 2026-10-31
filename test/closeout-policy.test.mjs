import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { exitFixture } from './helpers/retire-exit-fixture.mjs';
import { fixture, isolatedEnv } from './helpers/retire-fixture.mjs';
import { initOrg, loadEvents, transact } from '../lib/store.mjs';
import { joinFleet } from '../lib/fleet.mjs';
import { bindCloseoutSources, publishCloseoutEvents, readCloseoutEntries, readyLane, closeoutPolicy, retirementOwnerLock, retryPromotionCloseout, closeoutRevision, pruneCompletedCloseout, closeoutKey, recoverLane } from '../lib/closeout.mjs';
import { retirementLock } from '../lib/retire-lock.mjs';
import { finishCleanup, retryCleanup, drain as drainPromotions, queueFor } from '../promote/promote.mjs';
import { closeoutWaitId, closeoutWaitState } from '../lib/closeout-status.mjs';
import { currentCloseoutEntries } from '../lib/closeout.mjs';
import { cli, closer, events, waitForChange, setup, evaluations, effects, assertRemoved, child } from './helpers/closeout-fixture.mjs';

test('default landing and named requests, full-source opt-in, opt-out and canonical ownership', t => {
  const f = fixture(t, { occupied: false });
  fs.unlinkSync(path.join(f.repo, '.lane.json'));
  assert.equal(closeoutPolicy(f.repo), true);
  assert.equal(closeoutPolicy(f.repo, 'report.ingested'), false);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{}');
  assert.equal(closeoutPolicy(f.repo), true);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{"retirement":{"closeout_queue":false}}');
  assert.equal(closeoutPolicy(f.repo), false);
  fs.writeFileSync(path.join(f.lane, '.lane.json'), '{"retirement":{"closeout_queue":true}}');
  assert.deepEqual(publishCloseoutEvents({ cwd: f.lane, org: f.org, added: events(f) }), []);
  assert.deepEqual(readCloseoutEntries(f.common), []);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{"retirement":{"closeout_queue":"yes"}}');
  assert.throws(() => closeoutPolicy(f.repo), /invalid/);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{"retirement":{"closeout_queue":true}}');
  assert.equal(closeoutPolicy(f.repo), true);
});

for (const config of [null, {}, { retirement: {} }, { retirement: { closeout_queue: false } }, { retirement: { closeout_queue: true } }])
test(`automatic report stays opt-in; default landing/named policy (${config === null ? 'no config' : JSON.stringify(config)})`, async t => {
  const f = setup(t, { occupied: false }), file = path.join(f.scratch, 'report.md');
  if (config === null) fs.unlinkSync(path.join(f.repo, '.lane.json'));
  else fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify(config));
  assert.equal(closeoutPolicy(f.repo), config?.retirement?.closeout_queue !== false);
  fs.writeFileSync(file, '---\nrun: R-1\noutcome: done\nsummary: Complete.\nblockers: []\nproposals: []\n---\n');
  const result = spawnSync(process.execPath, [cli, 'ingest', file], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const source = events(f).find(e => e.type === 'report.ingested');
  assert.equal(source.report.outcome, 'done');
  if (config?.retirement?.closeout_queue) {
    assert.equal(source.closeout_targets.length, 1);
    assert.equal(source.closeout_targets[0].reportCloseout,true);
    assert.deepEqual(readCloseoutEntries(f.common),[],'direct report wakeup creates no per-allocation queue file');
    await waitForChange([f.eventFile], () => evaluations(f).length && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')));
    assert.ok(f.herdrCalls().some(a => a[0] === 'workspace' && a[1] === 'list'));
    assert.deepEqual(readCloseoutEntries(f.common),[]);
  } else {
    assert.equal(source.closeout_targets, undefined);
    assert.deepEqual(readCloseoutEntries(f.common), []);
    assert.equal(fs.existsSync(path.join(f.common, 'closeout/worker.log')), false, 'ingestion never launches the closer');
    assert.deepEqual(f.herdrCalls(), []);
    assert.equal(fs.existsSync(path.join(f.common, 'lane-promote.lock')), false);
    const landed = f.land();
    const disabled = config?.retirement?.closeout_queue === false;
    assert.equal(landed.at(-1).closeout_targets?.length ?? 0, disabled ? 0 : 1);
    if (!disabled) {
      assert.equal(readCloseoutEntries(f.common).find(e => e.signal === 'landed').schema, 'closeout-entry/v2');
      f.drain(); assertRemoved(f);
      return;
    }
    readyLane({ cwd: f.repo, org: f.org, topic: 'topic', run: 'R-1', env: f.env, start: false });
    recoverLane({ cwd: f.repo, org: f.org, lane: f.lane, env: f.env, start: false });
    assert.deepEqual(readCloseoutEntries(f.common), []);
    assert.equal(fs.existsSync(path.join(f.common, 'closeout/worker.log')), false);
    assert.deepEqual(f.herdrCalls(), []);
    assert.equal(fs.existsSync(f.lane), true);
  }
});

for (const type of ['report.ingested', 'review.verdict', 'item.closed', 'promotion.reconciled', 'lane.ready', 'lane.recovery-requested'])
test(`publication rechecks opt-in even when ${type} already has a binding`, t => {
  const f = setup(t, { occupied: false });
  const source = {
    'report.ingested': { type, run: 'R-1', report: { outcome: 'done', summary: 'Complete' }, sha256: 'fixture' },
    'review.verdict': { type, common: f.common, run: 'R-1', head: f.head, review: { id: 'bound-review', run: 'R-1' } },
    'item.closed': { type, id: 'ENG-1', as: 'dropped' },
    'promotion.reconciled': { type, identity: f.common, runs: ['R-1'], heads: [{ run: 'R-1', head: f.head }] },
    'lane.ready': { type, common: f.common, run: 'R-1', head: f.head },
    'lane.recovery-requested': { type, common: f.common, run: 'R-1', head: f.head, signal: 'landed' },
  }[type];
  const { added } = transact(f.org, current => bindCloseoutSources({ cwd: f.repo, org: f.org, events: current, mutation: { add: [
    source,
  ] } }));
  assert.equal(added[0].closeout_targets.length, 1);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{"retirement":{"closeout_queue":false}}');
  assert.deepEqual(publishCloseoutEvents({ cwd: f.repo, org: f.org, added, env: f.env }), []);
  assert.deepEqual(readCloseoutEntries(f.common), []);
  assert.equal(fs.existsSync(path.join(f.common, 'closeout/worker.log')), false);
  assert.deepEqual(f.herdrCalls(), []);
});

test('a hand-edited unknown desk route holds direct closeout policy and its consumer', t => {
  const f = setup(t, { occupied: false });
  const file = path.join(f.repo, '.lane.json');
  const config = { retirement: { closeout_queue: true }, routes: { reviewer: { kind: 'codex' } }, settle: { review_route: 'reviewer' } };
  fs.writeFileSync(file, JSON.stringify(config));
  assert.equal(closeoutPolicy(f.repo), true);
  config.settle.review_route = 'unknown-hand-edit'; fs.writeFileSync(file, JSON.stringify(config));
  assert.throws(() => closeoutPolicy(f.repo), /unknown route: unknown-hand-edit.*held/);
  assert.throws(() => f.drain(), /unknown route: unknown-hand-edit.*held/);
  assert.equal(fs.existsSync(f.lane), true);
  assert.deepEqual(effects(f), []);
});

test('source binding uses the supplied fleet environment through publication', t => {
  const f = setup(t, { occupied: false }), env = { ...f.env, HERDR_MONITOR_FLEET: path.join(f.scratch, 'binding-fleet.json') };
  fs.unlinkSync(path.join(f.repo, '.org'));
  joinFleet({ cwd: f.repo, record: f.org, worktrees: path.join(f.scratch, 'worktrees'), layers: [], env });
  const add = [{ type: 'report.ingested', run: 'R-1', report: { outcome: 'done', summary: 'Complete' }, sha256: 'fixture' }];
  const unbound = bindCloseoutSources({ cwd: f.repo, org: f.org, events: events(f), mutation: { add }, env: f.env });
  assert.equal(unbound.add[0].closeout_targets, undefined, 'an unrelated discovery environment grants no binding');
  const committed = transact(f.org, current => bindCloseoutSources({ cwd: f.repo, org: f.org, events: current, mutation: { add }, env }));
  assert.equal(committed.added[0].closeout_targets.length, 1);
  const published = publishCloseoutEvents({ cwd: f.repo, org: f.org, added: committed.added, env, start: false });
  assert.equal(published.length, 1);
  assert.deepEqual(readCloseoutEntries(f.common), [], 'direct reports have no persisted queue entry');
  const [entry] = currentCloseoutEntries(f.common, f.org, events(f));
  assert.equal(entry.org, fs.realpathSync(f.org)); assert.equal(entry.reportCloseout, true);
  assert.deepEqual(entry.source, {seq: committed.added[0].seq, type: 'report.ingested'});
});

test('concurrent foreign-record CLI writers neither consume nor prune the project record queue', async t => {
  const f = setup(t); f.report();
  const foreign = path.join(f.scratch, 'foreign-record'); initOrg(foreign);
  const [entry] = readCloseoutEntries(f.common);
  transact(f.org, () => ({ add: [{ type: 'closeout.evaluated', key: entry.key, identity: f.common, run: entry.run,
    item: entry.item, source: entry.source, revision: entry.source.seq, completed: true }] }));
  const entries = path.join(f.common, 'closeout/entries');
  fs.writeFileSync(path.join(entries, `${'f'.repeat(64)}.json`), '{"schema":"closeout-entry/v999"}\n');
  const before = fs.readdirSync(entries).map(name => [name, fs.readFileSync(path.join(entries, name), 'utf8')]);
  const recordBefore = fs.readFileSync(f.eventFile, 'utf8');
  assert.deepEqual(f.drain({ org: foreign, onClaim: () => assert.fail('a foreign record cannot claim the project consumer') }), { evaluated: [] });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => child(process.execPath,
    [cli, 'add', `Foreign ${i}`, '--role', 'engineer'], { cwd: i % 2 ? f.lane : f.repo, env: { ...f.env, ORG_DIR: foreign } })));
  for (const result of results) { assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(result.stderr, ''); }
  const written = loadEvents(foreign).events;
  assert.equal(written.length, 12); assert.ok(written.every(e => e.type === 'item.added'));
  assert.deepEqual(written.map(e => e.seq), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(new Set(results.map(r => r.stdout.trim())).size, 12);
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), recordBefore);
  assert.deepEqual(fs.readdirSync(entries).map(name => [name, fs.readFileSync(path.join(entries, name), 'utf8')]), before);
  assert.equal(fs.existsSync(path.join(f.common, 'closeout/worker.log')), false, 'foreign writes do not launch a closer');
  assert.deepEqual(f.read().actions, []);
});

test('own-record publication and drain ignore foreign-bound entries in the same project queue', t => {
  const f = setup(t); f.report();
  const foreign = path.join(f.scratch, 'foreign-record'); initOrg(foreign);
  const [entry] = readCloseoutEntries(f.common);
  const other = { ...entry, org: foreign, run: 'R-99', signal: 'landed', key: closeoutKey(entry.cwd, 'R-99', 'landed') };
  const file = path.join(f.common, 'closeout/entries', `${other.key}.json`), bytes = JSON.stringify(other) + '\n';
  fs.writeFileSync(file, bytes);
  f.append([{ type: 'item.added', id: 'ENG-2', title: 'Own record update', kind: 'work', role: 'engineer' }]);
  f.drain();
  assert.ok(evaluations(f).some(e => e.key === entry.key), 'the owning request is still evaluated');
  assert.equal(events(f).some(e => e.key === other.key), false, 'foreign entry produces no invalid or evaluated event');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes); assert.deepEqual(loadEvents(foreign).events, []);
  assert.deepEqual(f.read().actions, []);
});

for (const field of ['org', 'project']) test(`the owning record still diagnoses a changed ${field} binding without changing the entry`, t => {
  const f = setup(t); f.report();
  const [entry] = readCloseoutEntries(f.common), file = path.join(f.common, 'closeout/entries', `${entry.key}.json`);
  const changed = { ...entry, [field]: path.join(f.scratch, 'changed-binding') };
  const bytes = JSON.stringify(changed) + '\n'; fs.writeFileSync(file, bytes);
  f.drain();
  assert.ok(events(f).some(e => e.type === 'closeout.invalid' && e.key === entry.key && /record\/project binding changed/.test(e.reason)));
  assert.equal(fs.readFileSync(file, 'utf8'), bytes); assert.deepEqual(f.read().actions, []);
});

test('explicit opt-out promotion contention remains pending and retries every cleanup row after release', t => {
  const f = exitFixture(t); isolatedEnv(t, f);
  const queue = f.queue(), release = retirementLock(retirementOwnerLock(f.common));
  let released = false;
  try {
    const result = finishCleanup(f.job, { outcome: 'promoted', tip: f.head, workspace: f.lane }, queue, { now: 1000 });
    assert.equal(result.outcome, 'promoted'); assert.equal(result.cleanup.state, 'pending');
    assert.match(result.cleanup.last_refusal, /locked:.*retirement\/owner.lock/);
    assert.match(result.reason, /^integrated-but-cleanup-pending:/);
    queue.transaction(data => data.results.push(...['first', 'second'].map(id => ({ ...f.job, ...result, id }))));
    assert.doesNotThrow(() => retryCleanup(queue, { now: result.cleanup.next_attempt_at }));
    assert.deepEqual(queue.load().results.map(r => r.cleanup.attempts), [2, 2], 'contention cannot abort later rows');
    assert.deepEqual(f.read().actions, []); assert.equal(fs.existsSync(f.lane), true);
    const due = queue.load().results[0].cleanup.next_attempt_at;
    release(); released = true;
    retryCleanup(queue, { now: due });
    assert.deepEqual(queue.load().results.map(r => r.cleanup.state), ['complete', 'complete']);
    assert.equal(fs.existsSync(f.lane), false);
  } finally { if (!released) release(); }
});

test('ready ignores detached, non-Git and foreign workspaces, including a foreign lane with the same topic', t => {
  const f = setup(t), detached = path.join(f.scratch, 'detached'), plain = path.join(f.scratch, 'plain'), foreign = path.join(f.scratch, 'foreign');
  f.git(['worktree', 'add', '--detach', detached]); fs.mkdirSync(plain); fs.mkdirSync(foreign);
  f.git(['init', '-b', 'lane/topic'], foreign); f.git(['config', 'user.name', 'Fixture'], foreign);
  f.git(['config', 'user.email', 'fixture@example.invalid'], foreign); f.git(['commit', '--allow-empty', '-m', 'foreign'], foreign);
  f.append([detached, plain, foreign].map((workspace, i) => ({ type: 'run.started', id: `R-${i + 2}`, item: 'ENG-1', workspace, meta: {} })));
  assert.deepEqual(readyLane({ cwd: f.repo, org: f.org, topic: 'topic', start: false }), { run: 'R-1', signal: 'ready' });
  assert.equal(readCloseoutEntries(f.common)[0].cwd, f.lane);
});

test('non-lane and unavailable registered-lane reports retain typed binding exceptions without cleanup effects', t => {
  const f = setup(t), plain = path.join(f.scratch, 'planning'); fs.mkdirSync(plain);
  const assertKeptBinding = (source, code) => {
    assert.deepEqual(source.closeout_targets, []);
    const [error] = source.closeout_binding_errors;
    assert.equal(source.closeout_binding_errors.length, 1);
    assert.deepEqual({ run: error.run, signal: error.signal, code: error.code, disposition: error.disposition, owner: error.owner },
      { run: source.run, signal: 'ready', code, disposition: 'kept', owner: source.run });
    assert.ok(error.reason);
    assert.equal(source.closeout_binding_error, undefined);
    const kept = events(f).filter(e => e.type === 'closeout.binding-kept' && e.run === source.run);
    assert.equal(kept.length, 1);
    assert.deepEqual(kept[0].source, { seq: source.seq, type: source.type });
    assert.equal(kept[0].condition.kind, 'missing-identity');
    assert.equal(kept[0].completed, false);
    for (const resource of ['session', 'folder', 'branch']) assert.equal(kept[0].resources[resource].status, 'kept');
  };
  const stderr = process.stderr.write, messages = [];
  process.stderr.write = chunk => { messages.push(String(chunk)); return true; };
  try {
    const added = f.append([f.repo, plain].flatMap((workspace, i) => [
      { type: 'run.started', id: `R-${i + 2}`, item: 'ENG-1', workspace, meta: {} },
      { type: 'report.ingested', run: `R-${i + 2}`, report: { outcome: 'done' } },
    ]));
    for (const source of added.filter(e => e.type === 'report.ingested')) assertKeptBinding(source, 'NO_REGISTERED_ALLOCATION');
    fs.renameSync(f.lane, `${f.lane}-unavailable`);
    const [bad] = f.report();
    assertKeptBinding(bad, 'ALLOCATION_BINDING_FAILED');
    assert.deepEqual(readCloseoutEntries(f.common), []);
    assert.deepEqual(f.herdrCalls(), []); assert.deepEqual(effects(f), []); assert.deepEqual(f.read().actions, []);
    assert.deepEqual(messages, [], 'binding exceptions are durable record facts, without stderr-only warnings');
  } finally { process.stderr.write = stderr; }
});

test('promotion retries only its exact deferred lock target; empty drains never revisit completed or unrelated history', async t => {
  const f = setup(t); f.report(); f.land();
  for (let i = 2; i <= 5; i++) {
    const workspace = path.join(f.scratch, `target-${i}`);
    f.git(['worktree', 'add', '-b', `lane/target-${i}`, workspace]);
    f.append([{ type: 'item.added', id: `ENG-${i}`, kind: 'work', role: 'engineer' },
      { type: 'run.started', id: `R-${i}`, item: `ENG-${i}`, workspace, meta: {} },
      { type: 'promotion.reconciled', identity: f.common, heads: [{ run: `R-${i}`, head: f.head }], runs: [`R-${i}`], items: [`ENG-${i}`] }]);
  }
  const entries = readCloseoutEntries(f.common).filter(e => e.signal === 'landed');
  f.append(entries.flatMap(entry => {
    const prior={ type: 'closeout.evaluated', key: entry.key, identity: f.common, run: entry.run, item: entry.item,
      source: entry.source, revision: closeoutRevision(entry, events(f)), completed: entry.run === 'R-3',
      reason: entry.run === 'R-4' ? 'record source requires owner repair' : 'locked: promotion lifecycle' };
    if(prior.completed)return [prior];
    const waiting=entry.run==='R-4'?{owner:'line-service',defect:'record source requires owner repair',producers:[]}:
      {owner:'promotion-closeout',producers:[{kind:'lifecycle-release',job:entry.key,run:entry.run,head:entry.head,branch:entry.branch}]};
    return [prior,{type:'closeout.waiting',identity:f.common,key:entry.key,run:entry.run,item:entry.item,source:entry.source,
      revision:prior.revision,wait_id:closeoutWaitId(entry,prior),waiting}];
  }));
  const jobs = entries.filter(e => e.run !== 'R-2').map(e => ({ id: e.key, org: f.org, run: e.run, topic: e.branch.slice(5), tip: e.run === 'R-5' ? '0'.repeat(40) : e.head }));
  const queue = queueFor(f.repo);
  const before = events(f).length;
  await drainPromotions(queue);
  assert.equal(events(f).length, before, 'empty promotion drain does not retry historical entries');
  const added = retryPromotionCloseout({ cwd: f.repo, org: f.org, jobs, start: false });
  assert.deepEqual(added.map(e=>e.type),['closeout.lifecycle-released','closeout.producer-status'],
    'one callback records one lifecycle release and its newly linked completion');
  assert.deepEqual(added[0].jobs,jobs.map(({id,org,run,topic,tip})=>({id,run,topic,tip})));
  const statuses=()=>events(f).filter(e=>e.type==='closeout.producer-status');
  assert.deepEqual(statuses().map(e=>e.key),[entries.find(e=>e.run==='R-1').key],'only the exact owning callback resolves its wait');
  for(const entry of entries.filter(e=>!['R-1','R-3'].includes(e.run))){
    const wait=events(f).find(e=>e.type==='closeout.waiting'&&e.key===entry.key);assert.notEqual(closeoutWaitState(wait,events(f)),'complete',entry.run);
  }
  const completedStatuses=statuses(),beforeRepeat=events(f);
  // A release is a fresh callback fact: later waits require a sequence newer
  // than their revision, even when the job payload matches an earlier release.
  const repeated=retryPromotionCloseout({ cwd: f.repo, org: f.org, jobs, start: false });
  assert.equal(repeated.length,1,'an identical callback intentionally adds exactly one lifecycle release');
  assert.equal(repeated[0].type,'closeout.lifecycle-released');
  assert.deepEqual(repeated[0].jobs,added[0].jobs);
  assert.ok(repeated[0].seq>beforeRepeat.at(-1).seq,'the repeat is a fresh release fact');
  assert.deepEqual(events(f).slice(beforeRepeat.length),repeated,'no other record churn accompanies the repeat');
  assert.deepEqual(statuses(),completedStatuses,'repeated callback facts cannot duplicate linked completion');
  assert.equal(readCloseoutEntries(f.common).some(e => e.run === 'R-3'), false, 'completed request file is pruned after its durable receipt');
  const completed = entries.find(e => e.run === 'R-3'), source = events(f).find(e => e.seq === completed.source.seq);
  assert.deepEqual(publishCloseoutEvents({ cwd: f.repo, org: f.org, added: [source], start: false }), [], 'replay cannot resurrect a completed key');
  assert.equal(events(f).find(e => e.seq === source.seq).closeout_targets[0].gitIdentity.ino, completed.gitIdentity.ino, 'exact-run evidence remains in record');
});

test('source replay waiting on queue.lock cannot recreate a request completed and pruned during its wait', async t => {
  const f = setup(t, { occupied: false }), [source] = f.report(), [entry] = readCloseoutEntries(f.common);
  const lock = path.join(f.common, 'closeout/queue.lock'), marker = path.join(f.scratch, 'publisher-waiting');
  const release = retirementLock(lock);
  const replay = child(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { publishCloseoutEvents } from ${JSON.stringify(new URL('../lib/closeout.mjs', import.meta.url).href)};
    const original = fs.readFileSync;
    fs.readFileSync = (...args) => {
      if (args[0] === ${JSON.stringify(path.join(lock, 'owner.json'))}) fs.writeFileSync(${JSON.stringify(marker)}, 'waiting');
      return original(...args);
    };
    console.log(JSON.stringify(publishCloseoutEvents({ cwd: ${JSON.stringify(f.repo)}, org: ${JSON.stringify(f.org)}, added: [${JSON.stringify(source)}], start: false })));
  `], { cwd: f.repo, env: f.env });
  try {
    await waitForChange([marker], () => fs.existsSync(marker), { timeoutMs: 10000 });
    transact(f.org, () => ({ add: [{ type: 'closeout.evaluated', key: entry.key, identity: f.common, run: entry.run,
      item: entry.item, source: entry.source, revision: source.seq, completed: true }] }));
    pruneCompletedCloseout(f.common, f.org, [entry], events(f));
    assert.deepEqual(readCloseoutEntries(f.common), []);
  } finally { release(); }
  const result = await replay;
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), []);
  assert.deepEqual(readCloseoutEntries(f.common), []);
});
