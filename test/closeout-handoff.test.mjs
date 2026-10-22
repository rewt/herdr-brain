// Receipt/outcome checks use Git, files and file-only promotion locks; no native
// process source, watcher or retirement/consumer claim.
import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { completedCloseoutKeys, handoffCloseout } from '../lib/closeout-handoff.mjs';
import { recordedCloseoutHandoff } from '../lib/closeout.mjs';
import { readPlainFile } from '../lib/files.mjs';
import { digest } from '../lib/completion.mjs';
import { promotionCloseoutOutcome } from '../lib/closeout-results.mjs';
import { outstandingEffects } from '../lib/run-owner.mjs';
import { queueFor, retryCleanup } from '../promote/promote.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, { handed = true } = {}) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'completion-tail-')));
  const fleet = process.env.HERDR_MONITOR_FLEET;
  process.env.HERDR_MONITOR_FLEET = path.join(repo, '.lane/fleet');
  t.after(() => { if (fleet === undefined) delete process.env.HERDR_MONITOR_FLEET; else process.env.HERDR_MONITOR_FLEET = fleet; });
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Tail fixture']); git(['config', 'user.email', 'tail@example.invalid']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.org/\n.lane/\n'); git(['add', '.']); git(['commit', '-qm', 'Base']);
  const common = fs.realpathSync(path.join(repo, '.git')), head = git(['rev-parse', 'HEAD']), org = path.join(repo, '.org');
  fs.mkdirSync(org); fs.mkdirSync(path.join(repo, '.lane'));
  const log = path.join(repo, '.lane/gate.log'); fs.writeFileSync(log, 'green offline gate\n');
  const receipt = path.join(repo, '.lane/manual.record.json'), checkpoint = receipt + '.closeout.json';
  const target = { schema: 'closeout-entry/v2', key: '1'.repeat(64), common, project: repo, org,
    run: 'R-1', item: 'ENG-1', signal: 'landed', branch: 'lane/topic', head, cwd: path.join(repo, 'original-lane') };
  const payload = { version: 1, batch: 'manual-recovery', org, identity: common, base: head, tip: head,
    gate: { exit_code: 0, log, sha256: sha(fs.readFileSync(log)) }, items: [{ item: target.item, run: target.run, head, superseded: [] }], excluded: [] };
  fs.writeFileSync(receipt, JSON.stringify(payload));
  const source = { type: 'promotion.reconciled', identity: common, batch: payload.batch, base: head, tip: head,
    fingerprint: digest(payload), gate: payload.gate, heads: [{ item: target.item, run: target.run, head }], closeout_targets: [target], seq: 5 };
  const tail = { schema: 'closeout-completion/v1', identity: common, project: repo, org,
    source: { seq: source.seq, type: source.type, fingerprint: source.fingerprint, digest: digest(source), batch: source.batch },
    receipt: { file: receipt, sha256: sha(fs.readFileSync(receipt)), fingerprint: source.fingerprint }, keys: [target.key] };
  fs.writeFileSync(checkpoint, JSON.stringify(tail));
  const events = [
    { type: 'item.added', id: target.item, kind: 'work', role: 'engineer', seq: 1 },
    { type: 'run.started', id: target.run, item: target.item, workspace: target.cwd, meta: {}, seq: 2 },
    { type: 'report.ingested', run: target.run, report: { outcome: 'done' }, sha256: 'fixture', seq: 3 },
    { type: 'item.closed', id: target.item, as: 'done', seq: 4 }, source,
    ...(handed ? [{ type: 'closeout.handoff', seq: 6, identity: common, project: repo, org,
      source: { seq: source.seq, type: source.type }, keys: [target.key], checkpoint, digest: digest(tail) }] : []),
  ];
  const eventFile = path.join(org, 'events.jsonl'), save = () => fs.writeFileSync(eventFile, events.map(e => JSON.stringify(e) + '\n').join(''));
  save();
  const expected = { common, project: repo, org, run: target.run, item: target.item, topic: 'topic', tip: head,
    source: { seq: source.seq, type: source.type, fingerprint: source.fingerprint } };
  const resolve = (binding = expected) => completedCloseoutKeys({ cwd: repo, org, expected: binding });
  return { repo, common, org, git, target, source, tail, payload, receipt, checkpoint, log, events, eventFile, save, expected, resolve };
}

function systemAlias(t, file) {
  for (const alias of ['/var', '/tmp', '/etc']) {
    const physical = fs.realpathSync(alias);
    if (alias !== physical && file.startsWith(physical + path.sep)) return alias + file.slice(physical.length);
  }
  t.skip('this host has no macOS system alias for the scratch directory');
}

