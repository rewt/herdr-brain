// Synchronous adapters keep the existing lane/release APIs. The foreground CLI
// owns the asynchronous wait, command group, signal forwarding and lock lifetime.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REFUSED_EXIT } from './test-slot.mjs';
import { processStartRecord } from './lock-support.mjs';
const CLI = fileURLToPath(new URL('./test-slot.mjs', import.meta.url));
export { REFUSED_EXIT };
export function runTestSlotSync(label, argv, { retryTimeout = true, waitSeconds, waitReceipt, executionReceipt, ...options } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-test-slot-result-'));
  const receipt = executionReceipt ?? path.join(directory, 'result.json');
  try {
    const caller = { pid: process.pid, ...processStartRecord(process.pid) };
    const result = spawnSync(process.execPath, [CLI, 'run', label, '--result-path', receipt, '--caller', JSON.stringify(caller),
      ...(waitSeconds === undefined ? [] : ['--wait', String(waitSeconds)]),
      ...(waitReceipt === undefined ? [] : ['--wait-receipt-path', waitReceipt]),
      ...(retryTimeout ? ['--retry-timeout-under-load'] : []), '--', ...argv], options);
    // Preserve actual command signals across the wrapper's portable 128+signal
    // exit convention. Never guess a signal from a deliberate numeric exit.
    if (!result.error && fs.existsSync(receipt)) {
      const metadata = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      if (metadata.signal) { result.signal = metadata.signal; result.status = null; }
      result.attempts = metadata.attempts;
    }
    return result;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
