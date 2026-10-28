import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { fixture, hold } from './helpers/retire-fixture.mjs';
import { setTimeout as pause } from 'node:timers/promises';
import { fold } from '../lib/state.mjs';
import { completedCloseoutKeys, handoffCloseout, migrateCloseout } from '../lib/closeout-handoff.mjs';
import { digest } from '../lib/completion.mjs';
import { publishCloseoutEvents, readCloseoutEntries, readyLane, retryCloseout, retirementOwnerLock, closeoutKey } from '../lib/closeout.mjs';
import { drainCloseout } from '../lib/closeout-consumer.mjs';
import { retryCleanup, queueFor } from '../promote/promote.mjs';
import { outstandingEffects } from '../lib/run-owner.mjs';
import { closer, lanes, events, waitForChange, setup, evaluations, effects, assertRemoved, child } from './helpers/closeout-fixture.mjs';

for (const change of ['tip', 'branch generation', 'worktree identity', 'Git directory identity', 'registration', 'untracked', 'index flags',
  'integration', 'source', 'handoff', 'open run', 'job', 'callback', 'reference', 'HOLD', 'protected slot', 'manifest', 'preserved copy', 'source evidence', 'archive collision', 'policy'])
test(`guarded removal keeps when ${change} changes after preparation`, t => {
  const f = setup(t, { occupied: false, terminal: true }), command = f.options.command, log = f.options.log;
  let proof, reads = 0, changed = false;
  const mutate = () => {
    changed = true;
    const entry = readCloseoutEntries(f.common).find(e => e.signal === 'landed');
    if (change === 'tip') { fs.writeFileSync(path.join(f.lane, 'seed'), 'new work'); f.git(['commit', '-am', 'new work'], f.lane); }
    if (change === 'branch generation') { f.git(['update-ref', `refs/heads/${entry.branch}`, `${entry.head}^`]); f.git(['update-ref', `refs/heads/${entry.branch}`, entry.head]); }
    if (change === 'worktree identity') { fs.renameSync(f.lane, f.lane + '-old'); fs.mkdirSync(f.lane); }
    if (change === 'Git directory identity') { fs.renameSync(entry.gitDirectory, entry.gitDirectory + '-old'); fs.cpSync(entry.gitDirectory + '-old', entry.gitDirectory, { recursive: true }); }
    if (change === 'registration') fs.writeFileSync(path.join(entry.gitDirectory, 'gitdir'), f.lane + '-elsewhere/.git\n');
    if (change === 'untracked') fs.writeFileSync(path.join(f.lane, 'new-file'), 'untracked');
    if (change === 'index flags') f.git(['update-index', '--skip-worktree', 'seed'], f.lane);
    if (change === 'integration') f.git(['reset', '--hard', 'HEAD^']);
    if (change === 'source') {
      const all = events(f), source = all.find(e => e.seq === entry.source.seq); source.closeout_targets[0].head = '0'.repeat(40);
      fs.writeFileSync(f.eventFile, all.map(e => JSON.stringify(e) + '\n').join(''));
    }
    if (change === 'handoff') {
      const handoff = events(f).find(e => e.type === 'closeout.handoff'); fs.appendFileSync(handoff.checkpoint, 'changed');
    }
    if (change === 'open run') f.append([{ type: 'run.started', id: 'R-2', item: 'ENG-1', workspace: f.lane, meta: {} }]);
    if (change === 'job') {
      const queue = queueFor(f.repo); queue.transaction(data => data.pending.push({ id: 'live', run: 'R-1', topic: 'topic', cwd: f.lane }));
    }
    if (change === 'callback') {
      fs.mkdirSync(path.join(f.org, 'settle'), { recursive: true });
      fs.writeFileSync(path.join(f.org, 'settle/R-1.json'), JSON.stringify({ common: f.common, run: 'R-1', workspace: f.lane, stage: 'review' }));
    }
    if (change === 'reference') fs.writeFileSync(path.join(f.org, 'references/live.json'), JSON.stringify({
      schema: 'herdr-reference/v1', owner: 'fixture', kind: 'live', job: 'live', item: 'ENG-1', run: 'R-1', state: 'running',
      created_at: '2020-01-01', expires_at: '2099-01-01' }));
    if (change === 'HOLD') hold(f);
    if (change === 'protected slot') {
      fs.mkdirSync(path.join(f.common, 'sessions'), { recursive: true }); fs.writeFileSync(path.join(f.common, 'sessions/standard-slots.json'), '{"schema":"unknown"}');
    }
    if (change === 'manifest') fs.appendFileSync(proof.evidence.manifest, 'changed');
    if (change === 'preserved copy') fs.writeFileSync(path.join(proof.evidence.directory, 'files/changed'), 'new evidence');
    if (change === 'source evidence') { fs.mkdirSync(path.join(f.lane, '.lane')); fs.writeFileSync(path.join(f.lane, '.lane/new-evidence'), 'new evidence'); }
    if (change === 'archive collision') f.git(['tag', 'archive/lane/topic', `${f.head}^`]);
    if (change === 'policy') fs.writeFileSync(path.join(f.repo, '.lane.json'), '{"retirement":{"closeout_queue":false}}');
  };
  f.options.log = row => { log(row); if (row.action === 'lane-preflight') proof = row; };
  f.options.command = (exe, args, opt) => {
    const result = command(exe, args, opt);
    if (proof && exe === '/usr/sbin/lsof' && ++reads === 2) mutate();
    return result;
  };
  const result = f.drain();
  assert.ok(changed, 'mutation reached the boundary after selecting the candidate');
  assert.equal(fs.existsSync(f.lane), true);
  assert.equal(effects(f).some(e => ['worktree-removed', 'branch-removed', 'lane-removed'].includes(e.action)), false, JSON.stringify(result));
  assert.ok(result.restart || evaluations(f).some(e => !e.completed && e.reason));
  if (change !== 'archive collision') assert.equal(f.git(['tag', '--list', 'archive/lane/topic']), '');
});