test('a recovered source alone cannot substitute for its manual caller tail', t => {
  const f = fixture(t, { handed: false }), before = fs.readFileSync(f.eventFile);
  assert.throws(() => f.resolve(), /awaiting exact completion handoff/);
  assert.deepEqual(fs.readFileSync(f.eventFile), before);
});

test('an exact committed manual tail resolves idempotently without another handoff or effect', t => {
  const f = fixture(t), before = fs.readFileSync(f.eventFile), checkpoint = fs.readFileSync(f.checkpoint);
  assert.deepEqual(f.resolve(), [f.target.key]); assert.deepEqual(f.resolve(), [f.target.key]);
  assert.deepEqual(fs.readFileSync(f.eventFile), before); assert.deepEqual(fs.readFileSync(f.checkpoint), checkpoint);
});

for (const field of ['common', 'project', 'org', 'run', 'item', 'topic', 'tip', 'source-seq', 'source-type', 'source-fingerprint'])
  test(`a recovered outbox cannot redirect its ${field} binding`, t => {
    const f = fixture(t), expected = structuredClone(f.expected);
    if (field.startsWith('source-')) expected.source[field.slice(7)] = field === 'source-seq' ? 99 : 'foreign';
    else expected[field] = field === 'org' ? f.repo : 'foreign';
    assert.throws(() => f.resolve(expected), /binding|source|target/);
  });

for (const change of ['source', 'gate', 'receipt-bytes', 'checkpoint', 'redirected-receipt'])
  test(`a committed completion tail keeps changed ${change} evidence`, t => {
    const f = fixture(t);
    if (change === 'source') { f.source.heads[0].head = 'f'.repeat(40); f.save(); }
    if (change === 'gate') fs.appendFileSync(f.log, 'changed');
    if (change === 'receipt-bytes') fs.appendFileSync(f.receipt, ' ');
    if (change === 'checkpoint') fs.appendFileSync(f.checkpoint, 'changed');
    if (change === 'redirected-receipt') {
      const copy = f.receipt + '.copy'; fs.renameSync(f.receipt, copy); fs.symlinkSync(copy, f.receipt);
    }
    assert.throws(() => f.resolve());
  });

for (const change of ['reopen', 'new-run']) test(`manual recovery cannot acquire authority after ${change}`, t => {
  const f = fixture(t);
  f.events.push(change === 'reopen' ? { type: 'item.reopened', id: f.target.item, seq: 7 } :
    { type: 'run.started', id: 'R-2', item: f.target.item, workspace: f.target.cwd, meta: {}, seq: 7 });
  f.save(); assert.throws(() => f.resolve(), /reopened|run changed/);
});

for (const location of ['receipt', 'checkpoint', 'gate']) test(`legacy completion proof inside the target keeps before any effect (${location})`, t => {
  const f = fixture(t), directory = path.join(f.target.cwd, '.lane'); fs.mkdirSync(directory, { recursive: true });
  const inside = path.join(directory, `${location}.json`);
  if (location === 'receipt') {
    fs.copyFileSync(f.receipt, inside); f.tail.receipt.file = inside;
  } else if (location === 'checkpoint') {
    fs.writeFileSync(inside, JSON.stringify(f.tail)); f.events.at(-1).checkpoint = inside;
  } else {
    fs.copyFileSync(f.log, inside); f.source.gate.log = inside;
    f.payload.gate.log = inside;
    fs.writeFileSync(f.receipt, JSON.stringify(f.payload));
    f.source.fingerprint = digest(f.payload);
    f.tail.receipt.sha256 = sha(fs.readFileSync(f.receipt)); f.tail.receipt.fingerprint = f.source.fingerprint;
    f.expected.source.fingerprint = f.source.fingerprint;
  }
  f.tail.source.digest = digest(f.source); f.tail.source.fingerprint = f.source.fingerprint;
  fs.writeFileSync(f.events.at(-1).checkpoint, JSON.stringify(f.tail));
  f.events.at(-1).digest = digest(f.tail); f.save();
  const before = fs.readFileSync(f.eventFile);
  assert.throws(() => f.resolve(), /proof is inside a closing worktree/);
  assert.deepEqual(fs.readFileSync(f.eventFile), before);
  assert.equal(fs.existsSync(f.target.cwd), true);
});

