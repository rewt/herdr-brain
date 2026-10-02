import { spawn } from 'node:child_process';
import { registerProcess, killProcess } from './processes.mjs';

const children = new WeakMap();
const processes = new WeakMap();

export const childProcessEntry = (child) => processes.get(child);

// A separate group lets cleanup reap fixture shells and their sleeps while its
// exact leader is confirmed alive. A vanished leader never licenses a signal.
export function killChild(child, signal = 'SIGKILL') {
  if (!child.pid) return { ok: true, signaled: false };
  return killProcess(processes.get(child), signal);
}

export function spawnChild(t, command, args, options = {}, timeoutMs = 15_000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw new Error('child timeout must be 1..15000ms');
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options, detached: process.platform !== 'win32' });
  let rollback = false;
  child.kill = (signal = 'SIGTERM') => {
    const sent = killProcess({ ...processes.get(child), group: false }, signal).signaled ?? false;
    if (sent) child.killed = true;
    return sent;
  };
  let stdout = '', stderr = '', timer;
  const result = new Promise((resolve, reject) => {
    child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, status: code, signal, stdout, stderr });
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
      // awaiting an unconfirmed process forever. Its journal remains available.
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
      throw new Error(`${t.name}: child cleanup unconfirmed; no signal sent to ${child.pid}`);
    }
    await result;
    if (live && !rollback) throw new Error(`${t.name}: left child running: ${command} ${args.join(' ')}`);
  });
  try {
    if (child.pid) registerProcess(child.pid, process.platform !== 'win32', undefined, (entry) => processes.set(child, entry));
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
