// Internal response allowances, sampled at the operation rather than configured
// from session metadata. Load includes runnable and I/O-waiting work. Restrict
// the divisor to four: large hosts still share a serialized CLI/IPC path.
import os from 'node:os';

// Reuse dispatch's existing one-minute admission allowance for launch gates.
export const ADMISSION_WAIT_MS = 60_000;
export function admissionDeadline({ budgetMs = ADMISSION_WAIT_MS, now = () => performance.now(), allowance = loadTimeout } = {}) {
  if (!Number.isFinite(budgetMs) || budgetMs < 0) throw Error('invalid admission allowance');
  const deadline = now() + allowance(budgetMs);
  if (!Number.isFinite(deadline)) throw Error('invalid admission deadline');
  return deadline;
}

export function loadFactor(load = os.loadavg()[0], parallelism = os.availableParallelism()) {
  const capacity = Number.isFinite(parallelism) && parallelism > 0 ? Math.min(4, parallelism) : 1;
  return Number.isFinite(load) && load >= 0 ? Math.max(1, load / capacity) : 1;
}

export function loadTimeout(milliseconds, factor = loadFactor()) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || !Number.isFinite(factor) || factor < 1)
    throw new Error('invalid internal response allowance');
  // Node clamps overflowing timers to 1 ms. Keep even extreme measurements
  // finite and below that overflow, with zero preserving immediate refusal.
  return Math.min(2 ** 31 - 1, Math.ceil(milliseconds * factor));
}