test('a new native occupant before the final observation invalidates the selected vacancy', t => {
  const f = setup(t, { occupied: false, terminal: true }), command = f.options.command, log = f.options.log;
  let prepared = false, observations = 0;
  f.options.log = row => { log(row); if (row.action === 'lane-preflight') prepared = true; };
  f.options.command = (exe, args, opt) => {
    if (prepared && exe === f.job.herdr && args[0] === 'workspace' && args[1] === 'list' && ++observations === 2) {
      f.state.panes.push({ pane_id: 'new:p', tab_id: 'new:t', workspace_id: 'w' });
      f.state.tabs.push({ tab_id: 'new:t', workspace_id: 'w' }); f.save();
    }
    return command(exe, args, opt);
  };
  f.drain(); assert.equal(fs.existsSync(f.lane), true);
  assert.ok(evaluations(f).some(e => !e.completed));
  assert.equal(effects(f).some(e => e.action === 'worktree-removed'), false);
});

test('v1 is held until exact-key migration; interruption after the migration journal resumes the same bytes', t => {
  const f = setup(t, { occupied: false }); f.report();
  const [v2] = readCloseoutEntries(f.common), all = events(f), source = all.find(e => e.seq === v2.source.seq);
  source.closeout_targets[0].schema = 'closeout-entry/v1';
  fs.writeFileSync(f.eventFile, all.map(e => JSON.stringify(e) + '\n').join(''));
  const entry = { ...v2, schema: 'closeout-entry/v1' }, file = path.join(f.common, 'closeout/entries', `${entry.key}.json`);
  fs.writeFileSync(file, JSON.stringify(entry, null, 2) + '\n');
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{}');
  f.drain(); assert.equal(evaluations(f).length, 0);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === file) throw Error('interrupted atomic conversion'); return rename(from, to); };
  try { assert.throws(() => migrateCloseout({ cwd: f.repo, org: f.org, key: entry.key, env: f.env }), /interrupted/); }
  finally { fs.renameSync = rename; }
  assert.equal(readCloseoutEntries(f.common)[0].schema, 'closeout-entry/v1');
  assert.equal(events(f).filter(e => e.type === 'closeout.migrated').length, 1);
  migrateCloseout({ cwd: f.repo, org: f.org, key: entry.key, env: f.env });
  const [converted] = readCloseoutEntries(f.common);
  assert.equal(converted.schema, 'closeout-entry/v2'); assert.equal(converted.cwd, entry.cwd); assert.equal(converted.key, entry.key);
  assert.deepEqual(migrateCloseout({ cwd: f.repo, org: f.org, key: entry.key, env: f.env }), [entry.key]);
  f.drain(); assert.ok(evaluations(f).some(e => e.key === entry.key));
  assert.equal(events(f).filter(e => e.type === 'closeout.migrated').length, 1);
});

