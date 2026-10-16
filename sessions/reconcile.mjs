// Foreground policy. No scheduling, model, record mutation or live action path.
import { randomUUID } from 'node:crypto';
import { matchingRun } from '../lib/retire.mjs';
import { roleIs } from '../lib/roles.mjs';
import { agentBinding, sameBinding } from './observe.mjs';
import { acquireControllerLease, durableWrite, emptyJournal, readControllerJournal, runtimePaths } from './runtime.mjs';
import { specDigest } from './lifecycle-evidence.mjs';
import { planLifecycle, resetAssessment, lifecycleOperation } from './lifecycle.mjs';
export { specDigest } from './lifecycle-evidence.mjs';

const quiet = a => ['idle', 'done'].includes(a.agent_status ?? a.status);
const row = (entry, phase, decision, reason, extra = {}) => ({ uid: entry.manifest.metadata.uid,
  desired: { generation: entry.manifest.metadata.generation, specDigest: specDigest(entry), spec: entry.resolvedSpec },
  phase, decision, reason, action: null, ...extra });
function duplicates(observation) {
  for (const [rows, keys] of [[observation.workspaces, ['workspace_id']], [observation.tabs, ['tab_id']],
    [observation.panes, ['pane_id']], [observation.agents, ['name', 'pane_id', 'terminal_id']]]) {
    for (const key of keys) {
      const values = rows.map(r => r[key]).filter(Boolean);
      if (new Set(values).size !== values.length) return `duplicate observed ${key}`;
    }
  }
  const ids = observation.agents.map(a => a.agent_session?.value ?? a.agent_session_id).filter(Boolean);
  return new Set(ids).size === ids.length ? null : 'duplicate native session identity';
}
function slotTopology(slot, observation, common) {
  const workspace = observation.workspaces.find(w => w.workspace_id === slot.workspace);
  if (!workspace || workspace.worktree?.repo_key !== common || workspace.worktree?.checkout_path !== slot.checkout) return 'missing or mismatched enrolled workspace identity';
  const tab = observation.tabs.find(t => t.tab_id === slot.tab);
  if (!tab || tab.workspace_id !== slot.workspace) return 'missing or mismatched adopted tab; layout recovery is out of scope';
  const panes = observation.panes.filter(p => p.tab_id === slot.tab);
  if (panes.length !== slot.panes.length || panes.some(p => p.workspace_id !== slot.workspace || !slot.panes.some(s => s.pane === p.pane_id))) return 'adopted layout changed or contains unrelated panes';
  return null;
}
const targetMatches = (b, t) => b && ['server', 'workspace', 'tab', 'pane', 'checkout'].every(k => b[k] === t[k]);
const receiptMatches = (receipt, op) => receipt?.operationId === op.id && receipt.uid === op.uid &&
  receipt.specDigest === op.specDigest && receipt.generation === op.generation && targetMatches(receipt.binding, op.target);
const fence = (plan, reason) => ({ ...plan, action: null, errors: [...plan.errors, reason],
  decisions: plan.decisions.map(d => d.action ? { ...d, phase: 'Hold', decision: 'Hold', action: null, reason } : d) });

// A projection of the existing folded chain, never retirement authorization.
function chainEvidence(facts, run) {
  const { items, runs, links = [] } = facts.record;
  let root = items.find(i => i.id === run.item);
  const seen = new Set();
  while (root?.parent && roleIs(root, 'REV') && !seen.has(root.id)) { seen.add(root.id); root = items.find(i => i.id === root.parent); }
  const ids = new Set([root?.id ?? run.item]);
  for (let size = -1; size !== ids.size;) {
    size = ids.size;
    for (const item of items) if (ids.has(item.parent)) ids.add(item.id);
    for (const link of links) if (ids.has(link.blocked)) ids.add(link.blocker);
    for (const item of items) if (ids.has(item.id)) for (const id of item.blocked_by ?? []) ids.add(id);
  }
  return { root: root?.id ?? null, disposition: root?.closed ?? null,
    openItems: [...ids].filter(id => !items.find(i => i.id === id)?.closed),
    runs: runs.filter(r => ids.has(r.item)).map(r => ({ run: r.id, reportSeq: r.report?.seq ?? null, outcome: r.report?.outcome ?? null })),
    references: (facts.references ?? []).filter(ref => ids.has(ref.item) || ref.run === run.id) };
}

