import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { exitFixture } from './helpers/retire-exit-fixture.mjs';
import { fixture, hold, isolatedEnv } from './helpers/retire-fixture.mjs';
import { sweepCommands } from './helpers/retire-sweep-fixture.mjs';
import { assertFixtureScratch } from './helpers/scratch-fixture.mjs';
import { setTimeout as pause } from 'node:timers/promises';
import { loadTimeout } from '../lib/deadline.mjs';
import { initOrg, loadEvents, transact } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { joinFleet } from '../lib/fleet.mjs';
import { fold as olderFold } from './fixtures/state-v0.mjs';
import { completionFingerprint } from '../lib/completion.mjs';
import { bindCloseoutSources, publishCloseoutEvents, readCloseoutEntries, readyLane, retryCloseout,
  closeoutPolicy, recordCompletedReview, retirementOwnerLock, retryPromotionCloseout, closeoutRevision, pruneCompletedCloseout, closeoutKey,
  recoverLane } from '../lib/closeout.mjs';
import { retirementLock } from '../lib/retire-lock.mjs';
import { drainCloseout } from '../lib/closeout-consumer.mjs';
import { createHousekeeping, tidyFinishedTabs } from '../housekeeping/housekeeping.mjs';
import { enqueue, finishCleanup, retryCleanup, drain as drainPromotions, queueFor } from '../promote/promote.mjs';
import { stopFixtureInbox } from './helpers/inbox.mjs';
import { retirementStatus, renderRetirementStatus } from '../lib/retire-status.mjs';

const cli = fileURLToPath(new URL('../bin/org.mjs', import.meta.url));
const closer = fileURLToPath(new URL('../supervisor/closeout.mjs', import.meta.url));
const lanes = fileURLToPath(new URL('../lanes/lane.mjs', import.meta.url));
const retirementCLI = fileURLToPath(new URL('../supervisor/retire.mjs', import.meta.url));
const events = f => loadEvents(f.org).events;
async function waitForChange(_files, predicate, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + loadTimeout(timeoutMs);
  while (!predicate()) { if (Date.now() >= deadline) throw Error('bounded fixture observation timed out'); await pause(25); }
}
function setup(t, { occupied = true, merged = false, terminal = false } = {}) {
  const f = occupied ? exitFixture(t) : fixture(t, { occupied, merged });
  if (occupied && !merged) f.git(['reset', '--hard', `${f.head}^`]);
  isolatedEnv(t, f);
  fs.symlinkSync(f.org, path.join(f.repo, '.org'));
  fs.appendFileSync(path.join(f.common, 'info/exclude'), '\n.org\n.lane/\n');
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ retirement: { closeout_queue: true } }));
  fs.writeFileSync(f.eventFile, events(f).filter(e => e.type !== 'item.closed' && e.type !== 'report.ingested').map(e => JSON.stringify(e) + '\n').join(''));
  const commands = sweepCommands(f);
  const options = { herdr: f.job.herdr, command: commands.command,
    log: row => { if (row.action === 'scratch-manifest') assertFixtureScratch(row.manifest, f.env, options.scratchRoots); },
    readOwner: owner => (f.read().info?.process_tree ?? []).some(p => p.pid === owner.pid && p.identity === owner.identity) };
  f.append = add => {
    const result = transact(f.org, current => bindCloseoutSources({ cwd: f.repo, org: f.org, events: current, mutation: { add } }), { actor: 'fixture' });
    publishCloseoutEvents({ cwd: f.repo, org: f.org, added: result.added, start: false, env: f.env });
    return result.added;
  };
  f.options = options;
  f.drain = extra => drainCloseout({ cwd: f.repo, org: f.org, env: f.env, retirementOptions: options, ...extra });
  f.report = () => f.append([{ type: 'report.ingested', run: 'R-1', report: { outcome: 'done', summary: 'Complete' }, sha256: 'fixture' }]);
  f.land = () => { f.git(['merge', '--ff-only', f.head]); return f.append([{ type: 'item.closed', id: 'ENG-1', as: 'done' }, {
    type: 'promotion.reconciled', identity: f.common, batch: 'fixture', tip: f.head,
    heads: [{ run: 'R-1', item: 'ENG-1', head: f.head }], runs: ['R-1'], items: ['ENG-1'],
  }]); };
  if (terminal) { f.report(); f.land(); }
  return f;
}
const evaluations = f => events(f).filter(e => e.type === 'closeout.evaluated');
const effects = f => events(f).filter(e => e.type === 'closeout.effect').map(e => e.outcome);
function assertRemoved(f) {
  assert.equal(fs.existsSync(f.lane), false);
  assert.equal(f.git(['branch', '--list', 'lane/topic']), '');
  assert.deepEqual(f.read().workspaces, []);
  assert.ok(effects(f).some(e => e.action === 'lane-removed'));
}

