// Read-only ownership checks. Keep this import graph independent of cycle,
// transport and supervisor modules: the lane CLI loads it during promotion.
import fs from 'node:fs';
import path from 'node:path';
import { fold } from './state.mjs';
import { loadEvents, UserError } from './store.mjs';
import { gitProject } from './project.mjs';
import { checkFleetRecord } from './fleet.mjs';
import { projectEnvironment } from './releases.mjs';

export const BRAIN_CONTROLLER = 'brain';
const fail = (code, message) => { throw Object.assign(new UserError(`${code}: ${message}`), { code }); };
export const equalRelease = (a, b) => a === b || (!!a && !!b && ['id', 'commit', 'root', 'identity'].every(k => a[k] === b[k]));
export const sameOwner = (a, b) => !!a && !!b && a.controller === b.controller && a.legacy === b.legacy && equalRelease(a.release, b.release);
export const ownerBinding = run => ({ owner: run.owner, generation: run.owner_generation });

function namespace(org, cwd = path.dirname(org)) {
  const fleet = checkFleetRecord(org);
  if (fleet) return { record: fs.realpathSync(org), project: fs.realpathSync(fleet.identity) };
  let project = null;
  for (const candidate of [path.dirname(org), cwd]) {
    try { project = gitProject(candidate, { env: projectEnvironment() }).identity; break; } catch { /* A standalone record has no project. */ }
  }
  return { record: fs.realpathSync(org), project };
}
export function validateOwner(owner) {
  if (!owner || typeof owner.controller !== 'string' || !/^[\w][\w.:-]*$/.test(owner.controller) || typeof owner.legacy !== 'boolean' ||
      (!owner.release && !owner.legacy) || (owner.release && (!path.isAbsolute(owner.release.root ?? '') ||
        typeof owner.release.id !== 'string' || !(owner.release.id === 'source' && owner.release.commit === null
          ? path.isAbsolute(owner.release.identity ?? '') : /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(owner.release.commit ?? '')))))
    fail('RUN_CLAIM_INVALID', 'expected controller, legacy and exact installed release or canonical source identity (or null for legacy)');
  return { controller: owner.controller, release: owner.release ? Object.fromEntries(['id', 'commit', 'root', ...(owner.release.identity ? ['identity'] : [])].map(k => [k, owner.release[k]])) : null, legacy: owner.legacy };
}
export function readOwnedRun(org, id, events) {
  const loaded = events ? { events } : loadEvents(org);
  if (loaded.tornTail) fail('RUN_CLAIM_INVALID', 'incomplete record event');
  const run = fold(loaded.events).runs.get(id);
  if (!run) fail('RUN_CLAIM_INVALID', `unknown run ${id}`);
  if (run.owner) {
    const event = loaded.events.find(e => e.seq === run.owner_generation);
    if (event.record !== fs.realpathSync(org)) fail('RUN_CLAIM_INVALID', 'claim record identity changed');
    if (event.project) {
      // A completed promotion may already have removed its lane checkout.
      // The canonical common-directory binding survives that removal.
      const fleet = checkFleetRecord(org);
      if (fleet && fs.realpathSync(fleet.identity) !== event.project) fail('RUN_CLAIM_INVALID', 'claim fleet project identity changed');
      const candidates = [fleet?.checkout, path.dirname(org), run.workspace, path.dirname(event.project)].filter(Boolean);
      let matched = false;
      for (const cwd of candidates) {
        try { if (gitProject(cwd, { env: projectEnvironment() }).identity === event.project) { matched = true; break; } }
        catch { /* A removed lane or separate metadata directory is not a checkout. */ }
      }
      if (!matched) fail('RUN_CLAIM_INVALID', 'claim canonical project identity changed or is unavailable');
    } else if (namespace(org, run.workspace ?? path.dirname(org)).project !== null) {
      fail('RUN_CLAIM_INVALID', 'standalone claim acquired a different project identity');
    }
    validateOwner(run.owner);
  }
  return run;
}
export function assertOwner(run, expected) {
  if (!run.owner) fail('RUN_OWNER_UNCLAIMED', `${run.id} has no exclusive owner; inventory legacy work and use record claim explicitly (--admit-worker for its sole worker, --adopt-brain-receipt FILE for a saved Brain release)`);
  if (!sameOwner(run.owner, expected?.owner) || run.owner_generation !== expected?.generation)
    fail('RUN_OWNED_ELSEWHERE', `${run.id} owner=${JSON.stringify(run.owner)} generation=${run.owner_generation}`);
  return run;
}
export function requireController(run, controller = BRAIN_CONTROLLER) {
  if (!run.owner) return assertOwner(run);
  if (run.owner.controller !== controller || run.owner.legacy)
    fail('RUN_OWNED_ELSEWHERE', `${run.id} owner=${JSON.stringify(run.owner)} generation=${run.owner_generation}`);
  return ownerBinding(run);
}
export function adoptedPromotionBinding(org, run, job) {
  if (!run.owner || run.owner.legacy || job.ownership) return false;
  const claim = loadEvents(org).events.find(e => e.seq === run.owner_generation);
  const adoption = claim?.adoption;
  return !!adoption && equalRelease(adoption.release, job.release) && adoption.release.protocol === job.release?.protocol &&
    run.owner.release.root === adoption.release.root;
}
export function guardPromotionJob(job) {
  if (!job.run) return;
  // Admission's durable queue member fences transfer through completion,
  // delivery and cleanup. A restart still verifies that exact claim binding.
  const run = readOwnedRun(job.org, job.run);
  if (job.ownership) assertOwner(run, job.ownership);
  else if (run.owner && !run.owner.legacy && !adoptedPromotionBinding(job.org, run, job)) fail('RUN_OWNED_ELSEWHERE', `${run.id} owner=${JSON.stringify(run.owner)}`);
}

export { namespace as ownerNamespace };