test('v1 landed migration requires the original successful completion tail and preserves the exact original target', t => {
  const f = setup(t, { occupied: false }); f.report(); f.autoTail = false;
  const source = f.land().find(e => e.type === 'promotion.reconciled');
  const entry = readCloseoutEntries(f.common).find(e => e.signal === 'landed'), all = events(f);
  all.find(e => e.seq === source.seq).closeout_targets[0].schema = 'closeout-entry/v1';
  fs.writeFileSync(f.eventFile, all.map(e => JSON.stringify(e) + '\n').join(''));
  const file = path.join(f.common, 'closeout/entries', `${entry.key}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...entry, schema: 'closeout-entry/v1' }) + '\n');
  f.drain(); assert.equal(fs.existsSync(f.lane), true);
  assert.throws(() => migrateCloseout({ cwd: f.repo, org: f.org, key: entry.key, env: f.env }), /original completion receipt/);
  migrateCloseout({ cwd: f.repo, org: f.org, key: entry.key, receipt: f.receipts.get(source.batch), env: f.env });
  const converted = readCloseoutEntries(f.common).find(e => e.key === entry.key);
  assert.deepEqual(converted.worktreeIdentity, entry.worktreeIdentity); assert.equal(converted.head, entry.head);
  assert.equal(converted.source.seq, entry.source.seq); assert.ok(converted.handoff);
  const beforeTail = events(f).filter(e => e.type === 'closeout.handoff').length;
  handoffCloseout({ cwd: f.repo, org: f.org, receipt: f.receipts.get(source.batch), env: f.env });
  assert.equal(events(f).filter(e => e.type === 'closeout.handoff').length, beforeTail);
  f.drain(); assertRemoved(f);
});

test('a drain launched before fast-forward exits before evaluating the new landing; one fresh successor records the new bytes and epoch', async t => {
  const f = setup(t, { occupied: false }); f.report();
  const stop = hold(f), code = path.join(f.scratch, 'brain-code');
  const source = fileURLToPath(new URL('../', import.meta.url));
  f.git(['clone', '--quiet', '--shared', source, code]);
  f.git(['config', 'user.name', 'Fixture'], code); f.git(['config', 'user.email', 'fixture@example.invalid'], code);
  const beforeCode = f.git(['rev-parse', 'HEAD'], code), marker = path.join(f.scratch, 'loaded'), release = path.join(f.scratch, 'continue');
  const running = child(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { drainCloseout } from ${JSON.stringify(new URL('lib/closeout-consumer.mjs', 'file://' + code + '/').href)};
    import { restartCloseout } from ${JSON.stringify(new URL('lib/closeout-attempt.mjs', 'file://' + code + '/').href)};
    const cwd = ${JSON.stringify(f.repo)}, org = ${JSON.stringify(f.org)};
    const result = drainCloseout({ cwd, org, onClaim: binding => {
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(binding));
      const deadline = Date.now() + 60000;
      while (!fs.existsSync(${JSON.stringify(release)})) {
        if (Date.now() > deadline) throw Error('stale drain barrier timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    } });
    const successor = result.restart && restartCloseout({ cwd, org, restart: result.restart });
    console.log(JSON.stringify({ result, successor }));
  `], { cwd: f.repo, env: f.env });
  let reply, currentCode, head;
  try {
    await waitForChange([marker], () => fs.existsSync(marker));
    // The production incident began 0.2 s before the fast-forward. The barrier
    // proves import/epoch order; elapsed time itself grants no authority.
    await pause(200);
    fs.appendFileSync(path.join(code, 'lib/closeout-consumer.mjs'), '\n// new landing implementation bytes\n');
    f.git(['commit', '-am', 'new closer bytes'], code); currentCode = f.git(['rev-parse', 'HEAD'], code);
    f.land(); head = f.git(['rev-parse', 'HEAD']);
  } finally {
    fs.writeFileSync(release, 'continue'); reply = await running; stop();
  }
  assert.equal(reply.status, 0, reply.stdout + reply.stderr);
  const result = JSON.parse(reply.stdout.trim());
  assert.deepEqual(result.result.evaluated, [], 'the old imports evaluated no post-landing entry');
  assert.equal(result.successor.exit, 0); assert.equal(result.successor.root, code);
  const handoffs = events(f).filter(e => e.type === 'closeout.code-handoff');
  assert.equal(handoffs.length, 1); assert.equal(handoffs[0].old.code.commit, beforeCode);
  assert.equal(handoffs[0].current.code.commit, currentCode);
  assert.notEqual(handoffs[0].old.epoch.tip, head);
  const landed = evaluations(f).filter(e => e.source.type === 'promotion.reconciled');
  assert.equal(landed.length, 1); assert.equal(landed[0].code.code.commit, currentCode); assert.equal(landed[0].code.epoch.tip, head);
  assert.match(landed[0].reason, /HOLD-WORKER-TAB-CLOSE/);
  assert.equal(fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), false);
  assert.equal(fs.existsSync(retirementOwnerLock(f.common)), false);
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'hold removed after joined fresh successor', start: false });
  assert.deepEqual(f.drain().evaluated, []);
  assert.equal(fs.existsSync(f.lane), true); assert.deepEqual(f.read().actions, []);
  assert.ok(landed[0].waiting.defect && !landed[0].waiting.producers.length);
});