test('default off, explicit opt-in, malformed policy and canonical ownership', t => {
  const f = fixture(t, { occupied: false });
  fs.unlinkSync(path.join(f.repo, '.lane.json'));
  assert.equal(closeoutPolicy(f.repo), false);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{}');
  assert.equal(closeoutPolicy(f.repo), false);
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
test(`closeout starts only with explicit opt-in (${config === null ? 'no config' : JSON.stringify(config)})`, async t => {
  const f = setup(t, { occupied: false }), file = path.join(f.scratch, 'report.md');
  if (config === null) fs.unlinkSync(path.join(f.repo, '.lane.json'));
  else fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify(config));
  assert.equal(closeoutPolicy(f.repo), Boolean(config?.retirement?.closeout_queue));
  fs.writeFileSync(file, '---\nrun: R-1\noutcome: done\nsummary: Complete.\nblockers: []\nproposals: []\n---\n');
  const result = spawnSync(process.execPath, [cli, 'ingest', file], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const source = events(f).find(e => e.type === 'report.ingested');
  assert.equal(source.report.outcome, 'done');
  if (config?.retirement?.closeout_queue) {
    assert.equal(source.closeout_targets.length, 1);
    await waitForChange([f.eventFile], () => evaluations(f).length && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')));
    assert.ok(f.herdrCalls().some(a => a[0] === 'workspace' && a[1] === 'list'));
  } else {
    assert.equal(source.closeout_targets, undefined);
    assert.deepEqual(readCloseoutEntries(f.common), []);
    assert.equal(fs.existsSync(path.join(f.common, 'closeout/worker.log')), false, 'ingestion never launches the closer');
    assert.deepEqual(f.herdrCalls(), []);
    assert.equal(fs.existsSync(path.join(f.common, 'lane-promote.lock')), false);
    const reviewAndDrop = f.append([
      { type: 'review.verdict', common: f.common, run: 'R-1', head: f.head, review: { id: 'disabled-review', run: 'R-1' } },
      { type: 'item.closed', id: 'ENG-1', as: 'dropped' },
    ]);
    const landed = f.land();
    readyLane({ cwd: f.repo, org: f.org, topic: 'topic', run: 'R-1', env: f.env });
    recoverLane({ cwd: f.repo, org: f.org, lane: f.lane, env: f.env });
    publishCloseoutEvents({ cwd: f.repo, org: f.org, added: [...reviewAndDrop, ...landed], env: f.env });
    const sources = events(f).filter(e => ['report.ingested', 'review.verdict', 'item.closed',
      'promotion.reconciled', 'lane.ready', 'lane.recovery-requested'].includes(e.type));
    assert.equal(sources.length, 7);
    assert.ok(sources.every(e => e.closeout_targets === undefined));
    assert.deepEqual(readCloseoutEntries(f.common), []);
    assert.equal(fs.existsSync(path.join(f.common, 'closeout/worker.log')), false, 'no source launches a closer without opt-in');
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
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{}');
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
  assert.equal(readCloseoutEntries(f.common)[0].org, fs.realpathSync(f.org));
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

test('non-lane done reports are not applicable, while an unavailable registered lane still records a binding failure', t => {
  const f = setup(t), plain = path.join(f.scratch, 'planning'); fs.mkdirSync(plain);
  const stderr = process.stderr.write, messages = [];
  process.stderr.write = chunk => { messages.push(String(chunk)); return true; };
  try {
    const added = f.append([f.repo, plain].flatMap((workspace, i) => [
      { type: 'run.started', id: `R-${i + 2}`, item: 'ENG-1', workspace, meta: {} },
      { type: 'report.ingested', run: `R-${i + 2}`, report: { outcome: 'done' } },
    ]));
    for (const e of added.filter(e => e.type === 'report.ingested')) {
      assert.deepEqual(e.closeout_targets, []); assert.equal(e.closeout_binding_errors, undefined);
      assert.equal(e.closeout_binding_error, undefined);
    }
    assert.deepEqual(readCloseoutEntries(f.common), []); assert.deepEqual(messages, []);
    fs.renameSync(f.lane, `${f.lane}-unavailable`);
    const [bad] = f.report();
    assert.equal(bad.closeout_binding_errors[0].run, 'R-1');
    assert.match(messages.join(''), /no durable target binding/);
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
  f.append(entries.map(entry => ({ type: 'closeout.evaluated', key: entry.key, identity: f.common, run: entry.run, item: entry.item,
    source: entry.source, revision: closeoutRevision(entry, events(f)), completed: entry.run === 'R-3',
    waiting: { event: entry.run === 'R-4' ? 'target-record-changed' : 'lifecycle-lock-released' } })));
  const jobs = entries.filter(e => e.run !== 'R-2').map(e => ({ id: e.key, org: f.org, run: e.run, topic: e.branch.slice(5), tip: e.run === 'R-5' ? '0'.repeat(40) : e.head }));
  const queue = queueFor(f.repo);
  const before = events(f).length;
  await drainPromotions(queue);
  assert.equal(events(f).length, before, 'empty promotion drain does not retry historical entries');
  // A previous drain durably completed these jobs but stopped before notifying
  // the closer. Keep its consumer claimed so this fixture tests enqueue only.
  queue.transaction(data => { data.closeout_pending = jobs; });
  const release = retirementLock(path.join(f.common, 'closeout/consumer.lock'));
  try { await drainPromotions(queue); } finally { release(); }
  const added = events(f).filter(e => e.seq > before && e.type === 'closeout.retry');
  assert.equal(added.length, 1); assert.deepEqual(added[0].keys, [entries.find(e => e.run === 'R-1').key]);
  assert.deepEqual(queue.load().closeout_pending, [], 'bounded completion outbox is acknowledged after the durable enqueue');
  assert.deepEqual(retryPromotionCloseout({ cwd: f.repo, org: f.org, jobs, start: false }), [], 'an already requested retry adds no churn');
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

test('optional ready, repeated ready and ingested done are one entry; NEEDS-WORK retains its worker', t => {
  const f = setup(t);
  readyLane({ cwd: f.repo, org: f.org, topic: 'topic', start: false });
  readyLane({ cwd: f.repo, org: f.org, topic: 'topic', start: false });
  f.report();
  f.append([{ type: 'item.added', id: 'REV-1', role: 'reviewer', kind: 'work', parent: 'ENG-1' },
    { type: 'run.started', id: 'R-2', item: 'REV-1', workspace: f.lane, meta: {} },
    { type: 'report.ingested', run: 'R-2', report: { outcome: 'done', extra: { verdict: 'NEEDS-WORK' } } }]);
  assert.equal(readCloseoutEntries(f.common).filter(e => e.run === 'R-1').length, 1);
  f.drain();
  assert.deepEqual(f.read().actions, []);
  assert.ok(evaluations(f).some(e => !e.completed && e.waiting.event === 'target-record-changed'));
  const count = evaluations(f).length;
  f.drain(); assert.equal(evaluations(f).length, count, 'no rescan without a resolving revision');
});

for (const project of ['bch-cloak', 'herdr-brain']) test(`${project}: a landed event immediately releases and removes its exact lane, branch and empty workspace`, t => {
  const f = setup(t, { terminal: true });
  fs.mkdirSync(path.join(f.lane, '.lane'));
  fs.writeFileSync(path.join(f.lane, '.lane/evidence'), 'unique report and scratch\n');
  const [scratch] = JSON.parse(f.env.HERDR_TEST_SCRATCH_ROOTS), payload = path.join(scratch, 'run-review');
  fs.mkdirSync(payload, { recursive: true });
  fs.writeFileSync(path.join(payload, '.herdr-scratch.json'), JSON.stringify({ schema: 'herdr-scratch/v1', common: f.common, run: 'R-1' }));
  fs.writeFileSync(path.join(payload, 'result'), 'disposable');
  const nativeCommand = f.options.command;
  f.options.command = (exe, args, options) => exe === '/usr/sbin/lsof' && args.includes('-Fpfn0')
    ? { status: 0, stderr: '', stdout: `p${process.pid}\0fcwd\0n${f.repo}\0\n` }
    : nativeCommand(exe, args, options);
  const landed = readCloseoutEntries(f.common).find(e => e.signal === 'landed');
  assert.equal(landed.source.type, 'promotion.reconciled');
  f.drain(); assertRemoved(f);
  assert.deepEqual(readCloseoutEntries(f.common), [], 'only durable record evidence remains after completion');
  const actions = effects(f).map(e => e.action);
  for (const action of ['exit-observed', 'closed', 'lane-preflight', 'worktree-removed', 'branch-removed', 'lane-removed']) assert.ok(actions.includes(action), action);
  const proof = effects(f).find(e => e.action === 'lane-preflight');
  assert.equal(fs.existsSync(payload), false, 'the queue calls the guarded executor scratch sweep');
  const sweep = JSON.parse(fs.readFileSync(proof.scratchManifest));
  assert.equal(sweep.entries.find(e => e.path === payload).disposition, 'removed');
  assert.equal(fs.readFileSync(path.join(proof.evidence.directory, 'files/.lane/evidence'), 'utf8'), 'unique report and scratch\n');
  const completion = events(f).find(e => e.type === 'closeout.effect' && e.outcome.action === 'lane-removed');
  const source = events(f).find(e => e.type === 'promotion.reconciled');
  assert.ok(Date.parse(completion.at) - Date.parse(source.at) < 1800000, 'no scheduling delay before closeout');
  const nativeActions = f.read().actions;
  f.drain(); assert.deepEqual(f.read().actions, nativeActions, 'completed effects do not repeat');
});

for (const abandoned of [false, true, 'at-landing']) test(`a fix round retains its ${abandoned === 'at-landing' ? 'unreported until landing' : abandoned ? 'record-superseded' : 'reported'} worker, and landing closes every ended session in that lane`, t => {
  const f = setup(t);
  if (abandoned) {
    readyLane({ cwd: f.repo, org: f.org, topic: 'topic', start: false });
    if (abandoned === true) f.append([{ type: 'run.abandoned', id: 'R-1', note: 'superseded by a fresh fix worker' }]);
  } else f.report();
  f.drain();
  assert.deepEqual(f.read().actions, [], 'the worker stays available during review and fixes');
  fs.writeFileSync(path.join(f.lane, 'seed'), 'fixed'); f.git(['commit', '-am', 'fix'], f.lane);
  const head = f.git(['rev-parse', 'HEAD'], f.lane); f.git(['merge', '--ff-only', head]);
  f.state.tabs.push({ tab_id: 'w:fix', workspace_id: 'w' });
  f.state.panes.push({ pane_id: 'w:fix:p', tab_id: 'w:fix', workspace_id: 'w', terminal_id: 'fix-terminal' });
  f.state.agents.push({ ...f.state.agents[0], name: 'fix-worker', pane_id: 'w:fix:p', tab_id: 'w:fix',
    terminal_id: 'fix-terminal', agent_session: { value: 'fix-session' } });
  f.save();
  const base = f.options.command;
  f.options.command = (exe, args, opt) => {
    if (exe !== f.job.herdr) return base(exe, args, opt);
    const current = f.read(), out = result => ({ status: 0, stdout: JSON.stringify({ result }), stderr: '' });
    if (args[0] === 'pane' && args[1] === 'process-info') return out({ process_info: current.exited?.includes(args.at(-1)) ? {
      shell_pid: 1, foreground_processes: [{ pid: 1, name: 'zsh' }], process_tree_complete: true, process_tree: [current.info.process_tree[0]],
    } : current.info });
    if (args[0] === 'agent' && args[1] === 'prompt') {
      const agent = current.agents.find(a => a.name === args[2]);
      current.actions.push(args); current.exited = [...(current.exited ?? []), agent.pane_id];
      current.agents = current.agents.filter(a => a.name !== args[2]); fs.writeFileSync(f.file, JSON.stringify(current)); return out({});
    }
    return base(exe, args, opt);
  };
  f.append([{ type: 'run.started', id: 'R-2', item: 'ENG-1', workspace: f.lane, meta: { agent: 'fix-worker', pane: 'w:fix:p',
    worker_workspace: 'w', terminal_id: 'fix-terminal', agent_session_id: 'fix-session', lane: 'topic' } },
    { type: 'report.ingested', run: 'R-2', report: { outcome: 'done' } }]);
  if (abandoned === 'at-landing') {
    f.append([{ type: 'run.abandoned', id: 'R-1', note: 'explicit supersession at reconciliation' }, { type: 'item.closed', id: 'ENG-1', as: 'done' }]);
    f.drain(); assert.deepEqual(f.read().actions, [], 'the successor remains observable for the new supersession proof');
  }
  f.append([...(abandoned === 'at-landing' ? [] : [{ type: 'item.closed', id: 'ENG-1', as: 'done' }]),
    { type: 'promotion.reconciled', identity: f.common, heads: [{ run: 'R-2', item: 'ENG-1', head }], runs: ['R-2'], items: ['ENG-1'] }]);
  const landed = readCloseoutEntries(f.common).find(e => e.signal === 'landed');
  assert.deepEqual(landed.panes.map(p => p.run), ['R-1', 'R-2']);
  f.drain(); assertRemoved(f);
  assert.deepEqual(f.read().actions.filter(a => a[0] === 'agent').map(a => a[2]), ['worker', 'fix-worker']);
  assert.equal(f.read().actions.filter(a => a[0] === 'tab').length, 2);
  if (abandoned) assert.ok(events(f).some(e => e.type === 'retirement.release' && e.run === 'R-1'));
});

function reviewFixture(t, followup_expected = false) {
  const f = setup(t), initial = events(f);
  initial[1].meta = { ...initial[1].meta, agent: 'original-worker', pane: 'original-pane', terminal_id: 'original-terminal', agent_session_id: 'original-session' };
  fs.writeFileSync(f.eventFile, initial.map(e => JSON.stringify(e) + '\n').join(''));
  f.report();
  const r = f.retirement(f.options);
  r.recordCallback({ kind: 'settle', pane: 'w:p', agent: 'worker', run: 'R-1' });
  const evidence = path.join(f.scratch, 'review.md'), bytes = '**NEEDS-WORK**\nFindings retained.\n';
  fs.writeFileSync(evidence, bytes);
  const receipt = r.recordReviewVerdict({ pane: 'w:p', run: 'R-1', verdict: 'NEEDS-WORK', head: f.head,
    evidence, sha256: createHash('sha256').update(bytes).digest('hex'), followup_expected, deferCloseout: true });
  recordCompletedReview({ cwd: f.repo, org: f.org, receipt, head: f.head, item: 'ENG-1', start: false, env: f.env });
  return f;
}

test('review.verdict releases only its exact reviewer and preserves the worker and lane for fixes', t => {
  const f = reviewFixture(t), before = fold(events(f));
  assert.equal(events(f).filter(e => e.type === 'review.verdict').length, 1);
  f.drain();
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t']]);
  assert.equal(fs.existsSync(f.lane), true);
  assert.equal(f.read().workspaces.length, 1, 'pane-only release cannot close a workspace');
  assert.equal(events(f).find(e => e.type === 'retirement.release').recipient, 'reviewer');
  assert.deepEqual(fold(events(f)).runs, before.runs);
  assert.deepEqual(olderFold(events(f)).runs, olderFold(events(f).filter(e => !e.type.startsWith('review.') && !e.type.startsWith('closeout.'))).runs);
});

test('an explicit same-session reviewer follow-up keeps until its recorded end', t => {
  const f = reviewFixture(t, true);
  f.drain(); assert.deepEqual(f.read().actions, []);
  const review = events(f).find(e => e.type === 'review.verdict');
  f.append([{ type: 'review.followup-ended', review_id: review.review.id, run: review.run, item: review.item, source_seq: review.seq, why: 'follow-up completed' }]);
  f.drain(); assert.equal(f.read().actions.filter(a => a[0] === 'tab').length, 1);
});

test('HOLD stays deferred with a named resolving event; explicit removal retry re-enqueues and closes', t => {
  const f = setup(t, { terminal: true }), releaseHold = hold(f);
  f.drain();
  assert.deepEqual(f.read().actions, []);
  assert.ok(evaluations(f).every(e => !e.completed && e.waiting.event === 'hold-removed'));
  releaseHold();
  const before = evaluations(f).length;
  f.drain(); assert.equal(evaluations(f).length, before, 'removing an unobservable file is not an implicit poll');
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'hold-removed', start: false });
  f.drain(); assertRemoved(f);
});

for (const changed of ['head', 'pane', 'dirty', 'reference']) test(`${changed} changes keep the bound target with a recorded reason`, t => {
  const f = setup(t, { terminal: true });
  if (changed === 'head' || changed === 'dirty') fs.writeFileSync(path.join(f.lane, 'seed'), 'later work');
  if (changed === 'head') f.git(['commit', '-am', 'later'], f.lane);
  if (changed === 'pane') { f.state.agents[0].agent_session.value = 'replacement'; f.save(); }
  if (changed === 'reference') fs.writeFileSync(path.join(f.org, 'references/live.json'), JSON.stringify({ schema: 'herdr-reference/v1', owner: 'fixture',
    kind: 'named follow-up', job: 'follow-up', run: 'R-1', item: 'ENG-1', state: 'running', created_at: '2020-01-01', expires_at: '2099-01-01' }));
  f.drain();
  assert.deepEqual(f.read().actions, []);
  assert.ok(evaluations(f).every(e => !e.completed && e.reason && e.waiting.retry));
  assert.equal(fs.existsSync(f.lane), true);
});

test('a blocked target does not hold an unrelated eligible target at the head of the queue', t => {
  const f = setup(t, { terminal: true }), other = path.join(f.scratch, 'other');
  fs.writeFileSync(path.join(f.org, 'references/live.json'), JSON.stringify({ schema: 'herdr-reference/v1', owner: 'fixture',
    kind: 'named follow-up', job: 'follow-up', run: 'R-1', item: 'ENG-1', state: 'running', created_at: '2020-01-01', expires_at: '2099-01-01' }));
  f.git(['worktree', 'add', '-b', 'lane/other', other]);
  fs.writeFileSync(path.join(other, 'seed'), 'other work'); f.git(['commit', '-am', 'other'], other);
  const head = f.git(['rev-parse', 'HEAD'], other); f.git(['merge', '--ff-only', head]);
  f.append([{ type: 'item.added', id: 'ENG-2', kind: 'work', role: 'engineer' },
    { type: 'run.started', id: 'R-2', item: 'ENG-2', workspace: other, meta: {} },
    { type: 'report.ingested', run: 'R-2', report: { outcome: 'done' } }, { type: 'item.closed', id: 'ENG-2', as: 'done' },
    { type: 'promotion.reconciled', identity: f.common, heads: [{ run: 'R-2', item: 'ENG-2', head }], runs: ['R-2'], items: ['ENG-2'] }]);
  fs.writeFileSync(path.join(f.common, 'closeout/entries', `${'f'.repeat(64)}.json`), '{"schema":"closeout-entry/v999"}\n');
  f.drain();
  assert.equal(fs.existsSync(f.lane), true);
  assert.equal(fs.existsSync(other), false);
  assert.ok(effects(f).some(e => e.action === 'lane-removed' && e.cwd === other));
  assert.ok(events(f).some(e => e.type === 'closeout.invalid' && e.waiting.event === 'entry-repaired'));
});

test('an ended, explicitly dropped unmerged lane is archive-tagged and its evidence survives removal', t => {
  const f = setup(t, { occupied: false, merged: false });
  f.report(); f.append([{ type: 'item.closed', id: 'ENG-1', as: 'dropped' }]);
  f.drain(); assertRemoved(f);
  assert.equal(f.git(['rev-parse', 'refs/tags/archive/lane/topic']), f.head);
  assert.ok(effects(f).some(e => e.action === 'archive-created'));
});

test('restart after agent exit and a failed shell close resumes the shell without sending exit twice', t => {
  const f = setup(t, { terminal: true });
  f.state.failClose = true; f.save();
  f.drain(); assert.equal(fs.existsSync(f.lane), true);
  const current = f.read(); current.failClose = false; fs.writeFileSync(f.file, JSON.stringify(current));
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'native close transport recovered', start: false });
  f.drain(); assertRemoved(f);
  assert.equal(f.read().actions.filter(a => a[0] === 'agent').length, 1);
  assert.equal(effects(f).filter(e => e.action === 'exit-observed').length, 1);
});

test('restart after worktree removal revalidates preservation and finishes branch/workspace separately', t => {
  const f = setup(t, { terminal: true });
  const [root] = JSON.parse(f.env.HERDR_TEST_SCRATCH_ROOTS), own = path.join(root, 'topic-review');
  fs.mkdirSync(own); fs.writeFileSync(path.join(own, 'result'), 'disposable');
  let refuse = 'worktree';
  const base = f.options.command;
  f.options.command = (exe, args, opt) => exe === 'git' && ((args.includes('-D') && refuse === 'branch') ||
    (args.includes('worktree') && args.includes('remove') && refuse === 'worktree')) ?
    { status: 1, stderr: 'injected branch deletion refusal', stdout: '' } : base(exe, args, opt);
  f.drain();
  assert.equal(fs.existsSync(f.lane), true);
  const discarded = effects(f).find(e => e.action === 'lane-preflight');
  assert.equal(fs.existsSync(discarded.evidence.directory), false, 'failed-removal duplicate was safely discarded');
  assert.equal(fs.existsSync(discarded.scratchManifest), false, 'fallback attempt was discarded with its duplicate evidence');
  assert.ok(fs.existsSync(own));
  refuse = 'branch';
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'worktree removal recovered', start: false });
  f.drain();
  assert.equal(fs.existsSync(f.lane), false);
  assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
  assert.ok(fs.existsSync(own), 'scratch survives partial Git removal');
  const interrupted = effects(f).findLast(e => e.action === 'lane-preflight');
  assert.equal(JSON.parse(fs.readFileSync(interrupted.scratchManifest)).phase, 'not-executed');
  assert.ok(effects(f).some(e => e.action === 'worktree-removed'));
  refuse = null;
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'branch deletion recovered', start: false });
  f.drain(); assertRemoved(f);
  assert.equal(fs.existsSync(own), false, 'queue recovery uses the guarded scratch sweep');
  const completed = effects(f).find(e => e.action === 'lane-removed');
  const manifest = assertFixtureScratch(completed.scratchManifest, f.env);
  assert.equal(manifest.phase, 'complete'); assert.equal(manifest.recovery.manifest, interrupted.scratchManifest);
  assert.equal(manifest.entries.find(entry => entry.path === own).disposition, 'removed');
  assert.equal(effects(f).filter(e => e.action === 'worktree-removed').length, 1);
  assert.equal(effects(f).filter(e => e.action === 'lane-preflight').length, 2, 'each preservation manifest retains its own receipt');
});

test('lost native exit, shell-close and workspace-close replies reconcile exact identity without repeating effects', t => {
  const f = setup(t, { terminal: true }), base = f.options.command, lost = new Set();
  f.options.command = (exe, args, opt) => {
    const result = base(exe, args, opt), key = args.slice(0, 2).join(' ');
    if (exe === f.job.herdr && ['agent prompt', 'tab close', 'workspace close'].includes(key) && !lost.has(key)) {
      lost.add(key); return { ...result, status: 1, stderr: 'injected lost acknowledgement' };
    }
    return result;
  };
  f.drain();
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'reconcile lost native replies', start: false });
  f.drain(); assertRemoved(f);
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t'], ['workspace', 'close', 'w']]);
  assert.ok(effects(f).some(e => e.action === 'closed' && e.tab_id === 'w:t' && e.reconciled));
  assert.ok(effects(f).some(e => e.action === 'closed' && e.workspace_id === 'w' && e.reconciled));
});