function worker(entry, input, slots) {
  const { observation: o, facts, journal } = input, item = entry.manifest.spec.intent.item;
  const runs = facts.record.runs.filter(r => r.item === item).sort((a, b) => b.started.seq - a.started.seq);
  const latest = runs[0];
  if (!latest || latest.abandoned) return row(entry, 'Undispatched', 'Observe', 'work-item observation only; no active recorded dispatch');
  const candidates = o.agents.filter(a => a.name === latest.meta?.agent || a.pane_id === latest.meta?.pane ||
    (latest.meta?.agent_session_id && (a.agent_session?.value ?? a.agent_session_id) === latest.meta.agent_session_id));
  const a = candidates[0], run = a && matchingRun(a, facts.record.runs);
  if (candidates.length !== 1 || run?.id !== latest.id || !a.terminal_id || !latest.meta?.terminal_id || !latest.meta.agent_session_id) return row(entry, 'Hold', 'Hold', 'unknown, missing or mismatched work-item occupant; never substitute a worker');
  const pane = o.panes.find(p => p.pane_id === a.pane_id), tab = o.tabs.find(t => t.tab_id === pane?.tab_id);
  const binding = agentBinding(a, o.server, pane?.tab_id);
  const recordedBinding = { server: o.server, tab: pane?.tab_id, workspace: run.meta.worker_workspace, pane: run.meta.pane,
    terminalId: run.meta.terminal_id, agentName: run.meta.agent, nativeSessionId: run.meta.agent_session_id, checkout: run.workspace };
  const workspace = o.workspaces.find(w => w.workspace_id === a.workspace_id);
  if (!sameBinding(binding, recordedBinding) || !pane || pane.terminal_id !== a.terminal_id || pane.workspace_id !== a.workspace_id ||
      pane.tab_id !== binding.tab || tab?.workspace_id !== a.workspace_id ||
      !slots.some(s => s.workspace === a.workspace_id && s.checkout === a.cwd) ||
      workspace?.worktree?.repo_key !== input.inspection.project.common || workspace.worktree.checkout_path !== a.cwd) return row(entry, 'Hold', 'Hold', 'work-item topology disagrees with enrolled checkout');
  const job = facts.dispatches[run.id];
  if (!job || job.run !== run.id || job.item !== item || job.common !== input.inspection.project.common || job.workspace !== run.workspace ||
      (job.report && job.report !== run.report_path) || job.worker?.agentName !== a.name || job.worker.pane !== a.pane_id ||
      job.worker.workspaceId !== a.workspace_id || job.worker.terminalId !== a.terminal_id || job.worker.agentSessionId !== binding.nativeSessionId ||
      job.route !== run.meta.route || ['harness', 'model', 'effort'].some(k => (job.declared?.[k] ?? null) !== (run.meta[k] ?? null)) ||
      !['complete', 'prompting', 'prompt', 'watch'].includes(job.stage)) return row(entry, 'Hold', 'Hold', 'dispatch receipt does not prove this exact work-item incarnation');
  if (job.reuse) {
    const prior = facts.record.runs.find(r => r.id === job.reuse), p = prior?.meta;
    if (!prior || prior.item !== run.item || !prior.report || prior.report_path === run.report_path || prior.started.seq >= run.started.seq ||
        p.agent !== a.name || p.pane !== a.pane_id || p.worker_workspace !== a.workspace_id || p.terminal_id !== a.terminal_id ||
        p.agent_session_id !== binding.nativeSessionId || prior.workspace !== run.workspace || p.route !== run.meta.route ||
        ['harness', 'model', 'effort'].some(k => (p[k] ?? null) !== (run.meta[k] ?? null))) return row(entry, 'Hold', 'Hold', 'reuse receipt changed item, session, terminal, route or report identity');
  }
  const frozen = journal.bindings.find(b => b.uid === entry.manifest.metadata.uid);
  if (frozen && !sameBinding(frozen.binding, binding)) return row(entry, 'Hold', 'Hold', 'changed occupant since recorded observation');
  const route = entry.resolvedSpec.resolvedRoute;
  const changedRoute = route && (route.route !== run.meta.route || ['kind', 'model', 'effort'].some(k =>
    (route[k] ?? null) !== (run.meta[k === 'kind' ? 'harness' : k] ?? null)));
  const pending = changedRoute || (!frozen && entry.manifest.metadata.generation > 1) ||
    (frozen && (frozen.specDigest !== specDigest(entry) || frozen.generation !== entry.manifest.metadata.generation));
  const chain = chainEvidence(facts, run);
  const chainReason = chain.openItems.length ? `review, correction or integration chain is still open: ${chain.openItems.join(', ')}`
    : 'recorded disposition; retain until existing safe-retirement checks';
  const report = run.report || facts.reports[run.id]?.present;
  const phase = report && quiet(a) ? 'ParkedAwaitingReview' : 'Running';
  const uncertain = job.stage !== 'complete' || (!['working', 'idle', 'done'].includes(a.agent_status ?? a.status));
  return row(entry, uncertain ? 'Hold' : phase, uncertain ? 'Hold' : report && quiet(a) ? 'KEEP' : 'NoOp',
    uncertain ? 'dispatch, prompt or agent readiness uncertain; observe only' : report && quiet(a)
      ? `report ${run.id} present; ${chainReason}` : 'matching live work-item incarnation; observation only', {
      observed: { binding, run: run.id, report: run.report_path, recordSeq: facts.record.revision, chainReason, chain,
        watcher: facts.watches?.[run.id] ?? null,
        generation: frozen?.generation ?? null, specDigest: frozen?.specDigest ?? null, reuse: job.reuse ?? null },
      ...(pending ? { pendingGeneration: entry.manifest.metadata.generation } : {}),
      freeze: !frozen && !pending && !uncertain ? { uid: entry.manifest.metadata.uid, generation: entry.manifest.metadata.generation,
        specDigest: specDigest(entry), binding, run: run.id } : null });
}

