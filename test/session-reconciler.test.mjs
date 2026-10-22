import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseManifest, validateManifest } from '../sessions/manifest.mjs';
import { canonicalProject } from '../sessions/project.mjs';
import { recordStandardSlot, readStandardSlots } from '../sessions/receipts.mjs';
import { inspect } from '../sessions/sessions.mjs';
import { plan } from '../sessions/plan.mjs';
import { createHerdrObserver, readSessionFacts, agentBinding } from '../sessions/observe.mjs';
import { planSessions, reconcileOffline } from '../sessions/reconcile.mjs';
import { readControllerJournal, runtimePaths, acquireControllerLease } from '../sessions/runtime.mjs';
import { ROUTE_PRESET } from '../lanes/preset.mjs';
import { planRetirement } from '../lib/retire.mjs';
import { fold } from '../lib/state.mjs';
import { workerIdentityEvidence } from '../lib/worker-identity.mjs';
import { sessionBindFact } from './helpers/session-bind.mjs';
import { CreateNotInvokedError } from '../sessions/create-safety.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const example = name => parseManifest(fs.readFileSync(path.join(root, `test/fixtures/sessions/${name}.md`), 'utf8'));
const document = m => `## Manifest\n\`\`\`json\n${JSON.stringify(m)}\n\`\`\`\n`;
function fixture(t, names = ['chat']) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-'))), cwd = path.join(scratch, 'repo');
  fs.mkdirSync(cwd); t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(cwd, '.lane.json'), '{}'); git('add', '.'); git('commit', '-qm', 'fixture');
  const project = canonicalProject(cwd), org = path.join(scratch, 'record'); fs.mkdirSync(org);
  fs.writeFileSync(path.join(org, 'events.jsonl'), '');
  const env = { ...process.env, ORG_DIR: org, HERDR_MONITOR_FLEET: path.join(scratch, 'fleet'), LANE_CONFIG: undefined,
    XDG_STATE_HOME: path.join(scratch, 'state'), XDG_CONFIG_HOME: path.join(scratch, 'config'),
    BRAIN_SHADOW_ROOT: path.join(scratch, 'shadow'), HERDR_SOCKET_PATH: path.join(scratch, 'h.sock') };
  const entries = names.map(name => {
    const m = example(name); m.spec.workspaceRef = 'home';
    return { file: path.join(scratch, `${name}.md`), ...validateManifest(m, { project, config: ROUTE_PRESET }) };
  });
  const inspection = { project, entries, valid: true, diagnostics: [] };
  const observation = { server: env.HERDR_SOCKET_PATH, complete: true, workspaces: [{ workspace_id: 'w', worktree: {
    repo_key: project.common, checkout_path: cwd, is_linked_worktree: true } }], tabs: [], panes: [], agents: [], receipts: [], errors: [] };
  for (const entry of entries.filter(e => e.manifest.spec.standardSlot)) {
    const s = entry.manifest.spec, tab = `w:t-${s.standardSlot}`, pane = `w:p-${s.standardSlot}`;
    observation.tabs.push({ tab_id: tab, workspace_id: 'w' });
    observation.panes.push({ pane_id: pane, tab_id: tab, workspace_id: 'w', terminal_id: `term-${s.standardSlot}`, emptyConfirmed: true });
    recordStandardSlot({ cwd, action: 'adopt', uid: `slot-${s.standardSlot}`, actor: 'fixture', why: 'offline adopted layout',
      slot: { server: observation.server, workspace: 'w', checkout: cwd, tab, standardSlot: s.standardSlot, panes: [{ pane, paneSlot: 'primary' }] } });
  }
  const facts = { record: { runs: [], items: [], links: [], revision: 0 }, dispatches: {}, reports: {}, watches: {}, references: [], errors: [], stopped: false, closeHold: null };
  const f = { scratch, cwd, git, env, org, project, inspection, observation, facts, calls: [] };
  f.read = async () => ({ enrollment: readStandardSlots(project.common), observation: structuredClone(observation), facts: structuredClone(facts) });
  f.materialize = op => {
    const a = { name: `native-${op.uid}`, pane_id: op.target.pane, tab_id: op.target.tab, workspace_id: op.target.workspace,
      cwd, terminal_id: observation.panes.find(p => p.pane_id === op.target.pane).terminal_id,
      agent_session: { value: `session-${op.uid}` }, agent_status: 'idle' };
    observation.agents.push(a);
    observation.receipts.push({ operationId: op.id, uid: op.uid, generation: op.generation, specDigest: op.specDigest,
      binding: agentBinding(a, observation.server) });
  };
  f.actions = { offline: true, start: async op => {
    assert.equal(readControllerJournal(project.common).operations.at(-1).state, 'intent', 'intent durable before delegate');
    f.calls.push(op); f.materialize(op);
  } };
  f.run = () => reconcileOffline({ inspection, read: f.read, actions: f.actions });
  f.preview = async (journal = readControllerJournal(project.common)) => planSessions({ inspection, ...await f.read(), journal });
  return f;
}
const decision = p => p.decisions[0];

function removeChatAdoption(f) {
  recordStandardSlot({ cwd: f.cwd, action: 'withdraw', uid: 'slot-chat', actor: 'fixture', why: 'never-adopted creation fixture' });
  f.observation.tabs = f.observation.tabs.filter(t => t.tab_id !== 'w:t-chat');
  f.observation.panes = f.observation.panes.filter(p => p.pane_id !== 'w:p-chat');
}

