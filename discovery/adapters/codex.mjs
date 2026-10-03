#!/usr/bin/env node
// Install/launch outside the agent sandbox. The child keeps its native sandbox;
// this parent serves only fixed operations on its own creation receipts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createEntry } from '../runtime.mjs';
import { entryPolicy } from '../policy.mjs';
import { freshInteractive, interactiveResume } from '../launch.mjs';
import { sessionEnvironment, sessionHookArguments, passthroughEnvironment } from '../../supervisor/session-hooks.mjs';
import { spawnNative } from '../session.mjs';
import { FleetError } from '../../lib/fleet.mjs';
const separator = process.argv.indexOf('--');
const adapterArgs = process.argv.slice(2, separator < 0 ? undefined : separator);
const native = separator < 0 ? [] : process.argv.slice(separator + 1);
const { values } = parseArgs({ args: adapterArgs, options: {
  repo: { type: 'string', default: process.cwd() }, role: { type: 'string', default: 'worker' },
  binary: { type: 'string', default: 'codex' }, 'runtime-dir': { type: 'string' }, 'worktree-root': { type: 'string' },
  validator: { type: 'string' },
  'policy-only': { type: 'boolean' }, 'auto-entry': { type: 'boolean' },
} });
const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/u, '');
let entry;
function passthrough() {
  const child = spawn(values.binary, native, { stdio: 'inherit', env: passthroughEnvironment(process.env,
    { interactiveResume: interactiveResume({ kind: 'codex', args: native }) }) });
  child.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
  child.on('close', (code) => { process.exitCode = code ?? 1; });
}
const automatic = values['auto-entry'];
const enter = !automatic || freshInteractive({ kind: 'codex', args: native, cwd: values.repo });
if (!enter) passthrough();
else {
try {
  entry = createEntry({ cwd: values.repo, role: values.role, runtimeDir: values['runtime-dir'] ?? process.env.MONITOR_RUNTIME_DIR,
    worktreeRoot: values['worktree-root'] ?? process.env.MONITOR_WORKTREE_ROOT, sandboxBinary: values.validator ?? values.binary });
  if (!entry) passthrough();
  else {
  const context = entry.context();
  const policy = entryPolicy(context, root);
  if (values['policy-only']) { console.log(policy); entry.close(); }
  else {
    // Deliberately keep native model, effort, approvals and sandbox arguments.
    // -C belongs to entry because changing checkout changes the capability.
    if (native.some((arg) => arg.startsWith('-C') || ['--cd', '--worktree'].includes(arg) || arg.startsWith('--cd='))) throw new Error('select project with adapter --repo; native checkout overrides are not allowed');
    const nativeArgs = ['--no-daemon', ...native, ...sessionHookArguments('codex', context, root), '-C', context.workspace, '--add-dir', context.requests, '-c', `developer_instructions=${JSON.stringify(policy)}`];
    const child = spawnNative(entry, values.binary, nativeArgs, { cwd: context.workspace,
      env: { ...sessionEnvironment(context, root), ORG_DIR: context.org, MONITOR_REQUEST_DIR: context.requests } });
    const timer = setInterval(() => entry.poll(), 40);
    const signal = (s) => child.kill(s);
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => signal(s));
    child.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
    child.on('close', (code, s) => { clearInterval(timer); entry.close(); process.exitCode = code ?? (s ? 1 : 0); });
  }
  }
} catch (e) {
  if (entry) entry.close();
  const fallback = automatic && !entry && !(e instanceof FleetError);
  console.error(`monitor entry: ${e.message}${fallback ? '; continuing with native Codex' : ''}`);
  if (fallback) passthrough(); else process.exitCode = 1;
}
}