test('queue ownership skips both scheduled retirement passes and promotion-owned cleanup', t => {
  const f = setup(t, { terminal: true }), logs = [];
  const release = retirementLock(retirementOwnerLock(f.common)); t.after(release);
  assert.equal(tidyFinishedTabs({ cwd: f.repo, org: f.org, command: () => { throw Error('must not launch tidy'); }, log: e => logs.push(e) }), true);
  const housekeeping = createHousekeeping({ cwd: f.repo, org: f.org, herdr: f.job.herdr, record: undefined,
    command: f.options.command, log: e => logs.push(e) });
  assert.deepEqual(housekeeping.tick({ resume: false }).close, []);
  assert.deepEqual(f.read().actions, []);
  assert.ok(logs.some(e => e.action === 'retirement-skipped'));
  assert.equal(logs.some(e => /sweep|retirement-consumed|promotion-cleanup-retried/.test(e.action)), false);
  assert.equal(finishCleanup(f.job, { outcome: 'promoted' }, f.queue()).cleanup.owner, 'closeout-queue');
});

test('finished-lane age counts worktrees once, including protected/kept lanes, from reconciliation', t => {
  const f = setup(t, { terminal: true }), source = events(f).find(e => e.type === 'promotion.reconciled');
  const snapshot = f.retirement(f.options).observe(), generatedAt = new Date(Date.parse(source.at) + 1800001).toISOString();
  const status = retirementStatus(snapshot, { generatedAt, worktrees: [{ worktree: f.lane, branch: 'lane/topic', tip: f.head }] });
  assert.equal(status.finishedLanesOpenOver30Minutes, 1);
  assert.match(renderRetirementStatus(status), /Finished lanes open longer than 30 min: 1/);
});

