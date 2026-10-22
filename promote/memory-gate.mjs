import fs from 'node:fs';
import path from 'node:path';
import { waitForMemory } from '../lib/memory.mjs';
import { waitForProvingHold } from '../test-slot/reservations.mjs';
import { admissionDeadline } from '../lib/deadline.mjs';
import { waitSecondsOf, WAIT_ENV, LEGACY_WAIT_ENV } from '../test-slot/test-slot.mjs';
import { writeFileAtomic } from '../lib/files.mjs';
import { gitProject } from '../lib/project.mjs';
import { executionIdentity } from './execution-identity.mjs';

// An initial wait owns no promotion resources. Every re-check by a lock owner
// has a fixed allowance, independent of the (potentially hours-long) slot wait.
export const MEMORY_RECHECK_MS = 5000;
export function waitForPromotionMemory(canonical, { held = false, checkStop = true, deadline, clock = () => performance.now() } = {}) {
  try {
    const stop = () => {
      if (fs.existsSync(path.join(canonical, '.lane/supervisor/STOP'))) {
        throw Object.assign(new Error('PROMOTION_STOPPED: supervisor STOP exists; nothing merged'), { code: 'PROMOTION_STOPPED' });
      }
    };
    const check = () => { if (checkStop) stop(); };
    if (!held) {
      // Match the existing train slot allowance, including explicit zero.
      if (deadline === undefined) {
        const seconds = waitSecondsOf({ [WAIT_ENV]: process.env[WAIT_ENV] ?? process.env[LEGACY_WAIT_ENV] ?? '7200' });
        deadline = admissionDeadline({ budgetMs: seconds * 1000, now: clock, allowance: ms => ms });
      }
      // A resumed train may reconcile under STOP when no new launch is held.
      // STOP still cancels an actual reservation wait, preserving its receipt.
      waitForProvingHold({ label: 'lane promote', deadline, clock,
        check: ({ waiting = false } = {}) => { if (checkStop || waiting) stop(); } });
    }
    return waitForMemory({ label: 'lane promote', check, ...(held ? { maxWaitMs: MEMORY_RECHECK_MS, intervalMs: 1000 } : {}) });
  } catch (error) {
    if (error.code === 'MEMORY_PRESSURE_TIMEOUT') throw Object.assign(
      new Error(`PROMOTION_MEMORY_PRESSURE: ${error.message}; locks released on exit; enqueue again when pressure clears`),
      { code: 'PROMOTION_MEMORY_PRESSURE' });
    throw error;
  }
}

// Only a fresh plan can be completed as a pre-execution refusal. A resumed
// attempt may have integrated before losing its response; retain its checkpoint.
export function refuseBeforeTrain({ file, identity, error }) {
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (plan.schema === 'promotion-train/v2') {
    const project = gitProject(process.cwd());
    if (project.identity !== identity) throw Error('train project identity changed');
    for (const job of plan.jobs ?? []) executionIdentity(project, { bound: job.execution_identity ?? null });
  }
  if (!['promotion-train/v1', 'promotion-train/v2'].includes(plan.schema) || plan.identity !== identity || !Array.isArray(plan.jobs)) throw new Error('invalid train receipt');
  if (plan.attempts?.length) throw error;
  plan.results ??= {};
  for (const job of plan.jobs) plan.results[job.id] ??= { outcome: 'refused', code: error.code, reason: error.message, batch: plan.id };
  plan.groups = []; plan.phase = 'complete';
  writeFileAtomic(file, JSON.stringify(plan, null, 2) + '\n', 0o600);
}
