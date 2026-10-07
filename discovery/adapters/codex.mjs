#!/usr/bin/env node
// Install/launch outside the agent sandbox. The child keeps its native sandbox;
// this parent serves only fixed operations on its own creation receipts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from '../../lib/cli-help.mjs';
import { createEntry } from '../runtime.mjs';
import { entryPolicy } from '../policy.mjs';
import { freshInteractive, interactiveResume } from '../launch.mjs';
import { sessionEnvironment, sessionHookArguments, passthroughEnvironment } from '../../supervisor/session-hooks.mjs';
import { spawnNative } from '../session.mjs';
import { FleetError } from '../../lib/fleet.mjs';
import { nativeSandboxLaunch, nativeSessionContext, nativeSession } from '../native-sandbox.mjs';
import { TemporaryError } from '../temporary.mjs';
import { resolveNative } from '../native-binary.mjs';
const separator = process.argv.indexOf('--');
const adapterArgs = process.argv.slice(2, separator < 0 ? undefined : separator);
const native = separator < 0 ? [] : process.argv.slice(separator + 1);
const { values } = parseArgs({ usage: "Usage: monitor-codex [--repo PROJECT] [--role worker|supervisor] [OPTIONS] [-- NATIVE_ARGS...]", args: adapterArgs, options: {
  repo: { type: 'string', default: process.cwd() }, role: { type: 'string', default: 'worker' },
  binary: { type: 'string', default: 'codex' }, 'runtime-dir': { type: 'string' }, 'worktree-root': { type: 'string' },
  validator: { type: 'string' }, 'entry-bin': { type: 'string' },
  'policy-only': { type: 'boolean' }, 'auto-entry': { type: 'boolean' },
} });
if (values['entry-bin']) {
  try { values.binary = resolveNative('codex', { entryBin: values['entry-bin'], fallback: values.binary }); }
  catch (error) { console.error(`monitor entry: ${error.message}`); process.exit(1); }
}
const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/u, '');
let entry;
function passthrough() {
  let launch = { binary: values.binary, args: native, env: passthroughEnvironment(process.env,
    { interactiveResume: interactiveResume({ kind: 'codex', args: native }) }) };
  try {
    if (nativeSession('codex', native)) {
      let cwd = values.repo;
      for (let i = 0; i < native.length; i++) {
        if (['-C', '--cd'].includes(native[i])) cwd = native[++i];
        else if (native[i].startsWith('--cd=')) cwd = native[i].slice(5);
        else if (native[i].startsWith('-C')) cwd = native[i].slice(2);
      }
      const context = nativeSessionContext(cwd);
      if (context) launch = nativeSandboxLaunch({ kind: 'codex', binary: values.binary, args: native, context, env: { ...launch.env, ORG_DIR: context.org } });
      else console.error('monitor: not a fleet project; starting native Codex without a project sandbox');
    }
  } catch (error) { console.error(`monitor sandbox: ${error.message}`); process.exitCode = 1; return; }
  const child = spawn(launch.binary, launch.args, { stdio: 'inherit', env: launch.env });
  child.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
  child.on('close', (code) => { launch.close?.(); process.exitCode = code ?? 1; });
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
    // Keep native model, effort and approval arguments; generate the sandbox.
    // -C belongs to entry because changing checkout changes the capability.
    if (native.some((arg) => arg.startsWith('-C') || ['--cd', '--worktree'].includes(arg) || arg.startsWith('--cd='))) throw new Error('select project with adapter --repo; native checkout overrides are not allowed');
    const nativeArgs = ['--no-daemon', ...native, ...sessionHookArguments('codex', context, root), '-C', context.workspace, '-c', `developer_instructions=${JSON.stringify(policy)}`];
    const launch = nativeSandboxLaunch({ kind: 'codex', binary: values.binary, args: nativeArgs, context,
      env: { ...sessionEnvironment(context, root), ORG_DIR: context.org, MONITOR_REQUEST_DIR: context.requests } });
    let child;
    try { child = spawnNative(entry, launch.binary, launch.args, { cwd: context.workspace, env: launch.env }); }
    catch (error) { launch.close(); throw error; }
    const timer = setInterval(() => entry.poll(), 40);
    const signal = (s) => child.kill(s);
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => signal(s));
    child.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
    child.on('close', (code, s) => { clearInterval(timer); launch.close(); entry.close(); process.exitCode = code ?? (s ? 1 : 0); });
  }
  }
} catch (e) {
  if (entry) entry.close();
  const fallback = automatic && !entry && !(e instanceof FleetError) && !(e instanceof TemporaryError);
  console.error(`monitor entry: ${e.message}${fallback ? '; continuing with native Codex' : ''}`);
  if (fallback) passthrough(); else process.exitCode = 1;
}
}
