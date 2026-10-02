#!/usr/bin/env node
// Bound the entire process group, including background grandchildren. Kernel
// sandbox setup failures propagate; there is no unsandboxed retry.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export function runBounded(binary, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: 'inherit', detached: true });
    const stop = (signal) => { try { process.kill(-child.pid, signal); } catch {} };
    let expired = false;
    const timer = setTimeout(() => { expired = true; stop('SIGKILL'); }, timeoutMs);
    const handlers = Object.fromEntries(['SIGTERM', 'SIGINT', 'SIGHUP'].map((signal) => [signal, () => stop(signal)]));
    for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
    child.on('error', (e) => console.error(e.message));
    child.on('close', (code) => {
      clearTimeout(timer); stop('SIGKILL');
      for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
      if (expired) console.error(`sandbox command exceeded ${timeoutMs} milliseconds`);
      resolve(expired ? 124 : code ?? 1);
    });
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [binary, ...args] = process.argv.slice(2);
  process.exitCode = await runBounded(binary, args);
}
