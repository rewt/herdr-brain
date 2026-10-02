#!/usr/bin/env node
// Claude's prompt transport lives here, outside the neutral entry runtime/core.
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createEntry } from '../runtime.mjs';
import { entryPolicy } from '../policy.mjs';
import { freshInteractive } from '../launch.mjs';
const separator = process.argv.indexOf('--');
const { values } = parseArgs({ args: process.argv.slice(2, separator < 0 ? undefined : separator), options: {
  repo: { type: 'string', default: process.cwd() }, role: { type: 'string', default: 'worker' },
  binary: { type: 'string', default: 'claude' }, validator: { type: 'string', default: 'codex' },
  'runtime-dir': { type: 'string' }, 'worktree-root': { type: 'string' }, 'policy-only': { type: 'boolean' }, 'auto-entry': { type: 'boolean' },
} });
const native = separator < 0 ? [] : process.argv.slice(separator + 1);
const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/u, '');
let entry;
function passthrough() {
  const child = spawn(values.binary, native, { stdio: 'inherit' });
  child.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
  child.on('close', (code) => { process.exitCode = code ?? 1; });
}
const automatic = values['auto-entry'];
const enter = !automatic || freshInteractive({ kind: 'claude', args: native, cwd: values.repo });
if (!enter) passthrough();
else {
try {
  // Native --worktree creates a different checkout than our capability owns.
  if (native.some((arg) => ['--worktree', '-w'].includes(arg) || arg.startsWith('--worktree='))) throw new Error('Monitor owns the checkout; native worktree overrides are unavailable');
  entry = createEntry({ cwd: values.repo, role: values.role, runtimeDir: values['runtime-dir'] ?? process.env.MONITOR_RUNTIME_DIR,
    worktreeRoot: values['worktree-root'] ?? process.env.MONITOR_WORKTREE_ROOT, sandboxBinary: values.validator });
  const context = entry.context(), policy = entryPolicy(context, root);
  if (values['policy-only']) { console.log(policy); entry.close(); }
  else {
    const child = spawn(values.binary, [...native, '--append-system-prompt', policy, '--add-dir', context.requests], {
      cwd: context.workspace, stdio: 'inherit', env: { ...process.env, ORG_DIR: context.org, MONITOR_REQUEST_DIR: context.requests },
    });
    const timer = setInterval(() => entry.poll(), 40);
    process.on('SIGINT', () => child.kill('SIGINT')); process.on('SIGTERM', () => child.kill('SIGTERM'));
    child.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
    child.on('close', (code) => { clearInterval(timer); entry.close(); process.exitCode = code ?? 1; });
  }
} catch (e) {
  if (entry) entry.close();
  console.error(`monitor entry: ${e.message}${automatic && !entry ? '; continuing with native Claude' : ''}`);
  if (automatic && !entry) passthrough(); else process.exitCode = 1;
}
}
