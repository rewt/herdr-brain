import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fixture } from '../settle/test/fixture.mjs';
import { loadEvents, writeFileAtomic } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { fold as oldFold } from './fixtures/state-pre-session-bind.mjs';
import { claimRun, ownerBinding, fenceOwner, readOwnedRun, outstandingEffects } from '../lib/run-owner.mjs';
import { queueFor, enqueue } from '../promote/promote.mjs';
import { readInbox } from '../supervisor/prompt-supervisor.mjs';
import { receiptDirectory } from '../supervisor/context.mjs';
import { spawnChild, waitForExit } from './helpers/child.mjs';
import { tierFiles } from './helpers/tier.mjs';

const source = path.resolve(import.meta.dirname, '..');
const node = (f, file, args = [], extra = {}) => f.exec(process.execPath, [path.join(source, file), ...args], f.repo, { ORG_DIR: f.org, ...extra });
const ok = r => { assert.equal(r.status ?? r.code, 0, r.stderr || r.stdout); return r.stdout; };
const handle = (f, run, args = []) => node(f, 'supervisor/supervisor.mjs', ['handle', run, '--role', 'supervisor', ...args]);
const transferArgs = (run, current, controller = 'other') => ['claim', run, '--controller', controller, '--legacy',
  '--transfer-from', current.owner.controller, '--expected-owner', JSON.stringify(current.owner), '--expected-generation', String(current.generation), '--why', 'Drained inventory handoff'];
const claim = (f, run, args = []) => node(f, 'bin/org.mjs', ['claim', run, '--controller', 'brain', ...args]);
const events = f => loadEvents(f.org).events;
const binding = (f, run) => ownerBinding(readOwnedRun(f.org, run));
// Bookkeeping/synthetic-queue cases create no native worker or watcher. They
// need no system process census after each short record command.
const bookkeeping = (f, args, extra = {}) => spawnSync(process.execPath, [path.join(source, 'bin/org.mjs'), ...args], { cwd: f.repo, env: { ...f.env, ORG_DIR: f.org, ...extra }, encoding: 'utf8' });
const put = (file, value) => writeFileAtomic(file, JSON.stringify(value) + '\n');
const waitUntil = async predicate => {
  const by = Date.now() + 10000;
  while (!predicate()) { assert.ok(Date.now() < by, 'fixture barrier timed out'); await new Promise(r => setTimeout(r, 20)); }
};
function enqueueAdapter(f) {
  const file = path.join(f.root, 'enqueue.mjs');
  fs.writeFileSync(file, `import {parseArgs} from 'node:util';
import {queueFor,enqueue} from ${JSON.stringify(pathToFileURL(path.join(source, 'promote/promote.mjs')).href)};
const {values:o,positionals:p}=parseArgs({allowPositionals:true,options:Object.fromEntries(['repo','org','expected-head','if-current-run','claimed-by','claim-generation','required-tests','to'].map(k=>[k,{type:'string'}]))});
const q=queueFor(o.repo);console.log(JSON.stringify({queue:q.file,jobs:enqueue(q,p,{org:o.org,run:o['if-current-run'],expectedHead:o['expected-head'],claimedBy:o['claimed-by'],claimGeneration:Number(o['claim-generation']),requiredTests:JSON.parse(o['required-tests']??'[]')})}));`);
  return file;
}
// These promotion calls use the enqueue-only seam above; no drain worker is
// launched. Keep their bookkeeping independent of a system-wide process census.
const promote = (f, run, adapter, extra = []) => spawnSync(process.execPath, [path.join(source, 'supervisor/supervisor.mjs'), 'promote', run, '--role', 'supervisor', '--why', 'Fixture reviewed work', '--promote-cli', adapter, ...extra], { cwd: f.repo, env: { ...f.env, ORG_DIR: f.org }, encoding: 'utf8' });
const reviews = f => f.calls().filter(a => a[0] === 'agent' && a[1] === 'start').length;

