// Stage 4 policy and execution guards. Native mutations stay in live.mjs.
import { roleIs } from '../lib/roles.mjs';
import { agentBinding } from './observe.mjs';
import { lastTabCloseVeto, unexpectedWorkspaceRemoval } from './close-safety.mjs';
import { nativeResumeVeto } from './native-conversation.mjs';
import { digest, specDigest, equalBinding, validBinding, strings, sameStrings, text, verifyHandoff,
  validCloseReceipt, validMaterializationReceipt, validInboxReceipt, validLifecycleOperation } from './lifecycle-evidence.mjs';

const isLifecycle = op => ['reset', 'recovery'].includes(op.kind);
export const lifecycleOperation = isLifecycle;
const targetOf = b => Object.fromEntries(['server', 'workspace', 'tab', 'pane', 'checkout'].map(k => [k, b[k]]));
const receiptRows = (o, id, kind) => (o.receipts ?? []).filter(r => r.operationId === id && r.kind === kind);
const liveAgent = (o, b) => o.agents.find(a => equalBinding(agentBinding(a, o.server, a.tab_id ?? b.tab), b));
const liveViewer = (o, b) => (o.viewers ?? []).find(v => equalBinding(v.binding, b));
const live = (o, p) => p.kind === 'LogViewer' ? liveViewer(o, p.binding) : liveAgent(o, p.binding);
const quiet = a => ['idle', 'done'].includes(a?.agent_status ?? a?.status);
const same = (a, b) => digest(a) === digest(b);
const reasonText = veto => typeof veto === 'string' ? veto : veto.reason;

// The original record/dispatch binding is immutable, even after a resume.
function workerSource(entry, input) {
  const { facts, journal, inspection } = input, uid = entry.manifest.metadata.uid;
  const run = facts.record.runs.filter(r => r.item === entry.manifest.spec.intent.item).sort((a, b) => b.started.seq - a.started.seq)[0];
  const frozen = journal.bindings.find(b => b.uid === uid), b = frozen?.binding, job = facts.dispatches[run?.id];
  const route = entry.resolvedSpec.resolvedRoute;
  if (!run || run.abandoned || !frozen || !validBinding(b) || frozen.run !== run.id ||
      frozen.generation !== entry.manifest.metadata.generation || frozen.specDigest !== specDigest(entry) ||
      run.workspace !== b.checkout || run.meta?.agent !== b.agentName || run.meta.pane !== b.pane ||
      run.meta.worker_workspace !== b.workspace || run.meta.terminal_id !== b.terminalId || run.meta.agent_session_id !== b.nativeSessionId ||
      !job || job.run !== run.id || job.item !== run.item || job.common !== inspection.project.common ||
      job.workspace !== run.workspace || job.report !== run.report_path || job.stage !== 'complete' ||
      job.worker?.agentName !== b.agentName || job.worker.pane !== b.pane || job.worker.workspaceId !== b.workspace ||
      job.worker.terminalId !== b.terminalId || job.worker.agentSessionId !== b.nativeSessionId ||
      job.route !== run.meta.route || route?.route !== run.meta.route || ['kind', 'model', 'effort'].some(k =>
        (route[k] ?? null) !== (run.meta[k === 'kind' ? 'harness' : k] ?? null) ||
        (route[k] ?? null) !== (job.declared?.[k === 'kind' ? 'harness' : k] ?? null))) return null;
  if (job.reuse) {
    const prior = facts.record.runs.find(r => r.id === job.reuse);
    if (!prior?.report || prior.item !== run.item || prior.started.seq >= run.started.seq || prior.report_path === run.report_path ||
        prior.workspace !== run.workspace || ['agent', 'pane', 'worker_workspace', 'terminal_id', 'agent_session_id', 'route', 'harness', 'model', 'effort']
          .some(k => (prior.meta?.[k] ?? null) !== (run.meta[k] ?? null))) return null;
  }
  return { binding: b, incarnation: `run:${run.id}`, run };
}
function known(entry, input) {
  const uid = entry.manifest.metadata.uid, { journal } = input;
  let source;
  if (entry.manifest.spec.intent.kind === 'work-item') source = workerSource(entry, input);
  else {
    const starts = journal.operations.filter(op => !isLifecycle(op) && op.state !== 'never-started' && op.uid === uid);
    const op = starts.length === 1 && starts[0];
    const claims = op && (input.observation.receipts ?? []).filter(r => r.operationId === op.id);
    if (op?.state === 'acknowledged' && op.receipt?.operationId === op.id && op.receipt.uid === uid &&
        claims.length <= 1 && (!claims.length || same(claims[0], op.receipt)) &&
        op.receipt.generation === op.generation && op.receipt.specDigest === op.specDigest && validBinding(op.receipt.binding, entry.manifest.kind) &&
        Object.keys(targetOf(op.receipt.binding)).every(k => op.target[k] === op.receipt.binding[k])) {
      source = { binding: op.receipt.binding, incarnation: `start:${op.id}`, generation: op.generation, specDigest: op.specDigest };
    }
  }
  if (!source) return null;
  const incarnations = (journal.incarnations ?? []).filter(i => i.uid === uid);
  let current = source;
  for (const i of incarnations) {
    if (i.previous !== current.incarnation) return null;
    current = { ...source, binding: i.binding, incarnation: i.id, generation: i.generation, specDigest: i.specDigest, receipt: i };
  }
  const generation = current.generation ?? entry.manifest.metadata.generation;
  const sd = current.specDigest ?? specDigest(entry);
  return { uid, generation, specDigest: sd, kind: entry.manifest.kind, spec: entry.resolvedSpec,
    binding: current.binding, incarnation: current.incarnation, run: source.run, receipt: current.receipt };
}

