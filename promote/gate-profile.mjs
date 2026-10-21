// Canonical project declarations, independent of session/run metadata.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validationEnvironment } from '../lanes/validation.mjs';
import { lookupProcess } from '../lib/processes.mjs';
import { writeFileAtomic } from '../lib/files.mjs';
import { bundleRelease } from '../lib/releases.mjs';
import { policyLocation } from '../lib/config-home.mjs';
import { readPolicyFile, validatePromote } from '../lib/config-policy.mjs';
import { parseUniqueJson } from '../sessions/json.mjs';

import { limitSeconds } from '../test-slot/limits.mjs';

export const HOST_ENV = 'MONITOR_PROMOTION_HOST_PROFILE';
const HOST = fileURLToPath(new URL('./host-gate.mjs', import.meta.url));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);

// Only the canonical checkout's committed files configure the host: an edited or untracked
// working copy must never reach a child process before the train's clean-tree refusal.
function committedFile(canonical, relative) {
  const git = args => spawnSync('git', ['-C', canonical, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const checked = result => {
    if (result.error || result.status !== 0) throw new Error(`cannot read committed ${relative}: ${result.stderr || result.error?.message || `exit ${result.status}`}`);
    return result.stdout;
  };
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (!head.error && head.status === 1 && !head.stdout && !head.stderr) {
    // Only a confirmed unborn branch has no profile; any other Git failure refuses.
    const branch = checked(git(['symbolic-ref', '--quiet', 'HEAD'])).trim();
    const ref = git(['show-ref', '--verify', '--quiet', branch]);
    if (!ref.error && ref.status === 1 && !ref.stdout && !ref.stderr) return undefined;
    checked(ref);
    throw new Error(`cannot read committed ${relative}: HEAD does not resolve`);
  }
  const commit = checked(head).trim();
  if (!checked(git(['ls-tree', '--name-only', commit, '--', relative])).trim()) return undefined;
  return checked(git(['show', `${commit}:${relative}`]));
}

// `settings` is a committed .promote.json the caller already read (the queue's per-batch snapshot),
// so one batch never reads the declaration twice.
export function resolveGateProfile(canonical, environment = process.env, { settings } = {}) {
  const selected = policyLocation(canonical, 'promote', environment);
  const file = selected.file;
  let gate = settings?.gate;
  if (settings === undefined) {
    if (selected.home) gate = readPolicyFile(file, 'promote', { cwd: canonical, env: environment }).gate;
    else {
      const declared = committedFile(canonical, '.promote.json');
      gate = declared === undefined ? undefined : validatePromote(parseUniqueJson(declared)).gate;
    }
  }
  if (gate === undefined) return null;
  if (!object(gate)) throw new Error('promote gate must be an object');
  const fields = ['node_version_file', 'env', 'prepare', 'external_lock', 'refuse_processes', 'wait_seconds', 'timeout_seconds', 'idle_timeout_seconds', 'resource'];
  for (const key of Object.keys(gate)) if (!fields.includes(key)) throw new Error(`unknown promote gate field: ${key}`);
  if (gate.timeout_seconds !== undefined) limitSeconds(gate.timeout_seconds, 'gate.timeout_seconds');
  if (gate.idle_timeout_seconds !== undefined) limitSeconds(gate.idle_timeout_seconds, 'gate.idle_timeout_seconds', { idle: true });
  const waitSeconds = gate.wait_seconds ?? 7200;
  if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 9999999) throw new Error('gate.wait_seconds must be a bounded whole number of seconds');
  if (gate.env !== undefined && (!object(gate.env) || Object.entries(gate.env).some(([key, value]) =>
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0') ||
    /^(?:MONITOR_PROMOTION_|MONITOR_TEST_SLOT_(?:PATH|COMPAT_PATH|TOKEN)|BCH_CLOAK_TEST_SLOT_TOKEN|HERDR_(?:PANE|TAB|WORKSPACE)_ID|NODE_OPTIONS$)/.test(key)))) {
    // NODE_OPTIONS would load project code into the host adapter itself; gate commands can still set it.
    throw new Error('gate.env must map environment names to strings; slot paths/tokens, session transport and NODE_OPTIONS are host-owned');
  }
  const prepare = gate.prepare ?? [];
  if (!Array.isArray(prepare) || prepare.some(step => !object(step) || typeof step.run !== 'string' || !step.run.trim() ||
    Object.keys(step).some(key => !['run', 'unless'].includes(key)) || (step.unless !== undefined && (typeof step.unless !== 'string' ||
    path.isAbsolute(step.unless) || step.unless.split(/[\\/]/).includes('..'))))) throw new Error('gate.prepare must contain run and optional relative unless');
  if (gate.external_lock !== undefined && (typeof gate.external_lock !== 'string' || !path.isAbsolute(gate.external_lock) || gate.external_lock.includes('\0'))) throw new Error('gate.external_lock must be an absolute kernel lock file');
  const processes = gate.refuse_processes ?? [];
  if (!Array.isArray(processes) || processes.some(pattern => typeof pattern !== 'string' || !pattern.trim())) throw new Error('gate.refuse_processes must be an array of regular expressions');
  for (const pattern of processes) new RegExp(pattern);
  const env = validationEnvironment({ ...environment, ...gate.env });
  delete env[HOST_ENV];
  // The train's bound governs its slot as well as the transition lock. The
  // project's legacy variable still reaches its own nested slot wrapper.
  env.MONITOR_TEST_SLOT_WAIT_SECONDS = String(waitSeconds);
  let node = null;
  if (gate.node_version_file !== undefined) {
    const relative = gate.node_version_file;
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('gate.node_version_file must be a project-relative file');
    const pinned = committedFile(canonical, relative);
    if (pinned === undefined) throw new Error('gate.node_version_file must be committed');
    const pin = pinned.trim().replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(pin)) throw new Error('gate Node pin must be an exact version');
    if (!env.HOME || !path.isAbsolute(env.HOME)) throw new Error('gate Node pin needs an absolute HOME');
    const bin = path.join(env.HOME, '.nvm/versions/node', `v${pin}`, 'bin');
    const executable = path.join(bin, 'node');
    fs.accessSync(executable, fs.constants.X_OK);
    const result = spawnSync(executable, ['--version'], { encoding: 'utf8', env });
    if (result.error || result.status !== 0 || result.stdout.trim() !== `v${pin}`) throw new Error(`pinned Node v${pin} is unavailable at ${executable}`);
    env.PATH = [bin, ...(env.PATH ?? '').split(path.delimiter).filter(entry => entry !== bin)].join(path.delimiter);
    node = { pin, executable };
  }
  return { resource: gate.resource, env, node, prepare, externalLock: gate.external_lock, processes, waitSeconds, timeoutSeconds: gate.timeout_seconds, idleTimeoutSeconds: gate.idle_timeout_seconds,
    // Hash declarations and effective runtime without persisting environment
    // values. Preparation and this salt participate in tree-keyed evidence.
    fingerprint: hash({ gate, node }), file };
}