test('promotion inventory includes the ownership witnesses', () => assert.ok(tierFiles('promotion').includes('test/run-ownership.test.mjs')));

test('ambiguous legacy late delivery is held; another owner refuses before any settle journal or review', t => {
  const f = fixture(t), run = f.start({ owned: false }); f.commit('correct\n'); f.report(run);
  const unclaimed = handle(f, run);
  assert.equal(unclaimed.status, 1); assert.match(unclaimed.stderr, /RUN_OWNER_UNCLAIMED/);
  f.record(['claim', run, '--controller', 'other', '--legacy']);
  for (let i = 0; i < 2; i++) {
    const r = node(f, 'supervisor/supervisor.mjs', ['handle', '--role', 'supervisor', '--notice', `[org-report] run=${run} item=ENG-1 outcome=done headline=Late legacy report`]);
    assert.equal(r.status, 1); assert.match(r.stderr, /RUN_OWNED_ELSEWHERE.*other/);
  }
  assert.equal(fs.existsSync(path.join(f.org, 'settle', `${run}.json`)), false);
  assert.equal(reviews(f), 0); assert.equal(queueFor(f.repo).load().pending.length, 0);
});

test('concurrent controllers claim exactly once and the loser names the winner', async t => {
  const f = fixture(t), run = f.start({ owned: false });
  const a = f.concurrent('claim', path.join(source, 'bin/org.mjs'), [run, '--controller', 'a', '--legacy']);
  const b = f.concurrent('claim', path.join(source, 'bin/org.mjs'), [run, '--controller', 'b', '--legacy']);
  const results = await Promise.all([a.done, b.done]);
  assert.deepEqual(results.map(r => r.code).sort(), [0, 1]);
  const owner = f.show(run).owner.controller;
  assert.match(results.find(r => r.code === 1).stderr, new RegExp(`RUN_OWNED_ELSEWHERE.*${owner}`));
  assert.equal(events(f).filter(e => e.type === 'run.claimed').length, 1);
  assert.equal(JSON.parse(f.record(['claim', run, '--controller', owner, '--legacy'])).already, true);
});

test('transfer compares the complete owner and generation, including a later incarnation with the same name', t => {
  const f = fixture(t), run = f.start({ owned: false });
  f.record(['claim', run, '--controller', 'a', '--legacy']); const first = binding(f, run);
  const wrong = { ...first, owner: { ...first.owner, legacy: false } };
  assert.match(node(f, 'bin/org.mjs', transferArgs(run, wrong)).stderr, /RUN_CLAIM_TRANSFER_REFUSED/);
  ok(node(f, 'bin/org.mjs', transferArgs(run, first, 'b')));
  ok(node(f, 'bin/org.mjs', transferArgs(run, binding(f, run), 'a')));
  assert.match(node(f, 'bin/org.mjs', transferArgs(run, first, 'b')).stderr, /RUN_CLAIM_TRANSFER_REFUSED/);
  const transfers = events(f).filter(e => e.previous);
  assert.equal(transfers.length, 2); assert.deepEqual(transfers[0].previous, first);
  assert.equal(transfers[1].owner.controller, 'a'); assert.ok(transfers[1].why);
});