test('a default-on named ready resolves an identical pre-existing automatic ready without rebinding its source', t => {
  const f = setup(t, { merged: true }); f.report();
  const [original] = readCloseoutEntries(f.common);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{}');
  f.append([{ type: 'item.closed', id: 'ENG-1', as: 'done' }]);
  f.drain(); assert.equal(evaluations(f).length, 0, 'removing full-source opt-in keeps the automatic entry');
  readyLane({ cwd: f.repo, org: f.org, topic: 'topic', run: 'R-1', start: false, env: f.env });
  assert.deepEqual(readCloseoutEntries(f.common)[0].source, original.source);
  f.drain();
  assert.equal(f.read().actions.filter(a => a[0] === 'tab' && a[1] === 'close').length, 1,
    JSON.stringify(evaluations(f)));
  assert.equal(fs.existsSync(f.lane), true, 'the ready key still supplies only pane authority');
});

for (const stage of ['checkpoint', 'publication']) test(`completion tail resumes after interruption at ${stage} without a lost handoff or duplicate effect`, t => {
  const f = setup(t, { occupied: false }); f.report(); f.autoTail = false;
  const source = f.land().find(e => e.type === 'promotion.reconciled');
  const entry = readCloseoutEntries(f.common).find(e => e.signal === 'landed');
  const file = path.join(f.common, 'closeout/entries', `${entry.key}.json`), open = fs.openSync, rename = fs.renameSync;
  let interrupted = false;
  fs.openSync = (target, flags, ...args) => {
    if (stage === 'checkpoint' && target === f.eventFile && flags === 'a') { interrupted = true; throw Error('interrupted completion checkpoint append'); }
    return open(target, flags, ...args);
  };
  fs.renameSync = (from, to) => {
    if (stage === 'publication' && to === file) { interrupted = true; throw Error('interrupted handoff publication acknowledgement'); }
    return rename(from, to);
  };
  const tail = () => handoffCloseout({ cwd: f.repo, org: f.org, receipt: f.receipts.get(source.batch), env: f.env });
  try { assert.throws(tail, /interrupted/); }
  finally { fs.openSync = open; fs.renameSync = rename; }
  assert.ok(interrupted);
  assert.equal(fs.existsSync(f.lane), true);
  assert.equal(readCloseoutEntries(f.common).find(e => e.key === entry.key).handoff, undefined);
  f.drain(); assert.ok(!evaluations(f).some(e => e.source.seq === source.seq), 'an interrupted tail never becomes actionable');
  tail(); f.drain(); assertRemoved(f);
  const before = events(f); tail(); f.drain(); assert.deepEqual(events(f), before);
  assert.equal(events(f).filter(e => e.type === 'closeout.handoff').length, 1);
  assert.equal(effects(f).filter(e => e.action === 'worktree-removed').length, 1);
});

