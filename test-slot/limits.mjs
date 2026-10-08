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
export const HISTORY_FILES = 128;
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
export const commandFingerprint = command => createHash('sha256').update(JSON.stringify(command ?? null)).digest('hex');
export const gateHistoryKey = (tier, command) => ({ tier, command_fingerprint: commandFingerprint(command) });
function checkedKey(tier, command, key = gateHistoryKey(tier, command)) {
  if (!key || key.tier !== tier || !/^[0-9a-f]{64}$/.test(key.command_fingerprint ?? '')) throw Error('invalid gate history key');
  return key;
}
export function historyFile(common, tier, command, historyKey) {
  const key = checkedKey(tier, command, historyKey);
  return common && path.join(common, 'gate-watchdog', `${createHash('sha256').update(JSON.stringify([key.tier, key.command_fingerprint])).digest('hex')}.json`);
}
export function healthyHistory(common, tier, command, file, historyKey) {
  const key = checkedKey(tier, command, historyKey);
  file ??= historyFile(common, tier, command, historyKey);
  try {
    const history = JSON.parse(readPlainFile(file));
    if (history.schema !== 'gate-watchdog/v1' || history.tier !== tier || history.command_fingerprint !== key.command_fingerprint || !Array.isArray(history.runs)) return [];
    return history.runs.filter(run => Number.isFinite(run.duration_s) && run.duration_s >= 0 &&
      Number.isFinite(run.longest_silence_s) && run.longest_silence_s >= 0 && run.longest_silence_s <= run.duration_s &&
      Number.isFinite(Date.parse(run.finished_at))).slice(-RECENT_RUNS);
  } catch { return []; }
}
export function resolveGateLimits({ common, tier = 'gate', command, historyKey, timeoutSeconds, idleTimeoutSeconds, history = healthyHistory(common, tier, command, historyFile(common, tier, command, historyKey), historyKey) } = {}) {
  if (timeoutSeconds !== undefined) limitSeconds(timeoutSeconds, 'timeout_seconds');
  if (idleTimeoutSeconds !== undefined) limitSeconds(idleTimeoutSeconds, 'idle_timeout_seconds', { idle: true });
  return {
    wall_seconds: timeoutSeconds ?? (history.length ? Math.max(WALL_FLOOR_SECONDS, Math.ceil(2 * Math.max(...history.map(r => r.duration_s)))) : WALL_DEFAULT_SECONDS),
    wall_source: timeoutSeconds !== undefined ? 'config' : history.length ? 'history' : 'default',
    idle_seconds: idleTimeoutSeconds ?? (history.length ? Math.max(IDLE_FLOOR_SECONDS, Math.ceil(3 * Math.max(...history.map(r => r.longest_silence_s)))) : 0),
    idle_source: idleTimeoutSeconds !== undefined ? 'config' : history.length ? 'history' : 'off',
  };
}
export function recordHealthyGate({ common, tier = 'gate', command, historyKey, duration_s, longest_silence_s, file = historyFile(common, tier, command, historyKey) }) {
  if (!file) return;
  const key = checkedKey(tier, command, historyKey);
  const directory = plainDirectory(path.dirname(file));
  // Serialize recording and pruning so concurrent gates cannot delete a writer's history.
  const release = acquireLock(path.join(directory, '.history.lock'), { waitMs: 1000 });
  try {
    writeFileAtomic(file, JSON.stringify({ schema: 'gate-watchdog/v1', tier, command_fingerprint: key.command_fingerprint,
      runs: [...healthyHistory(common, tier, command, file, historyKey), { command, duration_s, longest_silence_s, finished_at: new Date().toISOString() }].slice(-RECENT_RUNS) }, null, 2) + '\n', 0o600);
    const files = fs.readdirSync(directory).filter(name => /^[0-9a-f]{64}\.json$/.test(name))
      .map(name => ({ name, stat: fs.lstatSync(path.join(directory, name)) })).filter(entry => entry.stat.isFile())
      .sort((a, b) => (b.name === path.basename(file)) - (a.name === path.basename(file)) || b.stat.mtimeMs - a.stat.mtimeMs || a.name.localeCompare(b.name));
    for (const entry of files.slice(HISTORY_FILES)) fs.unlinkSync(path.join(directory, entry.name));
  } finally { release(); }
}
