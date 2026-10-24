// Append-only observations shared by the foreground gate and its test runners.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { projectCommon } from './limits.mjs';

export const TIMINGS_ENV = 'MONITOR_TEST_TIMINGS_PATH';
export function timing(row, env = process.env) {
  const file = env[TIMINGS_ENV];
  if (!file) return;
  try { fs.appendFileSync(file, JSON.stringify({ ...row, pid: process.pid, at: new Date().toISOString() }) + '\n', { mode: 0o600 }); }
  catch (error) { console.error(`TEST_TIMING_WARNING: ${error.message}`); }
}
export function startTiming(kind, name, extra = {}) {
  if (!process.env[TIMINGS_ENV]) {
    const directory = path.join(projectCommon() ?? process.cwd(), 'lane-validation');
    fs.mkdirSync(directory, { recursive: true });
    process.env[TIMINGS_ENV] = path.join(directory, `${randomUUID()}.timings.jsonl`);
  }
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
