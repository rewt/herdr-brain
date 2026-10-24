// Fresh native observation -> authorized durable KEEP. This module exposes no
// native mutation adapter and never prompts, spawns, closes, resumes or renames.
import fs from 'node:fs';
import path from 'node:path';
import { readPlainFile } from '../lib/files.mjs';
import { parseUniqueJson } from './json.mjs';
import { agentBinding, sameBinding } from './observe.mjs';
import { digest, specDigest, validBinding, validLaunchReceipt } from './lifecycle-evidence.mjs';
import { SLOT_PANES } from './manifest.mjs';
import { readStandardSlots, recordStandardSlot, slotReceiptFile, validateStandardSlots } from './receipts.mjs';
import { readControllerJournal, runtimePaths, durableWrite, present } from './runtime.mjs';
import { humanAnswerEvidence } from './authorization.mjs';
import { validAdoptOperation, verifyAdoptOperation } from './adoption-evidence.mjs';

function fail(message) { throw Error(`adoption held: ${message}`); }
export function adoptionScope({ inspection, observation: o, record, identity, selections, caller, requester, expiresAt, facts, now = Date.now }) {
  const { project } = inspection;
  if (!inspection.valid || !o.complete || o.errors?.length || facts.errors?.length || facts.stopped || facts.closeHold) fail('invalid desired state, incomplete observation, STOP or canonical close hold');
  if (!Array.isArray(selections) || !selections.length || new Set(selections.map(s => s.uid)).size !== selections.length || new Set(selections.map(s => s.tab)).size !== selections.length) fail('explicit unique standard-slot selections required');
  for (const [rows, keys] of [[o.workspaces, ['workspace_id']], [o.tabs, ['tab_id']], [o.panes, ['pane_id', 'terminal_id']], [o.agents, ['name', 'pane_id', 'terminal_id']]]) for (const key of keys) {
    const ids = rows.map(r => r[key]).filter(Boolean);
    if (new Set(ids).size !== ids.length) fail(`duplicate native ${key}`);
  }
  const sessionIds = o.agents.map(a => a.agent_session?.value ?? a.agent_session_id).filter(Boolean);
  if (new Set(sessionIds).size !== sessionIds.length) fail('duplicate native conversation');
  const selected = selections.map(selection => {
    const entry = inspection.entries.find(e => e.manifest.metadata.uid === selection.uid), spec = entry?.manifest.spec;
    if (!entry || !spec.standardSlot || spec.workspaceRef !== 'home') fail('selection requires an inspected home standard-slot UID');
    const tab = o.tabs.find(t => t.tab_id === selection.tab), w = o.workspaces.find(w => w.workspace_id === tab?.workspace_id);
    if (!w || w.worktree?.repo_key !== project.common || w.worktree.repo_root !== project.root || w.worktree.checkout_path !== project.root || w.worktree.is_linked_worktree !== false) fail('workspace is not the exact canonical non-linked home workspace');
    const panes = o.panes.filter(p => p.tab_id === selection.tab);
    if (panes.length !== SLOT_PANES[spec.standardSlot].length || panes.some(p => p.workspace_id !== w.workspace_id || p.launch_pending || p.restore_error)) fail('whole selected tab layout is incomplete, pending or has extra panes');
    const entries = inspection.entries.filter(e => e.manifest.spec.workspaceRef === 'home' && e.manifest.spec.standardSlot === spec.standardSlot);
    if (entries.length !== panes.length) fail('every selected tab pane needs one desired standard-slot member');
    const members = entries.map(e => {
      const paneSlot = e.manifest.spec.paneSlot ?? 'primary';
      const paneId = selection.panes?.[paneSlot] ?? (panes.length === 1 ? panes[0].pane_id : undefined);
      const pane = panes.find(p => p.pane_id === paneId);
      if (!pane) fail(`missing pane binding for ${paneSlot}`);
      if (pane.foreground_cwd !== project.root) fail('pane checkout differs from the canonical project');
      const live = o.agents.filter(a => a.pane_id === paneId);
      const viewer = e.manifest.kind === 'LogViewer';
      const binding = viewer ? (o.viewers ?? []).find(v => v.binding.pane === paneId)?.binding : live.length === 1 && agentBinding(live[0], o.server, tab.tab_id);
      if (!validBinding(binding, e.manifest.kind) || binding.workspace !== w.workspace_id || binding.checkout !== project.root || binding.tab !== tab.tab_id || binding.terminalId !== pane.terminal_id ||
          (viewer ? live.length !== 0 : live[0].tab_id !== tab.tab_id || live[0].workspace_id !== w.workspace_id || !['working', 'idle', 'done'].includes(live[0].agent_status ?? live[0].status))) fail('pane, terminal, native owner or conversation binding disagrees');
      if (pane.agent && pane.agent !== (live[0]?.agent ?? live[0]?.kind) || pane.agent_session?.value && pane.agent_session.value !== binding.nativeSessionId) fail('pane and native agent disagree');
      if (Object.values(facts.dispatches ?? {}).some(job => job.worker?.pane === paneId || job.worker?.agentName === binding.agentName)) fail('dispatch owns a selected occupant');
      return { uid: e.manifest.metadata.uid, generation: e.manifest.metadata.generation, specDigest: specDigest(e), kind: e.manifest.kind, paneSlot, binding };
    });
    if (new Set(members.map(m => m.binding.pane)).size !== panes.length) fail('duplicate selected pane ownership');
    return { uid: selection.uid, slot: { server: o.server, workspace: w.workspace_id, checkout: project.root, tab: tab.tab_id, standardSlot: spec.standardSlot,
      panes: members.map(m => ({ pane: m.binding.pane, paneSlot: m.paneSlot })) }, members };
  });
  if (new Set(selected.map(s => s.slot.workspace)).size !== 1) fail('all selections must belong to one home workspace');
  const supervisor = selected.flatMap(s => s.members).find(m => inspection.entries.find(e => e.manifest.metadata.uid === m.uid)?.manifest.spec.role === 'supervisor');
  if (!supervisor || !sameBinding(caller, supervisor.binding)) fail('invocation must be the same project supervisor in the selected workspace');
  if (typeof requester !== 'string' || !requester.trim() || typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now()) fail('requester and bounded future authorization expiry required');
  return { schema: 'config-home-adoption-scope/v1', purpose: 'adopt existing workspace and supervisor', common: project.common,
    checkout: project.root, record, identity, requester, expiresAt, slots: selected, caller };
}
export function authorizeAdoption(scope, ref, { now = Date.now, expiredReadback = false } = {}) {
  if (!expiredReadback && Date.parse(scope.expiresAt) <= now()) fail('enrollment authorization expired');
  return humanAnswerEvidence({ record: scope.record, ref, field: 'adoption_authorization', validateScope(expected) {
    if (digest(expected) !== digest(scope)) fail('owner answer does not authorize this exact saved adoption scope');
  } });
}
export function prepareObservedEnrollment({ scope, authorization, adoptionId, actor }) {
  const common = scope.common, evidenceFile = path.join(common, 'sessions/adoptions', `${adoptionId}.json`);
  const evidence = { schema: 'observed-adoption/v1', common, scope, authorization, slots: scope.slots };
  if (present(evidenceFile)) {
    if (digest(parseUniqueJson(readPlainFile(evidenceFile))) !== digest(evidence)) fail('frozen native adoption evidence changed');
  }
  const journal = readControllerJournal(common), history = readStandardSlots(common);
  if (history.errors.length) fail(history.errors.join('; '));
  if (journal.operations.some(op => op.state !== 'acknowledged' && !(op.kind === 'adopt-standard-slot' && op.adoptionId === adoptionId))) fail('pending controller operation; enrollment cannot clear it');
  const members = scope.slots.flatMap(s => s.members);
  if (journal.operations.some(op => op.adoptionId === adoptionId && !members.some(m => op.id === `adopt-${digest([adoptionId, m.uid]).slice(0, 24)}`))) fail('competing controller ownership outside the selected scope');
  const saved = present(slotReceiptFile(common)) ? parseUniqueJson(readPlainFile(slotReceiptFile(common))) : { schema: 'standard-slot-history/v1', common, operations: [] };
  const writes = [];
  const keepWrite = planned => ({ kind: 'keep', apply() {
    if (digest(recordStandardSlot({ cwd: scope.checkout, ...planned })) !== digest(planned)) fail('KEEP sequence changed; inspect the retained intent');
  } });
  for (const selected of scope.slots) {
    const receiptUid = `adopt:${digest([common, selected.slot.tab]).slice(0, 24)}`;
    const conflicting = history.slots.find(s => s.server === selected.slot.server && (s.tab === selected.slot.tab || s.workspace === selected.slot.workspace && s.standardSlot === selected.slot.standardSlot));
    if (conflicting && digest(Object.fromEntries(Object.keys(selected.slot).map(k => [k, conflicting[k]]))) !== digest(selected.slot)) fail('existing KEEP layout conflicts');
    // Controller-created slots already derive KEEP from their launch receipt;
    // they need neither a second predicted slot nor an adopt history entry.
    const savedKeep = conflicting && saved.operations.findLast(o => o.uid === conflicting.uid && o.action === 'adopt');
    let keep = Boolean(conflicting);
    const pending = journal.operations.find(op => op.kind === 'adopt-standard-slot' && op.adoptionId === adoptionId && op.keep.uid === receiptUid);
    const planned = savedKeep ?? pending?.keep.operation ?? { seq: saved.operations.length + 1, action: 'adopt', uid: receiptUid, actor, why: `Owner-authorized observed adoption ${adoptionId}`, at: new Date().toISOString(), slot: selected.slot };
    if (!keep) {
      saved.operations.push(planned);
      validateStandardSlots(saved, common);
      history.slots.push({ uid: planned.uid, common, ...planned.slot });
    }
    for (const member of selected.members) {
      const id = `adopt-${digest([adoptionId, member.uid]).slice(0, 24)}`;
      const prior = journal.operations.filter(op => op.uid === member.uid || ['server', 'workspace', 'tab', 'pane', 'checkout'].every(k => (op.receipt?.binding ?? op.binding ?? op.target)?.[k] === member.binding[k]));
      if (prior.some(op => ['start-standard-slot', 'create-standard-slot'].includes(op.kind) && op.state === 'acknowledged' && validLaunchReceipt(op, op.receipt) && sameBinding(op.receipt.binding, member.binding))) continue;
      // Re-adopting config does not replace a verified native ownership receipt.
      // Require one exact acknowledged UID/KEEP/binding and preserve its evidence.
      const observed = prior.length === 1 && prior[0];
      if (observed && observed.id !== id && observed.kind === 'adopt-standard-slot' && observed.state === 'acknowledged' &&
          observed.uid === member.uid && observed.generation === member.generation && observed.specDigest === member.specDigest && observed.nativeKind === member.kind &&
          observed.standardSlot === selected.slot.standardSlot && digest(observed.binding) === digest(member.binding) &&
          observed.keep.uid === receiptUid && observed.keep.sha256 === digest(planned) && verifyAdoptOperation(observed, common)) continue;
      if (prior.some(op => op.id !== id)) fail('competing controller ownership at selected standard position');
      let op = journal.operations.find(op => op.id === id);
      if (op && (op.adoptionId !== adoptionId || op.generation !== member.generation || op.specDigest !== member.specDigest ||
          digest(op.binding) !== digest(member.binding) || digest(op.authorization) !== digest(authorization) ||
          op.evidence.file !== evidenceFile || op.evidence.sha256 !== digest(evidence) || op.keep.sha256 !== digest(planned))) fail('frozen native enrollment intent changed');
      if (!op) {
        op = { id, kind: 'adopt-standard-slot', uid: member.uid, generation: member.generation, specDigest: member.specDigest,
          target: Object.fromEntries(['server', 'workspace', 'tab', 'pane', 'checkout'].map(k => [k, member.binding[k]])), standardSlot: selected.slot.standardSlot,
          binding: member.binding, nativeKind: member.kind, origin: 'observed-adoption', state: 'intent', adoptionId,
          keep: { uid: planned.uid, seq: planned.seq, sha256: digest(planned), operation: planned }, authorization, evidence: { file: evidenceFile, sha256: digest(evidence) } };
        if (!validAdoptOperation(op)) fail('invalid planned native enrollment');
        journal.operations.push(op);
        writes.push({ kind: 'intent', apply: () => durableWrite(runtimePaths(common).journal, journal) });
      }
      if (!keep) {
        if (digest(planned) !== op.keep.sha256) fail('KEEP sequence changed; inspect the retained intent');
        keep = true;
        writes.push(keepWrite(planned));
      }
      if (op.state !== 'acknowledged') writes.push({ apply: () => { op.state = 'acknowledged'; durableWrite(runtimePaths(common).journal, journal); } });
    }
    if (!keep) writes.push(keepWrite(planned));
  }
  return { enrollment: history, journal: { ...journal, operations: journal.operations.map(op => op.adoptionId === adoptionId ? { ...op, state: 'acknowledged' } : op) },
    commit({ afterIntent, afterKeep } = {}) {
      if (!present(evidenceFile)) durableWrite(evidenceFile, evidence);
      for (const write of writes) {
        write.apply();
        if (write.kind === 'intent') afterIntent?.();
        if (write.kind === 'keep') afterKeep?.();
      }
      const reread = readControllerJournal(common);
      if (reread.operations.some(op => op.adoptionId === adoptionId && op.state !== 'acknowledged')) fail('native enrollment read-back incomplete');
      return { operations: reread.operations.filter(op => op.adoptionId === adoptionId).map(op => op.id), evidenceFile };
    } };
}
export function enrollObserved(options) { return prepareObservedEnrollment(options).commit(options); }
