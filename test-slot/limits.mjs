// Command clocks are observations; only confirmed inactivity permits a stop.
import fs from 'node:fs';
import path from 'node:path';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { plainDirectory, readPlainFile, writeFileAtomic } from '../lib/files.mjs';

export const FROZEN_SECONDS_ENV = 'MONITOR_TEST_SLOT_FROZEN_SECONDS';
// ENG-625 / R-822: longest retained completed case, 199580.020875 ms / 1000.
// Provenance: .org/evidence/ENG-625/R-822/measurement.md in the owning record.
export const FROZEN_SECONDS = 199.580020875;
export const SILENCE_SECONDS = 900;
export function frozenSeconds(env = process.env) {
  const value = Number(env[FROZEN_SECONDS_ENV] ?? FROZEN_SECONDS);
  if (!Number.isFinite(value) || value < 0 || value > 9999999) throw Error(`${FROZEN_SECONDS_ENV} must be non-negative bounded seconds (0 disables)`);
  return value;
}

export const WALL_FLOOR_SECONDS = 600;
export const WALL_DEFAULT_SECONDS = 0;
export const RELEASE_TIMEOUT_ENV = 'MONITOR_TEST_SLOT_RELEASE_TIMEOUT_SECONDS';
export const IDLE_FLOOR_SECONDS = 300;
export const MIN_HEALTHY_SAMPLES = 3;
// Full promotion/release gates must keep room for the observed 10/30-minute
// healthy runs even when their declared command selects a narrow test set.
export const wallFloorSeconds = tier => tier === 'promotion' ? 1200 : tier === 'release' ? 3600 : WALL_FLOOR_SECONDS;
// Subsecond fixture clocks cannot teach a full gate's watchdog. Short genuine
// commands keep the conservative default (or their explicit project limit).
export const sampleFloorSeconds = tier => tier === 'promotion' ? 180 : tier === 'release' ? 300 : 30;
export const RECENT_RUNS = 20;
export const HISTORY_FILES = 128;
export const TIMEOUT_EXIT = 124;
export const TIMEOUT_CODE = 'GATE_TIMEOUT';
export function limitSeconds(value, name, { idle = false } = {}) {
  if (!Number.isFinite(value) || value < 0 || value > 9999999)
    throw Error(`${name} must be a non-negative bounded number of seconds`);
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
export function historyFile(common, tier, command, historyKey, env = process.env) {
  const key = checkedKey(tier, command, historyKey);
  const override = env.MONITOR_GATE_HISTORY_ROOT;
  if (override !== undefined && (typeof override !== 'string' || !path.isAbsolute(override) || override.includes('\0') || override === '/'))
    throw Error('MONITOR_GATE_HISTORY_ROOT must be an absolute directory path');
  // Scratch roots still separate projects sharing the same tier/command.
  const directory = override && common ? path.join(override, createHash('sha256').update(common).digest('hex')) : common && path.join(common, 'gate-watchdog');
  return directory && path.join(directory, `${createHash('sha256').update(JSON.stringify([key.tier, key.command_fingerprint])).digest('hex')}.json`);
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
export function resolveGateLimits({ common, tier = 'gate', command, historyKey, timeoutSeconds, idleTimeoutSeconds, env = process.env, history } = {}) {
  // Historical/explicit wall allowances remain readable for old declarations,
  // but never authorize stopping a working run. Zero is the only wall limit.
  if (timeoutSeconds !== undefined) limitSeconds(timeoutSeconds, 'timeout_seconds');
  if (idleTimeoutSeconds !== undefined) limitSeconds(idleTimeoutSeconds, 'idle_timeout_seconds', { idle: true });
  return { wall_seconds: 0, wall_source: 'watch',
    idle_seconds: idleTimeoutSeconds ?? SILENCE_SECONDS,
    idle_source: idleTimeoutSeconds !== undefined ? 'config' : 'default',
    frozen_seconds: frozenSeconds(env) };
}

export function recordHealthyGate({ common, tier = 'gate', command, historyKey, duration_s, longest_silence_s, env = process.env, file = historyFile(common, tier, command, historyKey, env) }) {
  if (!file) return;
  const key = checkedKey(tier, command, historyKey);
  const directory = plainDirectory(path.dirname(file));
  // Serialize recording and pruning so concurrent gates cannot delete a writer's history.
  const release = acquireLock(path.join(directory, '.history.lock'), { waitMs: 1000 });
  try {
    writeFileAtomic(file, JSON.stringify({ schema: 'gate-watchdog/v1', tier, command_fingerprint: key.command_fingerprint,
      runs: [...healthyHistory(common, tier, command, file, historyKey), { command, duration_s, longest_silence_s, finished_at: new Date().toISOString(),
        ...(env.MONITOR_GATE_HISTORY_ORIGIN ? { origin: env.MONITOR_GATE_HISTORY_ORIGIN } : {}) }].slice(-RECENT_RUNS) }, null, 2) + '\n', 0o600);
    const files = fs.readdirSync(directory).filter(name => /^[0-9a-f]{64}\.json$/.test(name))
      .map(name => ({ name, stat: fs.lstatSync(path.join(directory, name)) })).filter(entry => entry.stat.isFile())
      .sort((a, b) => (b.name === path.basename(file)) - (a.name === path.basename(file)) || b.stat.mtimeMs - a.stat.mtimeMs || a.name.localeCompare(b.name));
    for (const entry of files.slice(HISTORY_FILES)) fs.unlinkSync(path.join(directory, entry.name));
  } finally { release(); }
}
