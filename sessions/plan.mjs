import { execFileSync } from 'node:child_process';
import { herdrSocketPath } from '../lanes/board/herdr-client.mjs';
import { inspect } from './sessions.mjs';
import { canonicalProject } from './project.mjs';
import { readStandardSlots } from './receipts.mjs';
import { createHerdrObserver, readSessionFacts } from './observe.mjs';
import { planSessions } from './reconcile.mjs';
import { digest } from './lifecycle-evidence.mjs';
import { observeLive } from './live-observe.mjs';
import { emptyJournal, readControllerJournal, present, runtimePaths } from './runtime.mjs';

// No mkdir, lease acquisition, status write, journal append or record mutation.
export function planInputs({ files = [], cwd = process.cwd(), workspace = 'home', env = process.env,
  observer, readFacts = readSessionFacts, evidence } = {}) {
  const inspection = inspect({ files, cwd, workspace, env }), { project } = inspection;
  const owned = !observer;
  observer ??= createHerdrObserver({ socketPath: herdrSocketPath(env) });
  const read = async () => {
    const enrollment = readStandardSlots(project.common);
    const facts = readFacts({ project, env, items: inspection.entries.filter(e => e.manifest.spec.intent.kind === 'work-item').map(e => e.manifest.spec.intent.item) });
    facts.workspaceRefs = {};
    for (const slot of enrollment.slots) {
      try {
        if (canonicalProject(slot.checkout).common !== project.common) throw Error('receipt checkout belongs to another project');
        const branch = execFileSync('git', ['-C', slot.checkout, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        (facts.workspaceRefs[branch] ??= []).push(slot.workspace);
      } catch (error) { facts.errors.push(`workspace binding ${slot.workspace}: ${error.message}`); }
    }
    const { observation, experiment } = await observeLive({ observer, project, workspace, evidence, env });
    if (experiment) for (const key of ['resetRequests', 'recovery', 'quiescence']) facts[key] = experiment[key];
    return { enrollment, facts, observation, env };
  };
  return { inspection, read, observer, close() { if (owned) observer.close(); } };
}
export const selectionDigest = plan => digest({ project: plan.project, valid: plan.valid, errors: plan.errors,
  decisions: plan.decisions, action: plan.action });
export function stampPlan(plan, workspace, now = Date.now) {
  return { ...plan, workspace, observedAt: new Date(now()).toISOString(), selectionDigest: selectionDigest(plan) };
}
export async function plan(options = {}) {
  const inputs = planInputs(options), { inspection } = inputs, { project } = inspection;
  try {
    let journal = emptyJournal(project.common), leaseHeld = true;
    const data = await inputs.read();
    try { journal = readControllerJournal(project.common); leaseHeld = present(runtimePaths(project.common).lease); }
    catch (error) { data.facts.errors.push(`controller evidence: ${error.message}`); }
    return stampPlan(planSessions({ inspection, ...data, journal, leaseHeld }), options.workspace ?? 'home', options.now);
  } finally { inputs.close(); }
}