test('never-adopted chat creates once through a durable intent and acknowledged receipt derives KEEP enrollment', async t => {
  const f = fixture(t, ['chat', 'supervisor']); removeChatAdoption(f);
  assert.equal(decision(await f.preview()).decision, 'WouldCreate');
  f.actions.create = async op => {
    assert.equal(readControllerJournal(f.project.common).operations.at(-1).state, 'intent');
    assert.deepEqual(Object.keys(op.target).sort(), ['checkout', 'server', 'workspace']);
    f.calls.push(op);
    const target = { ...op.target, tab: 'new-tab', pane: 'new-pane' };
    f.observation.tabs.push({ tab_id: target.tab, workspace_id: target.workspace });
    f.observation.panes.push({ pane_id: target.pane, tab_id: target.tab, workspace_id: target.workspace, terminal_id: 'new-terminal' });
    f.materialize({ ...op, target });
  };
  const first = await f.run(); assert.equal(decision(first).decision, 'KEEP', JSON.stringify(first));
  const op = readControllerJournal(f.project.common).operations[0]; assert.equal(op.state, 'acknowledged');
  assert.equal(readStandardSlots(f.project.common).slots.find(s => s.standardSlot === 'chat').controllerOperation, op.id);
  await f.run(); // starts the existing empty supervisor; chat stays KEEP.
  assert.equal(decision(await f.preview()).decision, 'KEEP'); assert.equal(f.calls.filter(op => op.kind === 'create-standard-slot').length, 1);
});

test('a create intent without an exact receipt holds and fences every later action', async t => {
  const f = fixture(t, ['chat', 'supervisor']); removeChatAdoption(f);
  f.actions.create = async op => { f.calls.push(op); throw Error('reply lost after create'); };
  const first = await f.run(); assert.match(decision(first).reason, /create intent unresolved/);
  assert.ok(first.decisions.every(d => d.decision === 'Hold'));
  await f.run(); assert.equal(f.calls.length, 1);
});

test('a create withheld after intent keeps its durable reason and fences unrelated starts without claiming a retained tab', async t => {
  const f = fixture(t, ['chat', 'supervisor']); removeChatAdoption(f);
  const read = f.read; let reads = 0;
  f.read = async () => { if (++reads === 3) f.facts.stopped = true; return read(); };
  f.actions.create = async () => assert.fail('create delegate must not run');
  await f.run();
  const op = readControllerJournal(f.project.common).operations[0];
  assert.equal(op.state, 'withheld'); assert.match(op.reason, /evidence changed after intent/);
  f.facts.stopped = false; f.read = read;
  const p = await f.run(), d = decision(p);
  assert.match(d.reason, /create withheld, delegate never invoked: evidence changed after intent/);
  assert.doesNotMatch(d.reason, /inspect retained tab/);
  assert.deepEqual(d.observed, { operationId: op.id, operationState: 'withheld', withheldReason: op.reason });
  assert.ok(p.decisions.every(d => d.decision === 'Hold')); assert.equal(f.calls.length, 0);
  assert.deepEqual(readControllerJournal(f.project.common).operations, [op]);
});

test('only a typed pre-create refusal records withheld; an ordinary lost reply stays intent', async t => {
  const f = fixture(t, ['chat', 'supervisor']); removeChatAdoption(f);
  f.actions.create = async () => { throw new CreateNotInvokedError(Error('physical STOP before tab create')); };
  const p = await f.run(), op = readControllerJournal(f.project.common).operations[0];
  assert.equal(op.state, 'withheld'); assert.match(op.reason, /create not invoked: physical STOP/);
  assert.match(decision(p).reason, /create withheld, delegate never invoked/);
  assert.equal(f.calls.length, 0);
});

test('missing logs positions Observe without fencing a chat or supervisor action', async t => {
  const f = fixture(t);
  for (const name of ['logs-viewer', 'logs-triage']) f.inspection.entries.push(validateManifest(example(name), { project: f.project, config: ROUTE_PRESET }));
  const p = await f.preview(); assert.equal(p.action.kind, 'start-standard-slot');
  for (const d of p.decisions.slice(1)) {
    assert.equal(d.decision, 'Observe'); assert.equal(d.reason, 'creation unsupported: logs layout awaits triage activation');
  }
});

test('workspace-wide unowned agents block creation, while a recorded live work-item binding is preserved', async t => {
  const f = fixture(t, ['chat', 'supervisor']); removeChatAdoption(f);
  const a = { name: 'retained-worker', workspace_id: 'w', tab_id: 'worker-tab', pane_id: 'worker-pane', terminal_id: 'worker-term', cwd: f.cwd,
    agent_session: { value: 'worker-native' }, agent_status: 'working' };
  f.observation.agents.push(a);
  assert.match(decision(await f.preview()).reason, /unowned live occupant in workspace: retained-worker/);
  f.facts.record.runs.push({ id: 'R-99', item: 'ENG-9', workspace: f.cwd, started: { seq: 1 }, meta: {
    agent: a.name, pane: a.pane_id, terminal_id: a.terminal_id, worker_workspace: 'w', agent_session_id: 'worker-native' } });
  assert.equal(decision(await f.preview()).decision, 'WouldCreate');
  f.facts.record.runs[0].meta.agent_session_id = 'different';
  assert.match(decision(await f.preview()).reason, /unowned live occupant/);
});

