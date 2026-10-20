// Validation declarations and evidence are independent of session metadata.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { plainDirectory, readPlainFile, writeFileAtomic } from '../lib/files.mjs';
import { acquireLock } from './promotion-lock.mjs';
import { runGateSync, runTestSlotSync, REFUSED_EXIT } from '../test-slot/run.mjs';
import { resolveResource } from '../test-slot/resources.mjs';
import { bundleRelease } from '../lib/releases.mjs';
import { exactIdentity, exactDigest, restrictEnvironment, excludedDelta, explainMiss } from './exact-validation.mjs';

import { limitSeconds } from '../test-slot/limits.mjs';

export const VALIDATION_TIERS = ['fast', 'promotion', 'release'];
export const VALIDATION_FILE = '.lane.validation.json';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Keep each TAP summary: a declared command can run several suites. Only
// unindented totals belong to a top-level suite, never nested subtests.
export function tapTotals(output) {
  const suites = [];
  let current;
  for (const line of output.split(/\r?\n/)) {
    const match = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (!match) continue;
    if (!current || Object.hasOwn(current, match[1])) { current = {}; suites.push(current); }
    current[match[1]] = Number(match[2]);
  }
  return suites.length ? suites : null;
}

export function validateValidation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('validation must be an object');
  for (const [key, command] of Object.entries(value)) {
    if (['host_suites', 'tier_suites'].includes(key)) continue;
    if (['timeout_seconds', 'idle_timeout_seconds'].includes(key)) {
      const values = typeof command === 'object' && command !== null && !Array.isArray(command) ? Object.entries(command) : [[null, command]];
      for (const [tier, seconds] of values) {
        if (tier !== null && !VALIDATION_TIERS.includes(tier)) throw Error(`unknown watchdog tier: ${tier}`);
        limitSeconds(seconds, `validation.${key}`, { idle: key === 'idle_timeout_seconds' });
      }
      continue;
    }
    if (![...VALIDATION_TIERS, 'environment', 'promotion_tests'].includes(key)) throw new Error(`unknown validation field: ${key}`);
    if (typeof command !== 'string' || !command.trim()) throw new Error(`validation.${key} must be a nonempty string`);
  }
  return value;
}

// Always use the canonical project's declarations, never a worker's override.
// A separate tracked file works even when .lane.json is shared machine config.
export function resolveValidation({ root, config = {}, source = 'lane config', sources = {}, env = process.env } = {}) {
  let declared = config.validation === undefined ? {} : validateValidation(config.validation);
  const file = path.join(root, VALIDATION_FILE);
  const declarationSources = Object.fromEntries(Object.keys(declared).map(key => [key, sources.validation ?? source]));
  if (fs.existsSync(file)) {
    const tracked = validateValidation(JSON.parse(fs.readFileSync(file, 'utf8')));
    declared = { ...declared, ...tracked };
    for (const key of Object.keys(tracked)) declarationSources[key] = file;
  }
  let fallback = config.validate ?? 'npm test';
  if (config.validate === undefined) {
    const packageFile = path.join(root, 'package.json');
    const testScript = fs.existsSync(packageFile) ? JSON.parse(fs.readFileSync(packageFile, 'utf8')).scripts?.test : undefined;
    if (!testScript && fs.existsSync(path.join(root, 'test'))) fallback = 'node --test';
  }
  const tiers = {};
  for (const tier of VALIDATION_TIERS) {
    // Legacy overrides remain available to CLI/queue adapters for all tiers.
    const command = env.LANE_VALIDATE ?? declared[tier] ?? fallback;
    if (typeof command !== 'string' || !command.trim()) throw new Error(`validation.${tier} must be a nonempty string`);
    tiers[tier] = { command, timeoutSeconds: typeof declared.timeout_seconds === 'object' ? declared.timeout_seconds[tier] : declared.timeout_seconds,
      idleTimeoutSeconds: typeof declared.idle_timeout_seconds === 'object' ? declared.idle_timeout_seconds[tier] : declared.idle_timeout_seconds, source: env.LANE_VALIDATE !== undefined ? 'env' : declarationSources[tier] ?? (config.validate !== undefined ? sources.validate ?? source : 'default') };
  }
  return { tiers, promotion_tests: declared.promotion_tests, environment: declared.environment ?? '', environment_source: declarationSources.environment ?? 'default', file: fs.existsSync(file) ? file : null };
}

