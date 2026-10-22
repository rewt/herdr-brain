import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { copyProduct } from '../lib/product-files.mjs';
import { bundleRelease } from '../lib/releases.mjs';
import { gitProject } from '../lib/project.mjs';
import { spawnSync } from 'node:child_process';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fixture } from '../settle/test/fixture.mjs';
import { loadEvents, writeFileAtomic } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { fold as oldFold } from './fixtures/state-pre-session-bind.mjs';
import { claimRun, ownerBinding, fenceOwner, readOwnedRun, assertOwner, outstandingEffects, adoptedPromotionBinding, guardPromotionJob } from '../lib/run-owner.mjs';
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
function enqueueAdapter(f, runtime = source) {
  const file = path.join(f.root, 'enqueue.mjs');
  fs.writeFileSync(file, `import {parseArgs} from 'node:util';
import {queueFor,enqueue} from ${JSON.stringify(pathToFileURL(path.join(runtime, 'promote/promote.mjs')).href)};
const {values:o,positionals:p}=parseArgs({allowPositionals:true,options:Object.fromEntries(['repo','org','expected-head','if-current-run','claimed-by','claim-generation','required-tests','to'].map(k=>[k,{type:'string'}]))});
const q=queueFor(o.repo);console.log(JSON.stringify({queue:q.file,jobs:enqueue(q,p,{org:o.org,run:o['if-current-run'],expectedHead:o['expected-head'],claimedBy:o['claimed-by'],claimGeneration:Number(o['claim-generation']),requiredTests:JSON.parse(o['required-tests']??'[]')})}));`);
  return file;
}
// These promotion calls use the enqueue-only seam above; no drain worker is
// launched. Keep their bookkeeping independent of a system-wide process census.
const promote = (f, run, adapter, extra = []) => spawnSync(process.execPath, [path.join(source, 'supervisor/supervisor.mjs'), 'promote', run, '--role', 'supervisor', '--why', 'Fixture reviewed work', '--promote-cli', adapter, ...extra], { cwd: f.repo, env: { ...f.env, ORG_DIR: f.org }, encoding: 'utf8' });
const localGit = (f, args, cwd = f.repo) => ok(spawnSync('git', args, { cwd, env: f.env, encoding: 'utf8' })).trim();
const reviewResult = (f, result) => {
  const file = path.join(f.org, 'settle/R-1.review-r1.log');
  if (result.status !== 0 && fs.existsSync(file)) result.stderr += '\n' + fs.readFileSync(file, 'utf8');
  return result;
};
const reviews = f => f.calls().filter(a => a[0] === 'agent' && a[1] === 'start').length;

test('promotion inventory includes the ownership witnesses', () => assert.ok(tierFiles('promotion').includes('test/run-ownership.test.mjs')));