test('one journaled fake delegate, then idempotent KEEP even idle; cache loss cannot launch or replay', async t => {
  const f = fixture(t);
  assert.equal(decision(await f.preview()).decision, 'WouldStart');
  assert.equal(decision(await f.run()).decision, 'KEEP');
  assert.equal(f.calls.length, 1);
  assert.equal(readControllerJournal(f.project.common).operations[0].state, 'acknowledged');
  const paths = runtimePaths(f.project.common); fs.unlinkSync(paths.status);
  assert.equal(decision(await f.run()).decision, 'KEEP'); assert.equal(f.calls.length, 1);
  fs.writeFileSync(paths.status, '{"phase":"Missing","action":"prompt"}');
  assert.equal(decision(await f.run()).decision, 'KEEP'); assert.equal(f.calls.length, 1);
  fs.unlinkSync(paths.journal);
  assert.equal(decision(await f.run()).decision, 'Hold', 'lost ownership is not adopted from cache');
  assert.equal(f.calls.length, 1);
});

test('lost start acknowledgement holds forever without another start; exact receipt can resolve it', async t => {
  const f = fixture(t);
  f.actions.start = async op => { f.calls.push(op); throw Error('ack lost'); };
  assert.equal(decision(await f.run()).decision, 'Hold');
  assert.equal(decision(await f.run()).decision, 'Hold'); assert.equal(f.calls.length, 1);
  const op = readControllerJournal(f.project.common).operations[0];
  f.materialize(op); // delayed fake server evidence, not controller retry
  assert.equal(decision(await f.run()).decision, 'KEEP'); assert.equal(f.calls.length, 1);
  assert.equal(readControllerJournal(f.project.common).operations[0].state, 'acknowledged');
});

test('lost adapter reply resolves immediately only when a fresh exact receipt proves the incarnation', async t => {
  const f = fixture(t), delegate = f.actions.start;
  f.actions.start = async op => { await delegate(op); throw Error('lost reply'); };
  assert.equal(decision(await f.run()).decision, 'KEEP');
  assert.equal(decision(await f.run()).decision, 'KEEP'); assert.equal(f.calls.length, 1);
});

for (const change of ['terminal_id', 'name', 'cwd', 'native', 'duplicate', 'pane-topology', 'unrelated-pane', 'wrong-receipt']) test(`changed or ambiguous occupant holds: ${change}`, async t => {
  const f = fixture(t); await f.run();
  const a = f.observation.agents[0];
  if (change === 'native') a.agent_session.value = 'different';
  else if (change === 'duplicate') f.observation.agents.push({ ...a, pane_id: 'elsewhere' });
  else if (change === 'pane-topology') f.observation.panes[0].workspace_id = 'other';
  else if (change === 'unrelated-pane') f.observation.panes.push({ ...f.observation.panes[0], pane_id: 'extra' });
  else if (change === 'wrong-receipt') f.observation.receipts[0].binding.nativeSessionId = 'different';
  else a[change] = 'different';
  assert.equal(decision(await f.run()).decision, 'Hold'); assert.equal(f.calls.length, 1);
});

test('unknown live occupant in adopted position is held, never adopted, prompted or closed', async t => {
  const f = fixture(t);
  f.observation.agents.push({ name: 'chat', pane_id: 'w:p-chat', terminal_id: 'term-chat', workspace_id: 'w', tab_id: 'w:t-chat', cwd: f.cwd,
    agent_session: { value: 'unknown' }, agent_status: 'idle' });
  assert.equal(decision(await f.run()).decision, 'Hold'); assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(runtimePaths(f.project.common).journal), false);
});

test('a pane retaining native/restore evidence is never treated as a missing empty occupant', async t => {
  const f = fixture(t); f.observation.panes[0].agent_session = { value: 'restoring-native' };
  assert.equal(decision(await f.run()).decision, 'Hold'); assert.equal(f.calls.length, 0);
});

test('no receipt means not enrolled despite matching labels or injected sidecars', async t => {
  const f = fixture(t); recordStandardSlot({ cwd: f.cwd, action: 'withdraw', uid: 'slot-chat', actor: 'fixture', why: 'offline withdrawal' });
  fs.mkdirSync(path.join(f.cwd, '.lane/sessions.json.d'), { recursive: true });
  fs.writeFileSync(path.join(f.cwd, '.lane/sessions.json.d/chat.json'), '{"phase":"Missing","enrolled":true}');
  assert.equal(decision(await f.run()).phase, 'NotEnrolled'); assert.equal(f.calls.length, 0);
});

test('pending generation freezes live route, context and personality and never replays the initial prompt', async t => {
  const f = fixture(t); await f.run();
  const entry = f.inspection.entries[0]; entry.manifest.metadata.generation++;
  entry.resolvedSpec.personality.instructions = 'changed'; entry.resolvedSpec.resolvedRoute.model = 'new-model';
  const p = await f.run(); assert.equal(decision(p).pendingGeneration, 2); assert.equal(decision(p).decision, 'KEEP');
  assert.equal(decision(p).observed.generation, 1); assert.equal(f.calls.length, 1);
});

