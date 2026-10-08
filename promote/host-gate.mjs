#!/usr/bin/env node
// Foreground host adapter. It inherits the supervisor's OS permissions; a
// detached process cannot escape a worker sandbox. Check capabilities before
// any build, and leave a refusal explaining how to launch from the host.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { writeFileAtomic } from '../lib/files.mjs';
import { runTestSlotSync } from '../test-slot/run.mjs';
import { resolveGateProfile, checkCompetingProcesses, HOST_ENV } from './gate-profile.mjs';
import { gitProject } from '../lib/project.mjs';
import { canonicalValidation } from '../lanes/validation.mjs';
import { resolveGateLimits } from '../test-slot/limits.mjs';
import { cliHelp } from '../lib/cli-help.mjs';
cliHelp(import.meta.url, "Usage: node promote/host-gate.mjs [--lock|--held|--execute] CANONICAL RECEIPT [COMMAND ARGS...]");

const args = process.argv.slice(2);
const mode = args[0]?.startsWith('--') ? args.shift() : '--lock';
const [canonical, receipt, ...argv] = args;
const hostFile = path.join(path.dirname(receipt), 'host-gate.json');
const slotFile = path.join(path.dirname(receipt), 'test-slot-wait.json');
const read = () => JSON.parse(fs.readFileSync(hostFile, 'utf8'));
const save = data => writeFileAtomic(hostFile, JSON.stringify(data, null, 2) + '\n', 0o600);
const update = changes => save({ ...read(), ...changes });
const exitOf = r => r.status ?? 1;

async function requireHost() {
  try {
    const fd = fs.openSync('/dev/ptmx', 'r+'); fs.closeSync(fd);
    await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()));
    });
  } catch (error) { throw new Error(`PROMOTE_HOST_REQUIRED: sockets or /dev/ptmx unavailable (${error.code ?? error.message}); launch promotion from the supervisor's host shell outside the worker sandbox`); }
}

try {
  const profile = resolveGateProfile(canonical);
  if (!profile) throw new Error('promotion host adapter requires a declared gate profile');
  if (mode !== '--lock' && read().profile_fingerprint !== profile.fingerprint) throw new Error('promotion gate profile changed while waiting; enqueue again');
  if (mode === '--lock') {
    save({ schema: 'promotion-host-gate/v1', profile_fingerprint: profile.fingerprint,
      started_at: new Date().toISOString(), phase: 'starting', slot_receipt: slotFile,
      ...(profile.node ? { node: profile.node } : {}) });
    if (profile.externalLock) {
      const started = new Date().toISOString();
      update({ phase: 'waiting-external-lock', external_lock: { path: profile.externalLock, state: 'waiting', started_at: started, wait_seconds: profile.waitSeconds } });
      process.stderr.write(`PROMOTE_LOCK_WAIT: ${profile.externalLock}; capped at ${profile.waitSeconds}s; receipt=${hostFile}\n`);
      // zsystem flock uses fcntl record locks, NOT flock(2). -e keeps the
      // descriptor through exec, so the same PID owns it until this batch ends.
      // No shell interpolation: project paths and commands are positional args.
      const script = 'zmodload zsh/system || exit 74\n: >> "$1" || exit 74\nzsystem flock -e -t "$2" -i 0.1 -f monitor_gate_fd "$1"\nrc=$?\n[[ $rc == 0 ]] || { [[ $rc == 2 ]] && exit 75; exit 74; }\nshift 2\nexec "$@"';
      const result = spawnSync('/bin/zsh', ['-f', '-c', script, 'monitor-gate-lock', profile.externalLock, String(profile.waitSeconds),
        process.execPath, process.argv[1], '--held', canonical, receipt, ...argv], { env: profile.env, stdio: 'inherit' });
      const saved = read();
      if (saved.external_lock.state === 'waiting') {
        const reason = result.status === 75 ? `PROMOTE_LOCK_HELD: ${profile.externalLock}; wait capped at ${profile.waitSeconds}s` : `PROMOTE_LOCK_UNKNOWN: ${result.error?.message ?? `kernel lock exit ${result.status}`}`;
        update({ phase: 'refused', reason, external_lock: { ...saved.external_lock, state: 'refused', finished_at: new Date().toISOString() } });
        process.stderr.write(reason + '\n');
      }
      process.exitCode = exitOf(result);
    } else {
      process.exitCode = await execute(profile);
    }
  } else if (mode === '--held') {
    const saved = read();
    update({ external_lock: { ...saved.external_lock, state: 'acquired', finished_at: new Date().toISOString() } });
    process.exitCode = await execute(profile);
  } else if (mode === '--execute') {
    checkCompetingProcesses(profile); // a competing direct gate may start during the slot wait
    update({ phase: 'running', command_started: true, command_started_at: new Date().toISOString() });
    const result = spawnSync(process.execPath, argv, { env: { ...profile.env, [HOST_ENV]: profile.fingerprint,
      MONITOR_TEST_SLOT_TOKEN: process.env.MONITOR_TEST_SLOT_TOKEN, BCH_CLOAK_TEST_SLOT_TOKEN: process.env.BCH_CLOAK_TEST_SLOT_TOKEN }, stdio: 'inherit' });
    update({ phase: 'finished', finished_at: new Date().toISOString(), exit_code: exitOf(result), signal: result.signal ?? null });
    process.exitCode = exitOf(result);
  } else throw new Error('unknown host gate phase');
} catch (error) {
  if (fs.existsSync(hostFile)) update({ phase: 'refused', reason: error.message, finished_at: new Date().toISOString() });
  process.stderr.write(error.message + '\n'); process.exitCode = 75;
}

async function execute(profile) {
  await requireHost();
  checkCompetingProcesses(profile);
  update({ phase: 'waiting-test-slot' });
  const common = gitProject(canonical).identity;
  const declared = canonicalValidation(canonical, profile.env).tiers.promotion;
  const limits = resolveGateLimits({ common, tier: 'promotion', command: ['/bin/sh', '-c', declared.command], timeoutSeconds: profile.timeoutSeconds ?? declared.timeoutSeconds,
    idleTimeoutSeconds: profile.idleTimeoutSeconds ?? declared.idleTimeoutSeconds });
  // The lifecycle envelope includes preparation and bookkeeping. Give the
  // inner gate time to return its exact timeout receipt before this backstop.
  const result = runTestSlotSync(`train ${canonical}`, [process.execPath, process.argv[1], '--execute', canonical, receipt, ...argv],
    { cwd: canonical, env: profile.env, common, tier: 'promotion-host', timeoutSeconds: Math.max(600, 2 * limits.wall_seconds), idleTimeoutSeconds: 0, waitSeconds: profile.waitSeconds, waitReceipt: slotFile, retryTimeout: false, stdio: 'inherit' });
  const saved = read();
  if (result.gateTimeout) update({ phase: 'timeout', finished_at: new Date().toISOString(), exit_code: 124, gate_timeout: result.gateTimeout,
    reason: result.gateTimeout.kind === 'idle' ? 'gate no-output limit exceeded; lane isolated for correction' : 'gate wall-clock limit exceeded; lane isolated for correction' });
  if (!saved.command_started) {
    const slotReason = fs.existsSync(slotFile) ? JSON.parse(fs.readFileSync(slotFile, 'utf8')).reason : null;
    update({ phase: 'refused', finished_at: new Date().toISOString(), reason: saved.reason ?? slotReason ?? `TEST_SLOT_REFUSED: inspect ${slotFile}` });
  }
  return exitOf(result);
}