test('every outstanding effect kind refuses transfer and an override cannot waive it', t => {
  const f = fixture(t), run = f.start(); const current = binding(f, run);
  const settleFile = path.join(f.org, 'settle', `${run}.json`);
  const queue = queueFor(f.repo), request = path.join(receiptDirectory(f.org, queue.project.identity), `${run}.json`);
  const watch = path.join(f.org, 'watch', `${run}.json`), inbox = path.join(f.org, 'supervisor/inbox.log');
  const job = { id: 'one', run, org: f.org, topic: 'topic' };
  const cases = [
    ...['reviewing', 'dispatching', 'validate', 'rebase'].map(stage => ['settle:' + stage, () => put(settleFile, { run, stage })]),
    ['active-completion', () => put(settleFile, { run, stage: 'complete', ownerActive: true })],
    ['enqueuing', () => put(request, { phase: 'enqueuing' })],
    ['queued', () => put(queue.file, { identity: queue.project.identity, pending: [job], current: null, results: [] })],
    ...['validating', 'integrating', 'prepared'].map(phase => [phase, () => put(queue.file, { identity: queue.project.identity, pending: [], current: { id: 'batch', phase, jobs: [job] }, results: [] })]),
    ['interrupted', () => put(queue.file, { identity: queue.project.identity, pending: [], current: null, interrupted: [{ id: 'batch', jobs: [job] }], results: [] })],
    ['unreconciled-landing', () => put(queue.file, { identity: queue.project.identity, pending: [], current: null, results: [{ ...job, outcome: 'promoted', reconciliation: { state: 'pending' } }] })],
    ['cleanup', () => put(queue.file, { identity: queue.project.identity, pending: [], current: null, results: [{ ...job, outcome: 'refused', cleanup: { state: 'pending' } }] })],
    ['uncertain-delivery', () => put(watch, { intent: 'delivery', inbox, deliveries: ['notice'] })],
    ['pending-callback', () => { fs.mkdirSync(path.dirname(inbox), { recursive: true }); fs.writeFileSync(inbox, JSON.stringify({ type: 'notice', id: 'notice', message: `[org-report] run=${run} item=ENG-1` }) + '\n'); }],
    ['dispatch-callback', () => put(path.join(f.org, 'dispatch/callback.json'), { run, stage: 'complete' })],
  ];
  for (const [kind, setup] of cases) {
    setup();
    const r = bookkeeping(f, transferArgs(run, current), { ORG_GUARD_OVERRIDE: 'one' });
    assert.equal(r.status, 1, `${kind}: ${r.stdout}`); assert.match(r.stderr, /RUN_CLAIM_TRANSFER_REFUSED/, kind);
    assert.deepEqual(binding(f, run), current);
    for (const file of [settleFile, request, queue.file, watch, inbox, path.join(f.org, 'dispatch/callback.json')]) fs.rmSync(file, { force: true });
  }
  fs.rmdirSync(path.join(f.org, 'dispatch')); // Only the synthetic callback receipt used this directory.
  ok(node(f, 'bin/org.mjs', transferArgs(run, current)));
});

test('transfer and durable review intent are serialized without holding the record lock over the effect', async t => {
  const f = fixture(t), run = f.start(), current = binding(f, run), script = path.join(f.root, 'reserve.mjs');
  const journal = path.join(f.org, 'settle', `${run}.json`), marker = path.join(f.root, 'reserved'), release = path.join(f.root, 'finish');
  fs.writeFileSync(script, `import fs from 'node:fs';import {fenceOwner} from ${JSON.stringify(pathToFileURL(path.join(source, 'lib/run-owner.mjs')).href)};
const journal=${JSON.stringify(journal)};fs.mkdirSync(${JSON.stringify(path.dirname(journal))},{recursive:true});
fenceOwner(${JSON.stringify(f.org)},${JSON.stringify(run)},${JSON.stringify(current)},()=>fs.writeFileSync(journal,JSON.stringify({stage:'reviewing'})));
fs.writeFileSync(${JSON.stringify(marker)},'reserved');
while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,20));
fenceOwner(${JSON.stringify(f.org)},${JSON.stringify(run)},${JSON.stringify(current)},()=>fs.writeFileSync(journal,JSON.stringify({stage:'complete'})));`);
  const child = f.concurrent(run, script, []); await waitUntil(() => fs.existsSync(marker));
  const r = node(f, 'bin/org.mjs', transferArgs(run, current));
  assert.equal(r.status, 1); assert.match(r.stderr, /RUN_CLAIM_TRANSFER_REFUSED.*reviewing/);
  // A same-owner record transaction succeeds while the model/transport waits.
  assert.equal(JSON.parse(ok(claim(f, run))).already, true);
  fs.writeFileSync(release, 'finish'); ok(await child.done);
  ok(node(f, 'bin/org.mjs', transferArgs(run, current)));
  assert.throws(() => fenceOwner(f.org, run, current, () => assert.fail('stale effect admitted')), /RUN_OWNED_ELSEWHERE/);
});