// Ask the lane CLI for its canonical, layered configuration. This keeps host
// envelopes aligned with train settings (including LANE_CONFIG/fleet layers).
export function canonicalValidation(root, env = process.env) {
  const cli = fileURLToPath(new URL('./lane.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [cli, 'config'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const rows = new Map(output.trim().split('\n').map(line => {
    const [key, value] = line.split('\t');
    return [key, JSON.parse(value)];
  }));
  return { tiers: Object.fromEntries(VALIDATION_TIERS.map(tier => [tier, {
    command: rows.get(`validation.${tier}`),
    timeoutSeconds: rows.get(`validation.${tier}.timeout_seconds`) ?? undefined,
    idleTimeoutSeconds: rows.get(`validation.${tier}.idle_timeout_seconds`) ?? undefined,
  }])) };
}

// Do not persist environment values (which may contain credentials). Hash all
// command inputs except transport/cwd bookkeeping. Unlisted variables invalidate
// reuse conservatively. Projects can salt ignored dependencies/container images
// with validation.environment; lockfiles and scripts already belong to the tree.
const bookkeeping = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'ORG_ACTOR', 'ORG_DIR', 'LANE_CONFIG', 'LANE_VALIDATE', 'LANE_WORKTREE_ROOT', 'MONITOR_VALIDATION_TIER', 'MONITOR_VALIDATION_DEADLINE', 'MONITOR_TEST_SLOT_PATH', 'MONITOR_TEST_SLOT_COMPAT_PATH', 'MONITOR_TEST_SLOT_TOKEN', 'MONITOR_TEST_SLOT_OCCUPANCY_PATH', 'MONITOR_TEST_SLOT_WAIT_SECONDS', 'MONITOR_TEST_SLOT_TIMEOUT_RETRIED', 'BCH_CLOAK_TEST_SLOT_TOKEN', 'BCH_CLOAK_TEST_SLOT_WAIT_SECONDS']);
const paneIdentity = new Set(['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID']);
// Session identity cannot be a validation input. Remove it from both execution
// and hashing, matching the promotion queue's detached environment.
export const validationEnvironment = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([key]) => !paneIdentity.has(key)));
export function environmentFingerprint({ env = process.env, prepare = [], environment = '' } = {}) {
  return digest({ version: 1, platform: process.platform, arch: process.arch, release: os.release(),
    node: [process.execPath, process.version], shell: '/bin/sh',
    git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(), prepare, environment,
    env: Object.entries(validationEnvironment(env)).filter(([key, value]) => !bookkeeping.has(key) && value !== undefined).sort(([a], [b]) => a.localeCompare(b)) });
}

function captured(cwd, label = 'validated worktree') {
  if (git(cwd, ['status', '--porcelain', '--untracked-files=all'])) throw new Error(`${label} is not clean`);
  const branch = git(cwd, ['branch', '--show-current']);
  if (!branch) throw new Error('current checkout is detached; check requires a branch');
  return { head: git(cwd, ['rev-parse', 'HEAD']), tree: git(cwd, ['rev-parse', 'HEAD^{tree}']), branch };
}
function unchanged(cwd, before, label) {
  let after;
  try { after = captured(cwd, label); } catch (error) { throw new Error(`worktree changed during validation: ${error.message}`); }
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('worktree branch or lane tip changed during validation');
}

