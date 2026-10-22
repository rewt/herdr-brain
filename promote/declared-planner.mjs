#!/usr/bin/env node
// Stream bounds live inside the watchdog's group. Exiting on an oversized
// stream lets that watchdog stop every descendant, including a stuck runtime.
import fs from 'node:fs';
import { isMain } from '../lib/cli-help.mjs';
import { spawn } from 'node:child_process';
import { MAX_PLAN_BYTES, argv } from './declaration.mjs';
export function main(args = process.argv.slice(2)) {
  const command = JSON.parse(args[0]);
  if (!argv(command)) throw Error('invalid planner command');
  const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [];
  let stdoutBytes = 0, stderrBytes = 0;
  child.stdout.on('data', chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_PLAN_BYTES) { console.error('planner stdout exceeds 1 MiB'); process.exit(1); }
    chunks.push(chunk);
  });
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_PLAN_BYTES) { console.error('planner diagnostics exceed 1 MiB'); process.exit(1); }
    process.stderr.write(chunk);
  });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('close', (code, signal) => {
    if (code !== 0 || signal) { process.exitCode = code || 1; return; }
    process.stdout.write(Buffer.concat(chunks));
  });
  child.stdin.on('error', () => {});
  child.stdin.end(fs.readFileSync(0));
}
if (isMain(import.meta.url)) main();
