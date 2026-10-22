// Frozen parked validator excerpt at 102589ac; only its import path is relocated.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { limitSeconds } from '../../../test-slot/limits.mjs';
export const DECLARED_SCHEMA = 'declared-gates/v1';
export const SELECTION_SCHEMA = 'promotion-tests/v2';
export const MAX_PLAN_BYTES = 1024 * 1024;
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const refuse = reason => Object.assign(Error(`DECLARED_GATES_REFUSED: ${reason}`), { code: 'DECLARED_GATES_REFUSED' });
export function closed(value, keys, label) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw refuse(`invalid ${label} fields`);
}
export const nonempty = value => typeof value === 'string' && value.trim() && !value.includes('\0');
export const argv = value => Array.isArray(value) && value.length > 0 && nonempty(value[0]) && value.every(arg => typeof arg === 'string' && !arg.includes('\0'));
export function relative(value, { dot = false } = {}) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && !value.includes('\\') &&
    !path.isAbsolute(value) && (dot && value === '.' || value !== '.' && path.posix.normalize(value) === value && !value.split('/').some(p => p === '..' || p === '.'));
}
export function preparation(value = [], label = 'prepare', { adopted = true } = {}) {
  if (!Array.isArray(value) || value.length > 512) throw refuse(`invalid ${label}`);
  for (const step of value) {
    closed(step, ['run', 'unless'], label);
    if (!nonempty(step.run) || step.unless !== undefined && (!relative(step.unless) || adopted &&
      (step.unless.split('/').includes('node_modules') || /(?:^|[\s;&|])(?:install|ci|sync)(?:\s|$)/.test(step.run))))
      throw refuse(`${label} needs a command; dependency installation must be unconditional`);
  }
  return value;
}
export function validateDeclared(value) {
  closed(value, ['schema', 'fast', 'promotion', 'release', 'environment', 'timeout_seconds', 'idle_timeout_seconds', 'host_suites', 'tier_suites', 'gate', 'runners', 'promotion_tests'], 'declaration');
  if (value.schema !== DECLARED_SCHEMA) throw refuse(`unsupported declaration schema: ${value.schema}`);
  for (const key of ['promotion', 'release']) if (!nonempty(value[key])) throw refuse(`${key} must be explicit and nonempty`);
  for (const key of ['fast', 'environment']) if (value[key] !== undefined && !nonempty(value[key])) throw refuse(`invalid ${key}`);
  for (const key of ['timeout_seconds', 'idle_timeout_seconds']) if (value[key] !== undefined) {
    const entries = object(value[key]) ? Object.entries(value[key]) : [[null, value[key]]];
    for (const [tier, seconds] of entries) {
      if (tier !== null && !['fast', 'promotion', 'release'].includes(tier)) throw refuse(`unknown watchdog tier: ${tier}`);
      limitSeconds(seconds, key, { idle: key === 'idle_timeout_seconds' });
    }
  }
  const gate = value.gate ?? {};
  closed(gate, ['node_version_file', 'env', 'prepare', 'external_lock', 'refuse_processes', 'wait_seconds', 'timeout_seconds', 'idle_timeout_seconds', 'resource'], 'gate');
  preparation(gate.prepare);
  if (gate.node_version_file !== undefined && !relative(gate.node_version_file)) throw refuse('invalid Node version file');
  if (gate.env !== undefined && (!object(gate.env) || Object.entries(gate.env).some(([name, value]) =>
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string' || value.includes('\0') ||
    /^(?:MONITOR_PROMOTION_|MONITOR_TEST_SLOT_(?:PATH|COMPAT_PATH|TOKEN)|BCH_CLOAK_TEST_SLOT_TOKEN|HERDR_(?:PANE|TAB|WORKSPACE)_ID|NODE_OPTIONS$|NODE_TEST_CONTEXT$)/.test(name)))) throw refuse('invalid or host-owned gate environment');
  if (gate.external_lock !== undefined && (typeof gate.external_lock !== 'string' || !path.isAbsolute(gate.external_lock) || gate.external_lock.includes('\0'))) throw refuse('invalid external lock');
  if (gate.wait_seconds !== undefined && (!Number.isSafeInteger(gate.wait_seconds) || gate.wait_seconds < 0 || gate.wait_seconds > 9999999)) throw refuse('invalid bounded host wait');
  if (gate.refuse_processes !== undefined) {
    if (!Array.isArray(gate.refuse_processes) || gate.refuse_processes.some(pattern => !nonempty(pattern))) throw refuse('invalid process patterns');
    for (const pattern of gate.refuse_processes) new RegExp(pattern);
  }
  for (const key of ['timeout_seconds', 'idle_timeout_seconds']) if (gate[key] !== undefined) limitSeconds(gate[key], `gate.${key}`, { idle: key === 'idle_timeout_seconds' });
  if (!object(value.runners) || Object.keys(value.runners).length > 512) throw refuse('runners must be an object');
  for (const [id, runner] of Object.entries(value.runners)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw refuse('invalid runner identifier');
    closed(runner, ['command', 'cwd'], 'runner');
    if (!argv(runner.command) || !relative(runner.cwd, { dot: true })) throw refuse('runner needs literal argv and normalized project-relative cwd');
  }
  if (value.promotion_tests !== undefined) {
    closed(value.promotion_tests, ['command', 'prepare'], 'promotion_tests');
    if (!argv(value.promotion_tests.command)) throw refuse('promotion_tests.command must be argv');
    preparation(value.promotion_tests.prepare, 'promotion_tests.prepare');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_PLAN_BYTES) throw refuse('declaration exceeds 1 MiB');
  return value;
}