function chain(input, run) {
  const { items, links = [] } = input.facts.record;
  let root = items.find(i => i.id === run.item);
  const walked = new Set();
  while (root?.parent && roleIs(root, 'REV') && !walked.has(root.id)) { walked.add(root.id); root = items.find(i => i.id === root.parent); }
  const ids = new Set([root?.id ?? run.item]);
  for (let size = -1; size !== ids.size;) {
    size = ids.size;
    for (const i of items) if (ids.has(i.parent)) ids.add(i.id);
    for (const l of links) if (ids.has(l.blocked)) ids.add(l.blocker);
    for (const i of items) if (ids.has(i.id)) for (const id of i.blocked_by ?? []) ids.add(id);
  }
  return [...ids].filter(id => !items.find(i => i.id === id)?.closed);
}
function topology(input, participants, { absent = false, loss = false, quiescent = false, closing = false } = {}) {
  const o = input.observation, b = participants[0].binding;
  const removed = absent && unexpectedWorkspaceRemoval(o, b);
  if (removed) return removed;
  const w = o.workspaces.find(w => w.workspace_id === b.workspace);
  if (o.server !== b.server || w?.worktree?.repo_key !== input.inspection.project.common || w.worktree.checkout_path !== b.checkout) return 'workspace ownership changed';
  if (absent) return o.tabs.some(t => t.tab_id === b.tab) || o.panes.some(p => p.tab_id === b.tab || participants.some(x => x.binding.pane === p.pane_id)) ||
      o.agents.some(a => a.tab_id === b.tab || participants.some(x => x.binding.pane === a.pane_id || x.binding.terminalId === a.terminal_id ||
        (x.binding.nativeSessionId && x.binding.nativeSessionId === (a.agent_session?.value ?? a.agent_session_id)))) ||
      (o.losses ?? []).some(l => participants.some(p => equalBinding(l.binding, p.binding)) && l.restore?.state !== 'none') ||
      (o.viewers ?? []).some(v => v.binding.tab === b.tab || participants.some(x => x.binding.pane === v.binding.pane)) ? 'closed tab absence is not confirmed' : null;
  if (!o.tabs.some(t => t.tab_id === b.tab && t.workspace_id === b.workspace)) return 'owned tab missing';
  const panes = o.panes.filter(p => p.tab_id === b.tab);
  if (panes.length !== participants.length || panes.some(p => p.workspace_id !== b.workspace || !participants.some(x => x.binding.pane === p.pane_id))) return 'multi-owner tab or unrelated pane; refuse close';
  for (const p of participants) {
    const pane = panes.find(x => x.pane_id === p.binding.pane), occupant = live(o, p);
    const lost = loss && lossEvidence(input, p)?.state === 'confirmed-exit';
    if (!pane || (!lost && (pane.terminal_id !== p.binding.terminalId || !occupant)) ||
        o.agents.some(a => a.pane_id === p.binding.pane && (!occupant || p.kind !== 'Session' || a.name !== p.binding.agentName)) ||
        (o.viewers ?? []).some(v => v.binding.pane === p.binding.pane && !equalBinding(v.binding, p.binding))) return 'unknown or changed tab occupant';
    if (!lost && p.kind === 'Session' && (!['idle', 'done', 'working'].includes(occupant?.agent_status ?? occupant?.status) ||
        (quiescent && !quiet(occupant)))) return 'incarnation readiness or quiescence uncertain';
    if (lost && (!pane.emptyConfirmed || pane.launch_pending || pane.restore_error)) return 'lost process pane is not confirmed available';
  }
  return closing ? lastTabCloseVeto(o, b) : null;
}
function processTopology(input, p, lost = false) {
  const o = input.observation, b = p.binding, w = o.workspaces.find(w => w.workspace_id === b.workspace);
  const pane = o.panes.find(x => x.pane_id === b.pane);
  if (o.server !== b.server || w?.worktree?.repo_key !== input.inspection.project.common || w.worktree.checkout_path !== b.checkout ||
      !o.tabs.some(t => t.tab_id === b.tab && t.workspace_id === b.workspace) || pane?.tab_id !== b.tab || pane.workspace_id !== b.workspace) return 'recovery target ownership changed';
  if (lost) return !pane.emptyConfirmed || pane.launch_pending || pane.restore_error || pane.agent ||
      o.agents.some(a => a.pane_id === b.pane) || (o.viewers ?? []).some(v => v.binding.pane === b.pane) ? 'recovery target is not confirmed available' : null;
  const occupant = live(o, p);
  return pane.terminal_id !== b.terminalId || !occupant ||
    (p.kind === 'Session' && !['idle', 'done', 'working'].includes(occupant.agent_status ?? occupant.status)) ? 'replacement process binding or readiness changed' : null;
}
function participantsFor(entry, input, slots, wholeLayout = true) {
  const first = known(entry, input);
  if (!first) return { error: 'missing exact incarnation ownership receipt' };
  const b = first.binding;
  const adopted = slots.filter(s => s.standardSlot === entry.manifest.spec.standardSlot);
  if (entry.manifest.spec.standardSlot && !adopted.some(s => s.tab === b.tab && s.panes.some(p => p.pane === b.pane))) return { error: 'incarnation is not in the adopted layout' };
  const entries = wholeLayout && entry.manifest.spec.standardSlot === 'logs'
    ? input.inspection.entries.filter(e => e.manifest.spec.standardSlot === 'logs' && e.manifest.spec.workspaceRef === entry.manifest.spec.workspaceRef)
    : [entry];
  const participants = [entry, ...entries.filter(e => e !== entry)].map(e => known(e, input));
  if (participants.some(p => !p) || (wholeLayout && entry.manifest.spec.standardSlot === 'logs' &&
      (participants.length !== 2 || !participants.some(p => p.kind === 'LogViewer') || !participants.some(p => p.spec.role === 'logs-triage')))) return { error: 'both owned logs panes and manifests are required' };
  if (participants.some(p => ['server', 'workspace', 'tab', 'checkout'].some(k => p.binding[k] !== b[k]) ||
      p.specDigest !== digest({ kind: p.kind, spec: p.spec }))) return { error: 'changed manifest or layout; incarnation remains frozen' };
  if (participants.some(p => p.generation !== input.inspection.entries.find(e => e.manifest.metadata.uid === p.uid).manifest.metadata.generation)) return { error: 'pending generation; incarnation remains frozen' };
  return { participants: participants.map(({ run, receipt, ...p }) => p), run: first.run };
}
function boundaryVeto(entry, input, participants, request, reconstruct = false, prepared = false) {
  if (!request) return 'declared safe boundary and verified handoff required';
  const b = request.boundary, isWorker = entry.manifest.spec.intent.kind === 'work-item';
  if (!b || !text(b.ref)) return 'declared boundary receipt required';
  if (isWorker && !reconstruct) return 'work-item sessions never enter standard reset';
  if (isWorker && (!text(request.disposition?.ref) || request.disposition.run !== participantsForRun(input, entry)?.id || request.disposition.contextLossAccepted !== true)) return 'explicit recovery disposition for open work required (context loss)';
  if (!isWorker && entry.manifest.spec.role === 'logs-triage') {
    if (b.kind !== 'committed-batch' || b.committed !== true || !text(b.batchRef) || !text(b.viewerCursor) || b.cursor !== request.handoff?.inboxCursor) return 'committed triage batch, service cursor and viewer cursor required';
  } else if (!isWorker && (b.kind !== 'handoff' || b.declared !== true)) return 'declared chat/supervisor handoff boundary required';
  if (entry.manifest.spec.role === 'supervisor' && !['complete', 'fallback'].includes(b.draft)) return 'supervisor handoff draft must finish or have explicit failure fallback';
  try { verifyHandoff(request.handoff); } catch (error) { return error.message; }
  const refs = new Set([...input.facts.record.items, ...input.facts.record.runs].map(r => r.id));
  if (request.handoff.recordRefs.some(ref => !refs.has(ref))) return 'handoff record reference missing';
  // Preparation freezes coverage and its revision. Later passes recheck only
  // old-incarnation dependencies; unrelated record/inbox progress is allowed.
  for (const p of participants) {
    const q = input.facts.quiescence?.[p.uid], h = request.handoff;
    if (!q || !equalBinding(q.binding, p.binding) || !text(q.ref) ||
        q.callbacksQuiesced !== true || !strings(q.openWork) || !strings(q.openReviews) || !strings(q.inFlightDeliveries) ||
        (!reconstruct && (q.openWork.length || q.openReviews.length)) || q.inFlightDeliveries.length ||
        (!prepared && (q.recordSeq !== input.facts.record.revision || !strings(q.pendingInboxIds) ||
          q.pendingInboxIds.some(id => !h.unresolvedMessageIds.includes(id)) || !sameStrings(q.recordRefs, h.recordRefs) ||
          !sameStrings(q.unresolvedMessageIds, h.unresolvedMessageIds) || q.inboxCursor !== h.inboxCursor))) return 'callbacks, work/review, delivery or handoff coverage is not quiescent and verified';
    if (prepared && reconstruct && (q.openWork.some(id => !request.quiescence[p.uid].openWork.includes(id)) ||
        q.openReviews.some(id => !request.quiescence[p.uid].openReviews.includes(id)))) return 'new open work/review depends on reconstruction incarnation';
    const dependentRuns = input.facts.record.runs.filter(run => run.meta && (run.meta.pane === p.binding.pane ||
      run.meta.terminal_id === p.binding.terminalId || (p.binding.nativeSessionId && run.meta.agent_session_id === p.binding.nativeSessionId)));
    const disposedItem = reconstruct && input.facts.record.runs.find(run => run.id === request.disposition?.run)?.item;
    if (dependentRuns.some(run => (!reconstruct || prepared && run.item !== disposedItem) && !run.abandoned &&
        (!run.report || chain(input, run).length))) return 'recorded open work/review depends on incarnation; reset veto';
    if ((input.facts.references ?? []).some(r => r.uid === p.uid || r.pane === p.binding.pane || r.tab === p.binding.tab ||
        (p.binding.nativeSessionId && r.nativeSessionId === p.binding.nativeSessionId) || dependentRuns.some(run => r.run === run.id || r.item === run.item))) return 'live callback or delivery reference depends on incarnation';
  }
  return null;
}
const participantsForRun = (input, entry) => input.facts.record.runs.filter(r => r.item === entry.manifest.spec.intent.item).sort((a, b) => b.started.seq - a.started.seq)[0];
export function resetAssessment(entry, input) {
  if (entry.manifest.spec.intent.kind === 'work-item') {
    const run = participantsForRun(input, entry), open = run ? chain(input, run) : [];
    return { eligible: false, vetoes: [open.length ? `open review/correction/integration chain: ${open.join(', ')}` : 'work-item sessions never enter standard reset'] };
  }
  return { eligible: false, vetoes: ['declared safe boundary and verified handoff required'] };
}

