import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readPlainFile } from '../lib/files.mjs';
import { runGateSync } from '../test-slot/run.mjs';
import { tapTotals } from '../lanes/validation.mjs';
import { bytesHash, refuse, MAX_PLAN_BYTES } from './declaration.mjs';
import { remaining, contained } from './declared-support.mjs';
import { refuseDeclaredGatesV2 } from './declared-inert.mjs';

const boundedOutput = fileURLToPath(new URL('./declared-planner.mjs', import.meta.url));
export function runDeclaredCommand({ command, argv = ['/bin/sh', '-c', command], cwd, env, deadline, limits, directory, evidence, onUpdate = () => {}, kind, input, capMs, bounded = false, guard = () => {} }) {
  refuseDeclaredGatesV2();
  guard();
  const id = randomUUID(), log = path.join(directory, `${id}.stdout.log`), stderr = path.join(directory, `${id}.stderr.log`);
  const row = { kind, command: command ?? [...argv], cwd, started_at: new Date().toISOString(), log, stderr_log: stderr,
    execution_receipt: path.join(directory, `${id}.execution.json`), outcome: 'running' };
  evidence.commands.push(row); onUpdate();
  const out = fs.openSync(log, 'wx', 0o600), err = fs.openSync(stderr, 'wx', 0o600);
  let result;
  try {
    result = runGateSync(`declared ${kind}`, bounded ? [process.execPath, boundedOutput, JSON.stringify(argv)] : argv,
      { cwd, env, input, stdio: [input === undefined ? 'ignore' : 'pipe', out, err], executionReceipt: row.execution_receipt,
        timeoutSeconds: Math.max(0.001, Math.min(capMs ?? Infinity, remaining(deadline)) / 1000),
        idleTimeoutSeconds: limits.idle_seconds, retryTimeout: false });
  } catch (error) {
    row.error = error.message; throw error;
  } finally {
    fs.closeSync(out); fs.closeSync(err);
    row.finished_at = new Date().toISOString();
    row.duration_s = Math.max(0, (Date.parse(row.finished_at) - Date.parse(row.started_at)) / 1000);
    const stdout = readPlainFile(log), diagnostics = readPlainFile(stderr);
    row.log_hash = bytesHash(readPlainFile(log, null)); row.stderr_hash = bytesHash(readPlainFile(stderr, null));
    row.tap_totals = tapTotals(stdout);
    row.exit_code = result?.status ?? null; row.signal = result?.signal ?? null;
    row.gate_timeout = result?.gateTimeout ?? null;
    row.executed = result?.execution?.command_started === true;
    row.cleanup_error = result?.execution?.cleanup_error ?? null;
    try { row.execution_hash = bytesHash(readPlainFile(row.execution_receipt, null)); } catch { row.execution_hash = null; }
    row.outcome = row.exit_code === 0 && !row.signal && !row.gate_timeout && !row.cleanup_error ? 'executed' : 'failed';
    onUpdate();
  }
  // Rechecks always happen after retaining the command exit and logs.
  guard();
  if (result?.error) row.error = result.error.code ?? result.error.message;
  const stdout = readPlainFile(log);
  return { row, stdout, output_digest: bytesHash(readPlainFile(log, null)), ok: row.outcome === 'executed' && row.executed,
    ...(Buffer.byteLength(stdout) > MAX_PLAN_BYTES && bounded ? { oversized: true } : {}) };
}
export function recoverCommandEvidence(evidence, timeout = null) {
  for (const row of evidence?.commands ?? []) {
    if (row.finished_at) continue;
    let execution;
    try { execution = JSON.parse(readPlainFile(row.execution_receipt)); } catch { /* Interrupted watchdog may have no completion sidecar. */ }
    Object.assign(row, { outcome: 'failed', interrupted: true, finished_at: execution?.finished_at ?? new Date().toISOString(),
      exit_code: execution?.exit_code ?? null, signal: execution?.signal ?? null, gate_timeout: execution?.gate_timeout ?? timeout,
      executed: execution?.command_started === true });
    for (const [field, file] of [['log_hash', row.log], ['stderr_hash', row.stderr_log], ['execution_hash', row.execution_receipt]]) {
      try { row[field] = bytesHash(readPlainFile(file, null)); } catch { row[field] = null; }
    }
  }
}
export function prepareDeclared(steps, context) {
  refuseDeclaredGatesV2();
  for (const step of steps ?? []) {
    // Honor ordinary ordered guards, but only within this project/snapshot.
    // Dependency directories alone never suppress preparation on a fresh tree.
    if (step.unless !== undefined && fs.existsSync(path.join(context.cwd, step.unless)) && fs.statSync(contained(context.cwd, step.unless)).isFile()) {
      context.evidence.preparation_skips ??= [];
      context.evidence.preparation_skips.push({ command: step.run, cwd: context.cwd, unless: step.unless });
      continue;
    }
    const result = runDeclaredCommand({ ...context, command: step.run, kind: 'preparation' });
    if (!result.ok) {
      const error = result.row.gate_timeout ? Object.assign(Error('DECLARED_GATE_TIMEOUT: preparation exceeded attempt limits'), { code: 'DECLARED_GATE_TIMEOUT' })
        : refuse(`preparation failed (exit ${result.row.exit_code}, signal ${result.row.signal ?? 'none'}); log=${result.row.log}`);
      throw Object.assign(error, { commandEvidence: result.row });
    }
  }
}