for (const address of ['proof', 'lane']) for (const location of ['receipt', 'checkpoint', 'gate'])
test(`physical proof containment refuses a system alias on the ${address} (${location})`, t => {
  const f = fixture(t), directory = path.join(f.target.cwd, '.lane'); fs.mkdirSync(directory, { recursive: true });
  let inside = path.join(directory, `${location}.json`);
  const aliased = systemAlias(t, address === 'proof' ? inside : f.target.cwd);
  if (!aliased) return;
  if (address === 'proof') inside = aliased; else f.target.cwd = aliased;
  if (location === 'receipt') {
    fs.copyFileSync(f.receipt, inside); f.tail.receipt.file = inside;
  } else if (location === 'checkpoint') f.events.at(-1).checkpoint = inside;
  else {
    fs.copyFileSync(f.log, inside); f.source.gate.log = inside; f.payload.gate.log = inside;
    fs.writeFileSync(f.receipt, JSON.stringify(f.payload)); f.source.fingerprint = digest(f.payload);
    f.tail.receipt.sha256 = sha(fs.readFileSync(f.receipt)); f.tail.receipt.fingerprint = f.source.fingerprint;
    f.expected.source.fingerprint = f.source.fingerprint;
  }
  f.tail.source.digest = digest(f.source); f.tail.source.fingerprint = f.source.fingerprint;
  fs.writeFileSync(f.events.at(-1).checkpoint, JSON.stringify(f.tail)); f.events.at(-1).digest = digest(f.tail); f.save();
  assert.ok(readPlainFile(inside).length, 'the proof reader accepts the OS alias');
  const before = fs.readFileSync(f.eventFile);
  assert.throws(() => f.resolve(), /proof is inside a closing worktree/);
  assert.deepEqual(fs.readFileSync(f.eventFile), before); assert.equal(fs.existsSync(f.target.cwd), true);
});

for (const location of ['receipt', 'gate', 'other-worktree'])
test(`alias-addressed disposable ${location} is refused before publishing any handoff`, t => {
  const f = fixture(t, { handed: false });
  const lane = location === 'other-worktree' ? path.join(f.repo, 'registered-other') : f.target.cwd;
  if (location === 'other-worktree') f.git(['worktree', 'add', '-qb', 'lane/other', lane]);
  fs.mkdirSync(path.join(lane, '.lane'), { recursive: true });
  const inside = systemAlias(t, path.join(lane, '.lane/proof.json'));
  if (!inside) return;
  let receipt = f.receipt;
  if (location === 'gate') {
    fs.copyFileSync(f.log, inside); f.payload.gate.log = inside; f.source.gate.log = inside;
    fs.writeFileSync(receipt, JSON.stringify(f.payload)); f.source.fingerprint = digest(f.payload); f.save();
  } else { fs.copyFileSync(receipt, inside); receipt = inside; }
  const before = fs.readFileSync(f.eventFile);
  assert.throws(() => handoffCloseout({ cwd: f.repo, org: f.org, receipt }), /proof is inside a closing worktree/);
  assert.deepEqual(fs.readFileSync(f.eventFile), before);
  assert.equal(fs.existsSync(path.join(f.common, 'closeout/completions')), false);
  assert.equal(fs.existsSync(lane), true); assert.equal(f.git(['branch', '--list', 'lane/other']) !== '', location === 'other-worktree');
});

function promotion(f) {
  const queue = queueFor(f.repo), job = { id: 'deferred', org: f.org, run: f.target.run, item: f.target.item,
    topic: 'topic', tip: f.target.head, outcome: 'promoted', delivered: true,
    reconciliation: { state: 'complete', fingerprint: f.source.fingerprint, receipt: f.receipt },
    cleanup: { state: 'pending', owner: 'closeout-queue', reason: 'HOLD', keys: [f.target.key], source: f.expected.source } };
  queue.transaction(data => data.results.push(job));
  const run = { id: f.target.run, item: f.target.item, report: { outcome: 'done' } };
  const read = () => outstandingEffects(f.org, run, f.common);
  const outcome = completed => {
    const handoff = f.events.findLast(e => e.type === 'closeout.handoff');
    f.events.push({ type: 'closeout.evaluated', seq: f.events.length + 1, identity: f.common, key: f.target.key,
      run: f.target.run, item: f.target.item, source: { seq: f.source.seq, type: f.source.type }, completed,
      ...(handoff ? { handoff: { seq: handoff.seq, digest: handoff.digest } } : {}),
      ...(!completed ? { reason: 'HOLD', waiting: { event: 'hold-removed' } } : {}) }); f.save();
  };
  return { queue, job, read, outcome };
}

