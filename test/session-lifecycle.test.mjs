import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseManifest, validateManifest } from '../sessions/manifest.mjs';
import { canonicalProject } from '../sessions/project.mjs';
import { readStandardSlots, recordStandardSlot } from '../sessions/receipts.mjs';
import { emptyJournal, durableWrite, runtimePaths, readControllerJournal } from '../sessions/runtime.mjs';
import { specDigest, digest, persistHandoff, verifyHandoff } from '../sessions/lifecycle-evidence.mjs';
import { planSessions, reconcileOffline } from '../sessions/reconcile.mjs';
import { plan } from '../sessions/plan.mjs';
import { planRetirement } from '../lib/retire.mjs';
import { ROUTE_PRESET } from '../lanes/preset.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function fixture(t, role = 'chat') {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'))), cwd = path.join(scratch, 'repo');
  fs.mkdirSync(cwd); t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(cwd, '.lane.json'), '{}'); git('add', '.'); git('commit', '-qm', 'fixture');
  const project = canonicalProject(cwd), names = role === 'logs' ? ['logs-triage', 'logs-viewer'] : [role];
  const entries = names.map(name => {
    const m = parseManifest(fs.readFileSync(path.join(root, `test/fixtures/sessions/${name}.md`), 'utf8'));
    m.spec.workspaceRef = 'home';
    return validateManifest(m, { project, config: ROUTE_PRESET });
  });
  const inspection = { project, entries, valid: true, diagnostics: [] }, journal = emptyJournal(project.common);
  const observation = { server: path.join(scratch, 'fixture.sock'), complete: true,
    workspaces: [{ workspace_id: 'w', worktree: { repo_key: project.common, checkout_path: cwd } }],
    tabs: [{ tab_id: 'tab-old', workspace_id: 'w' }], panes: [], agents: [], viewers: [], receipts: [], losses: [], errors: [] };
  const facts = { record: { items: [{ id: 'ENG-232', role: 'engineer' }], runs: [], links: [], revision: 7 },
    dispatches: {}, reports: {}, references: [], errors: [], stopped: false, closeHold: null, resetRequests: {}, quiescence: {}, recovery: {} };
  for (const entry of entries) {
    const uid = entry.manifest.metadata.uid, s = entry.manifest.spec;
    const binding = { server: observation.server, workspace: 'w', tab: 'tab-old', pane: `pane-${s.paneSlot ?? 'primary'}`,
      terminalId: `term-${uid}`, checkout: cwd, ...(entry.manifest.kind === 'Session' ? { agentName: `agent-${uid}`, nativeSessionId: `native-${uid}` } : {}) };
    observation.panes.push({ pane_id: binding.pane, tab_id: binding.tab, workspace_id: 'w', terminal_id: binding.terminalId });
    if (entry.manifest.kind === 'Session') observation.agents.push({ name: binding.agentName, pane_id: binding.pane, tab_id: binding.tab,
      workspace_id: 'w', terminal_id: binding.terminalId, cwd, agent_session: { value: binding.nativeSessionId }, agent_status: 'idle' });
    else observation.viewers.push({ binding });
    const target = Object.fromEntries(['server', 'workspace', 'tab', 'pane', 'checkout'].map(k => [k, binding[k]]));
    if (s.intent.kind === 'work-item') {
      const r = s.resolvedRoute ?? entry.resolvedSpec.resolvedRoute;
      const run = { id: 'R-old', item: 'ENG-232', workspace: cwd, report_path: path.join(scratch, 'report.md'), started: { seq: 1 },
        meta: { agent: binding.agentName, pane: binding.pane, terminal_id: binding.terminalId, worker_workspace: 'w',
          agent_session_id: binding.nativeSessionId, route: r.route, harness: r.kind, model: r.model, effort: r.effort }, report: { seq: 3, outcome: 'done' } };
      facts.record.runs.push(run); facts.record.items.push({ id: 'REV-open', role: 'reviewer', parent: 'ENG-232' });
      facts.dispatches[run.id] = { run: run.id, item: run.item, common: project.common, workspace: cwd, report: run.report_path, stage: 'complete',
        route: r.route, declared: { harness: r.kind, model: r.model, effort: r.effort },
        worker: { agentName: binding.agentName, pane: binding.pane, workspaceId: 'w', terminalId: binding.terminalId, agentSessionId: binding.nativeSessionId } };
      journal.bindings.push({ uid, generation: 1, specDigest: specDigest(entry), binding, run: run.id });
    } else {
      const id = `start-${uid}`, receipt = { operationId: id, uid, generation: 1, specDigest: specDigest(entry), binding };
      journal.operations.push({ id, uid, kind: 'start-standard-slot', generation: 1, specDigest: specDigest(entry), spec: entry.resolvedSpec,
        target, state: 'acknowledged', receipt }); observation.receipts.push(receipt);
    }
  }
  recordStandardSlot({ cwd, action: 'adopt', uid: 'original-slot', actor: 'fixture', why: 'offline ownership', slot: {
    server: observation.server, workspace: 'w', checkout: cwd, tab: role === 'engineer-worker' ? 'protected-other-tab' : 'tab-old',
    standardSlot: role === 'logs' ? 'logs' : role === 'supervisor' ? 'supervisor' : 'chat', panes: role === 'engineer-worker'
      ? [{ pane: 'other-pane', paneSlot: 'primary' }]
      : entries.map((e, i) => ({ pane: observation.panes[i].pane_id, paneSlot: e.manifest.spec.paneSlot ?? 'primary' })) } });
  durableWrite(runtimePaths(project.common).journal, journal);
  const f = { scratch, cwd, project, inspection, observation, facts, calls: [], uid: entries[0].manifest.metadata.uid };
  f.journal = () => readControllerJournal(project.common);
  f.read = async () => ({ enrollment: readStandardSlots(project.common), observation: structuredClone(observation), facts: structuredClone(facts) });
  f.preview = async () => planSessions({ inspection, ...await f.read(), journal: f.journal() });
  f.binding = uid => f.journal().incarnations.filter(i => i.uid === uid).at(-1)?.binding ??
    f.journal().bindings.find(b => b.uid === uid)?.binding ?? f.journal().operations.find(op => op.uid === uid).receipt.binding;
  f.boundary = (pending = ['M-1']) => {
    const h = persistHandoff({ file: path.join(scratch, 'handoff.md'), markdown: '# Handoff\nDurable context.\n',
      recordRefs: ['ENG-232'], unresolvedMessageIds: ['M-1', 'Q-parked'], inboxCursor: 'inbox:12' });
    const boundary = role === 'logs' ? { kind: 'committed-batch', ref: 'boundary-1', committed: true, batchRef: 'batch-7', cursor: h.inboxCursor, viewerCursor: 'viewer:34' }
      : { kind: 'handoff', ref: 'boundary-1', declared: true, draft: 'complete' };
    for (const e of entries) {
      const uid = e.manifest.metadata.uid;
      facts.quiescence[uid] = { ref: `quiescence-${uid}`, binding: structuredClone(f.binding(uid)), recordSeq: facts.record.revision,
        callbacksQuiesced: true, openWork: [], openReviews: [], inFlightDeliveries: [], pendingInboxIds: pending,
        recordRefs: h.recordRefs, unresolvedMessageIds: h.unresolvedMessageIds, inboxCursor: h.inboxCursor };
    }
    return facts.resetRequests[f.uid] = { boundary, handoff: h };
  };
  f.loss = (state = 'confirmed-exit') => {
    const binding = f.binding(f.uid);
    observation.agents = observation.agents.filter(a => a.name !== binding.agentName);
    observation.viewers = observation.viewers.filter(v => v.binding.pane !== binding.pane);
    observation.panes.find(p => p.pane_id === binding.pane).emptyConfirmed = true;
    const loss = { binding, state, ref: 'native-exit-1', processConfirmedGone: true,
      restore: { state: 'none' }, failures: 0, backoffReady: true };
    observation.losses.push(loss);
    facts.recovery[f.uid] = { mode: 'resume', contextRef: 'native-context-receipt', contextVerified: true,
      contextHash: digest('native-context'), nativeSessionId: binding.nativeSessionId, route: entries[0].resolvedSpec.resolvedRoute };
    return loss;
  };
  f.close = op => {
    assert.equal(f.journal().operations.find(o => o.id === op.id).state, 'close-intent');
    assert.deepEqual(op.target.tab, 'tab-old');
    assert.equal(observation.panes.filter(p => p.tab_id === op.target.tab).length, op.participants.length);
    observation.tabs = observation.tabs.filter(t => t.tab_id !== op.target.tab);
    observation.panes = observation.panes.filter(p => p.tab_id !== op.target.tab);
    observation.agents = observation.agents.filter(a => a.tab_id !== op.target.tab);
    observation.viewers = observation.viewers.filter(v => v.binding.tab !== op.target.tab);
    observation.receipts.push({ operationId: op.id, kind: 'close', uid: op.uid, target: op.target, bindings: op.participants.map(p => p.binding) });
  };
  f.materialize = (op, kind) => {
    const fresh = kind === 'respawn';
    if (fresh) {
      assert.equal(observation.tabs.some(t => t.tab_id === op.target.tab), false, 'observe old tab absence before spawn');
      assert.equal(f.journal().operations.find(o => o.id === op.id).closeReceipt.kind, 'close');
      assert.equal(verifyHandoff(op.request.handoff).digest, op.contextHash);
      observation.tabs.push({ tab_id: 'tab-new', workspace_id: 'w' });
    }
    const incarnations = op.participants.map(p => {
      const binding = { ...p.binding, tab: fresh ? 'tab-new' : p.binding.tab, pane: fresh ? `${p.binding.pane}-new` : p.binding.pane,
        terminalId: `${p.binding.terminalId}-new`, ...(p.kind === 'Session' ? { agentName: `${p.binding.agentName}-new`,
          nativeSessionId: fresh ? `${p.binding.nativeSessionId}-new` : p.binding.nativeSessionId } : {}) };
      const pane = { pane_id: binding.pane, tab_id: binding.tab, workspace_id: 'w', terminal_id: binding.terminalId };
      observation.panes = observation.panes.filter(x => x.pane_id !== pane.pane_id); observation.panes.push(pane);
      if (p.kind === 'Session') observation.agents.push({ name: binding.agentName, ...pane, cwd, agent_session: { value: binding.nativeSessionId }, agent_status: 'idle' });
      else observation.viewers.push({ binding });
      return { id: `incarnation-${op.id}-${p.uid}`, uid: p.uid, generation: p.generation, specDigest: p.specDigest,
        previous: p.incarnation, binding, contextHash: op.contextHash, contextVerified: true, route: p.spec.resolvedRoute };
    });
    observation.receipts.push({ operationId: op.id, kind, uid: op.uid, contextHash: op.contextHash, incarnations });
  };
  f.actions = { offline: true, start() { assert.fail('no initial start in lifecycle fixture'); },
    async close(op) { f.calls.push('close'); f.close(op); },
    async respawn(op) { f.calls.push('respawn'); assert.equal(f.journal().operations.at(-1).state, 'respawn-intent'); f.materialize(op, 'respawn'); },
    async resume(op) { f.calls.push('resume'); assert.equal(f.journal().operations.at(-1).state, 'resume-intent'); f.materialize(op, 'resume'); },
    async transfer(op) {
      f.calls.push('transfer'); const j = f.journal(); assert.equal(j.operations.at(-1).state, 'inbox-intent');
      const bound = j.incarnations.filter(i => i.operationId === op.id);
      assert.equal(bound.length, op.participants.length, 'new bindings durable before inbox handover');
      observation.receipts.push({ operationId: op.id, kind: 'inbox', uid: op.uid, messageIds: op.request.pendingInboxIds,
        cursor: op.request.handoff.inboxCursor, incarnationIds: bound.map(i => i.id) });
    } };
  f.run = () => reconcileOffline({ inspection, read: () => f.read(), actions: f.actions });
  return f;
}
const first = plan => plan.decisions?.[0] ?? plan;