for (const brake of ['stopped', 'closeHold']) test(`${brake} is observe-only, including immediately after durable intent`, async t => {
  const f = fixture(t); f.facts[brake] = brake === 'stopped' ? true : 'canonical close hold';
  assert.equal(decision(await f.run()).decision, 'Observe'); assert.equal(f.calls.length, 0);
  f.facts[brake] = false;
  const read = f.read; let reads = 0;
  f.read = async () => {
    if (++reads === 3) f.facts[brake] = true;
    if (reads === 4) assert.equal(readControllerJournal(f.project.common).operations[0].state, 'withheld', 'withholding durable before re-observation');
    return read();
  };
  const withheld = await f.run();
  assert.equal(decision(withheld).decision, 'Observe'); assert.equal(f.calls.length, 0);
  const operation = readControllerJournal(f.project.common).operations[0];
  assert.equal(operation.state, 'withheld'); assert.match(operation.reason, /evidence changed after intent/);
  assert.match(decision(withheld).reason, /delegate never invoked/);
  f.facts[brake] = false; f.read = read;
  const held = decision(await f.run());
  assert.equal(held.decision, 'Hold', 'withheld start never retried');
  assert.equal(held.observed.operationState, 'withheld'); assert.equal(held.observed.withheldReason, operation.reason);
  assert.match(held.reason, /delegate never invoked/); assert.equal(f.calls.length, 0);
  assert.deepEqual(readControllerJournal(f.project.common).operations, [operation]);
});

test('canonical lease contention across linked checkouts holds without writes or starts', async t => {
  const f = fixture(t), lane = path.join(f.scratch, 'lane'); f.git('worktree', 'add', '-b', 'lane/other', lane);
  assert.equal(canonicalProject(lane).common, f.project.common);
  const release = acquireControllerLease(f.project.common);
  try {
    const before = fs.readFileSync(path.join(runtimePaths(f.project.common).lease, 'owner.json'), 'utf8');
    const p = await f.run(); assert.equal(p.decision, 'Hold'); assert.equal(f.calls.length, 0);
    assert.equal(fs.readFileSync(path.join(runtimePaths(f.project.common).lease, 'owner.json'), 'utf8'), before);
    assert.equal(fs.existsSync(runtimePaths(f.project.common).status), false);
  } finally { release(); }
});

test('at most one action in a pass with two missing standard slots', async t => {
  const f = fixture(t, ['chat', 'supervisor']);
  const p = await f.preview(); assert.equal(p.decisions.filter(d => d.action).length, 1); assert.equal(p.decisions[1].decision, 'Defer');
  await f.run(); assert.equal(f.calls.length, 1);
  await f.run(); assert.equal(f.calls.length, 2);
  await f.run(); assert.equal(f.calls.length, 2);
});

test('a changed empty terminal cancels before intent and unresolved ownership fences other starts', async t => {
  const f = fixture(t, ['chat', 'supervisor']), read = f.read; let reads = 0;
  f.read = async () => { if (++reads === 2) f.observation.panes[0].terminal_id = 'replacement'; return read(); };
  const p = await f.run(); assert.equal(p.action, null); assert.equal(p.decisions[0].decision, 'Hold');
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(runtimePaths(f.project.common).journal), false);
  f.read = read; f.actions.start = async op => { f.calls.push(op); throw Error('uncertain'); };
  await f.run(); await f.run(); assert.equal(f.calls.length, 1);
});

test('execution rejects a non-fake adapter and malformed or symlinked operation evidence holds', async t => {
  const f = fixture(t);
  await assert.rejects(reconcileOffline({ inspection: f.inspection, read: f.read, actions: { start() { assert.fail('live'); } } }), /offline fake/);
  const file = runtimePaths(f.project.common).journal;
  fs.writeFileSync(file, '{'); assert.equal((await f.run()).decision, 'Hold');
  fs.unlinkSync(file); fs.symlinkSync('missing-target', file);
  assert.equal((await f.run()).decision, 'Hold'); assert.equal(f.calls.length, 0);
});

function withWorker(f) {
  const m = example('engineer-worker'); m.spec.workspaceRef = 'home';
  f.inspection.entries = [validateManifest(m, { project: f.project, config: ROUTE_PRESET })];
  const pane = { pane_id: 'w:p-worker', tab_id: 'w:t-worker', workspace_id: 'w', terminal_id: 'term-worker' };
  f.observation.tabs.push({ tab_id: pane.tab_id, workspace_id: 'w' }); f.observation.panes.push(pane);
  const a = { name: 'worker', ...pane, cwd: f.cwd, agent_session: { value: 'warm-native' }, agent_status: 'idle' };
  f.observation.agents.push(a);
  f.facts.record.items = [{ id: 'ENG-232', role: 'engineer', runs: ['R-1'] }, { id: 'REV-1', role: 'reviewer', parent: 'ENG-232', runs: [] }];
  function addRun(id, seq, reuse = null, reported = true) {
    const route = f.inspection.entries[0].resolvedSpec.resolvedRoute;
    const run = { id, item: 'ENG-232', workspace: f.cwd, report_path: path.join(f.org, `${id}.md`), started: { seq }, meta: {
      agent: a.name, pane: a.pane_id, worker_workspace: 'w', terminal_id: a.terminal_id, agent_session_id: a.agent_session.value,
      route: route.route, harness: route.kind, model: route.model, effort: route.effort }, ...(reported ? { report: { seq: seq + 1, outcome: 'done' } } : {}) };
    f.facts.record.runs.push(run); f.facts.record.revision = seq + 1;
    f.facts.dispatches[id] = { run: id, item: run.item, common: f.project.common, workspace: f.cwd, report: run.report_path, route: route.route,
      declared: { harness: route.kind, model: route.model, effort: route.effort }, stage: 'complete', reuse, worker: {
        agentName: a.name, pane: a.pane_id, workspaceId: 'w', terminalId: a.terminal_id, agentSessionId: a.agent_session.value } };
    f.facts.watches[id] = { pid: 999, identity: 'fixture-watcher' };
    return run;
  }
  return { a, addRun };
}