function replaceDisposableHandoff(f) {
  const inside = path.join(f.target.cwd, '.lane/original.record.json'); fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.copyFileSync(f.receipt, inside);
  const obsolete = f.events.find(e => e.type === 'closeout.handoff');
  fs.writeFileSync(obsolete.checkpoint, JSON.stringify({ ...f.tail, receipt: { ...f.tail.receipt, file: inside } }));
  obsolete.digest = digest(JSON.parse(fs.readFileSync(obsolete.checkpoint)));
  const checkpoint = path.join(f.common, 'closeout/completions', `${f.source.seq}-${f.tail.receipt.sha256}-${digest(f.tail.keys).slice(0, 16)}.json`);
  fs.mkdirSync(path.dirname(checkpoint), { recursive: true }); fs.writeFileSync(checkpoint, JSON.stringify(f.tail));
  const replacement = { ...obsolete, seq: f.events.length + 1, checkpoint, digest: digest(f.tail) };
  f.events.push(replacement); f.save(); return { obsolete, replacement, inside };
}

test('a successful replacement of obsolete disposable proof clears exact outcomes, recovery and ownership after removal', t => {
  const f = fixture(t), p = promotion(f), { replacement, inside } = replaceDisposableHandoff(f);
  const entry = { ...f.target, source: f.expected.source };
  assert.equal(recordedCloseoutHandoff(entry, f.events).seq, replacement.seq, 'publication recovery selects the replacement');
  assert.deepEqual(f.resolve(), [f.target.key], 'recovered outbox uses the current exact tail before evaluation');
  p.outcome(false); retryCleanup(p.queue); assert.equal(p.queue.load().results[0].cleanup.state, 'pending');
  p.outcome(true);
  assert.deepEqual(f.events.at(-1).handoff, { seq: replacement.seq, digest: replacement.digest });
  fs.rmSync(f.target.cwd, { recursive: true }); assert.equal(fs.existsSync(inside), false);
  const before = fs.readFileSync(f.eventFile), gate = fs.readFileSync(f.log), receipt = fs.readFileSync(f.receipt);
  assert.equal(promotionCloseoutOutcome(p.job, f.common).complete, true);
  assert.deepEqual(f.resolve(), [f.target.key]); assert.deepEqual(p.read(), []);
  retryCleanup(p.queue); const saved = p.queue.load().results[0]; assert.equal(saved.cleanup.state, 'complete');
  retryCleanup(p.queue); assert.deepEqual(p.queue.load().results[0], saved);
  assert.deepEqual(fs.readFileSync(f.eventFile), before); assert.deepEqual(fs.readFileSync(f.log), gate);
  assert.deepEqual(fs.readFileSync(f.receipt), receipt);
});

for (const change of ['obsolete', 'sequence', 'digest', 'future', 'ambiguous-legacy'])
test(`completed bookkeeping cannot substitute another handoff for its ${change} binding`, t => {
  const f = fixture(t), p = promotion(f);
  if (change === 'future') p.outcome(true);
  const { obsolete, replacement } = replaceDisposableHandoff(f);
  if (change !== 'future') p.outcome(true);
  const outcome = f.events.findLast(e => e.type === 'closeout.evaluated');
  if (change === 'obsolete') outcome.handoff = { seq: obsolete.seq, digest: obsolete.digest };
  if (change === 'sequence') outcome.handoff.seq = 999;
  if (change === 'digest') outcome.handoff.digest = 'f'.repeat(64);
  if (change === 'future') outcome.handoff = { seq: replacement.seq, digest: replacement.digest };
  if (change === 'ambiguous-legacy') delete outcome.handoff;
  f.save();
  assert.throws(() => f.resolve(), /handoff|proof is inside/);
  retryCleanup(p.queue); assert.equal(p.queue.load().results[0].cleanup.state, 'pending');
  assert.deepEqual(p.read(), ['promotion:unreconciled/pending-callback']);
});

test('a legacy completed evaluation with one exact handoff still clears bookkeeping', t => {
  const f = fixture(t), p = promotion(f); p.outcome(true); delete f.events.at(-1).handoff; f.save();
  assert.deepEqual(f.resolve(), [f.target.key]); assert.deepEqual(p.read(), []);
  retryCleanup(p.queue); assert.equal(p.queue.load().results[0].cleanup.state, 'complete');
});

