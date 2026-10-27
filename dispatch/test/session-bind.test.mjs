import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fold } from '../../lib/state.mjs';
import { fold as oldFold } from '../../test/fixtures/state-v0.mjs';
import { effectiveWorkerIdentity } from '../../lib/worker-identity.mjs';
import { sessionBindFact } from '../../test/helpers/session-bind.mjs';
import { observeSessionBinding, nativeProcess } from '../session-bind.mjs';
import { supervisorStatus } from '../../supervisor/status.mjs';
import { fixture as retirementFixture } from '../../test/helpers/retire-fixture.mjs';
import { planRetirement } from '../../lib/retire.mjs';

const record = path.resolve('bin/org.mjs');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-bind-'))), org = path.join(root, '.org');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, ORG_DIR: org, ORG_ACTOR: 'dispatch-fixture', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = args => { const r = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git(['init', '-b', 'main']);
  const common = fs.realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const rec = args => spawnSync(process.execPath, [record, ...args], { cwd: root, env, encoding: 'utf8' });
  const ok = args => { const r = rec(args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  ok(['init']); const item = ok(['add', 'Late native identity', '--role', 'engineer']).split('\n')[0];
  const journal = path.join(org, 'dispatch', 'attempt.json'); fs.mkdirSync(path.dirname(journal));
  const run = ok(['start', item, '--workspace', root, '--meta', 'lane=topic', '--meta', `dispatch_journal=${journal}`,
    '--meta', 'dispatch_attempt=attempt', '--meta', `dispatch_project=${common}`, '--meta', `dispatch_record=${org}`]).match(/^R-\d+/)[0];
  const worker = id => ok(['worker', id, '--agent', 'worker', '--pane', 'w:p', '--worker-workspace', 'w', '--terminal-id', 'terminal', '--cwd', root]);
  worker(run);
  const show = () => JSON.parse(ok(['show', run, '--json']));
  const events = () => fs.readFileSync(path.join(org, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const state = () => fold(events());
  const proposed = sessionBindFact(show(), state());
  const job = { run, repo: root, org, common, workspace: root, token: 'attempt', stage: 'complete',
    sessionBinding: { status: 'observing', process: proposed.process, receipt: proposed.receipt,
      prompted_at: proposed.prompted_at, deadline: proposed.deadline, proposed } };
  const save = () => fs.writeFileSync(journal, JSON.stringify(job)); save();
  const bind = () => rec(['session-bind', '--journal', journal]);
  const ingest = () => {
    const file = show().report_path;
    fs.writeFileSync(file, `---\nrun: ${run}\noutcome: done\nsummary: fixture finished\nheadline: Fixture finished\n---\n`);
    ok(['ingest', file]);
  };
  return { root, org, common, item, run, journal, rec, ok, worker, show, job, proposed, save, bind, events, state, ingest };
}

test('record bind is separate and immutable, folds once, and exact retries survive ingestion and expiry', t => {
  const f = fixture(t), before = f.show(), first = f.bind();
  assert.equal(first.status, 0, first.stderr); assert.equal(JSON.parse(first.stdout).recorded, true);
  assert.deepEqual(f.show().meta, before.meta);
  assert.equal(JSON.stringify(f.show()), JSON.stringify(before), 'run bytes stay unchanged by identity evidence');
  assert.equal(effectiveWorkerIdentity(f.show(), f.state()).agent_session_id, 'session');
  assert.equal(f.bind().status, 0);
  f.ingest(); const events = f.events();
  assert.equal(f.bind().status, 0); assert.deepEqual(f.events(), events);
  assert.equal(events.filter(e => e.type === 'run.session_bound').length, 1);
  assert.equal(oldFold(events).runs.get(f.run).meta.agent_session_id, undefined);
  assert.equal(oldFold(events).runs.get(f.run).session_bindings, undefined);
  // Expired exact replies are checked before the fresh-bind deadline guard.
  assert.equal(effectiveWorkerIdentity(fold(events).runs.get(f.run), fold(events)).identity_conflict, false);
  const changed = { ...f.proposed, session: 'other' };
  f.job.sessionBinding.proposed = changed; f.save();
  const refusal = f.bind(); assert.equal(refusal.status, 1); assert.match(refusal.stderr, /different or conflicting/);
  assert.deepEqual(f.events(), events);
});

for (const race of ['report', 'abandon', 'newer-name', 'newer-pane', 'newer-session']) test(`transaction refuses the ${race} race after the proposal was saved`, t => {
  const f = fixture(t);
  if (race === 'report') f.ingest();
  else if (race === 'abandon') f.ok(['abandon', f.run]);
  else {
    const next = f.ok(['start', f.item, '--workspace', f.root]).match(/^R-\d+/)[0];
    if (race === 'newer-name') f.worker(next);
    else f.ok(['worker', next, '--agent', 'other', '--pane', race === 'newer-pane' ? 'w:p' : 'w:q',
      '--worker-workspace', 'w', '--cwd', f.root, '--agent-session-id', 'session']);
  }
  const bytes = f.events(), result = f.bind();
  assert.equal(result.status, 1); assert.match(result.stderr, /open, unreported|newer run/);
  assert.deepEqual(f.events(), bytes);
});

test('binding refuses changed receipts, foreign dispatch anchors, renewed deadlines and legacy attempts', t => {
  const f = fixture(t), original = structuredClone(f.job), events = f.events();
  const mutations = [
    j => { j.sessionBinding.proposed.receipt.terminal_id = 'replacement'; },
    j => { j.sessionBinding.proposed.dispatch.attempt = 'other'; },
    j => { j.sessionBinding.proposed.dispatch.project = '/other/.git'; },
    j => { j.sessionBinding.proposed.dispatch.record = '/other/.org'; },
    j => { j.sessionBinding.proposed.dispatch.journal = '/other/dispatch.json'; },
    j => { j.sessionBinding.proposed.seq = 9999; },
    j => { j.sessionBinding.deadline = j.sessionBinding.proposed.deadline = new Date(Date.now() + 120000).toISOString(); },
    j => { j.sessionBinding.process = j.sessionBinding.proposed.process = null; },
    j => { j.stage = 'prompting'; },
    j => { j.sessionBinding.proposed.observed_at = new Date(Date.parse(j.sessionBinding.deadline) + 1).toISOString(); },
  ];
  for (const mutate of mutations) {
    Object.assign(f.job, structuredClone(original)); mutate(f.job); f.save();
    const result = f.bind(); assert.equal(result.status, 1, JSON.stringify(f.job));
    assert.deepEqual(f.events(), events);
  }
  Object.assign(f.job, structuredClone(original)); f.save();
  const legacy = structuredClone(events);
  delete legacy.find(e => e.type === 'run.started').meta.dispatch_attempt;
  fs.writeFileSync(path.join(f.org, 'events.jsonl'), legacy.map(e => JSON.stringify(e) + '\n').join(''));
  assert.equal(f.bind().status, 1, 'legacy terminal-only receipts have no dispatch bind authority');
  fs.writeFileSync(path.join(f.org, 'events.jsonl'), events.map(e => JSON.stringify(e) + '\n').join(''));
  f.ok(['set', f.run, 'terminal_id=replacement']);
  assert.equal(f.bind().status, 1);
});

test('timely expired proposal replays on an open unbound run, while reported runs never gain a fresh bind', t => {
  const f = fixture(t), old = Date.now() - 120000;
  f.job.sessionBinding.proposed = sessionBindFact(f.show(), f.state(), { at: old });
  Object.assign(f.job.sessionBinding, { prompted_at: f.job.sessionBinding.proposed.prompted_at,
    deadline: f.job.sessionBinding.proposed.deadline, status: 'unbound' }); f.save();
  const journal = fs.readFileSync(f.journal), result = f.bind(); assert.equal(result.status, 0, result.stderr);
  assert.equal(effectiveWorkerIdentity(f.show(), f.state()).identity_conflict, false);
  assert.deepEqual(fs.readFileSync(f.journal), journal);
  f.ingest(); const finished = f.events();
  assert.equal(f.bind().status, 0); assert.deepEqual(f.events(), finished);
  const g = fixture(t); g.job.sessionBinding.status = 'unbound'; g.save(); g.ingest();
  const reported = g.events(), refused = g.bind();
  assert.equal(refused.status, 1); assert.match(refused.stderr, /open, unreported/); assert.deepEqual(g.events(), reported);
});

test('duplicate/conflicting log evidence and stale receipt anchors are never resolved newest-first', t => {
  const f = fixture(t); assert.equal(f.bind().status, 0);
  const events = f.events(), current = fold(events).runs.get(f.run);
  for (const change of [b => { b.receipt.seq++; }, b => { b.dispatch.attempt = 'foreign'; }]) {
    const bad = structuredClone(events); change(bad.at(-1));
    assert.equal(effectiveWorkerIdentity(fold(bad).runs.get(f.run), fold(bad)).identity_conflict, true);
  }
  const duplicate = f.state(), binds = duplicate.sessionBindings.get(f.run);
  binds.push(binds[0]);
  assert.equal(effectiveWorkerIdentity(current, duplicate).identity_conflict, true);
});

test('status and pane-release consume the bound identity; replacement and conflicting evidence stay unknown', t => {
  const f = fixture(t); assert.equal(f.bind().status, 0);
  const agent = { name: 'worker', agent: 'codex', cwd: f.root, pane_id: 'w:p', workspace_id: 'w',
    terminal_id: 'terminal', agent_status: 'idle', agent_session: { value: 'session' } };
  const status = a => supervisorStatus({ cwd: f.root, org: f.org, agents: [a] });
  assert.equal(status(agent).lanes[0].live_status, 'idle');
  assert.equal(status({ ...agent, agent_session: { value: 'replacement' } }).lanes[0].live_status, 'unknown');
  f.ingest();
  const release = f.rec(['pane-release', f.run, '--session', 'session', '--terminal', 'terminal', '--pane', 'w:p',
    '--head', 'a'.repeat(40), '--authority', 'fixture', '--next', 'reviewer', '--unresolved', 'review', '--evidence', '/evidence', '--confirm', '--why', 'fixture']);
  assert.equal(release.status, 0, release.stderr);
  const file = path.join(f.org, 'events.jsonl'), events = f.events(), bind = events.find(e => e.type === 'run.session_bound');
  fs.appendFileSync(file, JSON.stringify({ ...bind, seq: events.at(-1).seq + 1, session: 'other' }) + '\n');
  fs.mkdirSync(path.join(f.org, 'settle'), { recursive: true });
  fs.writeFileSync(path.join(f.org, 'settle', `${f.run}.json`), JSON.stringify({ run: f.run, common: f.common, stage: 'fix' }));
  const doc = status(agent);
  assert.equal(doc.lanes[0].live_status, 'unknown'); assert.ok(doc.warnings.some(w => /conflicting recorded worker identity/.test(w)));
  assert.equal(f.rec(['session-bind', '--journal', f.journal]).status, 1);
});

test('handoff sees bound sessions and refuses a same-session successor hidden behind terminal-only receipts', t => {
  const f = fixture(t); assert.equal(f.bind().status, 0);
  const next = f.ok(['start', f.item, '--workspace', f.root]).match(/^R-\d+/)[0];
  f.ok(['worker', next, '--agent', 'successor', '--pane', 'w:q', '--worker-workspace', 'w', '--cwd', f.root,
    '--terminal-id', 'next-terminal', '--agent-session-id', 'session']);
  const args = ['handoff', f.run, '--to', next, '--confirm', '--why', 'retained successor'];
  assert.equal(f.rec(args).status, 1);
  f.ok(['set', next, 'agent_session_id=different']);
  assert.equal(f.rec(args).status, 0);
});

test('retirement adapter transports bound identity beside unchanged runs through JSON', t => {
  const f = retirementFixture(t), base = fs.readFileSync(f.eventFile, 'utf8').trim().split('\n').map(JSON.parse);
  const started = base[1]; delete started.meta.agent_session_id;
  Object.assign(started.meta, { dispatch_attempt: 'attempt', dispatch_journal: path.join(f.org, 'dispatch/attempt.json'),
    dispatch_project: f.common, dispatch_record: f.org });
  const launch = [base[0], started, { type: 'run.updated', id: 'R-1', seq: 3, meta: {
    agent: 'worker', pane: 'w:p', worker_workspace: 'w', terminal_id: 'term' } }];
  const state = fold(launch), bind = sessionBindFact(state.runs.get('R-1'), state, { seq: 4 });
  const events = [...launch, bind, { ...base[2], seq: 5 }, { ...base[3], seq: 6 }];
  fs.writeFileSync(f.eventFile, events.map(e => JSON.stringify(e) + '\n').join(''));
  const snapshot = JSON.parse(JSON.stringify(f.retirement().observe()));
  assert.equal(snapshot.record.runs[0].session_bindings, undefined);
  assert.equal(snapshot.record.sessionBindings['R-1'].length, 1);
  assert.equal(planRetirement(snapshot).close.length, 1);
});

function observationFixture() {
  let time = 100000, reads = 0, commits = 0, saves = 0;
  const process = { pid: 123, identity: 'native birth' }, deadline = time + 60000;
  const job = { run: 'R-1', token: 'attempt', common: '/repo/.git', org: '/repo/.org', journal: '/repo/.org/dispatch/attempt.json',
    sessionBinding: { status: 'observing', process, receipt: {}, prompted_at: new Date(time).toISOString(), deadline: new Date(deadline).toISOString() } };
  const options = { job, save: () => saves++, now: () => time, monotonic: () => time,
    observe: () => ({ process, session: ++reads >= 3 ? 'opaque/session' : null }), record: () => commits++, pause: async ms => { time += ms; } };
  return { job, process, options, deadline, time: () => time, commits: () => commits, reads: () => reads, saves: () => saves };
}

test('delayed observation returns immediately on identity; ordinary retries cannot renew the saved delivery deadline', async () => {
  const f = observationFixture(); await observeSessionBinding(f.options);
  assert.equal(f.job.sessionBinding.status, 'bound'); assert.equal(f.commits(), 1); assert.equal(f.reads(), 3); assert.equal(f.time(), 100500);
  await observeSessionBinding(f.options);
  assert.equal(f.commits(), 1); assert.equal(f.reads(), 3, 'a bound delivery never observes or commits twice');
  const timeout = observationFixture(); timeout.options.observe = () => ({ process: timeout.process });
  await observeSessionBinding(timeout.options);
  assert.equal(timeout.job.sessionBinding.status, 'unbound'); assert.equal(timeout.commits(), 0); assert.equal(timeout.time(), timeout.deadline);
  timeout.job.sessionBinding.status = 'observing'; // A crash before the timeout save.
  timeout.options.observe = () => { throw Error('expired retry must not observe'); };
  await observeSessionBinding(timeout.options); assert.equal(timeout.time(), timeout.deadline); assert.equal(timeout.commits(), 0);
});

test('continuity positive control binds but same PID replacement birth and missing evidence leave no fact', async () => {
  const row = { pid: 123, identity: 'native birth', state: 'S' }, agent = { agent: 'codex' };
  const info = { shell_pid: 1, foreground_processes: [{ pid: 123, name: 'codex' }] };
  const original = nativeProcess(agent, info, () => ({ ok: true, value: row }));
  for (const replacement of [false, true]) {
    const f = observationFixture(); f.options.observe = () => ({ session: 'opaque/session',
      process: nativeProcess(agent, info, () => ({ ok: true, value: { ...row, identity: replacement ? 'replacement birth' : row.identity } })) });
    assert.deepEqual(original, f.process);
    await observeSessionBinding(f.options); assert.equal(f.commits(), replacement ? 0 : 1);
  }
  const f = observationFixture(); f.options.observe = () => { throw Error('source unreadable'); };
  await observeSessionBinding(f.options); assert.equal(f.job.sessionBinding.status, 'unbound'); assert.equal(f.commits(), 0);
  const missing = observationFixture(); missing.job.sessionBinding.process = null;
  await observeSessionBinding(missing.options); assert.equal(missing.reads(), 0); assert.equal(missing.commits(), 0);
  assert.throws(() => nativeProcess(agent, info, () => ({ ok: false, error: 'unavailable' })), /unavailable/);
});

test('timely refused proposals replay without observing, and an elapsed observation error is labelled as expiry', async () => {
  const f = observationFixture(); await observeSessionBinding(f.options);
  f.job.sessionBinding.status = 'unbound'; const reads = f.reads();
  f.options.observe = () => { throw Error('must not observe a saved proposal again'); };
  await observeSessionBinding(f.options); assert.equal(f.commits(), 2); assert.equal(f.reads(), reads);
  const expired = observationFixture();
  expired.options.observe = () => { throw Error('session observation deadline expired'); };
  expired.options.now = (() => { let n = 0; return () => ++n > 2 ? expired.deadline + 1 : 100000; })();
  await observeSessionBinding(expired.options);
  assert.equal(expired.job.sessionBinding.reason, 'native session observation deadline expired');
  assert.equal(expired.commits(), 0);
});
