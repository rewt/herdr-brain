#!/usr/bin/env node
// Foreground gate adapter for project pins, locks, memory and validation.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bundleRelease } from '../lib/releases.mjs';
import { writeFileAtomic } from '../lib/files.mjs';
import { resolveResource } from '../test-slot/resources.mjs';
import { runTestSlotSync } from '../test-slot/run.mjs';
import { resolveGateProfile, checkCompetingProcesses, HOST_ENV } from './gate-profile.mjs';
import { gitProject } from '../lib/project.mjs';
import { canonicalValidation } from '../lanes/validation.mjs';
import { resolveGateLimits, gateHistoryKey } from '../test-slot/limits.mjs';
import { cliHelp } from '../lib/cli-help.mjs';
import { probeNativeGate } from './native-context.mjs';
import { waitForPromotionMemory } from './memory-gate.mjs';
import { admissionDeadline } from '../lib/deadline.mjs';
cliHelp(import.meta.url, "Usage: node promote/host-gate.mjs [--lock|--held|--execute] CANONICAL RECEIPT [COMMAND ARGS...]");

const args = process.argv.slice(2);
const SELF = fileURLToPath(import.meta.url);
const mode = args[0]?.startsWith('--') ? args.shift() : '--lock';
const [canonical, receipt, ...argv] = args;
const hostFile = path.join(path.dirname(receipt), 'host-gate.json');
const slotFile = path.join(path.dirname(receipt), 'test-slot-wait.json');
const read = () => JSON.parse(fs.readFileSync(hostFile, 'utf8'));
const save = data => writeFileAtomic(hostFile, JSON.stringify(data, null, 2) + '\n', 0o600);
const update = changes => save({ ...read(), ...changes });
const exitOf = r => r.status ?? 1;
// These updates precede the train child; never replace its recovery checkpoints.
const updateTrain = changes => {
  const plan = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  // A capped wait can be retried later. Pair the first successful grant with
  // that invocation's wait start, excluding the idle time between retries.
  if (changes.external_lock_granted_at && !plan.external_lock_granted_at) plan.external_lock_started_at = changes.external_lock_started_at;
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'native_context') plan[key] = value;
    else plan[key] ??= value;
  }
  writeFileAtomic(receipt, JSON.stringify(plan, null, 2) + '\n', 0o600);
};

try {
  const native = probeNativeGate();
  updateTrain({ native_context: native });
  if (!native.ok) throw Object.assign(new Error(native.reason), { code: native.code });
  const profile = resolveGateProfile(canonical);
  if (!profile) throw new Error('promotion host adapter requires a declared gate profile');
  // Saved attempts may have integrated before losing their response. Keep all
  // memory waits, but leave resumed STOP reconciliation/refusals to runTrain.
  const memoryOptions = { checkStop: !JSON.parse(fs.readFileSync(receipt, 'utf8')).attempts?.length,
    deadline: admissionDeadline({ budgetMs: profile.waitSeconds * 1000, allowance: ms => ms }) };
  if (mode !== '--lock' && read().profile_fingerprint !== profile.fingerprint) throw new Error('promotion gate profile changed while waiting; enqueue again');
  if (mode === '--lock') {
    updateTrain({ started_at: new Date().toISOString(), external_lock_required: Boolean(profile.externalLock) });
    save({ schema: 'promotion-host-gate/v1', release: bundleRelease(), profile_fingerprint: profile.fingerprint,
      started_at: new Date().toISOString(), phase: 'starting', slot_receipt: slotFile,
      ...(profile.node ? { node: profile.node } : {}) });
    update({ phase: 'waiting-memory' });
    waitForPromotionMemory(canonical, memoryOptions);
    if (profile.externalLock) {
      const started = new Date().toISOString();
      updateTrain({ external_lock_started_at: started });
      update({ phase: 'waiting-external-lock', external_lock: { path: profile.externalLock, state: 'waiting', started_at: started, wait_seconds: profile.waitSeconds } });
      process.stderr.write(`PROMOTE_LOCK_WAIT: ${profile.externalLock}; capped at ${profile.waitSeconds}s; receipt=${hostFile}\n`);
      // zsystem flock uses fcntl record locks, NOT flock(2). -e keeps the
      // descriptor through exec, so the same PID owns it until this batch ends.
      // No shell interpolation: project paths and commands are positional args.
      const script = 'zmodload zsh/system || exit 74\n: >> "$1" || exit 74\nzsystem flock -e -t "$2" -i 0.1 -f monitor_gate_fd "$1"\nrc=$?\n[[ $rc == 0 ]] || { [[ $rc == 2 ]] && exit 75; exit 74; }\nshift 2\nexec "$@"';
      const result = spawnSync('/bin/zsh', ['-f', '-c', script, 'monitor-gate-lock', profile.externalLock, String(profile.waitSeconds),
        process.execPath, SELF, '--held', canonical, receipt, ...argv], { env: profile.env, stdio: 'inherit' });
      const saved = read();
      if (saved.external_lock.state === 'waiting') {
        const reason = result.status === 75 ? `PROMOTE_LOCK_HELD: ${profile.externalLock}; wait capped at ${profile.waitSeconds}s` : `PROMOTE_LOCK_UNKNOWN: ${result.error?.message ?? `kernel lock exit ${result.status}`}`;
        update({ phase: 'refused', reason, external_lock: { ...saved.external_lock, state: 'refused', finished_at: new Date().toISOString() } });
        process.stderr.write(reason + '\n');
      }
      process.exitCode = exitOf(result);
    } else {
      process.exitCode = await execute(profile, memoryOptions);
    }
  } else if (mode === '--held') {
    const saved = read();
    const acquiredAt = new Date().toISOString();
    update({ external_lock: { ...saved.external_lock, state: 'acquired', acquired_at: acquiredAt, finished_at: acquiredAt } });
    updateTrain({ external_lock_started_at: saved.external_lock.started_at, external_lock_granted_at: acquiredAt });
    process.exitCode = await execute(profile, memoryOptions);
  } else if (mode === '--execute') {
    const slot = JSON.parse(fs.readFileSync(slotFile, 'utf8'));
    updateTrain({ slot_granted_at: slot.acquired_at });
    update({ phase: 'checking-memory' });
    waitForPromotionMemory(canonical, { ...memoryOptions, held: true });
    checkCompetingProcesses(profile); // a competing direct gate may start during the slot wait
    update({ phase: 'running', command_started: true, command_started_at: new Date().toISOString() });
    const result = spawnSync(process.execPath, argv, { env: { ...profile.env, [HOST_ENV]: profile.fingerprint,
      MONITOR_TEST_SLOT_TOKEN: process.env.MONITOR_TEST_SLOT_TOKEN, BCH_CLOAK_TEST_SLOT_TOKEN: process.env.BCH_CLOAK_TEST_SLOT_TOKEN }, stdio: 'inherit' });
    update({ phase: 'finished', finished_at: new Date().toISOString(), exit_code: exitOf(result), signal: result.signal ?? null });
    process.exitCode = exitOf(result);
  } else throw new Error('unknown host gate phase');
} catch (error) {
  const refusal = { phase: 'refused', reason: error.message, ...(error.code ? { code: error.code } : {}), finished_at: new Date().toISOString() };
  if (fs.existsSync(hostFile)) update(refusal);
  else if (error.code?.startsWith('PROMOTE_NATIVE_')) save({ schema: 'promotion-host-gate/v1', ...refusal });
  process.stderr.write(error.message + '\n'); process.exitCode = 75;
}