test('a later unrelated tail cannot redirect a completed outcome from its verified handoff', t => {
  const f = fixture(t), p = promotion(f); p.outcome(true);
  f.events.push({ ...f.events.find(e => e.type === 'closeout.handoff'), seq: f.events.length + 1,
    checkpoint: path.join(f.repo, 'missing-checkpoint.json'), digest: 'f'.repeat(64) }); f.save();
  assert.deepEqual(f.resolve(), [f.target.key]); assert.deepEqual(p.read(), []);
  retryCleanup(p.queue); assert.equal(p.queue.load().results[0].cleanup.state, 'complete');
});

test('KEEP then exact durable completion clears promotion bookkeeping and outstanding effects without another executor', t => {
  const f = fixture(t), p = promotion(f);
  p.outcome(false);
  assert.equal(promotionCloseoutOutcome(p.job, f.common).complete, false);
  assert.deepEqual(p.read(), ['promotion:unreconciled/pending-callback']);
  retryCleanup(p.queue); assert.equal(p.queue.load().results[0].cleanup.state, 'pending');
  p.outcome(true);
  const before = fs.readFileSync(f.eventFile), gate = fs.readFileSync(f.log), receipt = fs.readFileSync(f.receipt);
  assert.deepEqual(p.read(), [], 'ownership readers recognize completion before the queue checkpoint catches up');
  assert.equal(p.queue.load().results[0].cleanup.state, 'pending');
  retryCleanup(p.queue);
  const saved = p.queue.load().results[0];
  assert.equal(saved.cleanup.state, 'complete'); assert.equal(saved.cleanup.owner, 'closeout-queue');
  assert.deepEqual(saved.cleanup.outcomes, [f.events.at(-1).seq]);
  retryCleanup(p.queue); assert.deepEqual(p.queue.load().results[0], saved);
  assert.deepEqual(fs.readFileSync(f.eventFile), before);
  assert.deepEqual(fs.readFileSync(f.log), gate); assert.deepEqual(fs.readFileSync(f.receipt), receipt);
});

test('a startup failure stays pending until exact completion, including results written before key checkpointing', t => {
  const f = fixture(t), p = promotion(f);
  p.queue.transaction(data => { delete data.results[0].cleanup.keys; delete data.results[0].cleanup.source; });
  assert.deepEqual(p.read(), ['promotion:unreconciled/pending-callback']);
  retryCleanup(p.queue); assert.equal(p.queue.load().results[0].cleanup.state, 'pending');
  p.outcome(true); assert.deepEqual(p.read(), []);
  retryCleanup(p.queue); assert.equal(p.queue.load().results[0].cleanup.state, 'complete');
});

for (const when of ['before', 'after']) test(`reopening ${when} a durable closeout distinguishes pending authority from completed bookkeeping`, t => {
  const f = fixture(t), p = promotion(f);
  const reopen = () => { f.events.push({ type: 'item.reopened', seq: f.events.length + 1, id: f.target.item }); f.save(); };
  if (when === 'before') reopen();
  p.outcome(true);
  if (when === 'after') reopen();
  retryCleanup(p.queue);
  assert.equal(p.queue.load().results[0].cleanup.state, when === 'before' ? 'pending' : 'complete');
  assert.deepEqual(p.read(), when === 'before' ? ['promotion:unreconciled/pending-callback'] : []);
});

test('a completion outcome without its exact durable handoff cannot clear promotion ownership', t => {
  const f = fixture(t, { handed: false }), p = promotion(f); p.outcome(true);
  retryCleanup(p.queue); assert.equal(p.queue.load().results[0].cleanup.state, 'pending');
  assert.deepEqual(p.read(), ['promotion:unreconciled/pending-callback']);
});

for (const field of ['key', 'source-seq', 'source-type', 'run', 'item', 'identity', 'topic', 'tip', 'fingerprint', 'checkpoint'])
test(`deferred promotion cannot inherit a different completion (${field})`, t => {
  const f = fixture(t), p = promotion(f); p.outcome(true);
  const event = f.events.at(-1);
  if (field === 'source-seq') event.source.seq++;
  else if (field === 'source-type') event.source.type = 'lane.recovery-requested';
  else if (['key', 'run', 'item', 'identity'].includes(field)) event[field] = 'different';
  else if (field === 'checkpoint') fs.appendFileSync(f.checkpoint, 'changed');
  else p.queue.transaction(data => {
    const row = data.results[0];
    if (field === 'fingerprint') row.reconciliation.fingerprint = 'different';
    else row[field] = 'different';
  });
  f.save(); retryCleanup(p.queue);
  assert.equal(p.queue.load().results[0].cleanup.state, 'pending');
  assert.deepEqual(p.read(), ['promotion:unreconciled/pending-callback']);
});