test('late-bound worker reconciles from side evidence, retains the raw dispatch receipt and rejects conflicting identity', async t => {
  const f = fixture(t), { a, addRun } = withWorker(f), run = addRun('R-1', 1, null, false);
  delete run.meta.agent_session_id;
  const journal = path.join(f.org, 'dispatch.json');
  Object.assign(run.meta, { dispatch_attempt: 'attempt', dispatch_journal: journal, dispatch_project: f.project.common, dispatch_record: f.org });
  const worker = { agent: a.name, pane: a.pane_id, worker_workspace: a.workspace_id, terminal_id: a.terminal_id };
  const events = [
    { type: 'item.added', id: run.item, role: 'engineer' },
    { type: 'run.started', id: run.id, item: run.item, workspace: f.cwd, report_path: run.report_path, meta: run.meta },
    { type: 'run.updated', id: run.id, meta: worker },
  ].map((e, i) => ({ ...e, seq: i + 1, at: '2026-10-17T20:00:00Z', by: 'fixture' }));
  const launch = fold(events), bind = sessionBindFact(launch.runs.get(run.id), launch, { session: a.agent_session.value, seq: 4 });
  events.push(bind);
  fs.writeFileSync(path.join(f.org, 'events.jsonl'), events.map(e => JSON.stringify(e) + '\n').join(''));
  const job = f.facts.dispatches[run.id]; job.worker.agentSessionId = null; job.token = 'attempt';
  fs.writeFileSync(journal, JSON.stringify(job));
  const facts = readSessionFacts({ project: f.project, env: f.env });
  assert.deepEqual(facts.errors, []);
  f.facts.record = facts.record; f.facts.dispatches = facts.dispatches;
  assert.deepEqual(f.facts.record.sessionBindings, workerIdentityEvidence(fold(events)).sessionBindings);
  assert.equal(f.facts.record.runs[0].meta.agent_session_id, undefined);
  assert.equal(f.facts.record.runs[0].session_bindings, undefined);
  const p = await f.run(), d = decision(p);
  assert.equal(d.phase, 'Running', d.reason); assert.equal(d.decision, 'NoOp');
  assert.equal(d.observed.binding.nativeSessionId, 'warm-native');
  assert.equal(f.calls.length, 0);
  f.facts.record.sessionBindings[run.id].push({ ...bind, session: 'replacement', seq: 5 });
  assert.equal(decision(await f.preview()).decision, 'Hold');
  assert.equal(f.calls.length, 0);
});

for (const route of ['review', 'engineer']) test(`declarative reviewer on ${route} never binds the live engineer or fences another slot`, async t => {
  const f = fixture(t), chat = f.inspection.entries[0], { a, addRun } = withWorker(f); addRun('R-1', 1);
  const m = example('reviewer'); m.spec.workspaceRef = 'home'; m.spec.route = route;
  const reviewer = validateManifest(m, { project: f.project, config: ROUTE_PRESET });
  f.inspection.entries = [reviewer];
  const check = p => {
    const d = p.decisions.find(d => d.uid === m.metadata.uid);
    assert.equal(d.decision, 'Observe'); assert.equal(d.phase, 'DeclarativeOnly');
    assert.match(d.reason, /reviewer sessions are declarative only; settle owns review launch/);
    assert.equal(d.action, null); assert.equal(d.freeze, undefined); assert.equal(d.observed, undefined);
  };
  check(await f.preview());
  const p = await f.run(); check(p); assert.equal(p.action, null);
  assert.deepEqual(readControllerJournal(f.project.common).bindings, []); assert.equal(f.calls.length, 0);
  // Missing/mismatched engineer evidence must not turn the reviewer into a Hold.
  a.terminal_id = 'unexpected-occupant';
  f.inspection.entries.unshift(chat);
  const withChat = await f.preview(); check(withChat);
  assert.equal(withChat.decisions[0].decision, 'WouldStart'); assert.equal(withChat.action.uid, chat.manifest.metadata.uid);
  check(await f.run()); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].uid, chat.manifest.metadata.uid);
  assert.deepEqual(readControllerJournal(f.project.common).bindings, []);
});