test('missing records give ownership readers and consumers a named refusal before any effect', t => {
  const f = fixture(t), org = path.join(f.root, 'missing-record');
  fs.mkdirSync(org);
  const message = dir => `RUN_RECORD_MISSING: no record at ${dir}; run ownership requires the run's record`;
  for (const dir of [org, path.join(org, 'absent')]) {
    assert.throws(() => readOwnedRun(dir, 'R-1'), { code: 'RUN_RECORD_MISSING', message: message(dir) });
  }
  assert.throws(() => guardPromotionJob({ org, run: 'R-1' }), { code: 'RUN_RECORD_MISSING', message: message(org) });
  assert.throws(() => readOwnedRun(f.org, 'R-1'), { code: 'RUN_CLAIM_INVALID', message: 'RUN_CLAIM_INVALID: unknown run R-1' });
  for (const [file, args] of [
    ['watch/watch.mjs', ['R-1', '--org', org, '--cwd', f.repo, '--detach']],
    ['dispatch/dispatch.mjs', ['ENG-1', '--org', org, '--from-run', 'R-1', '--lane', 'topic', '--route', 'engineer', '--brief', path.join(f.root, 'ask with spaces.md')]],
    ['settle/settle.mjs', ['R-1', '--org', org]],
    ['promote/promote.mjs', ['topic', '--org', org, '--if-current-run', 'R-1']],
  ]) {
    const result = node(f, file, args);
    assert.equal(result.status, 1, `${file}: ${result.stderr}`);
    assert.ok(result.stderr.includes(message(org)), `${file}: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  }
  assert.deepEqual(fs.readdirSync(org), [], 'no operation receipt or watcher was created');
  assert.equal(f.calls().length, 0, 'no worker, reviewer or transport call was made');
});

test('ownership reads reuse only the unchanged record fold and keep fresh Git fences', t => {
  const f = fixture(t), run = f.start(), file = path.join(f.org, 'events.jsonl');
  const read = fs.readFileSync, exec = cp.execFileSync;
  let reads = 0, probes = 0;
  fs.readFileSync = function(name, ...args) { if (name === file) reads++; return read.call(this, name, ...args); };
  cp.execFileSync = function(command, ...args) { if (command === 'git') probes++; return exec.call(this, command, ...args); };
  syncBuiltinESMExports();
  try {
    const first = readOwnedRun(f.org, run), expected = structuredClone(first), firstProbes = probes;
    first.owner.controller = 'caller mutation'; first.meta.changed = true;
    assert.deepEqual(readOwnedRun(f.org, run), expected, 'callers cannot mutate the cached fold');
    assert.equal(reads, 1, 'unchanged record is read and folded once');
    assert.equal(firstProbes, 2, 'root discovery combines path queries but still verifies canonical checkout');
    assert.equal(probes, firstProbes * 2, 'the second fence still probes Git');
    const directory = path.join(f.repo, 'nested'); fs.mkdirSync(directory);
    assert.equal(gitProject(directory).identity, gitProject(f.repo).identity, 'subdirectory discovery retains its original semantics');
  } finally { fs.readFileSync = read; cp.execFileSync = exec; syncBuiltinESMExports(); }
});

test('ownership fold cache observes rewrites, claim changes, torn tails and live Git identity loss', t => {
  const f = fixture(t), run = f.start(), file = path.join(f.org, 'events.jsonl');
  const original = fs.readFileSync(file, 'utf8'), stamp = fs.statSync(file), expected = binding(f, run);
  const altered = original.replace('"controller":"brain"', '"controller":"other"');
  assert.notEqual(altered, original); assert.equal(Buffer.byteLength(altered), Buffer.byteLength(original));
  fs.writeFileSync(file, altered); fs.utimesSync(file, stamp.atime, stamp.mtime);
  assert.throws(() => assertOwner(readOwnedRun(f.org, run), expected), { code: 'RUN_OWNED_ELSEWHERE' });
  fs.writeFileSync(file, original);
  assertOwner(readOwnedRun(f.org, run), expected);
  const claim = events(f).find(e => e.type === 'run.claimed');
  fs.appendFileSync(file, JSON.stringify({ ...claim, seq: events(f).at(-1).seq + 1 }) + '\n');
  assert.throws(() => assertOwner(readOwnedRun(f.org, run), expected), { code: 'RUN_OWNED_ELSEWHERE' });
  fs.appendFileSync(file, '{"type":');
  assert.throws(() => readOwnedRun(f.org, run), { code: 'RUN_CLAIM_INVALID' });
  fs.writeFileSync(file + '.replacement', original); fs.renameSync(file + '.replacement', file);
  assertOwner(readOwnedRun(f.org, run), expected);
  fs.renameSync(path.join(f.repo, '.git'), path.join(f.repo, '.git.saved'));
  try { assert.throws(() => readOwnedRun(f.org, run), { code: 'RUN_CLAIM_INVALID' }); }
  finally { fs.renameSync(path.join(f.repo, '.git.saved'), path.join(f.repo, '.git')); }
  assertOwner(readOwnedRun(f.org, run), expected);
});

test('ownership fold cache never associates bytes from a changed record alias with the old record', t => {
  const f = fixture(t), run = f.start(), alias = path.join(f.root, 'record-alias'), other = path.join(f.root, 'other-record');
  const file = path.join(f.org, 'events.jsonl');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'events.jsonl'), events(f).map(e => JSON.stringify(e.type === 'run.claimed'
    ? { ...e, record: other, owner: { ...e.owner, controller: 'other' } } : e) + '\n').join(''));
  fs.symlinkSync(f.org, alias);
  const stat = fs.statSync; let moved = false;
  fs.statSync = function(name, options) {
    const result = stat.call(this, name, options);
    if (!moved && name === file && options?.bigint) { moved = true; fs.unlinkSync(alias); fs.symlinkSync(other, alias); }
    return result;
  };
  try { assert.throws(() => readOwnedRun(alias, run), { code: 'RUN_CLAIM_INVALID' }); }
  finally { fs.statSync = stat; fs.unlinkSync(alias); fs.symlinkSync(f.org, alias); }
  assert.equal(moved, true);
  assert.equal(readOwnedRun(f.org, run).owner.controller, 'brain');
});

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
  fs.rmSync(queueFor(f.repo).file, { force: true }); // The claim winner leaves no queue; neither child starts a worker.
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

test('transfer input errors name the expected JSON object and positive integer', t => {
  const f = fixture(t), run = f.start(), args = transferArgs(run, binding(f, run));
  for (const value of ['{', '[]', 'null', '"brain"']) {
    const bad = [...args]; bad[bad.indexOf('--expected-owner') + 1] = value;
    const result = node(f, 'bin/org.mjs', bad);
    assert.equal(result.status, 1); assert.match(result.stderr, /--expected-owner requires a JSON object/);
    assert.doesNotMatch(result.stderr, /SyntaxError/);
  }
  for (const value of ['0', '-1', '1.5', 'NaN', '9007199254740992']) {
    const bad = [...args]; bad.splice(bad.indexOf('--expected-generation'), 2, `--expected-generation=${value}`);
    assert.match(node(f, 'bin/org.mjs', bad).stderr, /--expected-generation requires a positive integer/);
  }
});

test('explicit own-worker admission permits re-arm but refuses every operation receipt', t => {
  const f = fixture(t), run = f.start({ owned: false });
  f.record(['set', run, 'terminal_id=own-terminal', 'agent_session_id=own-session']);
  assert.match(claim(f, run).stderr, /RUN_CLAIM_TRANSFER_REFUSED/);
  const queue = queueFor(f.repo);
  const receipts = [
    [path.join(f.org, 'watch', `${run}.json`), {}],
    [path.join(f.org, 'settle', `${run}.json`), { stage: 'complete' }],
    [path.join(f.org, 'dispatch', `${run}.json`), { run, stage: 'complete' }],
    [path.join(receiptDirectory(f.org, queue.project.identity), `${run}.json`), { phase: 'acknowledged' }],
    [queue.file, { identity: queue.project.identity, pending: [], current: null, results: [{ run, org: f.org, outcome: 'refused', delivered: true }] }],
  ];
  for (const [file, receipt] of receipts) {
    put(file, receipt);
    assert.match(bookkeeping(f, ['claim', run, '--controller', 'brain', '--admit-worker']).stderr, /only this run's own worker/);
    fs.rmSync(file);
  }
  fs.rmdirSync(path.join(f.org, 'dispatch')); // Synthetic receipts only, with no worker.

  ok(claim(f, run, ['--admit-worker']));
  assert.equal(JSON.parse(ok(claim(f, run, ['--admit-worker']))).already, true);
  // This is the same arm used by entry recovery, with a pre-upgrade worker.
  f.report(run);
  ok(node(f, 'watch/watch.mjs', [run, '--org', f.org, '--cwd', f.repo, '--start-grace', '0']));
  assert.equal(readInbox(path.join(f.org, 'supervisor/inbox.log')).filter(e => e.id === `watch:${run}:final`).length, 1);
});

test('explicit Brain receipt adoption binds old dispatch, settle and queued promotion releases', t => {
  for (const kind of ['dispatch', 'settle', 'supervisor']) {
    const f = fixture(t), run = f.start({ owned: false }), project = gitProject(f.repo);
    const release = bundleRelease();
    const file = kind === 'supervisor' ? path.join(receiptDirectory(f.org, project.identity), `${run}.json`) : path.join(f.org, kind, `${run}.json`);
    put(file, { run, org: f.org, repo: f.repo, common: project.identity, identity: project.identity, release,
      stage: kind === 'dispatch' ? 'launching' : 'reviewing', phase: 'enqueuing' });
    assert.match(bookkeeping(f, ['claim', run, '--controller', 'brain']).stderr, /RUN_CLAIM_TRANSFER_REFUSED/);
    const result = bookkeeping(f, ['claim', run, '--controller', 'brain', '--adopt-brain-receipt', file]);
    ok(result); assert.equal(binding(f, run).owner.release.root, release.root);
    assert.equal(events(f).find(e => e.type === 'run.claimed').adoption.receipt, file);
    assert.equal(JSON.parse(ok(bookkeeping(f, ['claim', run, '--controller', 'brain', '--adopt-brain-receipt', file]))).already, true);
    if (kind === 'dispatch') fs.rmSync(path.join(f.org, 'dispatch'), { recursive: true }); // No worker launched.
  }
});

test('Brain adoption refuses foreign receipts and unavailable saved releases without claiming', t => {
  const f = fixture(t), run = f.start({ owned: false }), file = path.join(f.org, 'settle', `${run}.json`);
  const saved = { run, org: f.org, common: gitProject(f.repo).identity, release: bundleRelease(), stage: 'reviewing' };
  for (const wrong of [{ run: 'R-999' }, { org: f.root }, { common: f.root }, { release: null }, { release: { ...saved.release, commit: 'a'.repeat(40) } }]) {
    put(file, { ...saved, ...wrong });
    const result = bookkeeping(f, ['claim', run, '--controller', 'brain', '--adopt-brain-receipt', file]);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(readOwnedRun(f.org, run).owner, undefined);
  }
});

test('a blocking idle watcher keeps one wait and an unchanged receipt between signals', async t => {
  const f = fixture(t), run = f.start(), herdr = path.join(f.root, 'bin/herdr');
  const report = f.show(run).report_path;
  fs.writeFileSync(herdr, fs.readFileSync(herdr, 'utf8').replace('await new Promise(r=>setTimeout(r,100));out({});', `while(!fs.existsSync(${JSON.stringify(report)}))await new Promise(r=>setTimeout(r,50));out({});`));
  const w = f.concurrent(run, path.join(source, 'watch/watch.mjs'), ['--org', f.org, '--cwd', f.repo, '--start-grace', '0']);
  await waitUntil(() => f.calls().some(a => a[0] === 'agent' && a[1] === 'wait'));
  const file = path.join(f.org, 'watch', `${run}.json`), stat = fs.statSync(file).mtimeMs, count = f.calls().length;
  await new Promise(resolve => setTimeout(resolve, 2300));
  assert.equal(f.calls().length, count, 'no 1 Hz transport/probe loop');
  assert.equal(fs.statSync(file).mtimeMs, stat, 'no idle receipt rewrites');
  f.report(run); ok(await w.done);
});

test('self-tab close may kill its watcher without leaving an outstanding cleanup intent', async t => {
  const f = fixture(t), run = f.start(); f.record(['abandon', run]);
  const herdr = path.join(f.root, 'kill-close'), marker = path.join(f.root, 'closed');
  fs.writeFileSync(herdr, `#!/bin/sh\nif [ "$1 $2" = 'tab close' ]; then\n  touch '${marker}'\n  kill -KILL "$PPID"\nfi\n`, { mode: 0o755 });
  const preload = path.join(f.root, 'keep-alive.mjs'); fs.writeFileSync(preload, 'setInterval(()=>{},1000);');
  const child = spawnChild(t, process.execPath, ['--import', preload, path.join(source, 'watch/watch.mjs'), run,
    '--org', f.org, '--cwd', f.repo, '--herdr', herdr, '--close-tab-on-exit'], { cwd: f.repo, env: { ...f.env, HERDR_TAB_ID: 'own-tab' } });
  const result = await waitForExit(child);
  assert.equal(result.signal, 'SIGKILL', result.stderr);
  assert.ok(fs.existsSync(marker));
  const receipt = JSON.parse(fs.readFileSync(path.join(f.org, 'watch', `${run}.json`)));
  assert.equal(receipt.intent, undefined); assert.equal(receipt.cleanup.state, 'handed-off');
  assert.deepEqual(outstandingEffects(f.org, readOwnedRun(f.org, run)), []);
  ok(node(f, 'bin/org.mjs', transferArgs(run, binding(f, run))));
});

test('legacy watch transport and supervisor restarts never create a Brain review or duplicate legacy enqueue', t => {
  const f = fixture(t), run = f.start({ owned: false }); f.commit('correct\n'); f.report(run);
  f.record(['claim', run, '--controller', 'legacy', '--legacy']);
  const delivery = path.join(f.root, 'legacy-watch-delivery.mjs');
  fs.writeFileSync(delivery, `import {promptSupervisor} from ${JSON.stringify(pathToFileURL(path.join(source, 'supervisor/prompt-supervisor.mjs')).href)};
console.log(JSON.stringify(await promptSupervisor('supervisor-herdr',${JSON.stringify(`[org-report] run=${run} item=${f.show(run).item} outcome=done headline=Legacy final`)},${JSON.stringify({ org: f.org, cwd: f.repo, herdr: path.join(f.root, 'bin/herdr'), id: `watch:${run}:final`, attempts: 1, retrySeconds: 0 })})));`);
  for (let restart = 0; restart < 2; restart++) {
    ok(f.exec(process.execPath, [delivery]));
    assert.match(handle(f, run, restart ? ['--retry'] : []).stderr, /RUN_OWNED_ELSEWHERE/);
  }
  const queue = queueFor(f.repo), options = { org: f.org, run, expectedHead: f.git(['rev-parse', 'HEAD'], f.workspace) };
  assert.equal(enqueue(queue, ['topic'], options)[0].duplicate, false);
  assert.equal(enqueue(queueFor(f.repo), ['topic'], options)[0].duplicate, true);
  assert.equal(reviews(f), 0); assert.equal(queue.load().pending.length, 1);
  assert.equal(readInbox(path.join(f.org, 'supervisor/inbox.log')).length, 1);
  fs.rmSync(queue.file); // Legacy enqueue only; no drain process.
});

test('moving source HEAD retains settle, handle, re-arm, correction and promotion callback admission', t => {
  const f = fixture(t), runtime = path.join(f.root, 'source-runtime'); copyProduct(source, runtime);
  f.env.SETTLE_TEST_RECORD = path.join(runtime, 'bin/org.mjs');
  f.git(['init', '-qb', 'main'], runtime); f.git(['config', 'user.name', 'Fixture'], runtime); f.git(['config', 'user.email', 'fixture@example.invalid'], runtime);
  f.git(['add', '.'], runtime); f.git(['commit', '-qm', 'Initial source runtime'], runtime);
  const run = f.start({ owned: false }); ok(claim(f, run, ['--release-root', runtime]));
  const original = binding(f, run), before = f.git(['rev-parse', 'HEAD'], runtime);
  f.git(['commit', '--allow-empty', '-qm', 'Another promotion advances source HEAD'], runtime);
  assert.notEqual(f.git(['rev-parse', 'HEAD'], runtime), before);
  assert.deepEqual(binding(f, run), original);
  f.commit('correct\n'); f.report(run);
  ok(node(f, 'watch/watch.mjs', [run, '--org', f.org, '--cwd', f.repo, '--start-grace', '0']));
  const ready = JSON.parse(ok(reviewResult(f, f.settle(run)))); assert.equal(ready.result, 'promotable');
  assert.equal(JSON.parse(ok(handle(f, run))).result, 'promotable');
  const queue = queueFor(f.repo); ok(promote(f, run, enqueueAdapter(f, runtime)));
  // The queue completion boundary is scripted; admission, callback, record and
  // actual source/project HEAD moves remain real. No gate or worker is launched.
  localGit(f, ['merge', '--ff-only', ready.head]);
  localGit(f, ['commit', '--allow-empty', '-qm', 'This promotion advances source HEAD'], runtime);
  const job = queue.load().pending[0];
  queue.transaction(q => { q.pending = []; q.results.push({ ...job, outcome: 'promoted', tip: ready.head }); });
  const callback = () => spawnSync(process.execPath, [path.join(source, 'supervisor/supervisor.mjs'), 'handle', '--notice', `[promote-queue] id=${job.id} lane=topic`, '--role', 'supervisor'], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(JSON.parse(ok(callback())).result, 'recorded_promotion');
  assert.equal(JSON.parse(ok(callback())).result, 'recorded_promotion');
  fs.rmSync(queue.file);
  const item = f.record(['add', 'Correction after source move', '--role', 'engineer']).split(' ')[0];
  const previous = f.record(['start', item, '--workspace', f.workspace, '--meta', 'lane=topic']).match(/R-\d+/)[0];
  ok(claim(f, previous, ['--release-root', runtime])); f.report(previous); f.record(['ingest', f.show(previous).report_path]);
  f.git(['commit', '--allow-empty', '-qm', 'Advance before correction'], runtime);
  const lane = path.join(f.root, 'stop-launch.mjs'); fs.writeFileSync(lane, `#!${process.execPath}\nif(process.argv[2]==='dispatch'){console.error('source correction admitted');process.exitCode=1;}`, { mode: 0o755 });
  const correction = spawnSync(process.execPath, [path.join(source, 'dispatch/dispatch.mjs'), item, '--org', f.org, '--lane', 'topic', '--route', 'engineer', '--brief', path.join(f.root, 'ask with spaces.md'), '--from-run', previous, '--lane-cli', lane], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(correction.status, 1); assert.match(correction.stderr, /source correction admitted/);
  const successor = [...fold(events(f)).runs.values()].at(-1);
  assert.notEqual(successor.id, previous); assert.deepEqual(successor.owner, binding(f, previous).owner);
  fs.rmSync(path.join(f.org, 'dispatch'), { recursive: true }); // Launch stopped before creating a worker.
});

test('adopted pre-upgrade settle and queue receipts finish without another review', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const ready = JSON.parse(ok(reviewResult(f, handle(f, run)))), q = queueFor(f.repo);
  ok(promote(f, run, enqueueAdapter(f)));
  const settleFile = path.join(f.org, 'settle', `${run}.json`), requestFile = path.join(receiptDirectory(f.org, q.project.identity), `${run}.json`);
  // Replay the real receipts as the previous release wrote them, before claims
  // existed. No pending model/transport process is synthesized or discarded.
  const older = events(f).filter(e => e.type !== 'run.claimed').map((e, i) => ({ ...e, seq: i + 1 }));
  fs.writeFileSync(path.join(f.org, 'events.jsonl'), older.map(e => JSON.stringify(e) + '\n').join(''));
  for (const file of [settleFile, requestFile]) {
    const saved = JSON.parse(fs.readFileSync(file)); delete saved.ownership; delete saved.ownerActive; put(file, saved);
  }
  q.transaction(data => { delete data.pending[0].ownership; });
  const count = reviews(f);
  assert.match(handle(f, run).stderr, /RUN_OWNER_UNCLAIMED/);
  ok(bookkeeping(f, ['claim', run, '--controller', 'brain', '--adopt-brain-receipt', requestFile]));
  const job = q.load().pending[0], owned = readOwnedRun(f.org, run);
  assert.equal(adoptedPromotionBinding(f.org, owned, job), true);
  assert.equal(adoptedPromotionBinding(f.org, owned, { ...job, release: { ...job.release, root: f.root } }), false);
  // Continue the completed settle checkpoint, retaining its original review.
  assert.equal(JSON.parse(ok(handle(f, run, ['--retry']))).result, 'promotable');
  assert.equal(reviews(f), count);
  localGit(f, ['merge', '--ff-only', ready.head]);
  q.transaction(data => { data.pending = []; data.results.push({ ...job, outcome: 'promoted', tip: ready.head }); });
  const result = spawnSync(process.execPath, [path.join(source, 'supervisor/supervisor.mjs'), 'handle', '--notice', `[promote-queue] id=${job.id} lane=topic`, '--role', 'supervisor'], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(JSON.parse(ok(result)).result, 'recorded_promotion');
  assert.equal(reviews(f), count); assert.equal(q.load().results.length, 1);
  fs.rmSync(q.file); // Scripted completed queue boundary; no native worker.
});

test('adopting an old installed dispatch receipt retries its saved release instead of current', t => {
  const f = fixture(t), run = f.start({ owned: false }), root = path.join(f.root, 'old-runtime');
  fs.mkdirSync(path.join(root, 'dispatch'), { recursive: true }); fs.writeFileSync(path.join(root, '.release-commit'), 'a'.repeat(40));
  fs.writeFileSync(path.join(root, 'dispatch/dispatch.mjs'), "console.log('continued-original-dispatch');");
  const file = path.join(f.org, 'dispatch', `${run}.json`);
  put(file, { run, org: f.org, repo: f.repo, stage: 'launching', release: bundleRelease(root) });
  ok(bookkeeping(f, ['claim', run, '--controller', 'brain', '--adopt-brain-receipt', file]));
  const result = spawnSync(process.execPath, [path.join(source, 'dispatch/dispatch.mjs'), '--retry', file, '--org', f.org], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.match(ok(result), /continued-original-dispatch/);
  assert.equal(events(f).filter(e => e.type === 'run.claimed').length, 1);
  fs.rmSync(path.join(f.org, 'dispatch'), { recursive: true }); // Old runtime stub performs no launch.
});
