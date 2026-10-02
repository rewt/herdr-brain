import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerProcess, killProcess } from './processes.mjs';

const children = new WeakMap();
const processes = new WeakMap();
const suiteRunner = fileURLToPath(new URL('./run.mjs', import.meta.url));

export const childProcessEntry = (child) => processes.get(child);

// Fixture descendants inherit the suite group. Individual teardown never
// licenses a signal to a vanished leader's historical process group.
export function killChild(child, signal = 'SIGKILL') {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return { ok: true, signaled: false };
  return killProcess(processes.get(child), signal);
}

export function spawnChild(t, command, args, options = {}, timeoutMs = 15_000) {
  // A nested suite has its own leader, file watchdog and cancellation cleanup.
  // Its aggregate duration can exceed one command's fifteen-second bound.
  const maximum = command === process.execPath && args[0] === suiteRunner ? 55_000 : 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximum) throw new Error(`child timeout must be 1..${maximum}ms`);
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options, detached: false });
  let rollback = false;
  child.kill = (signal = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    const sent = killProcess({ ...processes.get(child), group: false }, signal).signaled ?? false;
    if (sent) child.killed = true;
    return sent;
  };
  let stdout = '', stderr = '', timer, drainTimer;
  const result = new Promise((resolve, reject) => {
    child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(drainTimer);
      resolve({ code, status: code, signal, stdout, stderr });
    });
    child.once('exit', (code, signal) => {
      // A background grandchild can retain these pipes after its parent exits.
      // Do not let that prevent the report-only suite audit from running.
      drainTimer = setTimeout(() => {
        child.stdout?.destroy(); child.stderr?.destroy(); clearTimeout(timer);
        resolve({ code, status: code, signal, stdout, stderr });
      }, 500);
    });
    timer = setTimeout(() => {
      killChild(child);
      reject(new Error(`${t.name}: child ${command} ${args.join(' ')} did not exit within ${timeoutMs}ms\n${stdout}${stderr}`));
    }, timeoutMs);
  });
  // Tests sometimes inspect a fixture before awaiting it. Retain an early
  // error/close without an unhandled rejection or a missed close event.
  result.catch(() => {});
  children.set(child, result);
  const abort = () => killChild(child);
  t.signal.addEventListener('abort', abort, { once: true });
  t.after(async () => {
    clearTimeout(timer);
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