test('a watcher observes a moved claim and exits without delivery or cleanup; late handle refuses', async t => {
  const f = fixture(t), run = f.start(), current = binding(f, run);
  const w = f.concurrent(run, path.join(source, 'watch/watch.mjs'), ['--org', f.org, '--cwd', f.repo, '--start-grace', '60', '--close-tab-on-exit']);
  await waitUntil(() => f.calls().some(a => a[0] === 'agent' && a[1] === 'wait'));
  ok(node(f, 'bin/org.mjs', transferArgs(run, current)));
  const ended = await w.done; ok(ended); assert.match(ended.stdout, /stopping without delivery/);
  assert.equal(readInbox(path.join(f.org, 'supervisor/inbox.log')).length, 0);
  assert.equal(f.calls().filter(a => a[0] === 'tab' && a[1] === 'close').length, 0);
  assert.match(handle(f, run).stderr, /RUN_OWNED_ELSEWHERE/);
  assert.equal(reviews(f), 0);
});

test('two TMPDIR watchers, repeated ingest and supervisor restarts produce one notice, review and enqueue', async t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  f.record(['ingest', f.show(run).report_path]); f.record(['ingest', f.show(run).report_path]);
  const a = path.join(f.root, 'tmp-a'), b = path.join(f.root, 'tmp-b'); fs.mkdirSync(a); fs.mkdirSync(b);
  const start = tmp => {
    const old = f.env.TMPDIR; f.env.TMPDIR = tmp;
    const child = f.concurrent(run, path.join(source, 'watch/watch.mjs'), ['--org', f.org, '--cwd', f.repo, '--start-grace', '0']);
    if (old === undefined) delete f.env.TMPDIR; else f.env.TMPDIR = old;
    return child.done;
  };
  const results = await Promise.all([start(a), start(b)]);
  assert.ok(results.some(r => r.code === 0), results.map(r => r.stderr).join('\n'));
  for (const r of results) if (r.code !== 0) assert.match(r.stderr, /another watcher/);
  ok(node(f, 'watch/watch.mjs', [run, '--org', f.org, '--cwd', f.repo, '--start-grace', '0']));
  assert.equal(readInbox(path.join(f.org, 'supervisor/inbox.log')).filter(e => e.id === `watch:${run}:final`).length, 1);
  ok(handle(f, run)); ok(handle(f, run));
  assert.equal(reviews(f), 1);
  const adapter = enqueueAdapter(f);
  ok(promote(f, run, adapter)); ok(promote(f, run, adapter));
  assert.equal(queueFor(f.repo).load().pending.length, 1);
  assert.equal(events(f).filter(e => e.type === 'report.ingested' && e.run === run).length, 1);
  assert.equal(events(f).filter(e => e.type === 'run.claimed' && e.run === run).length, 1);
  fs.rmSync(queueFor(f.repo).file); // The adapter admits jobs but never starts a queue worker.
});

