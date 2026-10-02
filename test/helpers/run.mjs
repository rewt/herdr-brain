// Node 20 has no --test-timeout flag. Use its programmatic per-file timeout,
// plus a separate process as a watchdog for a blocked runner/event loop.
import { spawn } from 'node:child_process';
import { run } from 'node:test';
import { tap } from 'node:test/reporters';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killProcesses, processRegistries, registerProcess } from './processes.mjs';

const argv = process.argv.slice(2);
const worker = argv[0] === '--worker';
const files = (worker ? argv.slice(1) : argv).filter((arg) => !arg.startsWith('--'));
function bound(name, defaultValue, maximum = defaultValue) {
  const option = argv.find((arg) => arg.startsWith(`--${name}=`));
  const value = option ? Number(option.split('=')[1]) : defaultValue;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be 1..${maximum} milliseconds`);
  return value;
}
const fileTimeout = bound('file-timeout', 300_000, 480_000);
const suiteTimeout = bound('suite-timeout', 360_000, 540_000);
if (!files.length) throw new Error('usage: node test/helpers/run.mjs [--file-timeout=MS] [--suite-timeout=MS] TEST_FILES...');

if (worker) {
  // A worker must not start fixtures before its parent registers its group.
  // IPC loss also covers SIGKILL, for which the parent's hooks cannot run.
  const lostParent = () => {
    const registry = process.env.TEST_PROCESS_REGISTRY;
    const entries = fs.readFileSync(registry, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    fs.rmSync(path.dirname(registry), { recursive: true, force: true });
    killProcesses(entries);
    process.exit(1);
  };
  process.once('disconnect', lostParent);
  await new Promise((resolve) => process.once('message', resolve));
  process.channel.unref();
  const stream = run({ files, concurrency: 4, timeout: fileTimeout });
  stream.on('test:fail', () => { process.exitCode = 1; });
  stream.compose(tap).pipe(process.stdout);
} else {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-tests-'));
  const registry = path.join(scratch, 'processes.jsonl');
  fs.writeFileSync(registry, '');
  const ancestors = processRegistries();
  const registries = [registry, ...ancestors];
  const env = {
    ...process.env,
    TEST_PROCESS_REGISTRY: registry,
    TEST_PROCESS_ANCESTOR_REGISTRIES: JSON.stringify(ancestors),
  };
  delete env.NODE_TEST_CONTEXT; // A test may launch an independent regression suite.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', ...argv], {
    detached: process.platform !== 'win32', stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env,
  });
  if (child.pid) {
    registerProcess(child.pid, process.platform !== 'win32', registries);
    child.send('start');
  }
  let cleaned = false;
  const kill = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
    killProcesses(fs.readFileSync(registry, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    fs.rmSync(scratch, { recursive: true, force: true });
  };
  const timer = setTimeout(() => {
    console.error(`Test suite exceeded ${suiteTimeout}ms; killing runner and fixture processes. Files: ${files.join(', ')}`);
    kill();
    process.exitCode = 1;
  }, suiteTimeout);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { kill(); process.exitCode = 1; });
  child.once('error', (error) => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
  child.once('exit', (code) => { clearTimeout(timer); kill(); process.exitCode = code === 0 ? 0 : 1; });
}