export function validateTree({ cwd, common, command, tier, prepare = [], environment = '', env = process.env, label, onStart, historyKey, timeoutSeconds, idleTimeoutSeconds, exact }) {
  const admittedRelease = bundleRelease();
  env = exact ? restrictEnvironment(env, exact.declaration) : validationEnvironment(env);
  const before = captured(cwd, label);
  const identity = exact ? exactIdentity({ cwd, common, base: exact.base, commands: [command], prepare, environment, env,
    declaration: exact.declaration, toolchain: exact.toolchain, additional: exact.additional }) : null;
  const usesSlot = tier === 'promotion';
  const fingerprint = environmentFingerprint({ env, prepare, environment });
  // Identical commands across tiers prove the same thing. Tier names describe
  // who runs a check; they do not force a second execution of identical inputs.
  const key = identity ? exactDigest(identity) : digest({ schema: 'lane-validation/v1', tree: before.tree, command, fingerprint });
  const directory = plainDirectory(path.join(common, 'lane-validation'));
  const receipt = path.join(directory, `${key}.json`);
  const exactReceipt = exact ? path.join(plainDirectory(path.join(directory, 'exact')), `${key}.json`) : null;
  const release = acquireLock(path.join(directory, `${key}.lock`));
  process.once('exit', release);
  try {
    if (exact) {
      const hit = reusableExact({ cwd, before, directory, receipt, exactReceipt, key, identity, declaration: exact.declaration });
      if (hit) {
        unchanged(cwd, before, label);
        process.stdout.write(`EXACT_REUSE key=${key} receipt=${exactReceipt}\n`);
        return { ...hit.receipt, ...before, tier, reused: true, validated_head: hit.receipt.head,
          exact: { ...hit.receipt.exact, outcome: 'reused', excluded_delta: hit.excluded } };
      }
    }
    let previous;
    try { previous = JSON.parse(readPlainFile(receipt)); } catch { /* Missing/old/malformed evidence is a miss. */ }
    if (!exact && previous?.schema === 'lane-validation/v1' && previous.key === key && previous.tree === before.tree &&
        previous.command === command && previous.environment_fingerprint === fingerprint && previous.exit_code === 0 &&
        previous.signal === null && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(previous.head ?? '') &&
        VALIDATION_TIERS.includes(previous.tier) && previous.reused === false &&
        Number.isFinite(Date.parse(previous.started_at)) && Number.isFinite(Date.parse(previous.finished_at)) &&
        Date.parse(previous.finished_at) >= Date.parse(previous.started_at) &&
        Number.isFinite(previous.duration_s) && previous.duration_s >= 0 &&
        typeof previous.log === 'string' && path.dirname(previous.log) === directory &&
        (path.basename(previous.log) === `${key}.log` ||
          new RegExp(`^${key}\\.[0-9a-f-]{36}\\.log$`).test(path.basename(previous.log)))) {
      let usable = false;
      try { usable = digest(readPlainFile(previous.log)) === previous.log_hash; } catch {}
      if (usable) {
        unchanged(cwd, before, label);
        process.stdout.write(`REUSE tree=${before.tree} tier=${tier} command=${JSON.stringify(command)} log=${previous.log}\n`);
        return { ...previous, ...before, tier, reused: true, validated_head: previous.head };
      }
    }
    // The cache receipt can advance; every execution's log remains immutable.
    const log = path.join(directory, `${key}.${randomUUID()}.log`);
    const executionReceipt = `${log}.execution.json`;
    // Keep grant sidecars out of the validation receipt namespace. Existing
    // readers enumerate its JSON files, excluding watchdog execution receipts.
    const slotReceipt = usesSlot
      ? path.join(plainDirectory(path.join(directory, 'slot-waits')), `${path.basename(log)}.json`)
      : undefined;
    const fd = fs.openSync(log, 'wx', 0o600);
    const startedAt = new Date(), started = process.hrtime.bigint();
    let run;
    try {
      onStart?.({ command, release: admittedRelease, started_at: startedAt.toISOString(), log, execution_receipt: executionReceipt,
        ...(usesSlot ? { slot_receipt: slotReceipt } : {}) });
      // Hold one slot for the chain; only its leaf steps may spend a retry.
      const execute = usesSlot ? runTestSlotSync : runGateSync;
      const resolved = resolveResource(['/bin/sh', '-c', command], { cwd, env });
      const resource = resolved.profile ?? resolved.declaration;
      run = execute(`${tier} ${cwd}`, ['/bin/sh', '-c', command], { acquireSlot: usesSlot, cwd, env, common, tier, historyKey, timeoutSeconds, idleTimeoutSeconds, executionReceipt,
        resource,
        ...(usesSlot ? { waitReceipt: slotReceipt } : {}), retryTimeout: false, stdio: ['inherit', fd, fd] });
    }
    finally { fs.closeSync(fd); }
    const output = readPlainFile(log);
    if (run.error) process.stderr.write(`${run.error.message}\n`);
    const signal = run.signal ?? null;
    const exitCode = run.status ?? (signal && os.constants.signals[signal] ? 128 + os.constants.signals[signal] : 1);
    if (exitCode === REFUSED_EXIT && run.attempts === undefined) {
      // Slot contention is neither failed test evidence nor a reusable receipt.
      process.stderr.write(output);
      throw Object.assign(new Error(output.trim() || 'TEST_SLOT_HELD: validation slot refused'), { exitCode: REFUSED_EXIT });
    }
    process.stdout.write(output);
    let execution = {};
    if (usesSlot) {
      try { execution = JSON.parse(readPlainFile(executionReceipt)); } catch { /* A refusal has no command clocks. */ }
    }
    const gate = { schema: 'lane-validation/v1', key, ...before, tier, command, node_version: process.version, tap_totals: tapTotals(output), release: admittedRelease, environment_fingerprint: fingerprint,
      exit_code: exitCode, signal, started_at: startedAt.toISOString(), finished_at: new Date().toISOString(),
      duration_s: Number(process.hrtime.bigint() - started) / 1e9, log, log_hash: digest(output), reused: false,
      execution_receipt: executionReceipt, executed: run.attempts !== undefined, outcome: run.gateTimeout ? 'timeout' : exitCode === 0 ? 'green' : 'red', gate_timeout: run.gateTimeout ?? null, command_duration_s: run.execution?.duration_s, longest_silence_s: run.execution?.longest_silence_s, limits: run.execution?.limits,
      ...(usesSlot ? { slot_receipt: slotReceipt,
        ...(execution.command_started === true ? { command_started_at: execution.started_at, command_finished_at: execution.finished_at } : {}) } : {}) };
    // Failed, dirty or moving executions never become reusable green evidence.
    try { unchanged(cwd, before, label); }
    catch (error) { throw Object.assign(error, { gate }); }
    if (exact) {
      let executionHash = null;
      try { executionHash = digest(readPlainFile(executionReceipt)); } catch { /* Incomplete sources never reuse. */ }
      gate.exact = { schema: identity.schema, key, identity, outcome: 'executed', excluded_delta: [], execution_hash: executionHash };
    }
    writeFileAtomic(receipt, JSON.stringify(gate, null, 2) + '\n', 0o600);
    if (exact && gate.outcome === 'green' && gate.executed && !gate.gate_timeout) writeFileAtomic(exactReceipt, JSON.stringify(gate, null, 2) + '\n', 0o600);
    return gate;
  } finally { process.off('exit', release); release(); }
}