test('exact owned-tab close, observed absence, same manifest/handoff respawn, durable new binding, then inbox transfer', async t => {
  const f = fixture(t); f.boundary(); const original = structuredClone(f.journal().operations[0]);
  assert.equal(first(await f.preview()).reset.eligible, true);
  await f.run(); assert.deepEqual(f.calls, ['close']); assert.equal(f.journal().operations.at(-1).state, 'closed-for-reset');
  await f.run(); assert.deepEqual(f.calls, ['close', 'respawn']); assert.equal(f.journal().operations.at(-1).state, 'restarted');
  await f.run(); assert.deepEqual(f.calls, ['close', 'respawn', 'transfer']); assert.equal(f.journal().operations.at(-1).state, 'acknowledged');
  assert.deepEqual(f.journal().operations[0], original, 'earlier binding never rewritten');
  assert.equal(f.journal().incarnations[0].contextLoss, true);
  assert.equal(first(await f.run()).decision, 'KEEP'); assert.equal(f.calls.length, 3);
  const slots = readStandardSlots(f.project.common); assert.deepEqual(slots.errors, []);
  assert.deepEqual(slots.slots.map(s => s.tab), ['tab-old', 'tab-new'], 'only adds KEEP');
  const kept = planRetirement({ ...f.observation, common: f.project.common, record: f.facts.record, standardSlots: slots, git: [], references: [] });
  assert.equal(kept.close.length, 0);
});