export function planSessions(input) {
  const { inspection, enrollment, observation: o, facts, journal = emptyJournal(inspection.project.common), leaseHeld = false } = input;
  input = { ...input, journal };
  const errors = [...(enrollment.errors ?? []), ...(facts.errors ?? []), ...(o.errors ?? [])];
  if (!inspection.valid) errors.push('invalid desired manifests');
  if (!o.complete) errors.push('incomplete Herdr observation');
  const duplicate = duplicates(o); if (duplicate) errors.push(duplicate);
  if (leaseHeld) errors.push('canonical controller lease held or unresolved');
  const brake = facts.stopped ? 'STOP: observe only' : facts.closeHold ? `${facts.closeHold}: observe only` : null;
  const decisions = inspection.entries.map(entry => {
    const s = entry.manifest.spec, uid = entry.manifest.metadata.uid;
    if (s.role === 'reviewer') return row(entry, 'DeclarativeOnly', 'Observe', 'reviewer sessions are declarative only; settle owns review launch');
    if (enrollment.errors?.length) return row(entry, 'Hold', 'Hold', errors.join('; '));
    // home = canonical checkout, otherwise exact native workspace ID or a
    // Git-verified branch reference. Never use display labels for enrollment.
    const slots = enrollment.slots.filter(slot => slot.common === inspection.project.common && slot.server === o.server &&
      (s.workspaceRef === 'home' ? slot.checkout === inspection.project.root : slot.workspace === s.workspaceRef || facts.workspaceRefs?.[s.workspaceRef]?.includes(slot.workspace)));
    const workspaces = new Set(slots.map(slot => slot.workspace));
    if (!slots.length) return row(entry, 'NotEnrolled', 'Observe', 'not enrolled: no canonical standard-slot receipt binds this workspace');
    if (errors.length) return row(entry, 'Hold', 'Hold', errors.join('; '));
    if (workspaces.size !== 1) return row(entry, 'Hold', 'Hold', 'ambiguous workspace enrollment');
    let decision;
    const lifecycle = planLifecycle(entry, input, slots);
    if (lifecycle) decision = row(entry, lifecycle.phase, lifecycle.decision, lifecycle.reason, lifecycle);
    else if (s.intent.kind === 'work-item') decision = worker(entry, input, slots);
    else {
      const matching = slots.filter(slot => slot.standardSlot === s.standardSlot);
      if (matching.length !== 1) return row(entry, 'Hold', 'Hold', 'desired standard slot has no unique adopted binding');
      const slot = matching[0], why = slotTopology(slot, o, inspection.project.common);
      if (why) return row(entry, 'Hold', 'Hold', why);
      const paneId = slot.panes.find(p => p.paneSlot === (s.paneSlot ?? 'primary'))?.pane;
      const pane = o.panes.find(p => p.pane_id === paneId);
      const target = { server: o.server, workspace: slot.workspace, tab: slot.tab, pane: paneId, checkout: slot.checkout };
      const ops = journal.operations.filter(op => !lifecycleOperation(op) && (op.uid === uid || targetMatches(op.target, target)));
      if (ops.length > 1) return row(entry, 'Hold', 'Hold', 'multiple operations claim this standard position');
      const op = ops[0], agents = o.agents.filter(a => a.pane_id === paneId);
      if (op && op.uid !== uid) return row(entry, 'Hold', 'Hold', 'another manifest UID owns this standard position');
      const a = agents[0], binding = a && agentBinding(a, o.server, slot.tab);
      const claims = op ? (o.receipts ?? []).filter(r => r.operationId === op.id) : [];
      const receipts = claims.filter(r => receiptMatches(r, op));
      const receipt = op?.receipt ?? (receipts.length === 1 ? receipts[0] : null);
      if (op?.state === 'withheld') decision = row(entry, 'Hold', 'Hold', `start withheld, delegate never invoked: ${op.reason}; stage 4 recovery required`, {
        observed: { operationId: op.id, operationState: op.state, withheldReason: op.reason } });
      else if (a) {
        if (!op || !receipt || claims.length > 1 || (claims.length && (receipts.length !== 1 || !sameBinding(claims[0].binding, receipt.binding))) || !sameBinding(receipt.binding, binding) || pane.terminal_id !== binding.terminalId ||
            !targetMatches(binding, target) || !['working', 'idle', 'done'].includes(a.agent_status ?? a.status)) return row(entry, 'Hold', 'Hold', 'unknown or changed standard-slot occupant; never adopt or close');
        decision = row(entry, 'Running', 'KEEP', 'matching live incarnation; protected standard slot; no prompt replay', {
          observed: { binding, generation: op.generation, specDigest: op.specDigest },
          ...(op.specDigest !== specDigest(entry) || op.generation !== entry.manifest.metadata.generation ? { pendingGeneration: entry.manifest.metadata.generation } : {}),
          ...(op.state === 'intent' ? { resolvedOperation: op.id, receipt } : {}) });
      } else if (op) decision = row(entry, 'Hold', 'Hold', 'prior start intent or incarnation exists; acknowledgement/loss requires observation, never start twice');
      else if (entry.manifest.kind !== 'Session' || s.role === 'logs-triage') decision = row(entry, 'Hold', 'KEEP', 'protected slot; viewer/triage activation belongs to later stages');
      else if (pane.emptyConfirmed !== true || !pane.terminal_id || pane.agent || pane.agent_session?.value || pane.restore_error || pane.launch_pending) decision = row(entry, 'Hold', 'Hold', 'missing occupant is not proven empty; keep unknown processes');
      else decision = row(entry, 'Missing', 'WouldStart', 'missing occupant in an adopted standard slot', {
        observed: { target, terminalId: pane.terminal_id }, action: { kind: 'start-standard-slot', uid, target,
          generation: entry.manifest.metadata.generation, specDigest: specDigest(entry), spec: entry.resolvedSpec } });
    }
    decision.reset ??= resetAssessment(entry, input);
    decision.recovery ??= { state: 'not-required-or-unconfirmed' };
    if (brake) return { ...decision, decision: 'Observe', reason: `${brake}; ${decision.reason}`, action: null, lifecycleUpdate: null,
      reset: { eligible: false, vetoes: [brake, ...decision.reset.vetoes] } };
    return decision;
  });
  for (const d of decisions) {
    d.reset ??= { eligible: false, vetoes: [d.reason] };
    d.recovery ??= { state: 'unknown' };
  }
  // An unresolved ownership/launch hold fences the pass, including other slots.
  if (decisions.some(d => d.decision === 'Hold')) for (const d of decisions.filter(d => d.action)) {
    d.action = null; d.decision = 'Hold'; d.reason = 'another desired session has unresolved ownership or evidence';
  }
  const actionable = decisions.filter(d => d.action);
  for (const deferred of actionable.slice(1)) { deferred.action = null; deferred.decision = 'Defer'; deferred.reason = 'one action per pass; another missing slot selected'; }
  return { apiVersion: 'session-plan/v1', project: inspection.project, valid: inspection.valid,
    diagnostics: inspection.diagnostics, errors, decisions, action: actionable[0]?.action ?? null };
}

