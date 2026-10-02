import { spawn } from 'node:child_process';
import { registerProcess, killProcess } from './processes.mjs';

const children = new WeakMap();
const processes = new WeakMap();

// A separate process group lets cleanup reap fixture shells and their sleeps,
// even after the direct child has exited. Only groups created here are killed.
export function killChild(child) {
  if (!child.pid) return;
  killProcess(processes.get(child));
}

export function spawnChild(t, command, args, options = {}, timeoutMs = 15_000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw new Error('child timeout must be 1..15000ms');
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options, detached: process.platform !== 'win32' });
  if (child.pid) processes.set(child, registerProcess(child.pid));
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
    killChild(child);
    await result;
    if (live) throw new Error(`${t.name}: left child running: ${command} ${args.join(' ')}`);
  });
  return child;
}

export function waitForExit(child) {
  const result = children.get(child);
  if (!result) throw new Error('waitForExit requires a child registered at spawn time');
  return result;
}
