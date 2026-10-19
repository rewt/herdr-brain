// Read-only handoff verification and closed journal shapes. No native calls.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readPlainFile, writeFileAtomic } from '../lib/files.mjs';
import { hookHandoff } from '../messages/hook-pull.mjs';

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const digest = value => createHash('sha256').update(JSON.stringify(stable(value)) ?? 'undefined').digest('hex');
export const specDigest = entry => digest({ kind: entry.manifest.kind, spec: entry.resolvedSpec });
export const text = value => typeof value === 'string' && Boolean(value.trim());
export const strings = value => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
export const bindingKeys = ['server', 'workspace', 'tab', 'pane', 'checkout', 'terminalId', 'agentName', 'nativeSessionId'];
export const validBinding = (b, kind = 'Session') => exact(b, bindingKeys) &&
  bindingKeys.slice(0, 6).every(k => text(b[k])) && (kind === 'LogViewer' ? b.agentName == null && b.nativeSessionId == null :
    text(b.agentName) && text(b.nativeSessionId));
export const equalBinding = (a, b) => Boolean(a && b && bindingKeys.every(k => (a[k] ?? null) === (b[k] ?? null)));
export const sameStrings = (a, b) => strings(a) && strings(b) && a.length === b.length && a.every(v => b.includes(v));
const handoffBody = h => ({ file: h.file, sha256: h.sha256, recordRefs: h.recordRefs,
  unresolvedMessageIds: h.unresolvedMessageIds, inboxCursor: h.inboxCursor });
export const validHandoff = h => exact(h, ['file', 'sha256', 'recordRefs', 'unresolvedMessageIds', 'inboxCursor', 'digest']) &&
  path.isAbsolute(h.file ?? '') && /\.md$/u.test(h.file) && hash(h.sha256) && strings(h.recordRefs) &&
  strings(h.unresolvedMessageIds) && text(h.inboxCursor) && h.digest === digest(handoffBody(h));