async function execute(profile, memoryOptions) {
  // --held owns the external lock; without it the initial check is still cheap
  // and bounded. Never enter a slot wait while memory is already pressured.
  update({ phase: 'checking-memory' });
  waitForPromotionMemory(canonical, { ...memoryOptions, held: true });
  checkCompetingProcesses(profile);
  update({ phase: 'waiting-test-slot' });
  const common = gitProject(canonical).identity;
  const declared = canonicalValidation(canonical, profile.env).tiers.promotion;
  const limits = resolveGateLimits({ common, env: profile.env, tier: 'promotion', historyKey: gateHistoryKey('promotion', ['/bin/sh', '-c', declared.command]), timeoutSeconds: profile.timeoutSeconds ?? declared.timeoutSeconds,
    idleTimeoutSeconds: profile.idleTimeoutSeconds ?? declared.idleTimeoutSeconds });
  const plan = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  const command = [process.execPath, SELF, '--execute', canonical, receipt, ...argv];
  const resolved = resolveResource(['/bin/sh', '-c', declared.command], { cwd: canonical, env: profile.env });
  const declaredResource = profile.resource ?? resolved.profile ?? resolved.declaration;
  const resource = declaredResource ? { ...declaredResource, id: `${declaredResource.id}/train`, command,
    recipe: { command: declared.command, prepare: profile.prepare, gate_fingerprint: profile.fingerprint,
      batch_inputs: { identity: plan.identity, jobs: plan.jobs.map(job => ({ id: job.id, topic: job.topic, expected_head: job.expectedHead })) } } } : undefined;
  const executionReceipt = path.join(path.dirname(receipt), `host-gate.${randomUUID()}.execution.json`);
  update({ execution_receipt: executionReceipt });
  const result = runTestSlotSync(`train ${canonical}`, command,
    { cwd: canonical, env: { ...profile.env, MONITOR_GATE_NOTICE_CONTEXT: JSON.stringify({ to: plan.jobs[0]?.to, org: plan.jobs[0]?.org ?? undefined, cwd: canonical, herdr: plan.jobs[0]?.herdr }) },
      resource, executionReceipt, common, tier: 'promotion-host', timeoutSeconds: 0, idleTimeoutSeconds: limits.idle_seconds, waitSeconds: profile.waitSeconds, waitReceipt: slotFile, retryTimeout: false, stdio: 'inherit' });
  update({ resource: result.execution?.resource, measurement: result.execution?.measurement });
  const saved = read();
  if (result.gateTimeout) update({ phase: 'timeout', finished_at: new Date().toISOString(), exit_code: 124, gate_timeout: result.gateTimeout,
    reason: result.gateTimeout.kind === 'frozen' ? 'gate frozen without output or process activity; lane isolated for correction' : result.gateTimeout.kind === 'idle' ? 'gate no-output limit exceeded; lane isolated for correction' : 'gate wall-clock limit exceeded; lane isolated for correction' });
  if (!saved.command_started) {
    const slotReason = fs.existsSync(slotFile) ? JSON.parse(fs.readFileSync(slotFile, 'utf8')).reason : null;
    update({ phase: 'refused', finished_at: new Date().toISOString(), reason: saved.reason ?? slotReason ?? `TEST_SLOT_REFUSED: exit ${exitOf(result)}; inspect the gate log` });
  }
  return exitOf(result);
}