test('replacing an obsolete disposable handoff survives publication recovery, removal, restart and promotion bookkeeping', t => {
  const f = setup(t, { occupied: false }); f.report(); f.autoTail = false;
  const source = f.land().find(e => e.type === 'promotion.reconciled');
  const entry = readCloseoutEntries(f.common).find(e => e.signal === 'landed');
  const inside = path.join(f.lane, '.lane/completion.record.json'); fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.copyFileSync(f.receipts.get(source.batch), inside);
  const before = events(f);
  assert.throws(() => handoffCloseout({ cwd: f.repo, org: f.org, receipt: inside, env: f.env }), /proof is inside a closing worktree/);
  assert.deepEqual(events(f), before); assert.equal(fs.existsSync(f.lane), true);
  assert.deepEqual(f.read().actions, []);
  // Retain history produced by a pre-guard writer, whose receipt/checkpoint
  // would both disappear at worktree removal. Recovery must leave it obsolete.
  const oldCheckpoint = inside + '.closeout.json';
  const oldTail = { schema: 'closeout-completion/v1', identity: f.common, project: f.repo, org: f.org,
    source: { seq: source.seq, type: source.type, fingerprint: source.fingerprint, digest: digest(source), batch: source.batch },
    receipt: { file: inside, sha256: createHash('sha256').update(fs.readFileSync(inside)).digest('hex'), fingerprint: source.fingerprint }, keys: [entry.key] };
  fs.writeFileSync(oldCheckpoint, JSON.stringify(oldTail));
  f.append([{ type: 'closeout.handoff', identity: f.common, project: f.repo, org: f.org,
    source: { seq: source.seq, type: source.type }, checkpoint: oldCheckpoint, digest: digest(oldTail), keys: [entry.key] }]);
  const obsolete = events(f).find(e => e.type === 'closeout.handoff');
  const receipt = path.join(f.scratch, 'retained-completion.record.json'); fs.copyFileSync(inside, receipt);
  const entryFile = path.join(f.common, 'closeout/entries', `${entry.key}.json`), rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === entryFile) throw Error('interrupted replacement publication'); return rename(from, to); };
  try { assert.throws(() => handoffCloseout({ cwd: f.repo, org: f.org, receipt, env: f.env }), /interrupted replacement publication/); }
  finally { fs.renameSync = rename; }
  const handoff = events(f).findLast(e => e.type === 'closeout.handoff');
  assert.notEqual(handoff.seq, obsolete.seq);
  assert.ok(handoff.checkpoint.startsWith(path.join(f.common, 'closeout/completions') + path.sep));
  fs.unlinkSync(entryFile); // Restart publication from the immutable source.
  publishCloseoutEvents({ cwd: f.repo, org: f.org, added: [source], env: f.env, start: false });
  assert.deepEqual(readCloseoutEntries(f.common).find(e => e.key === entry.key).handoff, { seq: handoff.seq, digest: handoff.digest });
  const queue = queueFor(f.repo), job = { id: 'replacement-cleanup', org: f.org, run: entry.run, item: entry.item, topic: 'topic', tip: entry.head,
    outcome: 'promoted', delivered: true, reconciliation: { state: 'complete', fingerprint: source.fingerprint, receipt },
    cleanup: { state: 'pending', owner: 'closeout-queue', keys: [entry.key], source: { seq: source.seq, type: source.type, fingerprint: source.fingerprint } } };
  queue.transaction(data => data.results.push(job));
  const command = f.options.command; let refuse = true;
  f.options.command = (exe, args, opt) => exe === 'git' && args.includes('-D') && refuse ?
    { status: 1, stdout: '', stderr: 'injected branch removal interruption' } : command(exe, args, opt);
  f.drain({ keys: [entry.key] });
  assert.equal(fs.existsSync(f.lane), false); assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
  assert.ok(fs.existsSync(receipt)); assert.ok(fs.existsSync(handoff.checkpoint));
  assert.equal(fs.existsSync(oldCheckpoint), false);
  assert.equal(evaluations(f).findLast(e => e.key === entry.key).completed, false);
  refuse = false;
  retryCloseout({ cwd: f.repo, org: f.org, topic: entry.key, why: 'branch removal recovered', env: f.env, start: false });
  f.drain({ keys: [entry.key] }); assertRemoved(f);
  assert.deepEqual(evaluations(f).findLast(e => e.key === entry.key).handoff, { seq: handoff.seq, digest: handoff.digest });
  assert.deepEqual(completedCloseoutKeys({ cwd: f.repo, org: f.org, expected: { common: f.common, project: f.repo, org: f.org,
    item: entry.item, run: entry.run, topic: 'topic', tip: entry.head, source: job.cleanup.source }, env: f.env }), [entry.key]);
  assert.deepEqual(outstandingEffects(f.org, fold(events(f)).runs.get(entry.run), f.common), []);
  retryCleanup(queue); assert.equal(queue.load().results[0].cleanup.state, 'complete');
  const completed = events(f); handoffCloseout({ cwd: f.repo, org: f.org, receipt, env: f.env });
  f.drain({ keys: [entry.key] }); assert.deepEqual(events(f), completed);
  assert.equal(effects(f).filter(e => e.action === 'worktree-removed').length, 1);
});