test('uncertain review and enqueue restart never launch a duplicate effect', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  ok(handle(f, run)); const count = reviews(f);
  const settleFile = path.join(f.org, 'settle', `${run}.json`), completed = fs.readFileSync(settleFile);
  const uncertainReview = JSON.parse(completed); uncertainReview.stage = 'reviewing'; delete uncertainReview.result; put(settleFile, uncertainReview);
  const repeated = handle(f, run, ['--retry']); assert.equal(repeated.status, 1); assert.match(repeated.stderr, /review outcome is uncertain/);
  assert.equal(reviews(f), count);
  assert.match(node(f, 'bin/org.mjs', transferArgs(run, binding(f, run))).stderr, /RUN_CLAIM_TRANSFER_REFUSED/);
  // Restore this fixture's exact confirmed checkpoint; a retry cannot invent it.
  fs.writeFileSync(settleFile, completed);
  const adapter = enqueueAdapter(f); ok(promote(f, run, adapter));
  const file = path.join(receiptDirectory(f.org, queueFor(f.repo).project.identity), `${run}.json`), saved = JSON.parse(fs.readFileSync(file));
  saved.phase = 'enqueuing'; delete saved.queue; put(file, saved);
  const uncertain = promote(f, run, adapter); assert.equal(uncertain.status, 1); assert.match(uncertain.stderr, /enqueue is uncertain/);
  assert.equal(queueFor(f.repo).load().pending.length, 1);
  assert.equal(events(f).filter(e => e.type === 'run.claimed').length, 1);
  assert.equal(reviews(f), count);
  fs.rmSync(queueFor(f.repo).file); // No worker is launched by the enqueue seam.
});

test('first settle and supervisor entry refuse an unavailable bound release rather than following current', t => {
  const f = fixture(t), run = f.start({ owned: false }); f.report(run);
  claimRun({ org: f.org, run, owner: { controller: 'brain', legacy: false, release: { root: path.join(f.root, 'absent'), id: 'absent', commit: 'a'.repeat(40) } } });
  for (const r of [f.settle(run), handle(f, run)]) {
    assert.equal(r.status, 1); assert.match(r.stderr, /RUN_OWNER_RELEASE_UNAVAILABLE/);
  }
  assert.equal(fs.existsSync(path.join(f.org, 'settle', `${run}.json`)), false); assert.equal(reviews(f), 0);
});

test('first effectful entries continue the exact bound release, even with a different project pin', t => {
  const f = fixture(t), run = f.start({ owned: false }), root = path.join(f.root, 'old-release');
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, '.release-commit'), 'a'.repeat(40));
  for (const entry of ['settle/settle.mjs', 'supervisor/supervisor.mjs', 'watch/watch.mjs', 'dispatch/dispatch.mjs', 'promote/promote.mjs']) {
    fs.mkdirSync(path.dirname(path.join(root, entry)), { recursive: true }); fs.writeFileSync(path.join(root, entry), `console.log('bound-old-release');`);
  }
  ok(claim(f, run, ['--release-root', root]));
  // An invalid committed pin would refuse if any entry consulted it.
  fs.writeFileSync(path.join(f.repo, '.herdr-release.json'), JSON.stringify({ release: 'missing-new-pin' }));
  f.git(['add', '.herdr-release.json']); f.git(['commit', '-qm', 'Change project pin']);
  for (const [entry, args] of [
    ['settle/settle.mjs', [run, '--org', f.org]],
    ['supervisor/supervisor.mjs', ['handle', run, '--role', 'supervisor']],
    ['watch/watch.mjs', [run, '--org', f.org]],
    ['dispatch/dispatch.mjs', ['ENG-1', '--from-run', run, '--org', f.org]],
    ['promote/promote.mjs', ['topic', '--if-current-run', run, '--claimed-by', 'brain', '--org', f.org]],
  ]) assert.match(ok(node(f, entry, args)), /bound-old-release/, entry);
});