for (const role of ['chat', 'supervisor']) test(`${role} requires a declared boundary; supervisor draft needs completion/fallback`, async t => {
  const f = fixture(t, role); const r = f.boundary(); r.boundary.declared = false;
  assert.match(first(await f.run()).reason, /declared/); assert.deepEqual(f.calls, []);
  r.boundary.declared = true;
  if (role === 'supervisor') { r.boundary.draft = 'pending'; assert.match(first(await f.run()).reason, /draft/); r.boundary.draft = 'fallback'; }
  await f.run(); assert.deepEqual(f.calls, ['close']);
});

for (const change of ['extra-pane', 'other-owner', 'busy', 'callbacks', 'open-work', 'open-review', 'delivery', 'reference', 'cursor', 'unresolved', 'record-ref', 'hash', 'metadata-hash', 'generation'])
  test(`reset holds on ${change}`, async t => {
    const f = fixture(t), r = f.boundary(), q = f.facts.quiescence[f.uid];
    if (change === 'extra-pane') f.observation.panes.push({ pane_id: 'unrelated', tab_id: 'tab-old', workspace_id: 'w' });
    if (change === 'other-owner') f.observation.agents[0].name = 'foreign-owner';
    if (change === 'busy') f.observation.agents[0].agent_status = 'working';
    if (change === 'callbacks') q.callbacksQuiesced = false;
    if (change === 'open-work') q.openWork.push('ENG-open');
    if (change === 'open-review') q.openReviews.push('REV-open');
    if (change === 'delivery') q.inFlightDeliveries.push('M-flight');
    if (change === 'reference') f.facts.references.push({ uid: f.uid, kind: 'callback' });
    if (change === 'cursor') q.inboxCursor = 'inbox:13';
    if (change === 'unresolved') q.unresolvedMessageIds = ['missing'];
    if (change === 'record-ref') q.recordRefs = [];
    if (change === 'hash') fs.appendFileSync(r.handoff.file, 'changed');
    if (change === 'metadata-hash') r.handoff.unresolvedMessageIds = [];
    if (change === 'generation') f.inspection.entries[0].manifest.metadata.generation++;
    assert.equal(first(await f.run()).decision, 'Hold'); assert.deepEqual(f.calls, []);
    assert.equal(f.journal().operations.length, 1, 'no reset intent before eligibility');
  });

