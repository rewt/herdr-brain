// Concrete capability evidence, never a permission grant or an executor switch.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lookupProcess } from '../lib/processes.mjs';
import { OPERATOR_LANDING_WAIVER } from '../lib/validation-declaration.mjs';

const workerCLI = fileURLToPath(new URL('./promote.mjs', import.meta.url));
export function probeNativeGate({ open = fs.openSync, close = fs.closeSync } = {}) {
  const at = new Date().toISOString();
  try {
    const fd = open('/dev/ptmx', fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
    close(fd);
  } catch (error) {
    return { ok: false, code: 'PROMOTE_NATIVE_PTMX_REFUSED', capability: 'open /dev/ptmx read/write', at,
      reason: `PROMOTE_NATIVE_PTMX_REFUSED: ${error.code ?? 'unknown'} opening /dev/ptmx; native permissions remain authoritative; no relaunch`, error: error.code ?? null };
  }
  // The existing gate-profile fixture also requires a loopback listener.
  // This short foreground child inherits this exact native context. It closes
  // its ephemeral listener and cannot change permissions or retry a refusal.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import net from 'node:net';const s=net.createServer();s.once('error',e=>{console.error(e.code);process.exitCode=1;});s.listen(0,'127.0.0.1',()=>s.close());"],
    { encoding: 'utf8' });
  if (result.error || result.status !== 0 || result.signal) return { ok: false, code: 'PROMOTE_NATIVE_LOOPBACK_REFUSED',
    capability: 'listen 127.0.0.1:0', at, error: result.error?.code ?? result.stderr?.trim() ?? result.signal ?? 'unknown',
    reason: `PROMOTE_NATIVE_LOOPBACK_REFUSED: ${result.stderr?.trim() || result.error?.code || result.signal || `exit ${result.status}`}; native permissions remain authoritative; no relaunch` };
  // The bounded gate runner and its fixture cleanup require a complete native
  // process inventory. Never substitute a partial table or another executor.
  const inventory = lookupProcess();
  if (!inventory.ok) return { ok: false, code: 'PROMOTE_NATIVE_PROCESS_SOURCE_REFUSED', capability: 'complete native process inventory', at,
    error: inventory.error, reason: `PROMOTE_NATIVE_PROCESS_SOURCE_REFUSED: ${inventory.error}; native permissions remain authoritative; no relaunch` };
  return { ok: true, capabilities: ['open /dev/ptmx read/write', 'listen 127.0.0.1:0', 'complete native process inventory'], at };
}

// Written only by the finite drain while it owns worker.lock. A PID alone is
// insufficient: compare the kernel birth and command with the probe's owner.
export function nativeWorkerEvidence({ gateRequired = true, authority } = {}) {
  const native_gate = gateRequired ? probeNativeGate() : { outcome: 'not-required', executed: false, authority };
  if (gateRequired && !native_gate.ok) return { native_gate };
  const current = lookupProcess(process.pid);
  return { native_gate, ...(current.ok && current.value ? { native_process: current.value } : {}) };
}
export function liveNativeWorker(identity, { gateRequired = true, authority } = {}) {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(identity, 'promote/worker.lock/owner.json'), 'utf8'));
    const gate = owner.native_gate;
    // Only the canonical caller's actual waiver can match a drain that recorded
    // this probe as unused. A refused probe is never converted into permission.
    const waived = !gateRequired && authority === OPERATOR_LANDING_WAIVER &&
      gate?.outcome === 'not-required' && gate.executed === false &&
      gate.authority === authority && gate.ok === undefined;
    if ((!gate?.ok && !waived) || owner.argv?.[1] !== workerCLI || !owner.argv.includes('--drain') || owner.native_process?.pid !== owner.pid || !owner.native_process.command?.includes(`${workerCLI} --drain`)) return null;
    const current = lookupProcess(owner.pid);
    if (!current.ok || !current.value || /^Z/.test(current.value.state) || current.value.identity !== owner.native_process.identity || current.value.command !== owner.native_process.command) return null;
    return { pid: owner.pid, identity: current.value.identity, capability: owner.native_gate };
  } catch { return null; }
}