export function verifyHandoff(h) {
  if (!validHandoff(h)) throw Error('invalid handoff descriptor or metadata hash');
  const markdown = readPlainFile(h.file);
  if (!markdown.trim() || createHash('sha256').update(markdown).digest('hex') !== h.sha256) throw Error('handoff hash mismatch');
  return h;
}
// A caller can also supply an already persisted handoff; every observation
// re-reads its bytes. This helper gives fixture/context owners durable output.
export function persistHandoff({ file, markdown, recordRefs, unresolvedMessageIds, inboxCursor, hookSession }) {
  if (hookSession) {
    const claims = hookHandoff(hookSession);
    markdown += `\n${claims.markdown}`;
    unresolvedMessageIds = [...new Set([...unresolvedMessageIds, ...claims.claimedIds])];
  }
  if (typeof markdown !== 'string' || !markdown.trim()) throw Error('empty Markdown handoff');
  const h = { file, sha256: createHash('sha256').update(markdown).digest('hex'), recordRefs, unresolvedMessageIds, inboxCursor };
  h.digest = digest(h);
  if (!validHandoff(h)) throw Error('invalid handoff');
  writeFileAtomic(file, markdown, 0o600);
  for (const target of [file, path.dirname(file)]) {
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  return h;
}
export const states = ['reset-prepared', 'recovery-required', 'close-intent', 'closed-for-reset', 'respawn-intent', 'respawn-pending',
  'resume-intent', 'restarted', 'inbox-intent', 'inbox-pending', 'acknowledged', 'withheld', 'failed'];
const edges = {
  'reset-prepared': ['close-intent', 'withheld'], 'recovery-required': ['close-intent', 'resume-intent', 'restarted', 'withheld'],
  'close-intent': ['closed-for-reset', 'withheld', 'failed'], 'closed-for-reset': ['respawn-intent', 'respawn-pending', 'withheld'],
  'respawn-intent': ['restarted', 'respawn-pending', 'withheld', 'failed'], 'respawn-pending': ['respawn-intent', 'respawn-pending'],
  'resume-intent': ['restarted', 'withheld', 'failed'],
  restarted: ['inbox-intent', 'inbox-pending', 'acknowledged', 'withheld'], 'inbox-intent': ['acknowledged', 'inbox-pending', 'withheld', 'failed'],
  'inbox-pending': ['inbox-intent', 'inbox-pending'],
};
export function validParticipant(p) {
  return exact(p, ['uid', 'generation', 'specDigest', 'kind', 'spec', 'binding', 'incarnation']) && text(p.uid) &&
    Number.isSafeInteger(p.generation) && p.generation > 0 && ['Session', 'LogViewer'].includes(p.kind) && object(p.spec) &&
    p.specDigest === digest({ kind: p.kind, spec: p.spec }) && validBinding(p.binding, p.kind) && text(p.incarnation);
}
export function validStartOperation(op) {
  const create = op.kind === 'create-standard-slot', keys = create ? ['server', 'workspace', 'checkout'] : bindingKeys.slice(0, 5);
  return exact(op, ['id', 'uid', 'kind', 'generation', 'specDigest', 'target', 'spec', 'state', 'receipt', 'reason', 'disposition', ...(create ? ['standardSlot'] : [])]) &&
    (create || op.kind === 'start-standard-slot') && text(op.id) && text(op.uid) && hash(op.specDigest) && object(op.spec) &&
    (!create || ['chat', 'supervisor'].includes(op.spec.role) && op.standardSlot === op.spec.role && op.spec.standardSlot === op.standardSlot && op.spec.intent?.kind !== 'work-item') &&
    Number.isSafeInteger(op.generation) && op.generation > 0 && exact(op.target, keys) &&
    keys.every(k => text(op.target[k])) && ['intent', 'acknowledged', 'withheld', 'never-started'].includes(op.state) &&
    (op.state === 'never-started' ? !op.receipt && validStartDisposition(op, op.disposition?.request) &&
      exact(op.disposition, ['request', 'recordedAt', 'observationDigest']) &&
      Number.isFinite(Date.parse(op.disposition.recordedAt)) && hash(op.disposition.observationDigest) : op.disposition === undefined) &&
    (op.state !== 'withheld' || text(op.reason)) && (op.state !== 'acknowledged' || validLaunchReceipt(op, op.receipt));
}
export function validLaunchReceipt(op, receipt) {
  const keys = op.kind === 'create-standard-slot' ? ['server', 'workspace', 'checkout'] : bindingKeys.slice(0, 5);
  return receipt?.operationId === op.id && receipt.uid === op.uid && receipt.generation === op.generation && receipt.specDigest === op.specDigest &&
    validBinding(receipt.binding, op.spec.viewer ? 'LogViewer' : 'Session') && keys.every(k => receipt.binding[k] === op.target[k]);
}
// A supervisor's historical claim, bound to the exact unresolved intent and
// hashed source files. Native absence alone is never proof of non-invocation.
export function validStartDisposition(op, d) {
  const intent = { ...op, state: 'intent' }; delete intent.disposition;
  return exact(d, ['schema', 'common', 'operationId', 'operationDigest', 'target', 'outcome', 'launchInvoked',
    'shellOnly', 'agentPresent', 'sessionPresent', 'launchPending', 'role', 'actor', 'observedAt', 'reason', 'evidence']) &&
    d.schema === 'session-start-disposition/v1' && path.isAbsolute(d.common ?? '') && d.operationId === op.id &&
    d.operationDigest === digest(intent) && exact(d.target, bindingKeys.slice(0, 6)) && text(d.target.terminalId) &&
    bindingKeys.slice(0, 5).every(k => d.target[k] === op.target[k]) &&
    d.outcome === 'never-started' && d.launchInvoked === false && d.shellOnly === true && d.agentPresent === false &&
    d.sessionPresent === false && d.launchPending === false && d.role === 'supervisor' && text(d.actor) &&
    Number.isFinite(Date.parse(d.observedAt)) && text(d.reason) && Array.isArray(d.evidence) && d.evidence.length > 0 &&
    d.evidence.every(e => exact(e, ['file', 'sha256']) && path.isAbsolute(e.file ?? '') && hash(e.sha256)) &&
    new Set(d.evidence.map(e => e.file)).size === d.evidence.length;
}
export function validIncarnation(i) {
  return exact(i, ['id', 'uid', 'operationId', 'previous', 'generation', 'specDigest', 'kind', 'binding', 'contextLoss', 'contextHash']) &&
    ['id', 'uid', 'operationId', 'previous'].every(k => text(i[k])) && Number.isSafeInteger(i.generation) && i.generation > 0 &&
    hash(i.specDigest) && ['Session', 'LogViewer'].includes(i.kind) && validBinding(i.binding, i.kind) &&
    typeof i.contextLoss === 'boolean' && hash(i.contextHash);
}
export function validCloseReceipt(op, r) {
  return exact(r, ['operationId', 'kind', 'uid', 'target', 'bindings']) && r.operationId === op.id && r.kind === 'close' &&
    r.uid === op.uid && digest(r.target) === digest(op.target) && digest(r.bindings) === digest(op.participants.map(p => p.binding));
}
export function validMaterializationReceipt(op, r) {
  const kind = op.contextLoss ? 'respawn' : op.mode === 'native-restore' ? 'native-restore' : 'resume';
  if (!exact(r, ['operationId', 'kind', 'uid', 'contextHash', 'incarnations']) || r.operationId !== op.id || r.kind !== kind ||
      r.uid !== op.uid || r.contextHash !== op.contextHash || !Array.isArray(r.incarnations) || r.incarnations.length !== op.participants.length ||
      new Set(r.incarnations.map(i => i.id)).size !== r.incarnations.length) return false;
  return op.participants.every(p => {
    const rows = r.incarnations.filter(i => i.uid === p.uid), i = rows[0], b = i?.binding;
    return rows.length === 1 && exact(i, ['id', 'uid', 'generation', 'specDigest', 'previous', 'binding', 'contextHash', 'contextVerified', 'route']) &&
      text(i.id) && i.id !== p.incarnation && i.previous === p.incarnation && validBinding(b, p.kind) &&
      i.generation === p.generation && i.specDigest === p.specDigest && digest(i.route ?? null) === digest(p.spec.resolvedRoute ?? null) &&
      i.contextVerified === true && i.contextHash === op.contextHash &&
      ['server', 'workspace', 'checkout'].every(k => b[k] === p.binding[k]) && b.terminalId !== p.binding.terminalId &&
      (p.kind === 'LogViewer' || (op.contextLoss ? b.nativeSessionId !== p.binding.nativeSessionId : b.nativeSessionId === p.binding.nativeSessionId)) &&
      (op.contextLoss ? b.tab !== p.binding.tab && b.pane !== p.binding.pane : b.tab === p.binding.tab && b.pane === p.binding.pane);
  }) && new Set(r.incarnations.map(i => i.binding.pane)).size === r.incarnations.length &&
    new Set(r.incarnations.map(i => i.binding.terminalId)).size === r.incarnations.length &&
    new Set(r.incarnations.map(i => i.binding.tab)).size === 1;
}
export const validInboxReceipt = (op, r, ids) => exact(r, ['operationId', 'kind', 'uid', 'messageIds', 'cursor', 'incarnationIds']) &&
  r.operationId === op.id && r.kind === 'inbox' && r.uid === op.uid && sameStrings(r.messageIds, op.request.pendingInboxIds) &&
  r.cursor === op.request.handoff.inboxCursor && sameStrings(r.incarnationIds, ids);
function validRequest(op) {
  const r = op.request;
  if (!exact(r, ['boundary', 'handoff', 'pendingInboxIds', 'contextRef', 'contextVerified', 'contextHash', 'nativeSessionId', 'route',
    'mode', 'refused', 'disposition', 'restoreOperationId', 'quiescence']) || !strings(r.pendingInboxIds)) return false;
  if (!op.contextLoss) return !r.pendingInboxIds.length && r.contextVerified === true && r.contextHash === op.contextHash && text(r.contextRef) &&
    digest(r.route ?? null) === digest(op.participants[0].spec.resolvedRoute ?? null) &&
    (op.mode !== 'native-restore' || r.restoreOperationId === op.id) &&
    (op.participants[0].kind === 'LogViewer' || r.nativeSessionId === op.participants[0].binding.nativeSessionId);
  if (!validHandoff(r.handoff) || op.contextHash !== r.handoff.digest ||
      !exact(r.boundary, ['kind', 'ref', 'declared', 'draft', 'committed', 'batchRef', 'cursor', 'viewerCursor']) || !text(r.boundary.ref) ||
      !object(r.quiescence) || Object.keys(r.quiescence).length !== op.participants.length) return false;
  return op.participants.every(p => {
    const q = r.quiescence[p.uid], h = r.handoff;
    return exact(q, ['ref', 'binding', 'recordSeq', 'callbacksQuiesced', 'openWork', 'openReviews', 'inFlightDeliveries',
      'pendingInboxIds', 'recordRefs', 'unresolvedMessageIds', 'inboxCursor']) && text(q.ref) && equalBinding(q.binding, p.binding) &&
      Number.isSafeInteger(q.recordSeq) && q.recordSeq >= 0 && q.callbacksQuiesced === true && strings(q.openWork) && strings(q.openReviews) &&
      (op.mode === 'reconstruct' || !q.openWork.length && !q.openReviews.length) && strings(q.inFlightDeliveries) && !q.inFlightDeliveries.length &&
      strings(q.pendingInboxIds) && q.pendingInboxIds.every(id => h.unresolvedMessageIds.includes(id)) &&
      sameStrings(q.recordRefs, h.recordRefs) && sameStrings(q.unresolvedMessageIds, h.unresolvedMessageIds) && q.inboxCursor === h.inboxCursor;
  }) && sameStrings(r.pendingInboxIds, [...new Set(Object.values(r.quiescence).flatMap(q => q.pendingInboxIds))]);
}
export function validLifecycleOperation(op) {
  if (!exact(op, ['id', 'uid', 'kind', 'mode', 'generation', 'specDigest', 'target', 'participants', 'request', 'contextHash',
    'parkedIntent', 'state', 'history', 'reason', 'closeReceipt', 'receipt', 'inboxReceipt', 'contextLoss']) ||
    !text(op.id) || !text(op.uid) || !['reset', 'recovery'].includes(op.kind) ||
    !['reset', 'resume', 'native-restore', 'reconstruct'].includes(op.mode) || (op.kind === 'reset') !== (op.mode === 'reset') ||
    !Number.isSafeInteger(op.generation) || op.generation < 1 || !hash(op.specDigest) || !hash(op.contextHash) ||
    !Array.isArray(op.participants) || !op.participants.length || op.participants.some(p => !validParticipant(p)) ||
    new Set(op.participants.map(p => p.uid)).size !== op.participants.length ||
    op.participants[0].uid !== op.uid || op.specDigest !== op.participants[0].specDigest || op.generation !== op.participants[0].generation ||
    !exact(op.target, bindingKeys.slice(0, 5)) || !bindingKeys.slice(0, 5).every(k => op.target[k] === op.participants[0].binding[k]) ||
    op.participants.some(p => ['server', 'workspace', 'tab', 'checkout'].some(k => p.binding[k] !== op.target[k])) ||
    typeof op.contextLoss !== 'boolean' || op.contextLoss !== ['reset', 'reconstruct'].includes(op.mode) ||
    !object(op.request) || !states.includes(op.state) || !Array.isArray(op.history) || !op.history.length ||
    op.history[0] !== (op.kind === 'reset' ? 'reset-prepared' : 'recovery-required') || op.history.at(-1) !== op.state ||
    op.history.some((s, n) => !states.includes(s) || (n && !edges[op.history[n - 1]]?.includes(s))) ||
    ((['withheld', 'failed'].includes(op.state) || op.history.some(s => ['respawn-pending', 'inbox-pending'].includes(s))) && !text(op.reason))) return false;
  if (!validRequest(op)) return false;
  if (op.participants[0].spec.intent?.kind === 'work-item' && (!exact(op.parkedIntent, ['run', 'phase', 'openChain']) ||
      !text(op.parkedIntent.run) || !['Running', 'ParkedAwaitingReview'].includes(op.parkedIntent.phase) || !strings(op.parkedIntent.openChain))) return false;
  if (op.history.includes('closed-for-reset') && !validCloseReceipt(op, op.closeReceipt)) return false;
  if (op.history.includes('restarted') && !validMaterializationReceipt(op, op.receipt)) return false;
  if (op.history.includes('inbox-intent') && op.state === 'acknowledged' && !validInboxReceipt(op, op.inboxReceipt, op.receipt.incarnations.map(i => i.id))) return false;
  if (op.history.includes('respawn-pending') && !op.history.includes('closed-for-reset') ||
      op.history.includes('inbox-pending') && (!op.history.includes('restarted') || !op.request.pendingInboxIds.length)) return false;
  if (op.mode === 'reset' && op.history.includes('resume-intent') || !op.contextLoss && op.history.includes('close-intent') ||
      op.contextLoss && op.history.includes('restarted') && !op.history.includes('respawn-intent')) return false;
  return true;
}

export function validIncarnationLinks(journal) {
  const current = new Map();
  for (const i of journal.incarnations ?? []) {
    const op = journal.operations.find(op => op.id === i.operationId), p = op?.participants?.find(p => p.uid === i.uid);
    const r = op?.receipt?.incarnations?.find(r => r.id === i.id);
    const baseline = journal.bindings.find(b => b.uid === i.uid);
    const start = journal.operations.find(op => op.uid === i.uid && ['start-standard-slot', 'create-standard-slot'].includes(op.kind) && op.state === 'acknowledged');
    const prior = current.get(i.uid) ?? (baseline ? { id: `run:${baseline.run}`, binding: baseline.binding }
      : start ? { id: `start:${start.id}`, binding: start.receipt?.binding } : null);
    if (!p || !r || r.uid !== i.uid || i.previous !== prior?.id || p.incarnation !== prior?.id || !equalBinding(p.binding, prior.binding) ||
        i.generation !== p.generation || i.specDigest !== p.specDigest ||
        i.kind !== p.kind || i.contextLoss !== op.contextLoss || i.contextHash !== op.contextHash || !equalBinding(i.binding, r.binding)) return false;
    current.set(i.uid, i);
  }
  return journal.operations.filter(op => op.history?.includes('restarted')).every(op =>
    op.participants.length === journal.incarnations.filter(i => i.operationId === op.id).length);
}