test('the closer is finite, has no timers or polling, and a second claim cannot evaluate targets', t => {
  const f = setup(t, { terminal: true });
  const source = fs.readFileSync(new URL('../lib/closeout-consumer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bset(?:Interval|Timeout)\s*\(|\bwhile\s*\(|for\s*\(\s*;\s*;/);
  let second;
  f.drain({ onClaim: () => { second = f.drain(); } });
  assert.equal(second.already_running, true);
  assert.equal(fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), false, 'consumer exits after drain');
});

test('activation refuses legacy housekeeping ownership until inspected replacement and an explicit retry', t => {
  const f = setup(t, { terminal: true }), owner = path.join(f.org, 'housekeeping/default/lock/owner.json');
  fs.mkdirSync(path.dirname(owner), { recursive: true });
  fs.writeFileSync(owner, JSON.stringify({ cwd: f.repo, org: f.org, pid: process.pid }));
  f.drain(); assert.deepEqual(f.read().actions, []);
  assert.ok(evaluations(f).every(e => /ownership transfer/.test(e.reason)));
  fs.writeFileSync(owner, JSON.stringify({ cwd: f.repo, org: f.org, pid: process.pid, retirement_queue_protocol: 1 }));
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'legacy retirement stopped and inspected; adopted runtime restarted', start: false });
  f.drain(); assertRemoved(f);
});

