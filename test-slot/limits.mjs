// Healthy command clocks, never slot waits, provide project-local watchdog limits.
import fs from 'node:fs';
import path from 'node:path';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { plainDirectory, readPlainFile, writeFileAtomic } from '../lib/files.mjs';

export const WALL_FLOOR_SECONDS = 600;
export const WALL_DEFAULT_SECONDS = 4500;
export const IDLE_FLOOR_SECONDS = 300;
export const RECENT_RUNS = 20;
export const TIMEOUT_EXIT = 124;
export const TIMEOUT_CODE = 'GATE_TIMEOUT';
export function limitSeconds(value, name, { idle = false } = {}) {
  if (!Number.isFinite(value) || value < (idle ? 0 : Number.MIN_VALUE) || value > 9999999)
    throw Error(`${name} must be ${idle ? 'a non-negative' : 'a positive'} bounded number of seconds`);
  return value;
}
export function projectCommon(cwd = process.cwd()) {
  try { return fs.realpathSync(execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()); }
  catch { return null; }
}
export function historyFile(common, tier) {
  return common && path.join(common, 'gate-watchdog', `${createHash('sha256').update(tier).digest('hex')}.json`);
}
export function healthyHistory(common, tier, file = historyFile(common, tier)) {
  try {
    const history = JSON.parse(readPlainFile(file));
    if (history.schema !== 'gate-watchdog/v1' || history.tier !== tier || !Array.isArray(history.runs)) return [];
    return history.runs.filter(run => Number.isFinite(run.duration_s) && run.duration_s >= 0 &&
      Number.isFinite(run.longest_silence_s) && run.longest_silence_s >= 0 && run.longest_silence_s <= run.duration_s &&
      Number.isFinite(Date.parse(run.finished_at))).slice(-RECENT_RUNS);
  } catch { return []; }
}
export function resolveGateLimits({ common, tier = 'gate', timeoutSeconds, idleTimeoutSeconds, history = healthyHistory(common, tier) } = {}) {
  if (timeoutSeconds !== undefined) limitSeconds(timeoutSeconds, 'timeout_seconds');
  if (idleTimeoutSeconds !== undefined) limitSeconds(idleTimeoutSeconds, 'idle_timeout_seconds', { idle: true });
  return {
    wall_seconds: timeoutSeconds ?? (history.length ? Math.max(WALL_FLOOR_SECONDS, Math.ceil(2 * Math.max(...history.map(r => r.duration_s)))) : WALL_DEFAULT_SECONDS),
    wall_source: timeoutSeconds !== undefined ? 'config' : history.length ? 'history' : 'default',
    idle_seconds: idleTimeoutSeconds ?? (history.length ? Math.max(IDLE_FLOOR_SECONDS, Math.ceil(3 * Math.max(...history.map(r => r.longest_silence_s)))) : 0),
    idle_source: idleTimeoutSeconds !== undefined ? 'config' : history.length ? 'history' : 'off',
  };
}
export function recordHealthyGate({ common, tier = 'gate', command, duration_s, longest_silence_s, file = historyFile(common, tier) }) {
  if (!file) return;
  plainDirectory(path.dirname(file));
  const release = acquireLock(`${file}.lock`, { waitMs: 1000 });
  try {
    writeFileAtomic(file, JSON.stringify({ schema: 'gate-watchdog/v1', tier,
      runs: [...healthyHistory(common, tier, file), { command, duration_s, longest_silence_s, finished_at: new Date().toISOString() }].slice(-RECENT_RUNS) }, null, 2) + '\n', 0o600);
  } finally { release(); }
}
