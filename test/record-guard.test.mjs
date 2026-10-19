import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setupOrg, BIN, report } from './helpers.mjs';
import { queueFor, enqueue } from '../promote/promote.mjs';
import { fold as olderFold } from './fixtures/state-v0.mjs';
import { recordPaneRelease } from '../lib/retire-command.mjs';
import { completionFingerprint } from '../lib/completion.mjs';
import { fold } from '../lib/state.mjs';

function fixture(t, { done = true, question = false, launched = false } = {}) {
  const f = setupOrg();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const git = args => {
    const r = spawnSync('git', ['-C', f.root, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Guard']); git(['config', 'user.email', 'guard@example.invalid']);
  fs.writeFileSync(path.join(f.root, '.gitignore'), '.org/\n.lane/\n');
  git(['add', '.gitignore']); git(['commit', '-qm', 'Base']);
  const parent = f.ok(['add', 'Parent', '--goal']).trim();
  const blocker = f.ok(['add', 'Dependency']).trim();
  f.ok(['close', blocker]);
  const item = f.ok(question ? ['ask', 'Proceed?', '--parent', parent, '--category', 'design', '--recommend', 'yes', '--why', 'Need a decision', '--wait'] : ['add', 'Guarded work', '--parent', parent]).trim();
  const child = f.ok(['add', 'Existing child', '--parent', item]).trim();
  f.ok(['block', item, '--by', blocker]);
  const run = f.ok(['start', item, '--workspace', f.root]).match(/^R-\d+/)[0];
  if (launched) f.ok(['worker', run, '--agent', 'old-worker', '--pane', 'w:p', '--worker-workspace', 'w', '--cwd', f.root, '--terminal-id', 'term', '--agent-session-id', 'session']);
  const file = path.join(f.root, '.org/runs', run, 'report.md');
  if (done) { fs.writeFileSync(file, report(`run: ${run}\noutcome: done\nsummary: Implemented`)); f.ok(['ingest', file]); }
  const other = f.ok(['add', 'Unrelated work']).trim();
  const queue = queueFor(f.root), head = git(['rev-parse', 'HEAD']);
  const job = enqueue(queue, ['guarded-work'], { org: f.dir, run, expectedHead: head })[0];
  const batch = (phase = 'prepared', result) => {
    const id = 'batch-guard', jobs = queue.load().pending;
    const receipt = path.join(queue.directory, 'batches', id, 'train.json');
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(receipt, JSON.stringify({ schema: 'promotion-train/v1', id, identity: queue.project.identity, jobs,
      phase, results: result ? { [job.id]: { ...result, batch: id } } : {} }));
    queue.transaction(data => { data.pending = []; data.current = { id, phase: 'batching', jobs }; });
    return { id, receipt };
  };
  const refuse = (args, options) => {
    const before = f.events();
    const r = f.org(args, options);
    assert.equal(r.code, 3, `${args.join(' ')}\n${r.err}${r.out}`);
    assert.match(r.err, /promotion write guard REFUSED/);
    assert.match(r.err, /parent.*digest.*copy.*after landing/);
    assert.deepEqual(f.events(), before, 'refusal appends no events');
    return r.err;
  };
  return { ...f, git, parent, blocker, item, child, run, file, other, queue, job, head, batch, refuse };
}

test('queued member writes, run aliases, dependencies and child creation refuse with the queue job id', t => {
  const f = fixture(t);
  for (const args of [
    ['note', f.item, 'Queued update'], ['note', f.run, 'Run update'],
    ['set', f.item, 'priority=9'], ['set', f.run, 'tokens_in=42'],
    ['block', f.item, '--by', f.other], ['unblock', f.item, '--by', f.blocker],
    ['close', f.item], ['close', f.item, '--if-current-run', f.run], ['reopen', f.item], ['start', f.item],
    ['add', 'New scope', '--parent', f.item], ['set', f.other, `parent=${f.item}`],
    ['note', f.blocker, 'Dependency changes'],
    ['set', f.child, 'role=reviewer'], ['start', f.child], ['note', f.child, 'Child scope changes'],
    ['ask', 'Change scope?', '--parent', f.item, '--category', 'design', '--recommend', 'no', '--why', 'New decision', '--wait'],
  ]) assert.ok(f.refuse(args).includes(f.job.id));
  f.ok(['note', f.other, 'Independent']);
  f.ok(['note', f.parent, 'Digest pointer']);
  f.ok(['note', f.other, `Free text mentions ${f.item}; it is not a target`]);
});

test('worker and abandon resolve the run to its queued item; question answers are guarded', t => {
  const f = fixture(t, { done: false });
  f.refuse(['worker', f.run, '--agent', 'worker', '--pane', 'w:p', '--worker-workspace', 'w', '--cwd', f.root, '--terminal-id', 'term']);
  f.refuse(['abandon', f.run]);
  const q = fixture(t, { question: true });
  q.refuse(['answer', q.item, 'yes']);
});

test('queued recovery overrides require the exact job and lifecycle commands cannot bypass the guard', t => {
  const f = fixture(t, { launched: true }), options = { env: { ORG_GUARD_OVERRIDE: f.job.id } };
  const before = f.events();
  assert.throws(() => recordPaneRelease({ org: f.dir, run: f.run, opt: {
    session: 'session', terminal: 'term', pane: 'w:p', head: f.head, confirm: true,
    authority: 'Inspected', next: 'Successor', unresolved: 'Retained', evidence: [f.file], why: 'Policy release',
  } }), e => e.exitCode === 3);
  assert.deepEqual(f.events(), before, 'the direct policy writer also preserves batch fingerprints');
  f.refuse(['note', f.item, 'Wrong job'], { env: { ORG_GUARD_OVERRIDE: 'some-other-job' } });
  const next = f.ok(['start', f.item, '--workspace', f.root], options).match(/^R-\d+/)[0];
  f.ok(['worker', next, '--agent', 'new-worker', '--pane', 'w:q', '--worker-workspace', 'w', '--cwd', f.root, '--terminal-id', 'new-term', '--agent-session-id', 'new-session'], options);
  f.refuse(['handoff', f.run, '--to', next, '--confirm', '--why', 'Retained successor']);
  f.refuse(['pane-release', f.run, '--session', 'session', '--terminal', 'term', '--pane', 'w:p', '--head', f.head,
    '--authority', 'Inspected', '--next', 'Successor', '--unresolved', 'Retained', '--evidence', f.file, '--confirm', '--why', 'Handoff']);
  assert.equal(f.events().filter(e => e.type === 'promotion.write-overridden').length, 2);
});

test('enqueue serializes a concurrent writer that would otherwise commit from an unqueued snapshot', async t => {
  const f = fixture(t), run = f.ok(['start', f.other, '--workspace', f.root]).match(/^R-\d+/)[0];
  const status = path.join(f.dir, 'race-status'), release = path.join(f.dir, 'release-writer'), preload = path.join(f.dir, 'race.cjs');
  // Pause the real writer immediately after it snapshots queue.json. With
  // admission locking it instead stops at the record lock, then reads the
  // newly committed queue and refuses. Without the fix it commits a stale note.
  fs.writeFileSync(preload, `const fs=require('node:fs');
const mkdir=fs.mkdirSync, read=fs.readFileSync;let observed=false;
fs.mkdirSync=function(file,...args){try{return mkdir.call(this,file,...args);}catch(e){if(String(file)===${JSON.stringify(path.join(f.dir, 'lock'))}&&e.code==='EEXIST')fs.writeFileSync(${JSON.stringify(status)},'record-blocked');throw e;}};
fs.readFileSync=function(file,...args){const bytes=read.call(this,file,...args);if(!observed&&String(file)===${JSON.stringify(f.queue.file)}){observed=true;fs.writeFileSync(${JSON.stringify(status)},'queue-read');const until=Date.now()+15000;while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>until)throw Error('writer barrier timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}return bytes;};
require('node:module').syncBuiltinESMExports();`);
  const transaction = f.queue.transaction;
  let completed;
  f.queue.transaction = fn => {
    const child = spawn(process.execPath, ['--require', preload, BIN, 'note', f.other, 'Concurrent stale note'], {
      cwd: f.root, env: { ...process.env, ORG_DIR: f.dir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stdout.resume(); child.stderr.on('data', bytes => { err += bytes; });
    completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, err })); });
    const until = Date.now() + 15000;
    while (!fs.existsSync(status)) {
      assert.ok(Date.now() < until, 'writer reached a bounded admission barrier');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    const result = transaction(fn);
    fs.writeFileSync(release, 'continue'); return result;
  };
  try {
    const admitted = enqueue(f.queue, ['other-work'], { org: f.dir, run, expectedHead: f.head })[0];
    const reply = await completed;
    assert.equal(reply.code, 3, reply.err); assert.ok(reply.err.includes(admitted.id));
    assert.ok(!f.events().some(e => e.type === 'note.added' && e.text === 'Concurrent stale note'));
    assert.equal(f.queue.load().pending.find(j => j.id === admitted.id).admittedSeq, f.events().at(-1).seq);
  } finally {
    fs.writeFileSync(release, 'continue');
    if (completed) await completed;
  }
});

test('prepared, gating and green reconciliation-pending batches hold even when stale; exact override is audited', t => {
  for (const phase of ['prepared', 'validating', 'complete']) {
    const f = fixture(t), b = f.batch(phase, phase === 'complete' ? { outcome: 'promoted', tip: f.head } : undefined);
    fs.utimesSync(f.queue.file, 0, 0); fs.utimesSync(b.receipt, 0, 0);
    const message = f.refuse(['note', f.item, 'Held']);
    assert.ok(message.includes(b.id)); assert.match(message, /fail-closed.*never expire/);
    f.refuse(['note', f.item, 'Wrong override'], { env: { ORG_GUARD_OVERRIDE: f.job.id, ORG_ACTOR: 'promotion-queue' } });
    const r = f.org(['note', f.item, 'Inspected recovery'], { env: { ORG_GUARD_OVERRIDE: b.id } });
    assert.equal(r.code, 0, r.err); assert.match(r.err, /OVERRIDE batch-guard/);
    const event = f.events().at(-1);
    assert.equal(event.type, 'promotion.write-overridden'); assert.deepEqual(event.batches, [b.id]);
    assert.deepEqual(event.items, [f.item]); assert.equal(event.command, 'note'); assert.equal(event.override, b.id);
    assert.equal(olderFold(f.events()).items.get(f.item).notes.at(-1).text, 'Inspected recovery');
    f.refuse(['close', f.item, '--if-current-run', f.run], { env: { ORG_ACTOR: 'promotion-queue' } });
  }
});

test('terminal failed gates release members while a red batch queued for bisection keeps them guarded', t => {
  for (const outcome of ['refused', 'timeout']) {
    const f = fixture(t); f.batch('complete', { outcome, gate: { exit_code: 1 } });
    f.ok(['note', f.item, 'Correction after failure']);
    const legacy = fixture(t);
    legacy.queue.transaction(data => { data.current = { ...data.pending.shift(), phase: 'completed', result: { outcome } }; });
    legacy.ok(['note', legacy.item, 'Correction before failed-result delivery']);
  }
  const f = fixture(t), b = f.batch('validating');
  const train = JSON.parse(fs.readFileSync(b.receipt));
  train.attempts = [{ phase: 'red', gate: { exit_code: 1 }, ids: [f.job.id] }];
  fs.writeFileSync(b.receipt, JSON.stringify(train));
  f.refuse(['note', f.item, 'Bisection still queued']);
});

test('legacy completion close requires a persisted promoted exact head; actor and current-run flags grant no exemption', t => {
  for (const phase of ['promoted', 'completed']) {
    const f = fixture(t);
    f.refuse(['close', f.item, '--if-current-run', f.run], { env: { ORG_ACTOR: 'promotion-queue' } });
    f.queue.transaction(data => {
      const [job] = data.pending.splice(0);
      data.current = { ...job, phase, ...(phase === 'completed' ? { result: { outcome: 'promoted', tip: f.head } } : { tip: f.head }) };
    });
    f.refuse(['note', f.item, 'Only completion is allowed']);
    f.ok(['close', f.item, '--if-current-run', f.run, '--note', 'Promoted locally from the queue']);
    assert.equal(f.json(['show', f.item, '--json']).closed.as, 'done');
    f.ok(['note', f.item, 'Copying the digest after legacy completion']);
    f.ok(['reopen', f.item]);
    f.ok(['note', f.item, 'New scope after landing']);
    f.ok(['start', f.item]);
    f.ok(['add', 'Follow-up child', '--parent', f.item]);
  }
});

test('historical promoted results without reconciliation release only after their own current-run close', t => {
  for (const batch of [undefined, 'historical-batch']) {
    const f = fixture(t);
    const original = f.queue.load().pending[0];
    f.queue.transaction(data => { data.pending = []; });
    // An unrelated close must not count as completion of this run.
    f.ok(['close', f.other]);
    f.queue.transaction(data => { data.results.push({ ...original, outcome: 'promoted', tip: f.head, batch }); });
    f.refuse(['note', f.item, 'Not completed yet']);
    f.queue.transaction(data => { data.results = []; });
    f.ok(['close', f.item, '--if-current-run', f.run]);
    f.ok(['reopen', f.item]);
    f.ok(['start', f.item]);
    f.queue.transaction(data => { data.results.push({ ...original, outcome: 'promoted', tip: f.head, batch }); });
    f.ok(['note', f.item, 'Historical landed work stays writable']);
    assert.ok(!f.events().some(e => ['promotion.reconciled', 'promotion.write-overridden'].includes(e.type)));
    // A live reconciliation marker still requires the train's completion.
    f.queue.transaction(data => { data.results[0].reconciliation = { state: 'pending' }; });
    f.refuse(['note', f.item, 'Explicit reconciliation is still pending']);
  }
});

test('validated batch completion is exempt and its durable marker releases members before queue acknowledgement', t => {
  const f = fixture(t), b = f.batch('complete', { outcome: 'promoted', tip: f.head });
  const payload = { version: 1, batch: b.id, org: fs.realpathSync(f.dir), identity: f.queue.project.identity,
    base: f.head, tip: f.head, gate: { exit_code: 0, log: path.join(f.root, 'gate.log'), sha256: '0'.repeat(64) },
    items: [{ item: f.item, run: f.run, head: f.head, expected: completionFingerprint(fold(f.events()), f.item), superseded: [], why: 'Supervisor-attested completion' }], excluded: [] };
  const receipt = path.join(f.dir, 'complete.json'); fs.writeFileSync(receipt, JSON.stringify(payload));
  f.ok(['complete-batch', '--file', receipt]);
  assert.equal(f.json(['show', f.item, '--json']).closed.as, 'done');
  assert.equal(f.events().filter(e => e.type === 'promotion.reconciled').length, 1);
  assert.ok(!f.events().some(e => e.type === 'promotion.write-overridden'));
  fs.writeFileSync(b.receipt, '{obsolete unreadable train');
  f.ok(['note', f.item, 'Copying the digest after landing']);
});

test('validated batch completion allows collateral hits on pending and interrupted dependents', t => {
  for (const relation of ['blocker', 'parent', 'review-child']) {
    const f = fixture(t);
    // Prepare the relationship before admission, as a real dependent would.
    const original = f.queue.load().pending[0];
    f.queue.transaction(data => { data.pending = []; });
    const dependent = f.other;
    if (relation === 'blocker') f.ok(['block', dependent, '--by', f.item]);
    else f.ok(['set', f.item, `parent=${dependent}`, ...(relation === 'review-child' ? ['role=reviewer'] : [])]);
    const dependentRun = f.ok(['start', dependent]).match(/^R-\d+/)[0];
    f.queue.transaction(data => { data.pending = [original]; });
    const b = f.batch('complete', { outcome: 'promoted', tip: f.head, reconciliation: { state: 'pending' } });
    const pending = enqueue(f.queue, ['dependent-work'], { org: f.dir, run: dependentRun, expectedHead: f.head })[0];
    if (relation === 'review-child') f.queue.transaction(data => {
      data.interrupted = [{ ...data.pending.shift(), phase: 'prepared' }];
    });
    f.refuse(['note', f.item, 'Ordinary writes still refuse']);
    const payload = { version: 1, batch: b.id, org: fs.realpathSync(f.dir), identity: f.queue.project.identity,
      base: f.head, tip: f.head, gate: { exit_code: 0, log: path.join(f.root, 'gate.log'), sha256: '0'.repeat(64) },
      items: [{ item: f.item, run: f.run, head: f.head, expected: completionFingerprint(fold(f.events()), f.item), superseded: [], why: 'Supervisor-attested completion' }], excluded: [] };
    const receipt = path.join(f.dir, 'complete.json');
    fs.writeFileSync(receipt, JSON.stringify({ ...payload, identity: path.join(f.root, 'foreign.git') }));
    f.refuse(['complete-batch', '--file', receipt]);
    fs.writeFileSync(receipt, JSON.stringify(payload));
    f.ok(['complete-batch', '--file', receipt]);
    assert.equal(f.json(['show', f.item, '--json']).closed.as, 'done');
    assert.equal(f.json(['show', dependent, '--json']).closed, null);
    assert.ok(f.refuse(['note', dependent, 'Dependent is still queued']).includes(pending.id));
    assert.equal(f.events().filter(e => e.type === 'promotion.reconciled').length, 1);
    assert.ok(!f.events().some(e => e.type === 'promotion.write-overridden'));
  }
});

test('recovery override must name exactly all batch and job ids touched by one write', t => {
  const f = fixture(t);
  const original = f.queue.load().pending[0];
  f.queue.transaction(data => { data.pending = []; });
  const otherRun = f.ok(['start', f.other]).match(/^R-\d+/)[0];
  f.queue.transaction(data => { data.pending = [original]; });
  const b = f.batch();
  const otherJob = enqueue(f.queue, ['other-work'], { org: f.dir, run: otherRun, expectedHead: f.head })[0];
  const args = ['block', f.item, '--by', f.other];
  for (const override of [b.id, otherJob.id, `${b.id},wrong`, `${b.id},${otherJob.id},extra`, `${b.id},${otherJob.id},`]) {
    f.refuse(args, { env: { ORG_GUARD_OVERRIDE: override } });
  }
  const r = f.org(args, { env: { ORG_GUARD_OVERRIDE: `${otherJob.id},${b.id}` } });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.err.includes(b.id) && r.err.includes(otherJob.id));
  const audit = f.events().at(-1);
  assert.equal(audit.type, 'promotion.write-overridden');
  assert.deepEqual(new Set(audit.batches), new Set([b.id, otherJob.id]));
  assert.deepEqual(new Set(audit.items), new Set([f.item, f.other]));
  assert.equal(audit.override, `${otherJob.id},${b.id}`);
});

test('ingest and watcher sync preserve late reports and proposals on queued work', t => {
  for (const command of ['ingest', 'sync']) {
    const f = fixture(t, { done: false });
    fs.writeFileSync(f.file, report(`run: ${f.run}\noutcome: done\nsummary: Late report\nproposals:\n  - role: engineer\n    title: Follow-up\n    why: Preserve scope\n    blocking: true`));
    f.ok(command === 'ingest' ? ['ingest', f.file] : ['sync']);
    assert.equal(f.json(['show', f.run, '--json']).report.summary, 'Late report');
    assert.ok(f.events().some(e => e.type === 'item.added' && e.from_run === f.run));
    assert.equal(fs.readFileSync(path.join(f.dir, 'reports', `${f.run}.md`), 'utf8'), fs.readFileSync(f.file, 'utf8'));
    f.refuse(['note', f.item, 'Still queued']);
  }
});

test('unreadable or malformed local queue fails closed for writes while views and report intake remain usable', t => {
  const f = fixture(t, { done: false });
  const original = fs.readFileSync(f.queue.file);
  fs.writeFileSync(f.queue.file, '{torn queue');
  assert.match(f.refuse(['note', f.other, 'Unknown membership']), /fail-closed.*cannot read.*queue/);
  for (const args of [['show', f.item, '--json'], ['status', '--json'], ['snapshot'], ['log', '--json']]) f.ok(args);
  fs.writeFileSync(f.file, report(`run: ${f.run}\noutcome: done\nsummary: Preserve the report`)); f.ok(['ingest', f.file]);
  fs.unlinkSync(f.queue.file); f.ok(['note', f.item, 'No queue exists']);
  fs.writeFileSync(f.queue.file, original);
  const b = f.batch(); fs.writeFileSync(b.receipt, '{}');
  assert.match(f.refuse(['note', f.item, 'Unknown train state']), /invalid promotion-train/);
});

test('linked worktrees use the common queue and explicit fleet records consult only their owner even from another project', t => {
  const f = fixture(t), other = fixture(t), linked = path.join(f.root, 'linked');
  f.git(['worktree', 'add', '-qb', 'lane/linked', linked]);
  const invoke = (cwd, dir, args, env = {}) => spawnSync(process.execPath, [BIN, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ORG_DIR: dir, ...env },
  });
  const linkedReply = invoke(linked, f.dir, ['note', f.item, 'Linked writer']);
  assert.equal(linkedReply.status, 3, linkedReply.stderr); assert.ok(linkedReply.stderr.includes(f.job.id));
  const fleet = path.join(f.root, 'fleet'); fs.mkdirSync(fleet);
  const binding = p => ({ identity: p.queue.project.identity, checkout: p.queue.project.canonical, record: p.dir, worktrees: p.root, layers: [] });
  fs.writeFileSync(path.join(fleet, 'fleet.json'), JSON.stringify({ version: 1, session_limit: 12, projects: { local: binding(f), other: binding(other) } }));
  fs.writeFileSync(other.queue.file, '{foreign queue must never be read');
  const env = { HERDR_MONITOR_FLEET: fleet };
  const held = invoke(other.root, f.dir, ['note', f.item, 'Explicit owner'], env);
  assert.equal(held.status, 3, held.stderr); assert.ok(held.stderr.includes(f.job.id)); assert.ok(!held.stderr.includes(other.queue.file));
  fs.unlinkSync(f.queue.file);
  const free = invoke(other.root, f.dir, ['note', f.item, 'Foreign queue ignored'], env);
  assert.equal(free.status, 0, free.stderr);
});

test('fleet record bindings accept symlinked and trailing-slash checkout and identity paths', t => {
  const f = fixture(t), alias = path.join(f.root, 'checkout-alias'), fleet = path.join(f.dir, 'fleet');
  fs.symlinkSync(f.queue.project.canonical, alias, 'dir'); fs.mkdirSync(fleet);
  const owner = { identity: `${alias}/.git/`, checkout: `${alias}/`, record: f.dir, worktrees: f.root, layers: [] };
  fs.writeFileSync(path.join(fleet, 'fleet.json'), JSON.stringify({ version: 1, session_limit: 12, projects: { owner } }));
  const env = { HERDR_MONITOR_FLEET: fleet };
  assert.ok(f.refuse(['note', f.item, 'Canonical queue still protects its member'], { env }).includes(f.job.id));
  f.ok(['note', f.other, 'Unrelated record writes accept canonical aliases'], { env });
  fs.unlinkSync(f.queue.file);
  f.ok(['note', f.item, 'Released work accepts canonical aliases'], { env });
});