for (const abandoned of [false, true]) test(`an ${abandoned ? 'abandoned' : 'undispatched'} work item does not fence a missing chat slot`, async t => {
  const f = fixture(t), m = example('engineer-worker'); m.spec.workspaceRef = 'home';
  f.inspection.entries.push(validateManifest(m, { project: f.project, config: ROUTE_PRESET }));
  f.facts.record.items.push({ id: 'ENG-232', role: 'engineer', runs: abandoned ? ['R-1'] : [] });
  if (abandoned) f.facts.record.runs.push({ id: 'R-1', item: 'ENG-232', started: { seq: 1 }, abandoned: { seq: 2 } });
  const p = await f.preview();
  assert.equal(p.decisions[0].decision, 'WouldStart'); assert.equal(p.action.uid, f.inspection.entries[0].manifest.metadata.uid);
  assert.equal(p.decisions[1].decision, 'Observe'); assert.match(p.decisions[1].reason, /no active recorded dispatch/);
  await f.run(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].uid, p.action.uid);
});

test('a work-item ownership mismatch still fences a missing chat slot', async t => {
  const f = fixture(t), chat = f.inspection.entries[0], { a, addRun } = withWorker(f); addRun('R-1', 1);
  f.inspection.entries.unshift(chat); a.terminal_id = 'unexpected-occupant';
  const p = await f.preview();
  assert.equal(p.decisions[1].decision, 'Hold'); assert.equal(p.decisions[0].decision, 'Hold'); assert.equal(p.action, null);
  await f.run(); assert.equal(f.calls.length, 0);
});

test('report, repeated failed/delayed review, dispatch reuse, new report, then park in same native session', async t => {
  const f = fixture(t), { a, addRun } = withWorker(f);
  addRun('R-1', 1);
  let p = await f.run(); assert.equal(decision(p).phase, 'ParkedAwaitingReview'); assert.equal(decision(p).decision, 'KEEP');
  assert.deepEqual(decision(p).observed.chain.openItems, ['ENG-232', 'REV-1']);
  for (const outcome of ['failed', 'needs_human', 'done']) {
    f.facts.record.runs.push({ id: `review-${outcome}`, item: 'REV-1', started: { seq: 3 }, report: { seq: 4, outcome } });
    p = await f.run(); assert.equal(decision(p).phase, 'ParkedAwaitingReview');
  }
  const next = addRun('R-2', 10, 'R-1', false); a.agent_status = 'working';
  p = await f.run(); assert.equal(decision(p).phase, 'Running'); assert.equal(decision(p).observed.reuse, 'R-1');
  f.inspection.entries[0].manifest.metadata.generation = 2;
  f.inspection.entries[0].resolvedSpec.personality.instructions = 'new desired personality';
  next.report = { seq: 11, outcome: 'done' }; a.agent_status = 'idle';
  p = await f.run(); assert.equal(decision(p).phase, 'ParkedAwaitingReview'); assert.equal(decision(p).pendingGeneration, 2);
  assert.equal(decision(p).observed.binding.nativeSessionId, 'warm-native'); assert.equal(decision(p).observed.binding.terminalId, 'term-worker');
  assert.equal(f.calls.length, 0);
});

test('report file parks before ingestion; malformed report retains; reuse replacing terminal or report holds', async t => {
  const f = fixture(t), { a, addRun } = withWorker(f); addRun('R-1', 1, null, false);
  f.facts.reports['R-1'] = { present: true, valid: false };
  assert.equal(decision(await f.run()).phase, 'ParkedAwaitingReview');
  f.facts.record.runs[0].report = { seq: 2, outcome: 'done' };
  const next = addRun('R-2', 4, 'R-1'); next.report_path = f.facts.record.runs[0].report_path;
  f.facts.dispatches['R-2'].report = next.report_path;
  assert.equal(decision(await f.run()).decision, 'Hold');
  next.report_path = path.join(f.org, 'R-2.md'); f.facts.dispatches['R-2'].report = next.report_path;
  a.terminal_id = 'replacement'; assert.equal(decision(await f.run()).decision, 'Hold'); assert.equal(f.calls.length, 0);
});

for (const change of ['tab', 'checkout']) test(`work-item ${change} topology disagreement holds`, async t => {
  const f = fixture(t), { a, addRun } = withWorker(f); addRun('R-1', 1);
  if (change === 'tab') a.tab_id = 'w:t-chat'; else f.observation.workspaces[0].worktree.checkout_path = f.scratch;
  assert.equal(decision(await f.run()).decision, 'Hold'); assert.equal(f.calls.length, 0);
});

test('an edited generation without a prior manifest receipt stays pending and cannot claim the live spec', async t => {
  const f = fixture(t), { addRun } = withWorker(f); addRun('R-1', 1);
  f.inspection.entries[0].manifest.metadata.generation = 2;
  const p = await f.run(); assert.equal(decision(p).pendingGeneration, 2);
  assert.equal(decision(p).observed.generation, null); assert.equal(decision(p).freeze, null);
  assert.equal(fs.existsSync(runtimePaths(f.project.common).journal), false); assert.equal(f.calls.length, 0);
});

test('invalid manifests, unreadable canonical history and incomplete observations never start', async t => {
  const f = fixture(t); f.inspection.valid = false;
  assert.equal(decision(await f.run()).decision, 'Hold');
  f.inspection.valid = true; f.observation.complete = false;
  assert.equal(decision(await f.run()).decision, 'Hold');
  f.observation.complete = true; fs.writeFileSync(path.join(f.project.common, 'sessions/standard-slots.json'), '{');
  assert.equal(decision(await f.run()).decision, 'Hold'); assert.equal(f.calls.length, 0);
});