for (const status of ['idle', 'working']) test(`an open worker review chain unconditionally vetoes reset while ${status}`, async t => {
  const f = fixture(t, 'engineer-worker'); f.boundary(); f.observation.agents[0].agent_status = status;
  const d = first(await f.run()); assert.equal(d.decision, 'Hold'); assert.match(d.reason, /open review/); assert.deepEqual(f.calls, []);
});

test('quiescence claims cannot override recorded work/review dependencies on a standard incarnation', async t => {
  const f = fixture(t); f.boundary(); const b = f.binding(f.uid);
  f.facts.record.runs.push({ id: 'R-dependent', item: 'ENG-232', started: { seq: 1 }, report: { seq: 2, outcome: 'done' },
    meta: { pane: b.pane, terminal_id: b.terminalId, agent_session_id: b.nativeSessionId } });
  assert.match(first(await f.run()).reason, /recorded open work\/review/); assert.deepEqual(f.calls, []);
});

for (const stage of ['close', 'respawn', 'resume', 'transfer']) test(`${stage} crash/lost acknowledgement holds without a second invocation`, async t => {
  const f = fixture(t); if (stage === 'resume') f.loss(); else f.boundary();
  if (['respawn', 'transfer'].includes(stage)) await f.run();
  if (stage === 'transfer') await f.run();
  f.actions[stage] = async () => { f.calls.push(stage); throw Error('crash before receipt'); };
  assert.equal(first(await f.run()).decision, 'Hold');
  const before = [...f.calls]; await f.run(); await f.run(); assert.deepEqual(f.calls, before);
  assert.equal(f.journal().operations.at(-1).state, stage === 'transfer' ? 'inbox-intent' : `${stage}-intent`);
});

