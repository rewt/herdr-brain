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

// Darwin can lose argv during exit before its kernel row becomes a zombie.
// The cached executable is named by the full source digest; p_comm retains its
// first 16 characters. This name only licenses a bounded wait in an audited
// suite group, never an exemption, signal or fallback for a refused argv read.
export function lifetimeGuardExitCommand({ executable = process.env.HERDR_FIXTURE_LIFETIME_EXECUTABLE,
  platform = process.platform } = {}) {
  const name = executable && path.basename(executable);
  return platform === 'darwin' && /^[a-f0-9]{64}$/.test(name ?? '') ? `[${name.slice(0, 16)}]` : undefined;
}

// These are candidates to JOIN, never exemptions from the survivor audit. The
// native --watch entry validates its original direct parent before watching;
// reparenting to PID 1 therefore proves that target has exited. Selection
// assumes PID 1 adopts orphans; guards adopted by a subreaper remain survivors.
// Include nested runner
// owners as well as files, all using this suite's source-bound cached binary
// and private lifetime writers. A stuck or changed guard must still fail.
export function exitedLifetimeGuardCommands(rows, { executable = process.env.HERDR_FIXTURE_LIFETIME_EXECUTABLE,
  root = process.env.HERDR_TEST_OFFLINE_ROOT, platform = process.platform } = {}) {
  const commands = new Set();
  if (!executable || !root) return commands;
  const exitCommand = lifetimeGuardExitCommand({ executable, platform });
  const prefix = `${executable} --watch ${root}/lifetime-`;
  for (const row of rows) {
    if (row.ppid !== 1) continue;
    if (row.command === exitCommand) { commands.add(row.command); continue; }
    if (!row.command.startsWith(prefix)) continue;
    const match = /^([1-9]\d*)-[A-Za-z0-9]+\/alive ([1-9]\d*) ([1-9]\d*)$/.exec(row.command.slice(prefix.length));
    if (match && Number(match[1]) > 1 && Number(match[3]) > 1 && Number(match[3]) <= 2147483647)
      commands.add(row.command);
  }
  return commands;
}

function watchLifetime(owner) {
  const args = ['--watch', owner.fifo, owner.seconds, String(process.pid)];
  const guard = cp.spawn(owner.executable,
    args, { stdio: 'ignore' });
  guard.unref();
  return { pid: guard.pid, command: [owner.executable, ...args].join(' ') };
}

function closed(child) {
  let stdout = '', stderr = '', error;
  child.stdout?.setEncoding('utf8').on('data', bytes => { stdout += bytes; });
  child.stderr?.setEncoding('utf8').on('data', bytes => { stderr += bytes; });
  child.on('error', value => { error = value; });
  return new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, error, stdout, stderr })));
}

// Explicit async --exec only. Legacy spawn/close and preload/watch stay unjoined.
export async function spawnFixtureExec(executable, args, options = {}) {
  if (process.platform !== 'darwin') throw Error('fixture guard completion requires Darwin NOTE_REAP');
  const stdio = options.stdio ?? ['ignore', 'pipe', 'pipe'];
  if (args[0] !== '--exec' || !Array.isArray(stdio) || stdio.length < 3 || options.shell || options.detached)
    throw Error('fixture completion requires direct --exec and explicit contained stdio');
  const join = cp.spawn(executable, ['--join'], { cwd: options.cwd, env: options.env,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  const joinClosed = closed(join);
  let child;
  try {
    await new Promise((resolve, reject) => { join.once('spawn', resolve); join.once('error', reject); });
    child = cp.spawn(executable, args, { ...options, stdio: [...stdio, join.stdin, join.stdio[3]],
      env: { ...(options.env ?? process.env), HERDR_FIXTURE_COMPLETION_FD: String(stdio.length) } });
  } catch (error) {
    join.stdin?.destroy(); join.stdio[3]?.destroy();
    await joinClosed;
    throw error;
  }
  // Only G keeps these endpoints; T closes its copies before exec.
  join.stdin.destroy(); join.stdio[3].destroy();
  const targetClosed = closed(child);
  const complete = (async () => {
    const joined = await joinClosed;
    const failed = joined.error || joined.signal || (joined.code !== 0 && joined.code !== 126);
    let cleanupError;
    try {
      if (failed && child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    } catch (error) { cleanupError = error; }
    const target = await targetClosed;
    if (cleanupError) throw Object.assign(cleanupError, { target, join: joined });
    if (target.error) throw Object.assign(target.error, { target, join: joined });
    if (failed || (joined.code === 126 && target.code !== 125))
      throw Object.assign(Error(`fixture guard join failed: ${JSON.stringify(joined)}`), { target, join: joined });
    return target;
  })();
  complete.catch(() => {}); // Retain early failures until the fixture awaits them.
  return { child, targetClosed, joinClosed, complete };
}

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

// Called once by each runner/file owner after offline isolation. Children that
// only load this preload inherit that writer without acquiring another one.
export function ownFixtureLifetime() {
  if (lifetime) return lifetime.parentGuard;
  // Keep the enclosing runner's writer as a cancellation boundary before
  // acquiring this process's writer. A killed suite leader cannot run its
  // IPC cleanup, and a stuck test file otherwise keeps its inbox owners alive.
  // The native guard also works while this process is blocked or suspended.
  const parentGuard = process.env.HERDR_FIXTURE_LIFETIME_EXECUTABLE ? watchLifetime({
    executable: process.env.HERDR_FIXTURE_LIFETIME_EXECUTABLE,
    fifo: process.env.HERDR_FIXTURE_LIFETIME_FIFO,
    seconds: process.env.HERDR_FIXTURE_LIFETIME_SECONDS,
  }) : null;
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
  lifetime = { executable, fifo, seconds: String(Math.ceil(loadTimeout(60000) / 1000)), parentGuard };
  process.env.HERDR_FIXTURE_LIFETIME_EXECUTABLE = executable;
  process.env.HERDR_FIXTURE_LIFETIME_FIFO = fifo;
  process.env.HERDR_FIXTURE_LIFETIME_SECONDS = lifetime.seconds;
  if (standalone) process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }));
  return parentGuard;
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
  watchLifetime({ executable: process.env.HERDR_FIXTURE_LIFETIME_EXECUTABLE,
    fifo: process.env.HERDR_FIXTURE_LIFETIME_FIFO, seconds: process.env.HERDR_FIXTURE_LIFETIME_SECONDS });
}