test('KEEP-only retirement protection survives status deletion, idle state and missing panes', async t => {
  const f = fixture(t); await f.run();
  const snapshot = { ...f.observation, common: f.project.common, record: f.facts.record, standardSlots: readStandardSlots(f.project.common), git: [], references: [] };
  assert.match(planRetirement(snapshot).keep[0].why, /adopted standard slot/);
  snapshot.panes = []; snapshot.agents = [];
  assert.match(planRetirement(snapshot).keep[0].why, /adopted standard slot/);
  assert.equal(planRetirement(snapshot).close.length, 0);
});

function digestTree(directory) {
  const entries = [];
  function walk(dir) { for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    if (stat.isDirectory()) { entries.push([file, 'directory']); walk(file); }
    else if (stat.isFile()) entries.push([file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
    else if (!stat.isSocket()) entries.push([file, 'other']);
  } }
  walk(directory); return entries;
}
async function child(args, env) {
  const p = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; p.stdout.on('data', b => { stdout += b; }); p.stderr.on('data', b => { stderr += b; });
  const code = await new Promise((resolve, reject) => { p.once('exit', resolve); p.once('error', reject); });
  return { code, stdout, stderr };
}

test('read-only live adapter uses only snapshot and exact agent.get; mismatch and incomplete schema hold', async t => {
  const f = fixture(t);
  // Supply native wire records independently of controller operation evidence.
  const a = { name: 'fixture', pane_id: 'w:p-chat', tab_id: 'w:t-chat', workspace_id: 'w', cwd: f.cwd,
    terminal_id: 'term-chat', agent_session: { value: 'fixture-native' }, agent_status: 'idle' };
  const snapshot = { ...f.observation, agents: [a, { ...a, name: null, pane_id: 'unnamed' }] }, calls = [];
  const client = { snapshot: async () => { calls.push('session.snapshot'); return snapshot; },
    request: async (method, params) => { calls.push([method, params]); return { agent: { ...a } }; }, close() {} };
  const observer = createHerdrObserver({ socketPath: f.env.HERDR_SOCKET_PATH, client });
  assert.equal((await observer.observe()).complete, true);
  assert.deepEqual(calls, ['session.snapshot', ['agent.get', { target: 'fixture' }]]);
  client.request = async () => ({ agent: { ...a, terminal_id: 'changed' } });
  assert.equal((await observer.observe()).complete, false);
  delete snapshot.tabs; assert.match((await observer.observe()).errors[0], /incomplete Herdr snapshot/);
});

test('plan default observer honours supplied fixture env; API and CLI leave files unchanged and reject --apply', async t => {
  const f = fixture(t), rpc = [], sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let pending = '';
    socket.on('data', bytes => { pending += bytes; for (;;) {
      const end = pending.indexOf('\n'); if (end < 0) break;
      const request = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1); rpc.push(request.method);
      assert.equal(request.method, 'session.snapshot', 'only snapshot needed with no native agents');
      socket.write(JSON.stringify({ id: request.id, result: { type: 'session_snapshot', snapshot: f.observation } }) + '\n');
    } });
  });
  await new Promise(resolve => server.listen(f.env.HERDR_SOCKET_PATH, resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const connect = net.createConnection, contacted = [];
  assert.notEqual(f.env.HERDR_SOCKET_PATH, process.env.HERDR_SOCKET_PATH);
  t.mock.method(net, 'createConnection', (socketPath, ...args) => {
    contacted.push(socketPath);
    assert.equal(socketPath, f.env.HERDR_SOCKET_PATH, 'never contact ambient or live socket');
    return connect.call(net, socketPath, ...args);
  });
  const before = digestTree(f.scratch);
  const api = await plan({ cwd: f.cwd, env: f.env });
  assert.equal(api.valid, true); // Default UIDs have no matching incarnation; no enrollment guessing.
  assert.deepEqual(api.errors, []); assert.deepEqual(contacted, [f.env.HERDR_SOCKET_PATH]);
  const result = await child([path.join(root, 'sessions/sessions.mjs'), 'plan', '--project', f.cwd], f.env);
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).apiVersion, 'session-plan/v1');
  assert.ok(rpc.length >= 2); assert.deepEqual(digestTree(f.scratch), before);
  const rejected = await child([path.join(root, 'sessions/sessions.mjs'), 'plan', '--apply', '--project', f.cwd], f.env);
  assert.equal(rejected.code, 1); assert.match(rejected.stderr, /Unknown option/);
  assert.deepEqual(digestTree(f.scratch), before);
  // Explicit file preview reuses the inspector rather than a second parser.
  const file = path.join(f.scratch, 'chat.md'); fs.writeFileSync(file, document(example('chat')));
  assert.equal(inspect({ cwd: f.cwd, files: [file], env: f.env }).valid, true);
});