test('absence without a close receipt, and a returned create acknowledgement without observed binding, both hold', async t => {
  const f = fixture(t); f.boundary(); f.actions.close = async op => { f.calls.push('close'); f.close(op); f.observation.receipts.pop(); return { ok: true }; };
  assert.match(first(await f.run()).reason, /close acknowledgement/); await f.run(); assert.deepEqual(f.calls, ['close']);
  const g = fixture(t); g.boundary(); await g.run();
  g.actions.respawn = async () => { g.calls.push('respawn'); return { ok: true }; };
  assert.match(first(await g.run()).reason, /acknowledgement uncertain/); await g.run(); assert.deepEqual(g.calls, ['close', 'respawn']);
});

for (const change of ['wrong-context', 'wrong-route', 'old-terminal', 'old-native', 'wrong-previous', 'missing-pane', 'duplicate-receipt', 'old-tab-returned'])
  test(`replacement ${change} cannot bind or hand over inbox`, async t => {
    const f = fixture(t); f.boundary(); await f.run(); const materialize = f.materialize;
    f.materialize = (op, kind) => {
      materialize(op, kind); const r = f.observation.receipts.at(-1), i = r.incarnations[0];
      if (change === 'wrong-context') i.contextHash = digest('different');
      if (change === 'wrong-route') i.route.model = 'different';
      if (change === 'old-terminal') i.binding.terminalId = op.participants[0].binding.terminalId;
      if (change === 'old-native') i.binding.nativeSessionId = op.participants[0].binding.nativeSessionId;
      if (change === 'wrong-previous') i.previous = 'foreign-incarnation';
      if (change === 'missing-pane') f.observation.panes = [];
      if (change === 'duplicate-receipt') f.observation.receipts.push(structuredClone(r));
      if (change === 'old-tab-returned') f.observation.tabs.push({ tab_id: op.target.tab, workspace_id: 'w' });
    };
    assert.equal(first(await f.run()).decision, 'Hold'); await f.run();
    assert.deepEqual(f.calls, ['close', 'respawn']); assert.equal(f.journal().incarnations.length, 0);
  });

