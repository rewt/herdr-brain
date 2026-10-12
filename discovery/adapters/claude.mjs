#!/usr/bin/env node
// Claude's prompt transport lives here, outside the neutral entry runtime/core.
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
const { values } = parseArgs({ usage: "Usage: monitor-claude [--repo PROJECT] [--role worker|review|supervisor|chat] [OPTIONS] [-- NATIVE_ARGS...]", args: process.argv.slice(2, separator < 0 ? undefined : separator), options: {
  repo: { type: 'string', default: process.cwd() }, role: { type: 'string', default: 'worker' },
  binary: { type: 'string' }, 'native-fallback': { type: 'string' }, 'native-explicit': { type: 'boolean' }, validator: { type: 'string' },
  'entry-bin': { type: 'string' }, 'codex-fallback': { type: 'string' }, 'codex-explicit': { type: 'boolean' },
  'runtime-dir': { type: 'string' }, 'worktree-root': { type: 'string' }, 'policy-only': { type: 'boolean' }, 'auto-entry': { type: 'boolean' },
} });
if (!values.binary && values['entry-bin']) {
  try {
    values.binary = resolveNative('claude', { entryBin: values['entry-bin'], fallback: values['native-fallback'], explicit: values['native-explicit'] });
  } catch (error) { console.error(`monitor entry: ${error.message}`); process.exit(1); }
}
values.binary ??= 'claude';
const native = separator < 0 ? [] : process.argv.slice(separator + 1);
const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/u, '');
let entry;
function passthrough() {
  const resume = interactiveResume({ kind: 'claude', args: native });
  let launch = { binary: values.binary, args: native, env: passthroughEnvironment(process.env, { interactiveResume: resume }) };
  try {
    if (nativeSession('claude', native)) {
      const context = nativeSessionContext(values.repo);
      if (context) {
        context.role = resume ? (process.env.MONITOR_SESSION_ROLE || 'worker') : 'worker';
        launch = nativeSandboxLaunch({ entryBin: values['entry-bin'], kind: 'claude', binary: values.binary,
          args: native, context,
          env: { ...launch.env, ORG_DIR: context.org } });
      }
      else console.error('monitor: not a fleet project; starting native Claude without a project sandbox');
    }
  } catch (error) { console.error(`monitor sandbox: ${error.message}`); process.exitCode = 1; return; }
  const child = spawn(launch.binary, launch.args, { stdio: 'inherit', env: launch.env });
  child.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
  child.on('close', (code) => { launch.close?.(); process.exitCode = code ?? 1; });
}
const automatic = values['auto-entry'];
const enter = !automatic || freshInteractive({ kind: 'claude', args: native, cwd: values.repo });
if (!enter) passthrough();
else {
try {
  if (!values.validator && values['codex-fallback']) values.validator = resolveNative('codex', {
    entryBin: values['entry-bin'], fallback: values['codex-fallback'], explicit: values['codex-explicit'],
  });
  values.validator ??= 'auto';
  entry = createEntry({ cwd: values.repo, role: values.role, runtimeDir: values['runtime-dir'] ?? process.env.MONITOR_RUNTIME_DIR,
    worktreeRoot: values['worktree-root'] ?? process.env.MONITOR_WORKTREE_ROOT, sandboxBinary: values.validator });
  if (!entry) passthrough();
  else {
  // Native --worktree creates a different checkout than our capability owns.
  if (native.some((arg) => ['--worktree', '-w'].includes(arg) || arg.startsWith('--worktree='))) throw new Error('Monitor owns the checkout; native worktree overrides are unavailable');
  const context = { ...entry.context(), entryBin: values['entry-bin'] }, policy = entryPolicy(context, root);
  if (values['policy-only']) { console.log(policy); entry.close(); }
  else {
    const environment = { ...sessionEnvironment(context, root), ORG_DIR: context.org, MONITOR_REQUEST_DIR: context.requests };
    const launch = nativeSandboxLaunch({ entryBin: values['entry-bin'], kind: 'claude', binary: values.binary,
      args: [...native, ...sessionHookArguments('claude', context, root), '--append-system-prompt', policy], context,
      env: environment });
    let child;
    try { child = spawnNative(entry, launch.binary, launch.args, { cwd: context.workspace, env: launch.env }); }
    catch (error) { launch.close(); throw error; }
    const timer = setInterval(() => entry.poll(), 40);
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => child.kill(s));
    child.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
    child.on('close', (code) => { clearInterval(timer); launch.close(); entry.close(); process.exitCode = code ?? 1; });
  }
  }
} catch (e) {
  if (entry) entry.close();
  const fallback = automatic && !entry && !(e instanceof FleetError) && !(e instanceof TemporaryError);
  console.error(`monitor entry: ${e.message}${fallback ? '; continuing with native Claude' : ''}`);
  if (fallback) passthrough(); else process.exitCode = 1;
}
}