test('named drains isolate two eligible lanes and tolerate an unrelated main commit, including an empty key set', t => {
  const f = setup(t, { occupied: false, terminal: true }), other = path.join(f.scratch, 'other-lane');
  f.git(['worktree', 'add', '-b', 'lane/other', other]);
  f.append([{ type: 'item.added', id: 'ENG-2', kind: 'work', role: 'engineer' },
    { type: 'run.started', id: 'R-2', item: 'ENG-2', workspace: other, meta: {} },
    { type: 'report.ingested', run: 'R-2', report: { outcome: 'done' }, sha256: 'fixture-two' }]);
  f.append([{ type: 'item.closed', id: 'ENG-2', as: 'done' },
    { type: 'promotion.reconciled', identity: f.common, batch: 'other-landing', tip: f.head,
      heads: [{ run: 'R-2', item: 'ENG-2', head: f.head }], runs: ['R-2'], items: ['ENG-2'] }]);
  const entries = readCloseoutEntries(f.common), one = entries.find(e => e.run === 'R-1' && e.signal === 'landed');
  const otherEntries = entries.filter(e => e.run === 'R-2'), bytes = otherEntries.map(e =>
    fs.readFileSync(path.join(f.common, 'closeout/entries', `${e.key}.json`), 'utf8'));
  const before = events(f);
  assert.deepEqual(f.drain({ keys: [], onClaim: () => assert.fail('empty keys cannot claim or observe') }), { evaluated: [] });
  assert.deepEqual(events(f), before); assert.deepEqual(f.herdrCalls(), []);
  const result = f.drain({ keys: [one.key], onClaim: () => f.git(['commit', '--allow-empty', '-qm', 'unrelated main epoch changed']) });
  assert.deepEqual(result.evaluated.map(e => [e.key, e.completed]), [[one.key, true]]);
  assert.equal(result.restart, undefined);
  assert.equal(events(f).some(e => e.type === 'closeout.code-handoff'), false, 'unchanged closer bytes need no handoff');
  assert.equal(fs.existsSync(f.lane), false); assert.equal(fs.existsSync(other), true);
  assert.ok(otherEntries.every(e => !events(f).some(event => event.key === e.key)));
  assert.deepEqual(otherEntries.map(e => fs.readFileSync(path.join(f.common, 'closeout/entries', `${e.key}.json`), 'utf8')), bytes);
  f.drain(); assert.equal(fs.existsSync(other), false); assert.equal(f.git(['branch', '--list', 'lane/other']), '');
});