for (const stage of ['respawn', 'transfer']) for (const brake of ['stopped', 'closeHold']) test(`${brake} also blocks ${stage} after close/bind`, async t => {
  const f = fixture(t); f.boundary(); await f.run(); if (stage === 'transfer') await f.run();
  const calls = [...f.calls]; f.facts[brake] = true; assert.equal(first(await f.run()).decision, 'Observe'); assert.deepEqual(f.calls, calls);
  f.facts[brake] = false; await f.run(); assert.equal(f.calls.at(-1), stage);
});

test('an unrelated pane in the logs tab vetoes the entire two-pane rotation', async t => {
  const f = fixture(t, 'logs'); f.boundary();
  f.observation.panes.push({ pane_id: 'foreign', tab_id: 'tab-old', workspace_id: 'w' });
  assert.match(first(await f.run()).reason, /multi-owner|unrelated/); assert.deepEqual(f.calls, []);
});

test('lost replies with independent exact receipt evidence settle without retry', async t => {
  const f = fixture(t); f.boundary();
  for (const method of ['close', 'respawn', 'transfer']) {
    const delegate = f.actions[method]; f.actions[method] = async op => { await delegate(op); throw Error('reply lost after durable receipt'); };
  }
  await f.run(); await f.run(); await f.run(); await f.run();
  assert.deepEqual(f.calls, ['close', 'respawn', 'transfer']); assert.equal(f.journal().operations.at(-1).state, 'acknowledged');
});

for (const brake of ['stopped', 'closeHold']) test(`${brake} blocks every lifecycle phase, including after fsynced intent`, async t => {
  const f = fixture(t); f.boundary(); f.facts[brake] = true;
  assert.equal(first(await f.run()).decision, 'Observe'); assert.deepEqual(f.calls, []);
  f.facts[brake] = false; const read = f.read; let reads = 0;
  f.read = async () => { if (++reads === 3) f.facts[brake] = true; return read(); };
  await f.run(); assert.deepEqual(f.calls, []);
  assert.equal(f.journal().operations.at(-1).state, 'withheld');
  f.facts[brake] = false; f.read = read;
  assert.match(first(await f.run()).reason, /withheld/); assert.deepEqual(f.calls, []);
});

test('triage committed batch plus service/viewer cursors rotates both panes; pending batch or unrelated pane holds', async t => {
  const f = fixture(t, 'logs'), r = f.boundary(); r.boundary.committed = false;
  assert.match(first(await f.run()).reason, /committed/); r.boundary.committed = true;
  delete r.boundary.viewerCursor; assert.match(first(await f.run()).reason, /viewer cursor/); r.boundary.viewerCursor = 'viewer:34';
  await f.run(); await f.run(); await f.run();
  assert.deepEqual(f.calls, ['close', 'respawn', 'transfer']); assert.equal(f.journal().incarnations.length, 2);
  assert.deepEqual(f.journal().operations.at(-1).participants.map(p => p.spec.role), ['logs-triage', 'logs']);
  assert.equal(f.observation.viewers.length, 1); assert.equal(f.observation.agents.length, 1);
  assert.equal(first(await f.run()).decision, 'KEEP');
});

