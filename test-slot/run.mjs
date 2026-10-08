// Synchronous adapters keep the existing lane/release APIs. The foreground CLI
// owns the asynchronous wait, command group, signal forwarding and lock lifetime.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REFUSED_EXIT, HOLDER_UNKNOWN_CODE } from './test-slot.mjs';
import { processStartRecord } from './lock-support.mjs';
const CLI = fileURLToPath(new URL('./test-slot.mjs', import.meta.url));
export { REFUSED_EXIT };

// Match a wrapper refusal, including stderr redirected into a validation log.
// No execution receipt or attempts field: the command has not started.
function callerRefusal(label, error, options) {
  const message = `${HOLDER_UNKNOWN_CODE}: ${label} refused: cannot establish caller process source identity: ${error.message}\n`;
  const output = [null, '', message].map((text, index) => {
    if (index === 0) return null;
    const target = Array.isArray(options.stdio) ? options.stdio[index] : options.stdio;
    const fd = target === 'inherit' ? index : typeof target === 'number' ? target : target?.fd;
    if (typeof fd === 'number') { if (text) fs.writeSync(fd, text); return null; }
    if (target === 'ignore') return null;
    return options.encoding && options.encoding !== 'buffer' ? text : Buffer.from(text);
  });
  return { pid: 0, output, stdout: output[1], stderr: output[2], status: REFUSED_EXIT, signal: null };
}

export function runGateSync(label, argv, { acquireSlot = false, retryTimeout = true, waitSeconds, waitReceipt, executionReceipt, common, tier, timeoutSeconds, idleTimeoutSeconds, ...options } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-test-slot-result-'));
  const receipt = executionReceipt ?? path.join(directory, 'result.json');
  try {
    let caller;
    try { caller = { pid: process.pid, ...processStartRecord(process.pid) }; }
    catch (error) { return callerRefusal(label, error, options); }
    const result = spawnSync(process.execPath, [CLI, 'run', label, ...(acquireSlot ? [] : ['--no-slot']), '--result-path', receipt, '--caller', JSON.stringify(caller),
      ...(common === undefined ? [] : ['--project-common', common]),
      ...(tier === undefined ? [] : ['--tier', tier]),
      ...(timeoutSeconds === undefined ? [] : ['--timeout-seconds', String(timeoutSeconds)]),
      ...(idleTimeoutSeconds === undefined ? [] : ['--idle-timeout-seconds', String(idleTimeoutSeconds)]),
      ...(waitSeconds === undefined ? [] : ['--wait', String(waitSeconds)]),
      ...(waitReceipt === undefined ? [] : ['--wait-receipt-path', waitReceipt]),
      ...(retryTimeout ? ['--retry-timeout-under-load'] : []), '--', ...argv], options);
    // Preserve actual command signals across the wrapper's portable 128+signal
    // exit convention. Never guess a signal from a deliberate numeric exit.
    if (!result.error && fs.existsSync(receipt)) {
      const metadata = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      if (metadata.signal) { result.signal = metadata.signal; result.status = null; }
      result.attempts = metadata.attempts;
      result.execution = metadata;
      result.gateTimeout = metadata.gate_timeout;
    }
    return result;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

export function runTestSlotSync(label, argv, options = {}) {
  return runGateSync(label, argv, { ...options, acquireSlot: true });
}