test('correction dispatch inherits the exact predecessor owner before launching a worker', t => {
  const f = fixture(t), run = f.start(); f.report(run); f.record(['ingest', f.show(run).report_path]);
  const lane = path.join(f.root, 'admission-lane.mjs');
  // Stop at the launch boundary. The real dispatch, record start and claim run;
  // no native worker, watcher or transport callback is created by this seam.
  fs.writeFileSync(lane, `#!${process.execPath}\nif(process.argv[2]==='dispatch'){console.error('fixture launch boundary');process.exitCode=1;}`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [path.join(source, 'dispatch/dispatch.mjs'), f.show(run).item,
    '--org', f.org, '--lane', 'topic', '--route', 'engineer', '--brief', path.join(f.root, 'ask with spaces.md'),
    '--from-run', run, '--lane-cli', lane], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /fixture launch boundary/);
  const runs = [...fold(events(f)).runs.values()]; assert.equal(runs.length, 2);
  assert.deepEqual(runs[1].owner, runs[0].owner);
  assert.equal(events(f).filter(e => e.type === 'run.claimed' && e.run === runs[1].id).length, 1);
  const requests = fs.readdirSync(path.join(f.org, 'dispatch')).filter(n => n.endsWith('.json') && !n.endsWith('.routes.json'));
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.org, 'dispatch', requests[0]))).stage, 'launching');
  fs.rmSync(path.join(f.org, 'dispatch'), { recursive: true }); // The controlled refusal created no processes.
});

test('legacy enqueue supports unclaimed and legacy runs; Brain claims require the exact caller and generation', t => {
  const f = fixture(t), run = f.start({ owned: false }), q = queueFor(f.repo), expectedHead = f.git(['rev-parse', 'HEAD'], f.workspace);
  const options = { run, org: f.org, expectedHead };
  assert.equal(enqueue(q, ['topic'], options)[0].duplicate, false);
  ok(bookkeeping(f, ['claim', run, '--controller', 'legacy', '--legacy']));
  assert.equal(enqueue(q, ['topic'], options)[0].duplicate, true);
  q.transaction(data => { data.pending = []; });
  const old = binding(f, run);
  ok(bookkeeping(f, ['claim', run, '--controller', 'brain', '--transfer-from', 'legacy', '--expected-owner', JSON.stringify(old.owner), '--expected-generation', String(old.generation), '--why', 'Legacy drained']));
  assert.throws(() => enqueue(q, ['topic'], options), /RUN_OWNED_ELSEWHERE/);
  assert.throws(() => enqueue(q, ['topic'], { ...options, claimedBy: 'other' }), /RUN_OWNED_ELSEWHERE/);
  assert.throws(() => enqueue(q, ['topic'], { ...options, claimedBy: 'brain', claimGeneration: 1 }), /RUN_OWNED_ELSEWHERE/);
  assert.equal(enqueue(q, ['topic'], { ...options, claimedBy: 'brain', claimGeneration: binding(f, run).generation })[0].duplicate, false);
  fs.rmSync(q.file); // This fixture enqueues only, with no native drain worker.
});

test('unclaimed JSON and text are unchanged; an old reader ignores claimed and unknown fields', t => {
  const f = fixture(t), run = f.start({ owned: false }), before = f.show(run), text = f.record(['show', run]);
  assert.equal(Object.hasOwn(before, 'owner'), false); assert.equal(Object.hasOwn(before, 'owner_generation'), false);
  ok(claim(f, run));
  assert.equal(f.record(['show', run]), text);
  const all = events(f).map(e => e.type === 'run.claimed' ? { ...e, future_field: { opaque: true } } : e);
  const current = fold(all).runs.get(run); assert.equal(current.owner.controller, 'brain');
  // The retained pre-session-binding reader also predates run ownership.
  assert.equal(Object.hasOwn(oldFold(all).runs.get(run), 'owner'), false);
  assert.deepEqual(oldFold(all).runs.get(run), oldFold(all.filter(e => e.type !== 'run.claimed')).runs.get(run));
  const {owner, owner_generation, ...rest} = f.show(run); assert.deepEqual(rest, before);
});