export function checkCompetingProcesses(profile) {
  if (!profile.processes.length) return;
  const table = lookupProcess();
  if (!table.ok) throw new Error(`PROMOTE_PROCESS_UNKNOWN: ${table.error}`);
  const ancestors = new Set();
  for (let pid = process.pid; pid && !ancestors.has(pid); pid = table.value.get(pid)?.ppid) ancestors.add(pid);
  for (const row of table.value.values()) {
    if (ancestors.has(row.pid) || /^Z/.test(row.state)) continue;
    if (profile.processes.some(pattern => new RegExp(pattern).test(row.command))) throw new Error(`PROMOTE_PROCESS_RUNNING: pid ${row.pid}: ${row.command}`);
  }
}

export function runProjectGateSync({ canonical, receipt, argv, settings, ...options }) {
  const evidence = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  evidence.release ??= bundleRelease();
  writeFileAtomic(receipt, JSON.stringify(evidence, null, 2) + '\n', 0o600);
  const profile = resolveGateProfile(canonical, options.env, { settings });
  if (!profile) return spawnSync(process.execPath, argv, options);
  const plan = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  plan.host_receipt = path.join(path.dirname(receipt), 'host-gate.json');
  writeFileAtomic(receipt, JSON.stringify(plan, null, 2) + '\n', 0o600);
  return spawnSync(process.execPath, [HOST, canonical, receipt, ...argv], { ...options, env: profile.env });
}
