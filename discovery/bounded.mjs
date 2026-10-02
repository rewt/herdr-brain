#!/usr/bin/env node
// The native foreground owner confirms descendant cleanup before returning.
// Compilation/containment failures propagate; there is no unbounded retry.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkedDirectory } from './paths.mjs';
import { lifetimeScope, closeScope } from './lifetime.mjs';
let helper;
function supervisor() {
  if (helper) return helper;
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('validation descendant containment unavailable on this platform');
  // Ignore agent-controlled TMPDIR, CC and compiler flags. Project sandboxes
  // cannot write this private, no-follow-checked system scratch directory.
  const directory = fs.mkdtempSync(path.join(checkedDirectory('/tmp'), 'monitor-owner-'));
  fs.chmodSync(directory, 0o700); checkedDirectory(directory);
  const executable = path.join(directory, 'owner');
  const built = spawnSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-o', executable,
    fileURLToPath(new URL('./process-supervisor.c', import.meta.url))], { timeout: 15000, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', TMPDIR: directory } });
  if (built.error || built.status) { fs.rmSync(directory, { recursive: true, force: true }); throw new Error(`validation owner unavailable: ${built.error?.message ?? built.stderr}`); }
  const fd = fs.openSync(executable, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const identity = fs.fstatSync(fd); fs.closeSync(fd);
  if (!identity.isFile() || identity.uid !== process.getuid()) throw new Error('validation owner identity changed');
  helper = executable;
  process.once('exit', () => fs.rmSync(directory, { recursive: true, force: true }));
  return helper;
}
export function runBounded(binary, args, { timeoutMs = 120_000, scope = null, command = null } = {}) {
  const ownedScope = process.platform === 'darwin' && !scope ? lifetimeScope() : null;
  scope ??= ownedScope;
  const suppliedScope = !ownedScope;
  return new Promise((resolve) => {
    let executable, ownerArgs;
    try {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('invalid validation deadline');
      executable = supervisor();
      if (process.platform === 'darwin') {
        if (!suppliedScope) {
          // Standalone callers also get an inherited kernel identity, without
          // changing their filesystem authority except for one inert marker.
          command = [binary, ...args]; binary = '/usr/bin/sandbox-exec';
          args = ['-p', `(version 1)(allow default)(deny signal)(allow signal (target self) (target children) (target same-sandbox))(deny file-read* (literal ${JSON.stringify(scope.denied)}))`];
        }
        if (!command?.length) throw new Error('validation lifetime scope requires the trusted command boundary');
        ownerArgs = [String(timeoutMs), scope.allowed, scope.denied, binary, ...args,
          executable, '--enter', scope.allowed, scope.denied, ...command];
      } else ownerArgs = [String(timeoutMs), binary, ...args, ...(command ?? [])];
    } catch (error) { console.error(error.message); closeScope(ownedScope); resolve(125); return; }
    const child = spawn(executable, ownerArgs, { stdio: 'inherit' });
    const handlers = Object.fromEntries(['SIGTERM', 'SIGINT', 'SIGHUP'].map((signal) => [signal, () => child.kill(signal)]));
    for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
    child.on('error', (error) => console.error(error.message));
    child.on('close', (code) => {
      for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
      closeScope(ownedScope); resolve(code ?? 125);
    });
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let scope = null, command = null;
  if (args[0] === '--scope') { scope = JSON.parse(args[1]); args.splice(0, 2); }
  const split = args.indexOf('--command');
  if (split >= 0) command = args.splice(split).slice(1);
  const [binary, ...rest] = args;
  process.exitCode = await runBounded(binary, rest, { scope, command });
}
