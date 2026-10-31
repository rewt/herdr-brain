import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configFixture } from './helpers/config-home-fixture.mjs';
import { sessionBindFact } from './helpers/session-bind.mjs';
import { loadRecord } from '../lib/store.mjs';
import { gitProject } from '../lib/project.mjs';
import { effectiveWorkerIdentity } from '../lib/worker-identity.mjs';
import { lockRequest } from '../dispatch/request-lock.mjs';
import { replaySessionBinding } from '../dispatch/session-bind-replay.mjs';
import { createLineService, sourceRoot, serviceDirectory } from '../line-service/line-service.mjs';

function fixture(t) {
  const f = configFixture(t, { custom: true }), org = f.env.ORG_DIR, project = gitProject(f.cwd).identity;
  const command = args => spawnSync(process.execPath, [path.join(sourceRoot, 'bin/org.mjs'), ...args],
    { cwd: f.cwd, env: f.env, encoding: 'utf8' });
  const ok = args => { const r = command(args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const item = ok(['add', 'Binding fixture', '--role', 'engineer']).split('\n')[0];
  const journal = path.join(org, 'dispatch', 'original.json'); fs.mkdirSync(path.dirname(journal));
  const run = ok(['start', item, '--workspace', f.cwd, '--meta', `dispatch_journal=${journal}`,
    '--meta', 'dispatch_attempt=original', '--meta', `dispatch_project=${project}`, '--meta', `dispatch_record=${org}`]).match(/^R-\d+/)[0];
  ok(['worker', run, '--agent', 'original-worker', '--pane', 'w:p', '--worker-workspace', 'w', '--terminal-id', 'terminal', '--cwd', f.cwd]);
  ok(['claim', run, '--controller', 'brain', '--release-root', sourceRoot, '--admit-worker']);
  const loaded = loadRecord(org), r = loaded.state.runs.get(run), proposed = sessionBindFact(r, loaded.state, { at: Date.now() - 120000 });
  const original = { token: 'original', stage: 'complete', run, item, org, common: project, repo: f.cwd, workspace: f.cwd,
    ownership: { owner: r.owner, generation: r.owner_generation }, release: { root: '/saved/old-runtime' },
    sessionBinding: { status: 'observing', process: proposed.process, receipt: proposed.receipt,
      prompted_at: proposed.prompted_at, deadline: proposed.deadline, proposed, reason: 'bind reply unknown' } };
  const write = job => fs.writeFileSync(journal, JSON.stringify(job)); write(original);
  const read = () => JSON.parse(fs.readFileSync(journal));
  const bind = file => {
    const r = command(['session-bind', '--journal', file]);
    if (r.status !== 0) throw Object.assign(Error(r.stderr), { receipt: r });
    return r.stdout.trim();
  };
  const replay = extra => replaySessionBinding({ journal, org, project, guard: () => {}, record: bind, ...extra });
  return { ...f, org, project, item, run, journal, original, proposed, read, write, bind, replay, command, ok };
}

for (const lostReply of [false, true]) test(`the next line pass settles an expired proposal${lostReply ? ' after an unknown record reply' : ''} with a typed receipt and no dispatch/native input`, t => {
  const f = fixture(t), calls = [];
  let writes = 0;
  const service = createLineService({ repo: f.cwd, org: f.org, env: f.env, to: 'supervisor-test',
    maxStarts: 0, capacity: () => ({ count: 0, cap: 4 }), recordNotice: () => ({ state: 'record-only' }),
    command: (exe, args, opts) => {
      calls.push(args);
      if (args[0].endsWith('/bin/org.mjs') && args[1] === 'session-bind') {
        const r = spawnSync(exe, args, opts);
        if (lostReply && writes++ === 0) { assert.equal(r.status, 0, r.stderr); return { status: null, signal: 'SIGTERM', stderr: 'lost record reply', stdout: '' }; }
        return r;
      }
      return { status: 0, stdout: '{}', stderr: '' };
    } });
  service.pass();
  if (lostReply) {
    assert.equal(f.read().sessionBinding.status, 'observing');
    assert.equal(f.read().sessionBinding.commit_attempts[0].error.receipt.stderr, 'lost record reply');
    service.pass();
  }
  const saved = f.read(), receipt = saved.sessionBinding.commit_receipt;
  assert.equal(saved.sessionBinding.status, 'bound'); assert.equal(saved.sessionBinding.reason, undefined);
  assert.deepEqual(saved.sessionBinding.proposed, f.proposed); assert.deepEqual(saved.release, f.original.release);
  assert.equal(receipt.schema, 'dispatch-session-binding/v1'); assert.equal(receipt.outcome, 'bound');
  assert.equal(receipt.run, f.run); assert.equal(receipt.attempt, 'original'); assert.equal(receipt.journal, f.journal);
  const events = loadRecord(f.org).events, bound = events.find(e => e.type === 'run.session_bound');
  assert.equal(receipt.event_seq, bound.seq); assert.equal(receipt.session, f.proposed.session);
  assert.equal(effectiveWorkerIdentity(loadRecord(f.org).state.runs.get(f.run), loadRecord(f.org).state).agent_session_id, f.proposed.session);
  assert.equal(receipt.recorded, !lostReply);
  service.pass(); assert.equal(f.read().sessionBinding.commit_attempts.length, lostReply ? 2 : 1);
  assert.equal(loadRecord(f.org).events.filter(e => e.type === 'run.session_bound').length, 1);
  assert.equal(calls.filter(a => a[1] === 'session-bind').length, lostReply ? 2 : 1);
  assert.equal(calls.some(a => a[0].endsWith('/dispatch/dispatch.mjs') || a.includes('prompt')), false);
  const log = fs.readFileSync(path.join(serviceDirectory(f.org, f.project), 'passes.jsonl'), 'utf8');
  assert.match(log, /session-binding-replay/);
});

for (const recorded of [false, true]) test(`replay after ingestion preserves the proposal and ${recorded ? 'reads back the exact lost reply' : 'appends the timely fact once'}`, t => {
  const f = fixture(t);
  if (recorded) f.bind(f.journal);
  const report = JSON.parse(f.ok(['show', f.run, '--json'])).report_path;
  fs.writeFileSync(report, `---\nrun: ${f.run}\noutcome: done\nsummary: Finished fixture.\nheadline: Fixture finished\n---\n`);
  f.ok(['ingest', report]);
  const receipt = f.replay().receipt;
  assert.equal(receipt.recorded, !recorded); assert.deepEqual(f.read().sessionBinding.proposed, f.proposed);
  assert.equal(loadRecord(f.org).events.filter(e => e.type === 'run.session_bound').length, 1);
});

test('unknown record outcomes preserve attempt diagnostics and replay only the same record fact', t => {
  const f = fixture(t);
  const unknown = f.replay({ record: () => { throw Object.assign(Error('writer crashed'), { code: 'EPIPE', receipt: { status: null, stderr: 'original error' } }); } });
  assert.equal(unknown.outcome, 'unknown'); assert.equal(f.read().sessionBinding.status, 'observing');
  const bound = f.replay(); assert.equal(bound.outcome, 'bound');
  assert.equal(f.read().sessionBinding.commit_attempts[0].error.receipt.stderr, 'original error');
  assert.deepEqual(f.read().sessionBinding.proposed, f.proposed);
});

for (const receipt of [
  { status: 1, signal: null, stderr: 'record: the record is locked (/x/lock); owner death is not confirmed; retain it for inspection\n' },
  { status: 1, stderr: 'record: record changed repeatedly before commit; no commit callback was run\n' },
  { status: 1, stderr: 'record: record preparation conflict\n' },
  { status: 1, stderr: 'record: incomplete record tail\n' },
]) test(`busy writer stays replayable: ${receipt.stderr.trim()}`, t => {
  const f = fixture(t);
  const unknown = f.replay({ record: () => { throw Object.assign(Error(receipt.stderr), { receipt }); } });
  const pending = f.read().sessionBinding;
  assert.equal(unknown.outcome, 'unknown'); assert.equal(pending.status, 'observing');
  assert.equal(pending.record_refusal, undefined);
  assert.deepEqual(pending.proposed, f.proposed);
  assert.deepEqual(pending.commit_attempts[0].error.receipt, receipt);
  assert.equal(loadRecord(f.org).events.filter(e => e.type === 'run.session_bound').length, 0);
  assert.equal(f.replay().outcome, 'bound');
  assert.deepEqual(f.read().sessionBinding.proposed, f.proposed);
  assert.equal(f.read().sessionBinding.commit_attempts.length, 2);
  assert.equal(f.replay({ record: () => assert.fail('bound proposal replayed') }), undefined);
  assert.equal(loadRecord(f.org).events.filter(e => e.type === 'run.session_bound').length, 1);
});

test('record refusals are final and original lock, claim, source and STOP guards precede every replay', t => {
  const f = fixture(t), before = fs.readFileSync(f.journal);
  const lock = lockRequest(f.journal);
  try { assert.throws(() => f.replay(), /already running/); } finally { lock.release(); }
  assert.deepEqual(fs.readFileSync(f.journal), before);
  assert.throws(() => f.replay({ guard: () => { throw Error('STOP/HOLD'); } }), /STOP\/HOLD/);
  assert.deepEqual(fs.readFileSync(f.journal), before);
  for (const change of [j => j.ownership.generation++, j => j.common = '/foreign/.git', j => j.token = 'replacement']) {
    const job = structuredClone(f.original); change(job); f.write(job);
    assert.throws(() => f.replay()); assert.equal(f.read().sessionBinding.commit_attempts, undefined);
  }
  f.write(f.original);
  const result = f.replay({ record: () => { throw Object.assign(Error('record: conflicting session'),
    { receipt: { status: 3, signal: null, stderr: 'record: conflicting session\n',
      stdout: JSON.stringify({ schema: 'dispatch-session-binding/v1', outcome: 'refused', code: 'SESSION_BIND_REFUSED' }) } }); } });
  assert.equal(result.outcome, 'refused'); assert.equal(f.read().sessionBinding.status, 'unbound');
  assert.equal(f.replay({ record: () => assert.fail('refusal replayed') }), undefined);
  assert.equal(f.command(['session-bind', '--journal', f.journal]).status, 1);
  assert.deepEqual(f.read().sessionBinding.proposed, f.proposed);
});

test('real writer fact refusal is typed and final for replay', t => {
  const f = fixture(t);
  f.bind(f.journal);
  const job = f.read(); job.sessionBinding.proposed.session = 'conflicting-session'; f.write(job);
  const result = f.replay();
  assert.equal(result.outcome, 'refused');
  assert.match(result.error.receipt.stderr, /different or conflicting session bind/);
  assert.equal(JSON.parse(result.error.receipt.stdout).code, 'SESSION_BIND_REFUSED');
  assert.equal(f.read().sessionBinding.record_refusal, true);
  assert.equal(f.replay({ record: () => assert.fail('refusal replayed') }), undefined);
  assert.equal(loadRecord(f.org).events.filter(e => e.type === 'run.session_bound').length, 1);
});

test('permission refusals and journal changes never become retryable record writes', t => {
  const f = fixture(t);
  assert.equal(f.replay({ record: () => { throw Object.assign(Error('permission refused'), { code: 'EPERM' }); } }).outcome, 'refused');
  assert.equal(f.replay({ record: () => assert.fail('permission refusal replayed') }), undefined);
  f.write(f.original);
  const changed = { ...f.original, source_changed: true };
  assert.throws(() => f.replay({ record: () => { f.write(changed); return '{}'; } }), /source\/lock changed/);
  assert.deepEqual(f.read(), changed);
});