test('a missing-producer HOLD wait keeps promotion cleanup and ownership readers pending after a named retry', t => {
  const f = setup(t, { occupied: false, terminal: true }), stop = hold(f), queue = queueFor(f.repo);
  const source = events(f).find(e => e.type === 'promotion.reconciled'), target = source.closeout_targets[0];
  f.drain({ keys: [target.key] });
  assert.match(evaluations(f).findLast(e => e.key === target.key).reason, /HOLD/);
  const row = { ...f.job, id: 'kept-completion', org: f.org, run: target.run, item: target.item, topic: 'topic',
    tip: target.head, outcome: 'promoted', delivered: true,
    reconciliation: { state: 'complete', fingerprint: source.fingerprint, receipt: f.receipts.get(source.batch) },
    cleanup: { state: 'pending', owner: 'closeout-queue', keys: [target.key],
      source: { seq: source.seq, type: source.type, fingerprint: source.fingerprint } } };
  queue.transaction(data => data.results.push(row));
  const read = () => outstandingEffects(f.org, fold(events(f)).runs.get(target.run), f.common);
  assert.ok(read().includes('promotion:unreconciled/pending-callback'));
  retryCleanup(queue); assert.equal(queue.load().results[0].cleanup.state, 'pending');
  const receipt = fs.readFileSync(row.reconciliation.receipt), reconciled = events(f).filter(e => e.type === 'promotion.reconciled');
  stop(); retryCloseout({ cwd: f.repo, org: f.org, topic: target.key, why: 'hold removed', env: f.env, start: false });
  assert.deepEqual(f.drain({ keys: [target.key] }).evaluated, []);
  assert.equal(fs.existsSync(f.lane), true);
  assert.ok(read().includes('promotion:unreconciled/pending-callback'), 'a manual retry is not a completion receipt');
  retryCleanup(queue); assert.equal(queue.load().results[0].cleanup.state, 'pending');
  assert.deepEqual(events(f).filter(e => e.type === 'promotion.reconciled'), reconciled);
  assert.deepEqual(fs.readFileSync(row.reconciliation.receipt), receipt);
});