for (const change of ['disconnect', 'unknown', 'restore-pending', 'restore-unknown', 'missing-native', 'context', 'route', 'backoff', 'failures', 'refused'])
  test(`recovery holds on ${change}`, async t => {
    const f = fixture(t), loss = f.loss(), r = f.facts.recovery[f.uid];
    if (change === 'disconnect') loss.state = 'disconnected';
    if (change === 'unknown') loss.state = 'unknown';
    if (change === 'restore-pending') loss.restore.state = 'pending';
    if (change === 'restore-unknown') loss.restore.state = 'unknown';
    if (change === 'missing-native') r.nativeSessionId = null;
    if (change === 'context') r.contextVerified = false;
    if (change === 'route') r.route.model = 'different';
    if (change === 'backoff') loss.backoffReady = false;
    if (change === 'failures') loss.failures = 2;
    if (change === 'refused') loss.refused = true;
    assert.equal(first(await f.run()).decision, 'Hold'); assert.deepEqual(f.calls, []);
  });

test('confirmed exit resumes known native session, binds a new incarnation and retains parked review intent and old run', async t => {
  const f = fixture(t, 'engineer-worker'), before = structuredClone(f.facts.record.runs[0]), old = structuredClone(f.journal().bindings[0]);
  f.loss(); const p = await f.run();
  assert.deepEqual(f.calls, ['resume']); assert.equal(f.journal().operations.at(-1).state, 'acknowledged');
  assert.equal(first(p).phase, 'ParkedAwaitingReview');
  assert.equal(f.journal().operations.at(-1).parkedIntent.phase, 'ParkedAwaitingReview');
  assert.equal(f.journal().incarnations[0].contextLoss, false);
  assert.equal(f.journal().incarnations[0].binding.nativeSessionId, old.binding.nativeSessionId);
  assert.notEqual(f.journal().incarnations[0].binding.terminalId, old.binding.terminalId);
  assert.deepEqual(f.facts.record.runs[0], before); assert.deepEqual(f.journal().bindings[0], old);
  assert.equal(first(await f.run()).decision, 'KEEP'); assert.deepEqual(f.calls, ['resume']);
});

test('Herdr native restore owns the spawn; resumed reference is adopted with a new receipt and no controller resume', async t => {
  const f = fixture(t), loss = f.loss();
  const op = { ...first(await f.preview()).action.operation, id: 'native-restore-1' };
  loss.restore = { state: 'pending', operationId: op.id };
  assert.match(first(await f.run()).reason, /no second spawn/); assert.deepEqual(f.calls, []);
  f.materialize(op, 'native-restore'); loss.restore.state = 'resumed';
  await f.run(); assert.deepEqual(f.calls, []); assert.equal(f.journal().incarnations.length, 1);
  assert.equal(f.journal().operations.at(-1).mode, 'native-restore'); assert.equal(first(await f.run()).decision, 'KEEP');
});

test('viewer recovery uses cursor evidence and backoff without a native model session; its sibling stays untouched', async t => {
  const f = fixture(t, 'logs'); f.uid = f.inspection.entries[1].manifest.metadata.uid;
  const sibling = structuredClone(f.observation.agents[0]); const loss = f.loss();
  f.facts.recovery[f.uid].route = undefined;
  loss.backoffReady = false; await f.run(); assert.deepEqual(f.calls, []);
  loss.backoffReady = true; const p = await f.run();
  assert.deepEqual(f.calls, ['resume']); assert.equal(p.decisions[1].decision, 'KEEP');
  assert.deepEqual(f.observation.agents[0], sibling); assert.equal(f.observation.viewers.length, 1);
  assert.equal(f.journal().incarnations[0].binding.nativeSessionId, undefined);
});

test('fresh worker reconstruction requires explicit disposition and is labelled context loss while retaining the review chain', async t => {
  const f = fixture(t, 'engineer-worker'), r = f.boundary(); delete f.facts.resetRequests[f.uid]; f.loss();
  Object.assign(f.facts.recovery[f.uid], r, { mode: 'reconstruct' });
  assert.match(first(await f.run()).reason, /explicit recovery disposition/); assert.deepEqual(f.calls, []);
  f.facts.recovery[f.uid].disposition = { ref: 'recorded-recovery-decision', run: 'R-old', contextLossAccepted: true };
  await f.run(); await f.run(); await f.run();
  assert.deepEqual(f.calls, ['close', 'respawn', 'transfer']);
  assert.equal(f.journal().operations.at(-1).contextLoss, true);
  assert.equal(f.journal().operations.at(-1).parkedIntent.openChain.includes('REV-open'), true);
  assert.equal(first(await f.run()).phase, 'ParkedAwaitingReview');
});