test('source publication recovery retains the original binding when the old worktree name has been recreated', t => {
  const f = setup(t, { occupied: false, terminal: true });
  const source = events(f).find(e => e.type === 'promotion.reconciled');
  const entry = readCloseoutEntries(f.common).find(e => e.signal === 'landed');
  fs.unlinkSync(path.join(f.common, 'closeout/entries', `${entry.key}.json`));
  f.git(['worktree', 'remove', f.lane]); f.git(['worktree', 'add', f.lane, 'lane/topic']);
  publishCloseoutEvents({ cwd: f.repo, org: f.org, added: [source], start: false });
  const recovered = readCloseoutEntries(f.common).find(e => e.signal === 'landed');
  assert.deepEqual(recovered.worktreeIdentity, entry.worktreeIdentity);
  f.drain(); assert.equal(fs.existsSync(f.lane), true);
  assert.ok(evaluations(f).some(e => /identity/.test(e.reason)));
});

test('a report on disk is inert; the actual ingest CLI carries the same optional ready signal', async t => {
  const f = setup(t), file = path.join(f.scratch, 'report.md');
  fs.writeFileSync(file, '---\nrun: R-1\noutcome: done\nsummary: Complete.\nheadline: The change is complete.\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\ndecisions: []\nquestions: []\nchallenges: []\n---\n');
  assert.deepEqual(readCloseoutEntries(f.common), []);
  readyLane({ cwd: f.repo, org: f.org, topic: 'topic', start: false });
  const result = spawnSync(process.execPath, [cli, 'ingest', file], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await waitForChange([f.eventFile], () => evaluations(f).length && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), { timeoutMs: 60000 });
  assert.equal(readCloseoutEntries(f.common).length, 1);
  assert.deepEqual(f.read().actions, []);
  assert.equal(events(f).filter(e => e.type === 'report.ingested').length, 1);
});

test('opted-in train completion produces a landed entry and closes without manual release or sweep', async t => {
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
  await waitForChange([f.eventFile], () => effects(f).some(e => e.action === 'lane-removed') && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')),
    { timeoutMs: 60000 });
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
  await drainPromotions(queue);
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

function child(exe, args, options) {
  return new Promise((resolve, reject) => {
    const c = spawn(exe, args, options); let stdout = '', stderr = '';
    c.stdout.on('data', d => { stdout += d; }); c.stderr.on('data', d => { stderr += d; });
    c.once('error', reject); c.once('close', status => resolve({ status, stdout, stderr }));
  });
}

test('two concurrent ready enqueues bind one entry and one live closer; shutdown enqueue is not stranded', async t => {
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
  await waitForChange([f.eventFile], () => effects(f).some(e => e.action === 'lane-removed') && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), { timeoutMs: 60000 });
  assertRemoved(f);
  assert.equal(f.read().actions.filter(a => a[0] === 'agent').length, 1);
});