function closeProof(op, input) {
  const rows = receiptRows(input.observation, op.id, 'close');
  const r = rows[0];
  return rows.length === 1 && validCloseReceipt(op, r) && !topology(input, op.participants, { absent: true }) ? r : null;
}
function incarnationProof(op, input, kind) {
  const rows = receiptRows(input.observation, op.id, kind), r = rows[0];
  if ((op.contextLoss && topology(input, op.participants, { absent: true })) || rows.length !== 1 || !validMaterializationReceipt(op, r)) return null;
  const bindings = op.participants.map(p => ({ ...p, binding: r.incarnations.find(i => i.uid === p.uid).binding }));
  if ((input.journal.incarnations ?? []).some(i => r.incarnations.some(j => j.id === i.id)) ||
      (op.contextLoss ? topology(input, bindings) : bindings.some(p => processTopology(input, p)))) return null;
  return r;
}
function lossEvidence(input, p) {
  const rows = (input.observation.losses ?? []).filter(l => equalBinding(l.binding, p.binding));
  return rows.length === 1 ? rows[0] : null;
}
function recoveryVeto(entry, input, p, request) {
  const loss = lossEvidence(input, p);
  if (!loss || loss.state !== 'confirmed-exit' || !text(loss.ref) || loss.processConfirmedGone !== true || live(input.observation, p)) return 'process loss unconfirmed; disconnect/unknown readiness never authorizes a spawn';
  if (!loss.restore || !['none', 'resumed'].includes(loss.restore.state)) return `native restore ${loss.restore?.state ?? 'unknown'} owns or may own spawn; no second spawn`;
  if (loss.refused === true || request?.refused === true) return 'native refusal; hold';
  if (!Number.isSafeInteger(loss.failures) || loss.failures < 0 || loss.failures >= 2) return 'repeated failures or missing failure evidence; hold';
  if (loss.backoffReady !== true) return 'recovery backoff not satisfied';
  if (!request || !text(request.contextRef) || request.contextVerified !== true || !/^[a-f0-9]{64}$/u.test(request.contextHash ?? '') ||
      (p.kind === 'Session' && request.nativeSessionId !== p.binding.nativeSessionId) || !same(request.route ?? null, p.spec.resolvedRoute ?? null)) return 'missing native reference, route or verified context evidence';
  const policy = entry.manifest.spec.lifecycle;
  if (request.mode === 'resume' && p.kind === 'Session' && policy.recovery?.knownNativeSession !== 'resume' &&
      policy.restartPolicy !== 'on-confirmed-exit-resume-known-session') return 'adopted manifest does not authorize native resume';
  if (request.mode === 'resume' && loss.restore.state === 'none' && p.kind === 'Session') return nativeResumeVeto(p, input.env);
  return null;
}