test('fact readers observe canonical STOP/close hold, dispatch/watch receipts, malformed reports and torn record', t => {
  const f = fixture(t), { addRun } = withWorker(f), run = addRun('R-1', 2);
  const journal = path.join(f.scratch, 'dispatch.json'); run.meta.dispatch_journal = journal;
  fs.writeFileSync(journal, JSON.stringify(f.facts.dispatches['R-1']));
  fs.writeFileSync(run.report_path, 'malformed report');
  fs.writeFileSync(path.join(f.org, 'events.jsonl'), [
    { type: 'item.added', id: 'ENG-232', kind: 'work', role: 'engineer', seq: 1 },
    { type: 'run.started', id: 'R-1', item: 'ENG-232', workspace: f.cwd, report_path: run.report_path, meta: run.meta, seq: 2 },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.symlinkSync('missing-target', path.join(f.org, 'STOP'));
  fs.mkdirSync(path.join(f.cwd, '.lane/supervisor'), { recursive: true });
  fs.symlinkSync('missing-target', path.join(f.cwd, '.lane/supervisor/HOLD-WORKER-TAB-CLOSE'));
  const facts = readSessionFacts({ project: f.project, env: f.env });
  assert.equal(facts.stopped, true); assert.match(facts.closeHold, /retirement held/);
  assert.equal(facts.reports['R-1'].present, true); assert.equal(facts.reports['R-1'].valid, false);
  assert.equal(facts.dispatches['R-1'].worker.terminalId, 'term-worker');
  fs.appendFileSync(path.join(f.org, 'events.jsonl'), '{');
  assert.ok(readSessionFacts({ project: f.project, env: f.env }).errors.includes('incomplete record tail'));
});

test('fact reader accepts full promotion history over 1 MiB with unchanged references and strict queue checks', t => {
  const f = fixture(t, []), file = path.join(f.project.common, 'promote/queue.json');
  fs.mkdirSync(path.dirname(file));
  const pending = { id: 'open-job', item: 'ENG-232', run: 'R-1', cwd: f.cwd };
  const history = Array.from({ length: 8192 }, (_, index) => ({
    id: `promoted-${index}`, item: `ENG-${index + 1}`, run: `R-${index + 1}`, cwd: f.cwd,
    outcome: 'promoted', finished: '2026-10-21T22:00:00Z', tip: 'a'.repeat(40),
  }));
  const queue = { identity: f.project.common, pending: [pending], current: null, results: history.slice(0, 1) };
  const smallBytes = JSON.stringify(queue);
  assert.ok(Buffer.byteLength(smallBytes) < 1024 * 1024);
  fs.writeFileSync(file, smallBytes);
  const small = readSessionFacts({ project: f.project, env: f.env });
  assert.deepEqual(small.errors, []);
  assert.deepEqual(small.references, [{ kind: 'promotion', job: pending.id, item: pending.item, run: pending.run, cwd: pending.cwd }]);

  queue.results = history;
  const bytes = JSON.stringify(queue);
  assert.ok(Buffer.byteLength(bytes) > 1024 * 1024);
  fs.writeFileSync(file, bytes);
  const large = readSessionFacts({ project: f.project, env: f.env });
  assert.deepEqual(large.errors, []);
  assert.deepEqual(large.references, small.references);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'observation preserves the entire on-disk history');

  for (const fields of [{ identity: f.scratch }, { pending: {} }, { results: {} }]) {
    fs.writeFileSync(file, JSON.stringify({ ...queue, ...fields }));
    const facts = readSessionFacts({ project: f.project, env: f.env });
    assert.deepEqual(facts.errors, ['promotion queue: invalid canonical promotion queue']);
    assert.deepEqual(facts.references, []);
  }
  const duplicate = bytes.replace('"outcome":"promoted"', '"outcome":"promoted","\\u006futcome":"promoted"');
  assert.notEqual(duplicate, bytes);
  fs.writeFileSync(file, duplicate);
  const facts = readSessionFacts({ project: f.project, env: f.env });
  assert.match(facts.errors.join('\n'), /promotion queue: duplicate JSON key "outcome"/);
  assert.deepEqual(facts.references, []);
});

test('session manifests, receipts and journals retain their 1 MiB byte limit', t => {
  const f = fixture(t), limit = 1024 * 1024;
  const padded = bytes => bytes + ' '.repeat(limit - Buffer.byteLength(bytes));
  const manifest = example('chat'), markdown = padded(document(manifest));
  assert.deepEqual(parseManifest(markdown), manifest);
  assert.throws(() => parseManifest(markdown + ' '), /manifest exceeds 1 MiB/);

  const receiptFile = path.join(f.project.common, 'sessions/standard-slots.json');
  const receipt = padded(fs.readFileSync(receiptFile, 'utf8'));
  fs.writeFileSync(receiptFile, receipt);
  assert.deepEqual(readStandardSlots(f.project.common).errors, []);
  fs.writeFileSync(receiptFile, receipt + ' ');
  assert.match(readStandardSlots(f.project.common).errors.join('\n'), /JSON exceeds 1 MiB/);

  const journal = readControllerJournal(f.project.common), journalFile = runtimePaths(f.project.common).journal;
  const journalBytes = padded(JSON.stringify(journal));
  fs.writeFileSync(journalFile, journalBytes);
  assert.deepEqual(readControllerJournal(f.project.common), journal);
  fs.writeFileSync(journalFile, journalBytes + ' ');
  assert.throws(() => readControllerJournal(f.project.common), /JSON exceeds 1 MiB/);
});
