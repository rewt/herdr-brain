// Explicit supervisor receipt. This command records scope; it never observes or
// mutates Herdr, enrolls a workspace, changes a hold, or writes record events.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { findOrgDir } from '../lib/store.mjs';
import { humanAnswerEvidence } from '../lib/human-answer.mjs';
export { humanAnswerEvidence } from '../lib/human-answer.mjs';
import { readPlainFile } from '../lib/files.mjs';
import { canonicalProject } from './project.mjs';
import { readStandardSlots } from './receipts.mjs';
import { parseUniqueJson } from './json.mjs';
import { durableWrite, acquireControllerLease } from './runtime.mjs';
import { digest, strings, text } from './lifecycle-evidence.mjs';

export const ACTIONS = ['start-standard-slot', 'create-standard-slot', 'close', 'respawn', 'resume', 'transfer'];
export function enrolledWorkspace(project, ref) {
  if (!text(ref)) throw Error('an explicit --workspace is required');
  const enrollment = readStandardSlots(project.common);
  if (enrollment.errors.length) throw Error(enrollment.errors.join('; '));
  const slots = enrollment.slots.filter(s => {
    if (canonicalProject(s.checkout).common !== project.common) throw Error('foreign enrolled checkout');
    if (ref === 'home') return s.checkout === project.root;
    if (s.workspace === ref) return true;
    try { return execFileSync('git', ['-C', s.checkout, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() === ref; }
    catch { return false; }
  });
  if (!slots.length || new Set(slots.map(s => JSON.stringify([s.server, s.workspace, s.checkout]))).size !== 1)
    throw Error('workspace requires one exact canonical standard-slot enrollment');
  // Bind the original enrollment history. Replacement KEEP layouts may grow.
  const originals = slots.filter(s => !s.controllerOperation);
  return { ref, server: slots[0].server, workspace: slots[0].workspace, checkout: slots[0].checkout,
    enrollmentDigest: digest(originals), slots };
}
function decisionEvidence(project, env, ref, workspace, actions) {
  const org = findOrgDir({ cwd: project.root, env });
  if (!org) throw Error('operator decision requires the project record');
  return humanAnswerEvidence({ record: org, ref, field: 'session_authorization', validateScope(scope) {
  const keys = ['schema', 'common', 'server', 'workspace', 'checkout', 'actions'];
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).length !== keys.length ||
      Object.keys(scope).some(k => !keys.includes(k)) || scope.schema !== 'session-authorization-scope/v1' ||
      scope.common !== project.common || !['server', 'workspace', 'checkout'].every(k => scope[k] === workspace[k]) ||
      !strings(scope.actions) || !scope.actions.length || scope.actions.some(a => !ACTIONS.includes(a)) ||
      !strings(actions) || !actions.length || actions.some(a => !scope.actions.includes(a)))
    throw Error('operator decision workspace or action scope mismatch');
  } });
}
export function validateAuthorization(r) {
  const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => keys.includes(k));
  const w = r?.workspace, d = r?.operatorDecision;
  if (!exact(r, ['schema', 'id', 'common', 'workspace', 'actions', 'operatorDecision', 'actor', 'createdAt', 'expiresAt']) ||
      r.schema !== 'session-authorization/v1' || !text(r.id) || !path.isAbsolute(r.common ?? '') ||
      !exact(w, ['ref', 'server', 'workspace', 'checkout', 'enrollmentDigest']) ||
      !['ref', 'server', 'workspace', 'checkout'].every(k => text(w[k])) || !/^[a-f0-9]{64}$/u.test(w.enrollmentDigest ?? '') ||
      !strings(r.actions) || !r.actions.length || r.actions.some(k => !ACTIONS.includes(k)) || !text(r.actor) ||
      !exact(d, ['record', 'id', 'seq', 'sha256']) || !path.isAbsolute(d.record ?? '') || !text(d.id) ||
      !Number.isSafeInteger(d.seq) || d.seq < 1 || !/^[a-f0-9]{64}$/u.test(d.sha256 ?? '') ||
      ![r.createdAt, r.expiresAt].every(v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/u.test(v) && Number.isFinite(Date.parse(v))) ||
      Date.parse(r.expiresAt) <= Date.parse(r.createdAt)) throw Error('invalid session authorization receipt');
  return r;
}
export function authorize({ cwd = process.cwd(), workspace, actions, operatorDecision, expiresAt, role, actor,
  env = process.env, now = Date.now } = {}) {
  const project = canonicalProject(cwd);
  if (role !== 'supervisor' || fs.realpathSync(cwd) !== project.root) throw Error('authorize requires --role supervisor from the canonical checkout');
  if (!operatorDecision || !Number.isSafeInteger(operatorDecision.seq)) throw Error('operator decision id and sequence required');
  const createdAt = new Date(now()).toISOString();
  const { slots, ...bound } = enrolledWorkspace(project, workspace);
  const receipt = validateAuthorization({ schema: 'session-authorization/v1', id: randomUUID(), common: project.common,
    workspace: bound, actions,
    operatorDecision: decisionEvidence(project, env, operatorDecision, bound, actions), actor, createdAt, expiresAt });
  if (Date.parse(expiresAt) <= now()) throw Error('authorization already expired');
  const release = acquireControllerLease(project.common);
  try {
    const file = path.join(project.common, 'sessions/authorizations', `${receipt.id}.json`);
    durableWrite(file, receipt);
    return { file, receipt };
  } finally { release(); }
}
export function checkAuthorization({ file, project, workspace, action, env = process.env, now = Date.now }) {
  if (!file) throw Error('explicit --authorization receipt required');
  const r = validateAuthorization(parseUniqueJson(readPlainFile(file)));
  if (path.resolve(file) !== path.join(project.common, 'sessions/authorizations', `${r.id}.json`)) throw Error('authorization must be the canonical command receipt');
  const { slots, ...bound } = enrolledWorkspace(project, workspace);
  if (r.common !== project.common || digest(r.workspace) !== digest(bound)) throw Error('authorization workspace or enrollment mismatch');
  if (Date.parse(r.createdAt) > now() || Date.parse(r.expiresAt) <= now()) throw Error('authorization expired or not yet valid');
  if (digest(decisionEvidence(project, env, r.operatorDecision, bound, r.actions)) !== digest(r.operatorDecision)) throw Error('operator decision evidence changed');
  if (action && !r.actions.includes(action.kind === 'lifecycle' ? action.stage : action.kind)) throw Error(`action kind is not authorized: ${action.kind === 'lifecycle' ? action.stage : action.kind}`);
  return r;
}