test('a delegate refusal is durable and cannot be resolved by retry or a later receipt', async t => {
  const f = fixture(t); f.loss();
  f.actions.resume = async op => { f.calls.push('resume'); f.materialize(op, 'resume'); throw Object.assign(Error('native denied'), { refused: true }); };
  assert.match(first(await f.run()).reason, /refusal/); await f.run(); assert.deepEqual(f.calls, ['resume']);
  assert.equal(f.journal().operations.at(-1).state, 'failed'); assert.equal(f.journal().incarnations.length, 0);
});

test('a known native reference elsewhere contradicts an empty pane and cannot cause a second spawn', async t => {
  const f = fixture(t); f.loss(); const b = f.binding(f.uid);
  f.observation.agents.push({ name: 'restored-elsewhere', tab_id: 'other', pane_id: 'other', terminal_id: 'other',
    workspace_id: 'w', cwd: f.cwd, agent_session: { value: b.nativeSessionId }, agent_status: 'idle' });
  assert.match(first(await f.run()).reason, /known native reference/); assert.deepEqual(f.calls, []);
});

test('a stage 3 journal without an incarnation array remains readable', t => {
  const f = fixture(t), j = f.journal(); delete j.incarnations;
  durableWrite(runtimePaths(f.project.common).journal, j); assert.deepEqual(f.journal().incarnations, []);
});

test('journal rejects malformed states, transitions, handoff metadata and incarnation linkage', async t => {
  const f = fixture(t); f.boundary(); await f.run(); await f.run(); const original = f.journal();
  for (const mutate of [j => j.operations.at(-1).state = 'magic', j => j.operations.at(-1).history = ['reset-prepared', 'restarted'],
    j => j.operations.at(-1).request.handoff.inboxCursor = 'tampered', j => j.incarnations[0].previous = 'foreign',
    j => j.operations.at(-1).participants[0].spec.route = 'changed', j => j.operations.at(-1).unknown = true,
    j => j.incarnations[0].binding.terminalId = 'tampered', j => j.operations.at(-1).receipt.incarnations[0].contextVerified = false]) {
    const j = structuredClone(original); mutate(j); durableWrite(runtimePaths(f.project.common).journal, j);
    assert.throws(f.journal, /invalid controller journal/);
  }
});

test('plan API shows reset eligibility/vetoes and recovery state without files or adapter mutations', async t => {
  const f = fixture(t); f.boundary();
  const file = path.join(f.scratch, 'chat.md'); fs.writeFileSync(file, `## Manifest\n\`\`\`json\n${JSON.stringify(f.inspection.entries[0].manifest)}\n\`\`\`\n`);
  const before = fs.readFileSync(runtimePaths(f.project.common).journal, 'utf8');
  const env = { ...process.env, LANE_CONFIG: undefined, HERDR_MONITOR_FLEET: path.join(f.scratch, 'fleet') };
  const result = await plan({ cwd: f.cwd, files: [file], env, observer: { observe: async () => structuredClone(f.observation) }, readFacts: () => structuredClone(f.facts) });
  assert.equal(result.valid, true, JSON.stringify(result)); assert.deepEqual(result.errors, [], JSON.stringify(result));
  assert.equal(first(result).reset.eligible, true); assert.equal(first(result).recovery.state, 'none');
  assert.equal(fs.readFileSync(runtimePaths(f.project.common).journal, 'utf8'), before); assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(runtimePaths(f.project.common).status), false);
});
