// Shared by direct test files and all their product descendants. No product
// options, daemon semantics or recorded argv change: the native launcher execs.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import cp, { ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadTimeout } from '../../lib/deadline.mjs';

const preload = fileURLToPath(import.meta.url);
const source = fileURLToPath(new URL('./fixture-lifetime.c', import.meta.url));
const nativeSync = cp.spawnSync;
const nativeSpawn = ChildProcess.prototype.spawn;
let lifetime;

function nativeGuard(root) {
  const digest = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const cache = path.join(root, 'fixture-lifetime-cache');
  fs.mkdirSync(cache, { recursive: true });
  const executable = path.join(cache, digest);
  // Test files start concurrently. Each builder compiles to its own name and
  // publishes by atomic link: the first complete binary wins and is never
  // replaced, and a killed builder leaves only an unused partial, never a lock.
  if (!fs.existsSync(executable)) {
    const temporary = `${executable}.${process.pid}.tmp`;
    try {
      const built = nativeSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-o', temporary, source],
        { env: { PATH: '/usr/bin:/bin', TMPDIR: cache }, encoding: 'utf8' });
      if (built.error || built.status) throw Error(built.error?.message ?? built.stderr);
      try { fs.linkSync(temporary, executable); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  return executable;
}

// Called once by bounded-test, after offline isolation. Children that only load
// this preload inherit the test file's writer; they never acquire another one.
export function ownFixtureLifetime() {
  if (lifetime) return;
  const standalone = !process.env.HERDR_TEST_OFFLINE_ROOT;
  // A shared offline root can outlive a PID; never reuse its previous FIFO.
  const root = standalone ? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fixture-lifetime-')) :
    fs.mkdtempSync(path.join(process.env.HERDR_TEST_OFFLINE_ROOT, `lifetime-${process.pid}-`));
  const executable = nativeGuard(standalone ? root : process.env.HERDR_TEST_OFFLINE_ROOT);
  const fifo = path.join(root, 'alive');
  const env = { PATH: '/usr/bin:/bin', TMPDIR: root };
  const made = nativeSync('/usr/bin/mkfifo', [fifo], { env, encoding: 'utf8' });
  if (made.error || made.status) throw Error(made.error?.message ?? made.stderr);
  // O_RDWR avoids a blocking open. The descriptor is deliberately retained
  // until process exit, and Node does not inherit it into children.
  fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  lifetime = { executable, fifo, seconds: String(Math.ceil(loadTimeout(60000) / 1000)) };
  process.env.HERDR_FIXTURE_LIFETIME_EXECUTABLE = executable;
  process.env.HERDR_FIXTURE_LIFETIME_FIFO = fifo;
  process.env.HERDR_FIXTURE_LIFETIME_SECONDS = lifetime.seconds;
  if (standalone) process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }));
}

function inherited(env = process.env) {
  const result = { ...env };
  if (process.env.BRAIN_SHADOW_ROOT) result.BRAIN_SHADOW_ROOT ||= process.env.BRAIN_SHADOW_ROOT;
  const owner = lifetime ?? {
    executable: process.env.HERDR_FIXTURE_LIFETIME_EXECUTABLE,
    fifo: process.env.HERDR_FIXTURE_LIFETIME_FIFO,
    seconds: process.env.HERDR_FIXTURE_LIFETIME_SECONDS,
  };
  if (!owner.executable) return result;
  result.HERDR_FIXTURE_LIFETIME_EXECUTABLE = owner.executable;
  result.HERDR_FIXTURE_LIFETIME_FIFO = owner.fifo;
  result.HERDR_FIXTURE_LIFETIME_SECONDS = owner.seconds;
  result.HERDR_FIXTURE_GATE_LIFETIME ??= process.env.HERDR_FIXTURE_GATE_LIFETIME;
  if (!result.NODE_OPTIONS?.includes(preload)) result.NODE_OPTIONS = `--import=${JSON.stringify(preload)} ${result.NODE_OPTIONS ?? ''}`;
  return result;
}
const guarded = (args, env) => env.HERDR_FIXTURE_LIFETIME_EXECUTABLE &&
  (args.includes('--owner-worker') || env.HERDR_FIXTURE_GATE_LIFETIME === '1');
const launcherArgs = (command, args, env) => ['--exec', env.HERDR_FIXTURE_LIFETIME_FIFO,
  env.HERDR_FIXTURE_LIFETIME_SECONDS, command, ...args];
const exempt = command => /(?:sandbox-exec|\/codex)$/.test(command) || command === process.env.HERDR_FIXTURE_LIFETIME_EXECUTABLE;

for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
  const original = cp[name];
  cp[name] = function (...args) {
    const index = name === 'execSync' ? 1 : Array.isArray(args[1]) ? 2 : 1;
    if (exempt(args[0])) return original.apply(this, args);
    const env = inherited(args[index]?.env);
    args[index] = { ...args[index], env };
    // execSync shells inherit the preload; explicit gate commands additionally
    // get a native guard even when the executable is a shell or lock holder.
    const argv = Array.isArray(args[1]) ? args[1] : [];
    // Keep native measurement/Git probe commands visible to fixture adapters.
    // Long-running profile commands are Node or shells; Node shebang children
    // also install their guard through the inherited preload.
    if (name === 'spawnSync' && guarded(argv, env) &&
        (argv.includes('--owner-worker') || args[index].shell || /(?:^|\/)(?:node|sh|zsh)$/.test(args[0]))) {
      const options = args[index];
      const command = options.shell ? (typeof options.shell === 'string' ? options.shell : '/bin/sh') : args[0];
      const commandArgs = options.shell ? ['-c', [args[0], ...argv].join(' ')] : argv;
      args = [env.HERDR_FIXTURE_LIFETIME_EXECUTABLE,
        launcherArgs(command, commandArgs, env), { ...options, shell: false }];
    }
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();

ChildProcess.prototype.spawn = function (options) {
  if (exempt(options.file)) return nativeSpawn.call(this, options);
  // The genuine detached-inbox fixture already has its fixed kernel alarm.
  if (options.args.some(arg => arg.endsWith('/detached-fixture.mjs'))) return nativeSpawn.call(this, options);
  const env = inherited(Object.fromEntries(options.envPairs.map(pair => {
    const index = pair.indexOf('='); return [pair.slice(0, index), pair.slice(index + 1)];
  })));
  // Node installs its native guard before loading the product. Avoid an async
  // exec transition racing spawnChild's birth-command registration.
  if (guarded(options.args, env) && /\/(?:sh|zsh)$/.test(options.file)) {
    options.args = [env.HERDR_FIXTURE_LIFETIME_EXECUTABLE, ...launcherArgs(options.file, options.args.slice(1), env)];
    options.file = env.HERDR_FIXTURE_LIFETIME_EXECUTABLE;
  }
  options.envPairs = Object.entries(env).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`);
  return nativeSpawn.call(this, options);
};

// A shell can fork/exec the pinned Node without calling Node's spawn API.
// Its preload installs the same guard, so blocking JS cannot escape either.
if ((process.env.HERDR_FIXTURE_GATE_LIFETIME === '1' || process.argv.includes('--owner-worker')) &&
    process.env.HERDR_FIXTURE_LIFETIME_EXECUTABLE) {
  const guard = cp.spawn(process.env.HERDR_FIXTURE_LIFETIME_EXECUTABLE,
    ['--watch', process.env.HERDR_FIXTURE_LIFETIME_FIFO, process.env.HERDR_FIXTURE_LIFETIME_SECONDS, String(process.pid)],
    { stdio: 'ignore' });
  guard.unref();
}
