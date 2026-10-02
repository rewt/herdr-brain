// The guardian stays outside the worker group and survives outer cancellation.
import { spawn, ChildProcess } from 'node:child_process';
import { run } from 'node:test';
import { tap } from 'node:test/reporters';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killProcess, killProcesses, stopProcesses, processRegistries, registerProcess } from './processes.mjs';

const script = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const role = ['--worker', '--guardian', '--reaper'].includes(argv[0]) ? argv.shift() : 'outer';
const files = argv.filter((arg) => !arg.startsWith('--'));
function bound(name, defaultValue, maximum = defaultValue) {
  const option = argv.find((arg) => arg.startsWith(`--${name}=`));
  const value = option ? Number(option.split('=')[1]) : defaultValue;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be 1..${maximum} milliseconds`);
  return value;
}
const fileTimeout = bound('file-timeout', 300_000, 480_000);
const suiteTimeout = bound('suite-timeout', 360_000, 540_000);
if (role !== '--reaper' && !files.length) throw new Error('usage: node test/helpers/run.mjs [--file-timeout=MS] [--suite-timeout=MS] TEST_FILES...');

function readRegistry(registry) {
  return fs.readFileSync(registry, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
async function cleanup(registry, workerEntry) {
  let initial = [], ok = true;
  try { initial = readRegistry(registry); }
  catch (error) { console.error(`Cannot read fixture registry ${registry}: ${error.message}`); ok = false; }
  const stopped = await stopProcesses([workerEntry, ...initial].filter((entry) => entry && entry.pid !== process.pid));
  if (!stopped.ok) { console.error(`Cleanup could not confirm stopped producers; registry retained at ${registry}`); return false; }
  // No producer can now launch/register a detached child during this snapshot.
  let final = [];
  try { final = readRegistry(registry); }
  catch (error) { console.error(`Cannot read final fixture registry ${registry}: ${error.message}`); ok = false; }
  const result = killProcesses([...final.filter((entry) => entry.pid !== process.pid), ...stopped.entries]);
  ok = result.ok && ok;
  if (ok) fs.rmSync(path.dirname(registry), { recursive: true, force: true });
  else console.error(`Unconfirmed cleanup; registry retained at ${registry}`);
  return ok;
}

if (role === '--reaper') {
  const ok = await cleanup(process.env.TEST_PROCESS_REGISTRY, JSON.parse(process.env.TEST_WORKER_ENTRY));
  process.exit(ok ? 0 : 1);
} else if (role === '--worker') {
  // node:test's per-file timeout also signals children. Preserve the same
  // confirmation requirement on that built-in path and journal file producers.
  const originalSpawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function (options) {
    const result = originalSpawn.call(this, options);
    let entry;
    this.kill = (signal = 'SIGTERM') => {
      if (signal === 'SIGTERM' && this.exitCode === null && this.signalCode === null && process.connected) {
        console.error(`testTimeoutFailure: Test file exceeded ${fileTimeout}ms. File: ${options.args.at(-1)}`);
        process.send({ cancel: true });
        this.killed = true;
        return true; // The guardian stops producers before killing any file.
      }
      const sent = killProcess(entry, signal).signaled ?? false;
      if (sent) this.killed = true;
      return sent;
    };
    try {
      if (this.pid) registerProcess(this.pid, false, undefined, (owned) => { entry = owned; });
    } catch (error) {
      if (entry) killProcess(entry);
      throw error;
    }
    return result;
  };
  // If the guardian itself is killed unexpectedly, delegate to a reaper outside
  // this group. It can stop this worker and its test files before reading.
  process.once('disconnect', () => {
    const reaper = spawn(process.execPath, [script, '--reaper'], {
      detached: process.platform !== 'win32', stdio: 'inherit', env: process.env,
    });
    reaper.once('error', (error) => { console.error(error); process.exitCode = 1; });
    reaper.unref();
  });
  const message = await new Promise((resolve) => process.once('message', resolve));
  process.env.TEST_WORKER_ENTRY = JSON.stringify(message.entry);
  process.channel.unref();
  const stream = run({ files, concurrency: 4, timeout: fileTimeout });
  stream.on('test:fail', () => { process.exitCode = 1; });
  stream.compose(tap).pipe(process.stdout);
} else if (role === '--guardian') {
  // The outer process acknowledges guardian registration before any fixtures.
  const start = await new Promise((resolve) => {
    process.once('message', resolve);
    process.once('disconnect', () => resolve('cancel'));
  });
  if (start !== 'start') process.exit(1);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-tests-'));
  const registry = path.join(scratch, 'processes.jsonl');
  fs.writeFileSync(registry, '');
  const ancestors = processRegistries();
  const env = { ...process.env, TEST_PROCESS_REGISTRY: registry,
    TEST_PROCESS_ANCESTOR_REGISTRIES: JSON.stringify(ancestors), TEST_GUARDIAN_PID: String(process.pid) };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [script, '--worker', ...argv], {
    detached: process.platform !== 'win32', stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env,
  });
  let workerEntry, finishing = false, timer;
  const finish = async (code) => {
    if (finishing) return;
    finishing = true; clearTimeout(timer);
    const ok = await cleanup(registry, workerEntry);
    process.exit(ok ? code : 1);
  };
  child.once('error', (error) => { console.error(error); void finish(1); });
  child.once('exit', (code) => { void finish(code === 0 ? 0 : 1); });
  child.on('message', (message) => { if (message.cancel) void finish(1); });
  process.on('message', (message) => { if (message === 'cancel') void finish(1); });
  process.on('disconnect', () => { void finish(1); });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { void finish(1); });
  try {
    workerEntry = registerProcess(child.pid, process.platform !== 'win32', [registry, ...ancestors], (entry) => { workerEntry = entry; });
    child.send({ start: true, entry: workerEntry });
  } catch (error) { console.error(error); await finish(1); }
  timer = setTimeout(() => {
    console.error(`Test suite exceeded ${suiteTimeout}ms; stopping producers and reaping fixtures. Files: ${files.join(', ')}`);
    void finish(1);
  }, suiteTimeout);
} else {
  const child = spawn(process.execPath, [script, '--guardian', ...argv], {
    detached: process.platform !== 'win32', stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: process.env,
  });
  let guardianEntry;
  child.once('error', (error) => { console.error(error); process.exitCode = 1; });
  child.once('exit', (code) => { process.exitCode = code === 0 ? 0 : 1; });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
    process.exitCode = 1;
    if (child.connected) child.send('cancel');
  });
  try {
    registerProcess(child.pid, process.platform !== 'win32', processRegistries(), (entry) => { guardianEntry = entry; });
    child.send('start');
  } catch (error) {
    console.error(error); process.exitCode = 1;
    if (guardianEntry) killProcess(guardianEntry);
    if (child.connected) child.disconnect();
  }
}