function reusableExact({ cwd, before, directory, receipt, exactReceipt, key, identity, declaration }) {
  try {
    // Independent copies detect a modified source receipt. This is integrity
    // evidence, not a signature: the engineer owning the repo attests execution.
    const bytes = readPlainFile(exactReceipt);
    if (bytes !== readPlainFile(receipt)) return null;
    const source = JSON.parse(bytes);
    if (source.schema !== 'lane-validation/v1' || source.key !== key || source.exact?.key !== key ||
        source.exact.schema !== 'exact-validation/v1' || exactDigest(source.exact.identity) !== key || explainMiss(identity, source) !== null ||
        source.command !== identity.commands[0] || source.exit_code !== 0 || source.signal !== null || source.outcome !== 'green' ||
        source.executed !== true || source.reused !== false || source.exact.outcome !== 'executed' || source.gate_timeout ||
        !VALIDATION_TIERS.includes(source.tier) || !Number.isFinite(source.duration_s) || source.duration_s < 0 ||
        !Number.isFinite(Date.parse(source.started_at)) || !Number.isFinite(Date.parse(source.finished_at)) || Date.parse(source.finished_at) < Date.parse(source.started_at) ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(source.head ?? '') || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(source.tree ?? '') ||
        typeof source.log !== 'string' || path.dirname(source.log) !== directory ||
        !new RegExp(`^${key}\\.[0-9a-f-]{36}\\.log$`).test(path.basename(source.log)) || source.execution_receipt !== `${source.log}.execution.json`) return null;
    if (digest(readPlainFile(source.log)) !== source.log_hash) return null;
    const sidecar = readPlainFile(source.execution_receipt);
    if (digest(sidecar) !== source.exact.execution_hash) return null;
    const execution = JSON.parse(sidecar);
    if (execution.command_started !== true || execution.exit_code !== 0 || execution.signal != null || execution.gate_timeout || execution.cleanup_error ||
        !Number.isSafeInteger(execution.attempts) || execution.attempts < 1 || !Number.isFinite(Date.parse(execution.started_at)) ||
        !Number.isFinite(Date.parse(execution.finished_at)) || Date.parse(execution.finished_at) < Date.parse(execution.started_at)) return null;
    if (git(cwd, ['rev-parse', `${source.head}^{tree}`]) !== source.tree) return null;
    git(cwd, ['merge-base', '--is-ancestor', identity.base, source.head]);
    const excluded = excludedDelta({ repo: cwd, from: source.tree, to: before.tree, declaration });
    return excluded === null ? null : { receipt: source, excluded };
  } catch { return null; }
}
