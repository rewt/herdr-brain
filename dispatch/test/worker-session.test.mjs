import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fold } from '../../lib/state.mjs';
import { sessionBindFact } from '../../test/helpers/session-bind.mjs';
import { readWorkerSession, workerSessionState, waitForWorkerSession } from '../worker-session.mjs';
import { saveDispatchJournal } from '../journal-save.mjs';

function fixture(t, { launchSession = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-session-'))), cwd = path.join(root, 'project');
  const priorFleet = process.env.HERDR_MONITOR_FLEET;
  process.env.HERDR_MONITOR_FLEET = path.join(root, 'fleet');
  t.after(() => { if (priorFleet === undefined) delete process.env.HERDR_MONITOR_FLEET; else process.env.HERDR_MONITOR_FLEET = priorFleet; fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(cwd); fs.writeFileSync(path.join(root, '.identity-root'), 'fixture\n');
  execFileSync('git', ['init', '-q', '-b', 'main', cwd]);
  const org = path.join(cwd, '.org'), common = path.join(cwd, '.git'), journal = path.join(org, 'dispatch/attempt.json');
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  const owner = { controller: 'brain', legacy: false, release: { id: 'source', commit: null, root: cwd, identity: common } };
  const events = [
    { type: 'item.added', id: 'ENG-1', role: 'engineer', title: 'Fixture', meta: {} },
    { type: 'run.started', id: 'R-1', item: 'ENG-1', workspace: cwd, meta: {
      dispatch_journal: journal, dispatch_attempt: 'attempt', dispatch_project: common, dispatch_record: org } },
    { type: 'run.claimed', run: 'R-1', owner, project: common, record: org },
    { type: 'run.updated', id: 'R-1', meta: { agent: 'worker', pane: 'w:p', worker_workspace: 'w', terminal_id: 'terminal',
      ...(launchSession ? { agent_session_id: 'session' } : {}) } },
  ].map((e, i) => ({ ...e, seq: i + 1, at: new Date(100000 + i).toISOString(), by: 'fixture' }));
  const native = { name: 'worker', cwd, pane_id: 'w:p', workspace_id: 'w', terminal_id: 'terminal', agent_session: { value: 'session' } };
  const job = { run: 'R-1', org, common, repo: cwd, workspace: cwd, token: 'attempt', stage: 'complete', ownership: { owner, generation: 3 },
    worker: { agentName: 'worker', pane: 'w:p', workspaceId: 'w', terminalId: 'terminal' }, sessionBinding: { status: 'observing' } };
  const binding = { org, project: { identity: common, canonical: cwd, checkout: cwd }, native };
  const write = () => { fs.writeFileSync(journal, JSON.stringify(job)); fs.writeFileSync(path.join(org, 'events.jsonl'), events.map(e => JSON.stringify(e) + '\n').join('')); };
  const options = () => ({ id: 'R-1', org, journal, job, binding, events, state: fold(events) });
  const inspect = () => workerSessionState(options());
  const bind = () => {
    const state = fold(events), event = sessionBindFact(state.runs.get('R-1'), state, { at: 100100, seq: events.length + 1 });
    events.push(event); write(); return event;
  };
  const env = { ...process.env, HERDR_ENV: '1', HERDR_PANE_ID: native.pane_id, HERDR_WORKSPACE_ID: native.workspace_id, CODEX_THREAD_ID: '', ORG_DIR: org };
  const read = () => readWorkerSession({ id: 'R-1', org, journal, cwd, env, call: () => JSON.stringify({ result: { agent: native } }) });
  write();
  return { cwd, org, journal, job, events, native, binding, options, inspect, read, bind, write };
}

test('worker task stays behind committed session evidence despite a proposed or claimed-bound journal', async t => {
  const f = fixture(t), initial = f.read(); assert.equal(initial.status, 'pending');
  const state = fold(f.events);
  f.job.sessionBinding = { status: 'bound', proposed: sessionBindFact(state.runs.get('R-1'), state, { at: 100100 }) }; f.write();
  assert.equal(f.read().status, 'pending', 'journal success is not a committed bind');
  const originalJournal = fs.readFileSync(f.journal), originalWorker = structuredClone(f.events[3]);
  let now = 0, pauses = 0, firstAction;
  const result = await waitForWorkerSession({ inspect: f.read, now: () => now, pause: async ms => {
    assert.equal(firstAction, undefined); pauses++; now += ms; f.bind();
  } });
  firstAction = { type: 'note.added', id: 'R-1', seq: f.events.length + 1, text: 'First task action after readiness' };
  assert.equal(result.status, 'ready'); assert.equal(pauses, 1);
  assert.ok(result.event_seq < firstAction.seq);
  assert.deepEqual(f.events[3], originalWorker, 'raw launch receipt stays unchanged');
  assert.deepEqual(fs.readFileSync(f.journal), originalJournal, 'wait sends no prompt and writes no binding');
});

test('a pending wait yields without reporting and later accepts original line replay after the launch deadline', async t => {
  const f = fixture(t); let now = 0, reads = 0;
  const pending = await waitForWorkerSession({ inspect: () => { reads++; return f.read(); }, timeoutMs: 2000,
    now: () => now, pause: async ms => { now += ms; } });
  assert.equal(pending.status, 'pending'); assert.equal(reads, 3);
  assert.equal(f.events.some(e => e.type === 'report.ingested'), false);
  f.bind();
  const ready = await waitForWorkerSession({ inspect: f.read });
  assert.equal(ready.status, 'ready'); assert.equal(ready.session, 'session');
  assert.equal(f.job.sessionBinding.status, 'observing', 'record is authoritative even before journal receipt save');
});

test('already committed launch sessions need no late bind', t => {
  const f = fixture(t, { launchSession: true }); assert.equal(f.read().status, 'ready'); assert.equal(f.read().event_seq, 4);
});

test('native replacements, changed claim/source, duplicate identity and inactive runs stop before task work', t => {
  const f = fixture(t); f.bind();
  const original = f.options();
  const changes = [
    o => { o.binding.native.agent_session.value = 'replacement'; },
    o => { o.binding.native.terminal_id = 'replacement'; },
    o => { o.binding.native.pane_id = 'replacement'; },
    o => { o.binding.native.workspace_id = 'replacement'; },
    o => { o.binding.native.name = 'replacement'; },
    o => { o.job.ownership.generation++; },
    o => { o.job.token = 'replacement'; },
    o => { o.job.run = 'R-other'; },
    o => { o.binding.project.identity = '/foreign/.git'; },
    o => { o.state.runs.get('R-1').meta.dispatch_journal = '/foreign/attempt.json'; },
    o => { o.state.runs.get('R-1').meta.terminal_id = 'replacement'; },
    o => { o.state.sessionBindings.get('R-1').push(o.state.sessionBindings.get('R-1')[0]); },
    o => { o.state.runs.get('R-1').report = {}; },
    o => { o.state.runs.get('R-1').abandoned = {}; },
    o => { o.state.items.get('ENG-1').meta.hold = true; },
    o => { o.state.items.get('ENG-1').runs.push('R-next'); o.state.runs.set('R-next', {}); },
  ];
  for (const change of changes) { const changed = structuredClone(original); change(changed); assert.throws(() => workerSessionState(changed)); }
  fs.mkdirSync(path.join(f.cwd, '.lane/supervisor'), { recursive: true });
  for (const marker of ['STOP', 'HOLD']) {
    const file = path.join(f.cwd, '.lane/supervisor', marker); fs.writeFileSync(file, 'held');
    assert.throws(f.read, new RegExp(marker)); fs.unlinkSync(file);
  }
});

test('original binding refusals and malformed record tails are retained rather than waited or repaired', async t => {
  const f = fixture(t);
  for (const refusal of [{ status: 'unbound', reason: 'native process changed' }, { status: 'observing', record_refusal: true }]) {
    f.job.sessionBinding = refusal; f.write(); let attempts = 0;
    await assert.rejects(waitForWorkerSession({ inspect: () => { attempts++; return f.read(); } }), /original binding stopped/);
    assert.equal(attempts, 1);
  }
  f.bind(); assert.throws(f.read, /original binding stopped/, 'a recorded refusal remains final even if a fact is present');
  f.job.sessionBinding = { status: 'observing' }; f.write();
  const file = path.join(f.org, 'events.jsonl'); fs.appendFileSync(file, '{"incomplete":');
  const before = fs.readFileSync(file); assert.throws(f.read, /incomplete tail/); assert.deepEqual(fs.readFileSync(file), before);
});

test('wait retries only pre-effect read contention and stops on native refusal or changed anchors', async () => {
  let now = 0, reads = 0;
  const contention = () => Error('record changed repeatedly while preparing a consistent read; no mutation attempted');
  const result = await waitForWorkerSession({ now: () => now, pause: async ms => { now += ms; }, inspect: () => {
    if (++reads === 1) throw contention();
    return { status: 'ready', anchor: { generation: 1 } };
  } });
  assert.equal(result.status, 'ready'); assert.equal(reads, 2);
  reads = 0;
  await assert.rejects(waitForWorkerSession({ inspect: () => { reads++; throw Object.assign(Error('native refusal'), { code: 'EPERM' }); } }), /native refusal/);
  assert.equal(reads, 1);
  await assert.rejects(waitForWorkerSession({ now: () => now, pause: async ms => { now += ms; }, inspect: () =>
    ({ status: 'pending', anchor: { generation: ++reads } }) }), /binding changed while waiting/);
});

test('journal contention recovery commits once with the original claim and never retries a started effect or refusal', () => {
  const originalClaim = { generation: 3 }; let reads = 0, writes = 0;
  const message = 'record changed repeatedly while preparing a consistent read; no mutation attempted';
  const result = saveDispatchJournal({ reserve: write => {
    assert.equal(originalClaim.generation, 3);
    if (++reads === 1) throw Error(message);
    return write();
  }, write: () => { writes++; return 'saved'; } });
  assert.equal(result, 'saved'); assert.equal(reads, 2); assert.equal(writes, 1);
  for (const effectStarted of [false, true]) {
    reads = writes = 0;
    assert.throws(() => saveDispatchJournal({ reserve: write => {
      reads++; if (!effectStarted) throw Object.assign(Error('claim changed'), { code: 'RUN_OWNED_ELSEWHERE' });
      return write();
    }, write: () => { writes++; throw Error(message); } }), error => {
      assert.equal(Boolean(error.dispatchJournalEffectStarted), effectStarted); return true;
    });
    assert.equal(reads, 1); assert.equal(writes, effectStarted ? 1 : 0);
  }
  reads = 0;
  assert.throws(() => saveDispatchJournal({ reserve: () => { reads++; throw Error(message); }, write: () => assert.fail('write on exhausted read') }), /consistent read/);
  assert.equal(reads, 32, 'contention recovery is bounded');
});
