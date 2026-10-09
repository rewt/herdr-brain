import fs from 'node:fs';
import path from 'node:path';
import { waitForMemory } from '../lib/memory.mjs';
import { writeFileAtomic } from '../lib/files.mjs';

// An initial wait owns no promotion resources. Every re-check by a lock owner
// has a fixed allowance, independent of the (potentially hours-long) slot wait.
export const MEMORY_RECHECK_MS = 5000;
export function waitForPromotionMemory(canonical, { held = false, checkStop = true } = {}) {
  try {
    return waitForMemory({ label: 'lane promote', ...(held ? { maxWaitMs: MEMORY_RECHECK_MS, intervalMs: 1000 } : {}),
      check: () => {
        if (checkStop && fs.existsSync(path.join(canonical, '.lane/supervisor/STOP'))) {
          throw Object.assign(new Error('PROMOTION_STOPPED: supervisor STOP exists; nothing merged'), { code: 'PROMOTION_STOPPED' });
        }
      } });
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
  if (plan.schema !== 'promotion-train/v1' || plan.identity !== identity || !Array.isArray(plan.jobs)) throw new Error('invalid train receipt');
  if (plan.attempts?.length) throw error;
  plan.results ??= {};
  for (const job of plan.jobs) plan.results[job.id] ??= { outcome: 'refused', code: error.code, reason: error.message, batch: plan.id };
  plan.groups = []; plan.phase = 'complete';
  writeFileAtomic(file, JSON.stringify(plan, null, 2) + '\n', 0o600);
}
