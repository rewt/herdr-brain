#!/usr/bin/env node
// Stream bounds live inside the watchdog's group. Exiting on an oversized
// stream lets that watchdog stop every descendant, including a stuck runtime.
import fs from 'node:fs';
import { isMain } from '../lib/cli-help.mjs';
import { spawn } from 'node:child_process';
import { MAX_PLAN_BYTES, argv } from './declaration.mjs';
import { refuseDeclaredGatesV2 } from './declared-inert.mjs';
export function main(args = process.argv.slice(2)) {
  refuseDeclaredGatesV2();
  const command = JSON.parse(args[0]);
  if (!argv(command)) throw Error('invalid planner command');
  const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdoutBytes = 0, stderrBytes = 0;
  let oversized = false;
  const flush = callback => process.stdout.write('', () => process.stderr.write('', callback));
  const overflow = stream => {
    if (oversized) return;
    oversized = true;
    console.error(`planner ${stream} exceeds 1 MiB`);
    flush(() => process.exit(1));
  };
  child.stdout.on('data', chunk => {
    if (oversized) return;
    const available = MAX_PLAN_BYTES - stdoutBytes;
    stdoutBytes += chunk.length;
    // Retain bounded output as it arrives, even on failure or signal. This
    // also lets the leaf watchdog observe real output activity.
    if (available > 0) process.stdout.write(chunk.subarray(0, available));
    if (stdoutBytes > MAX_PLAN_BYTES) overflow('stdout');
  });
  child.stderr.on('data', chunk => {
    if (oversized) return;
    const available = MAX_PLAN_BYTES - stderrBytes;
    stderrBytes += chunk.length;
    if (available > 0) process.stderr.write(chunk.subarray(0, available));
    if (stderrBytes > MAX_PLAN_BYTES) overflow('diagnostics');
  });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('close', (code, signal) => {
    if (oversized) return;
    flush(() => {
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code ?? 1;
    });
  });
  child.stdin.on('error', () => {});
  child.stdin.end(fs.readFileSync(0));
}
if (isMain(import.meta.url)) main();
