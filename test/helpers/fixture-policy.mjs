// Test-only containment. Product daemon launchers also stay in the suite group.
// Native script creates a PTY session independently of Node spawn options;
// runPTY gives that session its own native owner and cancellation deadline.
import childProcess, { ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import './memory-fixture.mjs';

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const policy = fileURLToPath(import.meta.url);
const detachedFixture = fileURLToPath(new URL('./detached-fixture.mjs', import.meta.url));
function containedEnv(env = process.env, command, args) {
  const result = { ...env };
  result.MONITOR_GATE_HISTORY_ROOT ??= process.env.MONITOR_GATE_HISTORY_ROOT;
  if (command === process.execPath && args?.[0] === detachedFixture) {
    // This fixed, bounded entrypoint puts a native alarm on every detached
    // descendant before exec. Those deadlines survive suite cancellation.
    delete result.NODE_OPTIONS;
    return result;
  }
  if (command?.endsWith('/sandbox-exec') || (command?.endsWith('/codex') && args?.[0] === 'sandbox')) {
    // The acceptance kernel boundary forbids importing host test helpers.
    // Keep that boundary intact; these synchronous attack fixtures are already
    // bounded and their known commands do not launch detached processes.
    delete result.NODE_OPTIONS;
    return result;
  }
  // Minimal fixture environments must not fall back to the native default
  // socket. Explicit fixture sockets remain available for fake server tests.
  if (process.env.HERDR_TEST_OFFLINE_ROOT) {
    result.HERDR_TEST_OFFLINE_ROOT ??= process.env.HERDR_TEST_OFFLINE_ROOT;
    result.HERDR_SOCKET_PATH ??= process.env.HERDR_SOCKET_PATH;
    result.HERDR_MONITOR_FLEET ??= process.env.HERDR_MONITOR_FLEET;
    result.ORG_ACTOR ??= process.env.ORG_ACTOR;
  }
  if (!result.NODE_OPTIONS?.includes(policy)) result.NODE_OPTIONS = `${result.NODE_OPTIONS ?? ''} --import=${JSON.stringify(policy)}`;
  return result;
}
// Explicit fixture env overrides (including fault-injection preloads) cannot
// accidentally drop the containment policy for a nested Node launcher.
for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
  const original = childProcess[name];
  childProcess[name] = function (...args) {
    const index = name === 'execSync' ? 1 : Array.isArray(args[1]) ? 2 : 1;
    args[index] = { ...args[index], env: containedEnv(args[index]?.env, args[0], Array.isArray(args[1]) ? args[1] : []) };
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();
const originalSpawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function (options) {
  // A nested bounded suite owns its own persistent leader and IPC death handler.
  const suite = options.file === process.execPath && options.args[1] === runner && options.args[2] === '--worker';
  if (!suite) options.detached = false;
  const env = Object.fromEntries(options.envPairs.map(pair => { const index = pair.indexOf('='); return [pair.slice(0, index), pair.slice(index + 1)]; }));
  options.envPairs = Object.entries(containedEnv(env, options.file, options.args.slice(1))).map(([key, value]) => `${key}=${value}`);
  const result = originalSpawn.call(this, options);
  if (process.argv[1] === runner && process.argv[2] === '--worker' && !suite) {
    this.kill = () => {
      // A file deadline ends this entire owned group, keeping its leader alive
      // until the coordinator's fresh group signal. The fixed detachment
      // regression entrypoint additionally owns native descendant deadlines.
      if (process.connected) process.send({ timeout: options.args.at(-1) }, error => { if (error && process.connected) process.disconnect(); });
      this.killed = true;
      return true;
    };
  }
  return result;
};
