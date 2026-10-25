// One live group leader per suite; no registries, suspended producers or reapers.
import { testLoadFactor } from '../../test-slot/load.mjs';
import { spawn } from 'node:child_process';
import { run } from 'node:test';
import { tap } from 'node:test/reporters';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { registerProcess, killProcess, auditGroup } from './processes.mjs';
import { offlineHerdr } from './offline-herdr.mjs';
import { runnerLimits } from './runner-limits.mjs';
import path from 'node:path';
import { watchRun } from '../../test-slot/watch.mjs';
import { silenceNotice } from '../../test-slot/watch-notice.mjs';
import { TIMINGS_ENV, startTiming, timing } from '../../test-slot/timings.mjs';

const cleanupHerdr = offlineHerdr();

const script = fileURLToPath(import.meta.url);
const policy = fileURLToPath(new URL('./fixture-policy.mjs', import.meta.url));
const argv = process.argv.slice(2);
const worker = argv[0] === '--worker';
if (worker) argv.shift();
const selected = new Set(JSON.parse(process.env.MONITOR_PROMOTION_TEST_FILES ?? '[]'));
const files = argv.filter(arg => !arg.startsWith('--')).filter(file => !argv.some(arg => arg.startsWith('--test-name-pattern=')) || !selected.has(file));
const nameOption = argv.find(arg => arg.startsWith('--test-name-pattern='));
const testNamePatterns = nameOption ? [new RegExp(nameOption.slice('--test-name-pattern='.length))] : undefined;
const factorOption = argv.find(arg => arg.startsWith('--load-factor='));
const factor = factorOption ? Number(factorOption.split('=')[1]) : testLoadFactor();
// Legacy deadline options are accepted for old callers, but never arm a timer.
const { concurrency } = runnerLimits({ factor });
if (!files.length && selected.size) { cleanupHerdr(); process.exit(0); }
if (!files.length) throw Error('usage: node test/helpers/run.mjs [--test-name-pattern=REGEX] TEST_FILES...');

if (worker) {
  // Selection above consumes the train's request; test files start with their
  // own project settings. Keep containment, slot ownership and retry state.
  for (const key of ['LANE_VALIDATE', 'LANE_CONFIG', 'ORG_DIR', 'HERDR_RETIRE_HERDR', 'MONITOR_PROMOTION_TEST_FILES']) delete process.env[key];
  // This leader never exits voluntarily with fixtures running in its group.
  const owner = registerProcess(process.pid, true);
  process.env.HERDR_TEST_SUITE_PID = String(process.pid);
  const cleanup = () => {
    const result = killProcess(owner);
    if (!result.ok || !result.signaled) { console.error('Suite group cleanup unconfirmed'); process.exit(1); }
  };
  process.once('disconnect', cleanup);
  process.once('message', async () => {
    const stream = run({ files, concurrency, testNamePatterns });
    let code = 0;
    stream.on('test:fail', () => { code = 1; });
    try { await pipeline(stream.compose(tap), process.stdout, { end: false }); }
    catch (error) { console.error(error); code = 1; }
    if (process.connected) process.send({ complete: true, code }, error => { if (error) cleanup(); });
    // Keep IPC referenced: the coordinator audits and kills this live leader.
  });
  process.send({ ready: true }, error => { if (error) cleanup(); });
} else {
  const finishTiming = startTiming('suite', process.env.MONITOR_TEST_SUITE_NAME ?? 'selected', { files, tier: process.env.MONITOR_TEST_TIER });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(policy)} --import=${JSON.stringify(fileURLToPath(new URL('./file-timing.mjs', import.meta.url)))}`;
  env.MONITOR_TEST_TIMING_FILES = JSON.stringify(files.map(file => path.resolve(file)));
  env.MONITOR_TEST_TIMING_SUITE = finishTiming.id;
  env.MONITOR_TEST_TIMING_DEPTH = String(Number(process.env.MONITOR_TEST_TIMING_DEPTH ?? 0) + 1);
  env.MONITOR_TEST_WATCH_OWNER ??= String(process.pid);
  const child = spawn(process.execPath, [script, '--worker', ...argv.filter(arg => !arg.startsWith('--load-factor=')), `--load-factor=${factor}`], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env,
  });
  let owner, finished = false, watcher;
  child.stdout.on('data', data => { watcher?.output(); process.stdout.write(data); });
  child.stderr.on('data', data => { watcher?.output(); process.stderr.write(data); });
  // An enclosing gate watches the entire run once, including nested suites.
  if (!process.env.MONITOR_TEST_WATCH_OWNER) watcher = watchRun({ pid: child.pid,
    onSilence: observation => { observation.notice = silenceNotice(observation, { label: files.join(', '), receipt: process.env[TIMINGS_ENV], runId: finishTiming.id }); timing(observation); },
    onFrozen: observation => { timing(observation); console.error(`GATE_TIMEOUT: frozen limit ${observation.limit_seconds}s exceeded; elapsed ${observation.elapsed_s.toFixed(3)}s`); finish(1); },
  });
  function finish(code, audit = false) {
    if (finished) return;
    finished = true; watcher?.stop();
    if (audit && owner) {
      const result = auditGroup(owner);
      if (!result.ok) code = 1;
      for (const row of result.survivors ?? []) {
        timing({ kind: 'fixture-survivor', depth: 0, fixture: row, files });
        console.error(`Surviving fixture: PID ${row.pid}, command ${row.command}. Files: ${files.join(', ')}`);
        code = 1;
      }
    }
    // Audit is report-only. Ordinary teardown always targets the one known group,
    // with a fresh individual leader lookup even when the batch audit fails.
    const result = owner ? killProcess(owner) : { ok: false };
    if (!result.ok || !result.signaled) code = 1;
    finishTiming({ exit_code: code, ...(watcher ? watcher.snapshot() : {}) });
    if (child.connected) child.disconnect();
    const exit = () => {
      cleanupHerdr();
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      process.exit(code);
    };
    if (child.exitCode !== null || child.signalCode !== null) exit();
    else child.once('exit', exit);
  }
  child.on('message', message => {
    if (finished) return;
    if (message.ready) {
      try { owner = registerProcess(child.pid, true); child.send('start'); }
      catch (error) { console.error(error); finish(1); }
    } else if (message.complete) finish(message.code, true);
  });
  child.once('error', error => { console.error(error); finish(1); });
  child.once('exit', () => { if (!finished) finish(1); });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => finish(1));
}
