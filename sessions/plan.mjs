import { execFileSync } from 'node:child_process';
import { herdrSocketPath } from '../lanes/board/herdr-client.mjs';
import { inspect } from './sessions.mjs';
import { canonicalProject } from './project.mjs';
import { readStandardSlots } from './receipts.mjs';
import { createHerdrObserver, readSessionFacts } from './observe.mjs';
import { planSessions } from './reconcile.mjs';
import { emptyJournal, readControllerJournal, present, runtimePaths } from './runtime.mjs';

// No mkdir, lease acquisition, status write, journal append or record mutation.
export async function plan({ files = [], cwd = process.cwd(), workspace = 'home', env = process.env,
  observer, readFacts = readSessionFacts } = {}) {
  const inspection = inspect({ files, cwd, workspace, env }), { project } = inspection;
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
  let journal = emptyJournal(project.common), leaseHeld = true;
  try { journal = readControllerJournal(project.common); leaseHeld = present(runtimePaths(project.common).lease); }
  catch (error) { facts.errors.push(`controller evidence: ${error.message}`); }
  const owned = !observer;
  observer ??= createHerdrObserver({ socketPath: herdrSocketPath(env) });
  try { return planSessions({ inspection, enrollment, facts, observation: await observer.observe(), journal, leaseHeld }); }
  finally { if (owned) observer.close(); }
}