test('an explicit initial Brain claim racing a legacy enqueue admits only one owner path', async t => {
  const f = fixture(t), run = f.start({ owned: false }), script = path.join(f.root, 'legacy-enqueue.mjs');
  const head = f.git(['rev-parse', 'HEAD'], f.workspace);
  fs.writeFileSync(script, `import {queueFor,enqueue} from ${JSON.stringify(pathToFileURL(path.join(source, 'promote/promote.mjs')).href)};
console.log(JSON.stringify(enqueue(queueFor(${JSON.stringify(f.repo)}),['topic'],${JSON.stringify({ org: f.org, run, expectedHead: head })})));`);
  const attempts = await Promise.all([
    waitForExit(spawnChild(t, process.execPath, [path.join(source, 'bin/org.mjs'), 'claim', run, '--controller', 'brain'], { cwd: f.repo, env: f.env })),
    waitForExit(spawnChild(t, process.execPath, [script], { cwd: f.repo, env: f.env })),
  ]);
  assert.deepEqual(attempts.map(r => r.code).sort(), [0, 1]);
  const queued = queueFor(f.repo).load().pending.length;
  assert.equal(queued + events(f).filter(e => e.type === 'run.claimed').length, 1);
  assert.match(attempts.find(r => r.code === 1).stderr, /RUN_OWNED_ELSEWHERE|RUN_CLAIM_TRANSFER_REFUSED/);
  fs.rmSync(queueFor(f.repo).file); // Both children finished; neither starts a worker.
});

test('concurrent transfers compare one exact incarnation', async t => {
  const f = fixture(t), run = f.start(), current = binding(f, run);
  const attempts = await Promise.all(['a', 'b'].map(controller => {
    const [command, ...args] = transferArgs(run, current, controller);
    return f.concurrent(command, path.join(source, 'bin/org.mjs'), args).done;
  }));
  assert.deepEqual(attempts.map(r => r.code).sort(), [0, 1]);
  assert.equal(events(f).filter(e => e.type === 'run.claimed').length, 2);
  assert.match(attempts.find(r => r.code === 1).stderr, /RUN_CLAIM_TRANSFER_REFUSED/);
});

test('passive comparison never claims, delivers, ingests or writes process metadata', t => {
  const f = fixture(t), run = f.start({ owned: false }); f.report(run);
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'));
  ok(node(f, 'watch/watch.mjs', [run, '--org', f.org, '--cwd', f.repo, '--dry-run']));
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), before);
  assert.equal(fs.existsSync(path.join(f.org, 'watch')), false);
  assert.equal(readInbox(path.join(f.org, 'supervisor/inbox.log')).length, 0);
  assert.equal(reviews(f), 0); assert.equal(queueFor(f.repo).load().pending.length, 0);
});


test('the canonical record and common-directory identity survive symlinks and separate Git metadata', t => {
  const f = fixture(t), repo = path.join(f.root, 'separate'), metadata = path.join(f.root, 'separate-metadata');
  ok(f.exec('git', ['init', '-q', '-b', 'main', '--separate-git-dir', metadata, repo]));
  f.git(['config', 'user.name', 'Ownership fixture'], repo); f.git(['config', 'user.email', 'fixture@example.invalid'], repo);
  f.git(['commit', '--allow-empty', '-qm', 'Separate metadata'], repo);
  const org = path.join(repo, '.org'), alias = path.join(f.root, 'record-alias');
  const record = (args, directory = org) => ok(spawnSync(process.execPath, [path.join(source, 'bin/org.mjs'), ...args], {
    cwd: repo, env: { ...f.env, ORG_DIR: directory }, encoding: 'utf8',
  })).trim();
  record(['init']); const item = record(['add', 'Separate project', '--role', 'engineer']).split(' ')[0];
  const run = record(['start', item, '--workspace', repo]).match(/R-\d+/)[0];
  record(['claim', run, '--controller', 'brain']); fs.symlinkSync(org, alias);
  assert.equal(JSON.parse(record(['claim', run, '--controller', 'brain'], alias)).already, true);
  assert.equal(readOwnedRun(alias, run).owner.controller, 'brain');
  const claims = loadEvents(org).events.filter(e => e.type === 'run.claimed');
  assert.equal(claims.length, 1); assert.equal(claims[0].record, fs.realpathSync(org));
  assert.equal(claims[0].project, fs.realpathSync(metadata));
});