test('a production drain fast-forwarded during module loading hands only its named landing to one fresh successor', async t => {
  const f = setup(t, { occupied: false }); f.report(); const stop = hold(f);
  const code = path.join(f.scratch, 'loading-code'), marker = path.join(f.scratch, 'graph-loading'), release = path.join(f.scratch, 'graph-continue');
  f.git(['clone', '--quiet', '--shared', fileURLToPath(new URL('../', import.meta.url)), code]);
  f.git(['config', 'user.name', 'Loading fixture'], code); f.git(['config', 'user.email', 'loading@example.invalid'], code);
  const runtime = path.join(code, 'lib/closeout-executor.mjs'), original = fs.readFileSync(runtime, 'utf8');
  fs.appendFileSync(runtime, `
fs.writeFileSync(${JSON.stringify(marker)}, 'old modules loaded');
const loadingDeadline = Date.now() + 60000;
while (!fs.existsSync(${JSON.stringify(release)})) {
  if (Date.now() > loadingDeadline) throw Error('loading barrier expired');
  await new Promise(resolve => setTimeout(resolve, 10));
}
`);
  f.git(['commit', '-am', 'Pause during consumer loading'], code);
  const beforeCode = f.git(['rev-parse', 'HEAD'], code), branch = f.git(['symbolic-ref', '--short', 'HEAD'], code);
  f.git(['checkout', '-qb', 'new-loading-code'], code);
  fs.writeFileSync(runtime, original + '\n// newly landed removal implementation\n');
  f.git(['commit', '-am', 'Land fresh consumer bytes'], code); const freshCode = f.git(['rev-parse', 'HEAD'], code);
  f.git(['checkout', '-q', branch], code);
  const key = closeoutKey(f.lane, 'R-1', 'landed');
  const running = child(process.execPath, [path.join(code, 'supervisor/closeout.mjs'), 'drain', '--repo', f.repo,
    '--org', f.org, '--keys', JSON.stringify([key])], { cwd: f.repo, env: f.env });
  let reply;
  try {
    await waitForChange([marker], () => fs.existsSync(marker));
    f.git(['merge', '--ff-only', 'new-loading-code'], code); f.land();
  } finally { fs.writeFileSync(release, 'continue'); reply = await running; stop(); }
  assert.equal(reply.status, 0, reply.stdout + reply.stderr);
  const result = JSON.parse(reply.stdout.trim());
  assert.deepEqual(result.evaluated, []); assert.deepEqual(result.restart.keys, [key]);
  assert.equal(result.restart.old.code.commit, beforeCode); assert.equal(result.restart.current.code.commit, freshCode);
  assert.equal(result.successor.exit, 0); assert.equal(result.successor.root, code);
  const observed = evaluations(f); assert.equal(observed.length, 1); assert.equal(observed[0].key, key);
  assert.equal(observed[0].code.code.commit, freshCode); assert.equal(observed[0].code.epoch.tip, f.head);
  assert.match(observed[0].reason, /HOLD/);
  assert.equal(events(f).filter(e => e.type === 'closeout.code-handoff').length, 1);
  retryCloseout({ cwd: f.repo, org: f.org, topic: key, why: 'hold removed after fresh loading successor', env: f.env, start: false });
  assert.deepEqual(f.drain({ keys: [key] }).evaluated, []);
  assert.equal(fs.existsSync(f.lane), true); assert.deepEqual(f.read().actions, []);
  assert.ok(observed[0].waiting.defect && !observed[0].waiting.producers.length);
});

for (const budgetMs of [50000, 180000, 240000]) test(`loaded removal reserves both Git steps inside a fixed ${budgetMs / 1000} s closeout pass`, t => {
  const f = setup(t, { occupied: false, terminal: true });
  let now = Date.now();
  const deadline = now + budgetMs, preparationMs = 30000, calls = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(os, 'loadavg', () => [16, 16, 16]);
  t.mock.method(os, 'availableParallelism', () => 4);
  const command = f.options.command, log = f.options.log;
  f.options.command = (exe, args, options) => {
    if (exe === 'git' && ((args[2] === 'worktree' && args[3] === 'remove') || (args[2] === 'branch' && args[3] === '-D')))
      calls.push({ action: args[2], timeout: options.timeout });
    return command(exe, args, options);
  };
  f.options.log = row => { log(row); if (row.action === 'lane-preflight') now += preparationMs; };
  const result = f.drain({ retirementOptions: { ...f.options, deadline } });
  const availableMs = budgetMs - preparationMs;
  if (budgetMs === 50000) {
    assert.deepEqual(calls, [], 'insufficient base reserve starts neither Git effect');
    assert.ok(result.evaluated.some(e => !e.completed && /removal needs .*pass has/.test(e.reason)), JSON.stringify(result));
    assert.equal(fs.existsSync(f.lane), true); assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
    assert.equal(effects(f).some(e => ['worktree-removed', 'branch-removed', 'lane-removed'].includes(e.action)), false);
  } else {
    assertRemoved(f);
    assert.deepEqual(calls.map(c => c.action), ['worktree', 'branch']);
    assert.ok(calls.every(c => c.timeout >= 30000), JSON.stringify(calls));
    const reservedMs = calls.reduce((sum, c) => sum + c.timeout, 0);
    assert.ok(reservedMs <= availableMs, JSON.stringify({ availableMs, calls }));
    if (budgetMs === 180000) assert.equal(reservedMs, availableMs, 'load headroom fits the original remaining deadline');
    else {
      assert.ok(calls[0].timeout >= 120000, 'a larger pass retains the full load-scaled worktree allowance');
      assert.equal(calls[1].timeout, 60000, 'the existing branch allowance cap stays intact');
    }
  }
  t.diagnostic(JSON.stringify({ budgetMs, preparationMs, calls }));
});
