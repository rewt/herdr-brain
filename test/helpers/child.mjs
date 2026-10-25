import { loadTimeout } from '../../lib/deadline.mjs';
import { spawn } from 'node:child_process';
import { registerProcess, killProcess } from './processes.mjs';

const children = new WeakMap();
const processes = new WeakMap();

export const childProcessEntry = (child) => processes.get(child);

// Fixture descendants inherit the suite group. Individual teardown never
// licenses a signal to a vanished leader's historical process group.
export function killChild(child, signal = 'SIGKILL') {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return { ok: true, signaled: false };
  return killProcess(processes.get(child), signal);
}

// Legacy fifth arguments remain accepted; they no longer limit execution.
export function spawnChild(t, command, args, options = {}, _timeoutMs) {
  return trackedChild(t, command, args, options);
}

// Compound scenarios keep the same ownership, cancellation and teardown.
export function spawnScenarioChild(t, command, args, options = {}, _timeoutMs) {
  return trackedChild(t, command, args, options);
}

function trackedChild(t, command, args, options) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options, detached: false });
  let rollback = false;
  child.kill = (signal = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    const sent = killProcess({ ...processes.get(child), group: false }, signal).signaled ?? false;
    if (sent) child.killed = true;
    return sent;
  };
  let stdout = '', stderr = '', drainTimer;
  const result = new Promise((resolve, reject) => {
    child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(drainTimer);
      resolve({ code, status: code, signal, stdout, stderr });
    });
    child.once('exit', (code, signal) => {
      // A background grandchild can retain these pipes after its parent exits.
      // Do not let that prevent the report-only suite audit from running.
      drainTimer = setTimeout(() => {
        child.stdout?.destroy(); child.stderr?.destroy();
        resolve({ code, status: code, signal, stdout, stderr });
      }, loadTimeout(500));
    });
  });
  // Tests sometimes inspect a fixture before awaiting it. Retain an early
  // error/close without an unhandled rejection or a missed close event.
  result.catch(() => {});
  children.set(child, result);
  const abort = () => killChild(child);
  t.signal.addEventListener('abort', abort, { once: true });
  t.after(async () => {
    t.signal.removeEventListener('abort', abort);
    const live = child.exitCode === null && child.signalCode === null;
    const cleanup = killChild(child);
    if (!cleanup.ok || cleanup.reason === 'changed') {
      // A refused lookup must neither authorize a signal nor leave teardown
      // awaiting an unconfirmed process forever. The suite reports the failure.
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
      throw new Error(`${t.name}: child cleanup unconfirmed; no signal sent to ${child.pid}`);
    }
    await result;
    if (live && !rollback) throw new Error(`${t.name}: left child running: ${command} ${args.join(' ')}`);
  });
  try {
    if (child.pid) processes.set(child, registerProcess(child.pid));
  } catch (error) {
    rollback = true;
    killChild(child);
    throw error;
  }
  return child;
}

export function waitForExit(child) {
  const result = children.get(child);
  if (!result) throw new Error('waitForExit requires a child registered at spawn time');
  return result;
}
