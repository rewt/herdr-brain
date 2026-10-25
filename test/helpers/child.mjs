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
  let stdout = '', stderr = '';
  const result = new Promise((resolve, reject) => {
    let exited = false, disconnected = false, code, signal;
    const complete = (exitCode, exitSignal) => resolve({ code: exitCode, status: exitCode, signal: exitSignal, stdout, stderr });
    const joinedIPC = () => {
      // A parent-initiated IPC disconnect can lose Node's aggregate close
      // notification. Require the actual exit, observed IPC disconnect and
      // BOTH readable ends instead; never infer drain from exit or elapsed time.
      if (exited && disconnected && [child.stdout, child.stderr].every(stream => !stream || stream.readableEnded)) complete(code, signal);
    };
    child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.stdout?.on('end', joinedIPC); child.stderr?.on('end', joinedIPC);
    child.once('exit', (exitCode, exitSignal) => { exited = true; code = exitCode; signal = exitSignal; joinedIPC(); });
    child.once('disconnect', () => { disconnected = true; joinedIPC(); });
    child.once('error', reject);
    child.once('close', complete);

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
