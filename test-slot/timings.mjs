// Append-only observations shared by the foreground gate and its test runners.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

export const TIMINGS_ENV = 'MONITOR_TEST_TIMINGS_PATH';
export function timing(row, env = process.env) {
  const file = env[TIMINGS_ENV];
  if (!file) return;
  try { fs.appendFileSync(file, JSON.stringify({ ...row, pid: process.pid, at: new Date().toISOString() }) + '\n', { mode: 0o600 }); }
  catch (error) { console.error(`TEST_TIMING_WARNING: ${error.message}`); }
}
export function startTiming(kind, name, extra = {}) {
  // Only the owning gate allocates a journal. Ungated/fixture runners must not
  // leave unpaired evidence in the shared Git common directory.
  extra = { depth: Number(process.env.MONITOR_TEST_TIMING_DEPTH ?? 0), ...extra };
  const id = randomUUID(), started = process.hrtime.bigint();
  timing({ id, kind, name, ...extra, event: 'start' });
  return Object.assign(result => timing({ id, kind, name, ...extra, event: 'finish',
    duration_s: Number(process.hrtime.bigint() - started) / 1e9, ...result }), { id });
}
export function readTimings(file) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
}