// Test harness only. Production CLI never calls this execution path.
// actions.start delegates to an existing launch owner; it must not build native
// argv or send a prompt here. No live implementation is wired in this stage.
export async function reconcileOffline({ inspection, read, actions }) {
  if (actions?.offline !== true || typeof actions.start !== 'function') throw Error('session actions require an explicit offline fake');
  const common = inspection.project.common, paths = runtimePaths(common);
  let release;
  try { release = acquireControllerLease(common); }
  catch (error) { return { decision: 'Hold', reason: `controller lease: ${error.message}`, action: null }; }
  try {
    let journal;
    try { journal = readControllerJournal(common); }
    catch (error) { return { decision: 'Hold', reason: error.message, action: null }; }
    const observe = async (evidence = journal) => planSessions({ inspection, ...await read(), journal: evidence });
    const advance = (op, state, evidence = {}) => {
      Object.assign(op, evidence, { state }); op.history.push(state); durableWrite(paths.journal, journal);
    };
    // Only fresh receipts resolve an uncertain operation. These writes never
    // invoke an adapter and can finish an interrupted acknowledgement pass.
    const settle = async () => {
      for (let n = 0; n < 5; n++) {
        const plan = await observe(), updates = plan.decisions.filter(d => d.lifecycleUpdate);
        if (!updates.length) return plan;
        for (const d of updates) {
          const { operationId, state, ...evidence } = d.lifecycleUpdate;
          const op = journal.operations.find(op => op.id === operationId);
          if (state === 'restarted') {
            for (const i of evidence.receipt.incarnations) journal.incarnations.push({ id: i.id, uid: i.uid, operationId,
              previous: i.previous, generation: i.generation, specDigest: i.specDigest,
              kind: op.participants.find(p => p.uid === i.uid).kind, binding: i.binding, contextLoss: op.contextLoss, contextHash: op.contextHash });
          }
          advance(op, state, evidence);
        }
      }
      throw Error('lifecycle acknowledgement did not converge');
    };
    let plan = await settle();
    for (const d of plan.decisions) {
      if (d.freeze) journal.bindings.push(d.freeze);
      if (d.resolvedOperation) Object.assign(journal.operations.find(op => op.id === d.resolvedOperation), { state: 'acknowledged', receipt: d.receipt });
    }
    if (plan.decisions.some(d => d.freeze || d.resolvedOperation)) durableWrite(paths.journal, journal);
    if (plan.action) {
      // Repeat all record, enrollment, STOP and ownership checks immediately
      // before recording intent. Changed facts cancel this pass's action.
      const fresh = await observe();
      if (JSON.stringify(fresh.action) !== JSON.stringify(plan.action) ||
          JSON.stringify(fresh.decisions.find(d => d.action)?.observed) !== JSON.stringify(plan.decisions.find(d => d.action)?.observed)) plan = fresh.action
        ? fence(fresh, 'selected occupant changed before action; hold') : fresh;
      else {
        if (plan.action.kind === 'lifecycle') {
          const selected = plan.action, before = structuredClone(journal);
          let op = selected.operationId && journal.operations.find(op => op.id === selected.operationId);
          if (!op) {
            const first = selected.operation.kind === 'reset' ? 'reset-prepared' : 'recovery-required';
            op = { ...selected.operation, id: selected.operation.mode === 'native-restore' ? selected.operation.request.restoreOperationId : randomUUID(),
              state: first, history: [first] };
            journal.operations.push(op); durableWrite(paths.journal, journal);
          }
          if (selected.stage !== 'adopt') {
            const method = selected.stage, intent = { close: 'close-intent', respawn: 'respawn-intent', resume: 'resume-intent', transfer: 'inbox-intent' }[method];
            if (!intent || typeof actions[method] !== 'function') {
              advance(op, 'withheld', { reason: `offline ${method} delegate missing; never invoked` });
            } else {
              advance(op, intent); // durable before final check and adapter.
              const final = await observe(before);
              if (JSON.stringify(final.action) !== JSON.stringify(selected) ||
                  JSON.stringify(final.decisions.find(d => d.action)?.observed) !== JSON.stringify(plan.decisions.find(d => d.action)?.observed)) {
                advance(op, 'withheld', { reason: 'evidence changed after lifecycle intent; delegate never invoked' });
              } else {
                try { await actions[method](structuredClone(op)); }
                catch (error) {
                  // A refusal is terminal. An ordinary lost reply remains an
                  // intent: only independent receipt evidence can resolve it.
                  if (error.refused === true) advance(op, 'failed', { reason: `native refusal: ${error.message}` });
                  plan.adapterError = error.message;
                }
              }
            }
          }
          const adapterError = plan.adapterError;
          plan = await settle();
          for (const d of plan.decisions.filter(d => d.action)) {
            d.action = null; d.decision = 'Defer'; d.reason = 'one action already attempted in this pass';
          }
          plan.action = null; plan.attemptedOperation = op.id;
          if (adapterError) plan.adapterError = adapterError;
        } else {
          const op = { ...plan.action, id: randomUUID(), state: 'intent' };
          journal.operations.push(op); durableWrite(paths.journal, journal); // fsync before adapter.
          let failure;
          const final = planSessions({ inspection, ...await read(), journal: { ...journal, operations: journal.operations.filter(candidate => candidate.id !== op.id) } });
          if (JSON.stringify(final.action) !== JSON.stringify(plan.action) ||
              JSON.stringify(final.decisions.find(d => d.action)?.observed) !== JSON.stringify(plan.decisions.find(d => d.action)?.observed)) {
            failure = 'evidence changed after intent; start withheld';
            Object.assign(op, { state: 'withheld', reason: failure });
            durableWrite(paths.journal, journal);
          }
          else try { await actions.start(op); } catch (error) { failure = error.message; }
          // The returned acknowledgement alone is insufficient. Only exact
          // receipt evidence in a new observation can acknowledge an intent.
          plan = await observe();
          for (const d of plan.decisions.filter(d => d.action)) {
            d.action = null; d.decision = 'Defer'; d.reason = 'one action already attempted in this pass';
          }
          plan.action = null; plan.attemptedOperation = op.id;
          for (const d of plan.decisions) if (d.resolvedOperation === op.id) Object.assign(op, { state: 'acknowledged', receipt: d.receipt });
          if (op.state === 'acknowledged') durableWrite(paths.journal, journal);
          if (failure) plan.adapterError = failure;
        }
      }
    }
    durableWrite(paths.status, { ...plan, observedAt: new Date().toISOString() });
    return plan;
  } finally { release(); }
}