// Reuse the prepared-boundary policy at the physical edge after shell readiness
// or native identity reads. The adapter separately proves current topology.
export function lifecycleEdgeVeto(entry, input, op) {
  if (op.contextLoss) return boundaryVeto(entry, input, op.participants, op.request, op.mode === 'reconstruct', true);
  if (op.kind === 'recovery') return recoveryVeto(entry, input, op.participants[0], op.request);
  return null;
}

export function planLifecycle(entry, input, slots) {
  const uid = entry.manifest.metadata.uid, o = input.observation;
  const pending = input.journal.operations.filter(op => isLifecycle(op) && op.participants.some(p => p.uid === uid) && op.state !== 'acknowledged');
  let reset = input.facts.resetRequests?.[uid], recovery = input.facts.recovery?.[uid];
  const current = known(entry, input);
  const loss = current && lossEvidence(input, current);
  if (reset && input.journal.operations.some(op => isLifecycle(op) && op.uid === uid && op.state === 'acknowledged' && op.request.boundary?.ref === reset.boundary?.ref)) reset = null;
  if (current && live(o, current) && !loss) recovery = null;
  const make = (phase, decision, reason, extra = {}) => ({ phase, decision, reason, action: null, ...extra });
  let hold = veto => make('Hold', 'Hold', reasonText(veto), {
    ...(veto.code ? { holdCode: veto.code } : {}),
    reset: { eligible: false, vetoes: [reasonText(veto)] }, recovery: { state: loss?.state ?? 'unknown' } });
  if (pending.length > 1) return hold('multiple lifecycle operations claim this incarnation');
  if (pending.length) {
    const op = pending[0];
    if (op.uid !== uid) return make('KEEP', 'KEEP', `layout transition owned by ${op.uid}`, { observed: { operationId: op.id, operationState: op.state } });
    const observed = { operationId: op.id, operationState: op.state, contextLoss: op.contextLoss, parkedIntent: op.parkedIntent };
    if (['respawn-pending', 'inbox-pending'].includes(op.state)) observed.pendingReason = op.reason;
    const baseHold = hold;
    hold = reason => ({ ...baseHold(reason), observed,
      ...(['closed-for-reset', 'respawn-pending'].includes(op.state) ? { phase: 'ClosedForReset', reason: `closed session awaiting respawn: ${reasonText(reason)}` } : {}),
      recovery: { state: op.kind === 'recovery' ? 'RecoveryRequired' : 'not-required', operationState: op.state, mode: op.mode, contextLoss: op.contextLoss } });
    const result = (phase, decision, reason, extra = {}) => make(phase, decision, reason, { observed, ...extra });
    const action = stage => result(['closed-for-reset', 'respawn-pending'].includes(op.state) ? 'ClosedForReset' : op.state === 'inbox-pending' ? 'Restarted' : op.kind === 'recovery' ? 'RecoveryRequired' : 'ResetPrepared',
      `Would${stage[0].toUpperCase()}${stage.slice(1)}`, `${stage === 'respawn' ? 'closed session awaiting respawn' : `journaled ${op.mode}: ${stage}`}${observed.pendingReason ? `; ${op.reason}` : ''}`,
      { action: { kind: 'lifecycle', stage, operationId: op.id } });
    const update = (phase, state, evidence) => result(phase, 'Observe', `observed ${state}`, { lifecycleUpdate: { operationId: op.id, state, ...evidence } });
    if (['withheld', 'failed'].includes(op.state)) return hold(`${op.state}; delegate never retried: ${op.reason}`);
    if (op.contextLoss && op.history.includes('close-intent')) {
      const removed = unexpectedWorkspaceRemoval(o, op.target);
      if (removed) return hold(removed);
    }
    if (op.participants.some(p => !input.inspection.entries.some(e => e.manifest.metadata.uid === p.uid &&
        e.manifest.metadata.generation === p.generation && specDigest(e) === p.specDigest))) return hold('manifest changed during lifecycle operation');
    if (op.contextLoss) {
      const veto = boundaryVeto(entry, input, op.participants, op.request, op.mode === 'reconstruct', true);
      if (veto) return hold(veto);
    }
    if (op.state === 'close-intent') {
      const proof = closeProof(op, input);
      return proof ? update('ClosedForReset', 'closed-for-reset', { closeReceipt: proof }) : hold('close acknowledgement or absence uncertain; observe, never close or spawn twice');
    }
    if (['closed-for-reset', 'respawn-pending'].includes(op.state)) {
      const veto = topology(input, op.participants, { absent: true });
      if (veto) return hold(veto);
      if (op.kind === 'recovery') {
        const veto = recoveryVeto(entry, input, op.participants[0], op.request);
        if (veto) return hold(veto);
      }
      return action('respawn');
    }
    if (['respawn-intent', 'resume-intent', 'recovery-required'].includes(op.state)) {
      if (op.kind === 'recovery' && !op.contextLoss) {
        const veto = recoveryVeto(entry, input, op.participants[0], op.request);
        if (veto) return hold(veto);
      }
      const kind = op.mode === 'native-restore' ? 'native-restore' : op.state === 'respawn-intent' ? 'respawn' : 'resume';
      const proof = incarnationProof(op, input, kind);
      if (proof) return update('Restarted', 'restarted', { receipt: proof });
      if (op.state !== 'recovery-required') return hold('create/resume acknowledgement uncertain; observe, never spawn twice');
      const veto = recoveryVeto(entry, input, op.participants[0], op.request);
      if (veto) return hold(veto);
      if (op.mode === 'native-restore') return hold('native restore resumed without exact incarnation receipt; no controller spawn');
      if (op.mode === 'reconstruct') {
        const why = topology(input, op.participants, { loss: true, quiescent: true, closing: true });
        return why ? hold(why) : action('close');
      }
      const why = processTopology(input, op.participants[0], true);
      return why ? hold(why) : action('resume');
    }
    if (['reset-prepared'].includes(op.state)) {
      const veto = topology(input, op.participants, { quiescent: true, closing: true });
      return veto ? hold(veto) : action('close');
    }
    if (['restarted', 'inbox-pending', 'inbox-intent'].includes(op.state)) {
      const incarnations = input.journal.incarnations.filter(i => i.operationId === op.id);
      const bound = op.participants.map(p => ({ ...p, binding: incarnations.find(i => i.uid === p.uid)?.binding }));
      if (incarnations.length !== op.participants.length || (op.contextLoss ? topology(input, bound) : bound.some(p => processTopology(input, p)))) return hold('replacement binding changed before inbox handover');
      const ids = op.request.pendingInboxIds ?? [];
      if (!ids.length) return update('Restarted', 'acknowledged', {});
      if (['restarted', 'inbox-pending'].includes(op.state)) return action('transfer');
      const rows = receiptRows(o, op.id, 'inbox'), r = rows[0];
      return rows.length === 1 && validInboxReceipt(op, r, incarnations.map(i => i.id)) ? update('Restarted', 'acknowledged', { inboxReceipt: r }) :
        hold('inbox acknowledgement uncertain; preserve pending IDs, never redeliver blindly');
    }
    return hold('unknown lifecycle state');
  }
  if (!reset && !recovery && !loss) {
    if (!current?.receipt && current?.kind !== 'LogViewer') return null;
    // Full tab ownership is rechecked below for standard slots and logs pairs.
    const group = participantsFor(entry, input, slots);
    const why = group.error ?? topology(input, group.participants);
    if (why) return hold(why);
    const phase = current.run && (current.run.report || input.facts.reports[current.run.id]?.present) ? 'ParkedAwaitingReview' : 'Running';
    return make(phase, 'KEEP', 'matching recovered incarnation; historical run binding retained; no prompt replay', {
      observed: { binding: current.binding, incarnation: current.incarnation, run: current.run?.id,
        contextLoss: current.receipt?.contextLoss ?? false, parkedIntent: current.run ? { run: current.run.id, phase } : null } });
  }
  if (reset && entry.manifest.spec.intent.kind === 'work-item') return hold(resetAssessment(entry, input).vetoes[0]);
  const group = participantsFor(entry, input, slots, Boolean(reset) || recovery?.mode === 'reconstruct');
  if (group.error) return hold(group.error);
  const { participants, run } = group;
  let request, mode, kind, veto;
  if (reset) {
    if (input.journal.operations.some(op => isLifecycle(op) && op.uid === uid && op.request.boundary?.ref === reset.boundary?.ref)) {
      // A consumed boundary never rotates a second time.
      return make('Running', 'KEEP', 'handoff boundary already consumed; no second reset', { observed: { binding: current.binding } });
    }
    request = structuredClone(reset); mode = 'reset'; kind = 'reset';
    veto = boundaryVeto(entry, input, participants, request) ?? topology(input, participants, { quiescent: true, closing: true });
  } else {
    request = structuredClone(recovery ?? {}); kind = 'recovery';
    mode = loss?.restore?.state === 'resumed' ? 'native-restore' : request.mode;
    if (mode === 'native-restore') {
      if (!text(loss.restore.operationId) || input.journal.operations.some(op => op.id === loss.restore.operationId)) return hold('native restore receipt reference missing or already claimed');
      request.restoreOperationId = loss.restore.operationId;
    }
    if (!['resume', 'native-restore', 'reconstruct'].includes(mode)) return hold('RecoveryRequired: explicit recovery mode/context evidence required');
    veto = recoveryVeto(entry, input, participants[0], request);
    if (!veto && mode !== 'native-restore' && participants.some(p => p.kind === 'Session' && o.agents.some(a =>
      (a.agent_session?.value ?? a.agent_session_id) === p.binding.nativeSessionId))) veto = 'known native reference already observed; reconcile native restore owner before spawning';
    if (!veto && mode === 'reconstruct') veto = boundaryVeto(entry, input, participants, request, true);
    if (!veto && mode !== 'native-restore') veto = mode === 'reconstruct'
      ? topology(input, participants, { loss: true, quiescent: true, closing: true }) : processTopology(input, participants[0], true);
  }
  if (veto) return hold(veto);
  const contextLoss = ['reset', 'reconstruct'].includes(mode);
  request.pendingInboxIds = contextLoss ? [...new Set(participants.flatMap(p => input.facts.quiescence[p.uid].pendingInboxIds))] : [];
  if (contextLoss) request.quiescence = Object.fromEntries(participants.map(p => [p.uid, structuredClone(input.facts.quiescence[p.uid])]));
  const operation = { uid, kind, mode, generation: participants[0].generation, specDigest: participants[0].specDigest,
    target: targetOf(participants[0].binding), participants, request, contextLoss,
    contextHash: contextLoss ? request.handoff.digest : request.contextHash,
    parkedIntent: run ? { run: run.id, phase: run.report || input.facts.reports[run.id]?.present ? 'ParkedAwaitingReview' : 'Running', openChain: chain(input, run) } : null };
  const state = kind === 'reset' ? 'reset-prepared' : 'recovery-required';
  if (!validLifecycleOperation({ ...operation, id: mode === 'native-restore' ? request.restoreOperationId : 'planned', state, history: [state] })) return hold('invalid lifecycle evidence; hold');
  return make(kind === 'reset' ? 'Eligible' : 'RecoveryRequired', kind === 'reset' ? 'WouldReset' : 'WouldRecover',
    `${mode}${contextLoss ? ': context loss declared' : ': known native session'}; exact incarnation evidence verified`, {
      reset: { eligible: kind === 'reset', vetoes: [] }, recovery: { state: loss?.state ?? 'none', mode, contextLoss },
      observed: { binding: current.binding }, action: { kind: 'lifecycle', stage: mode === 'resume' ? 'resume' : mode === 'native-restore' ? 'adopt' : 'close', operation } });
}
