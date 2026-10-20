// One live group leader per suite; no registries, suspended producers or reapers.
import { loadTimeout, loadFactor } from '../../lib/deadline.mjs';
import { spawn } from 'node:child_process';
import { run } from 'node:test';
import { tap } from 'node:test/reporters';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { registerProcess, killProcess, auditGroup } from './processes.mjs';
import { offlineHerdr } from './offline-herdr.mjs';
import { runnerLimits } from './runner-limits.mjs';

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
// Fixed mode is reserved for intentional cancellation regressions. Ordinary
// CLI overrides (including the npm scripts' file/suite limits) scale too.
const fixedDeadlines = argv.includes('--fixed-deadlines');
const factorOption = argv.find(arg => arg.startsWith('--load-factor='));
const factor = factorOption ? Number(factorOption.split('=')[1]) : loadFactor();
function timeoutOption(name) {
  const option = argv.find(arg => arg.startsWith(`--${name}=`));
  return option ? Number(option.split('=')[1]) : undefined;
}
const { concurrency, fileTimeout, suiteTimeout } = runnerLimits({ factor, fixedDeadlines,
  fileTimeout: timeoutOption('file-timeout'), suiteTimeout: timeoutOption('suite-timeout') });
if (!files.length && selected.size) { cleanupHerdr(); process.exit(0); }
if (!files.length) throw Error('usage: node test/helpers/run.mjs [--file-timeout=MS] [--suite-timeout=MS] [--fixed-deadlines] [--test-name-pattern=REGEX] TEST_FILES...');

if (worker) {
  // This leader never exits voluntarily with fixtures running in its group.
  const owner = registerProcess(process.pid, true);
  process.env.HERDR_TEST_SUITE_PID = String(process.pid);
  const cleanup = () => {
    const result = killProcess(owner);
    if (!result.ok || !result.signaled) { console.error('Suite group cleanup unconfirmed'); process.exit(1); }
  };
  process.once('disconnect', cleanup);
  process.once('message', async () => {
    const stream = run({ files, concurrency, timeout: fileTimeout, testNamePatterns });
    let code = 0;
    stream.on('test:fail', () => { code = 1; });
    try { await pipeline(stream.compose(tap), process.stdout, { end: false }); }
    catch (error) { console.error(error); code = 1; }
    if (process.connected) process.send({ complete: true, code }, error => { if (error) cleanup(); });
    // Keep IPC referenced: the coordinator audits and kills this live leader.
  });
  setTimeout(() => {
    console.error(`Test suite exceeded ${suiteTimeout}ms. Files: ${files.join(', ')}`);
    cleanup();
  }, loadTimeout(suiteTimeout + loadTimeout(2500, factor), 1));
  process.send({ ready: true }, error => { if (error) cleanup(); });
} else {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(policy)}`;
  const child = spawn(process.execPath, [script, '--worker', ...argv.filter(arg => !arg.startsWith('--load-factor=')), `--load-factor=${factor}`], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env,
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  let owner, finished = false;
  const timer = setTimeout(() => {
    console.error(`Test suite exceeded ${suiteTimeout}ms. Files: ${files.join(', ')}`);
    finish(1);
  }, suiteTimeout);
  function finish(code, audit = false) {
    if (finished) return;
    finished = true; clearTimeout(timer);
    if (audit && owner) {
      const result = auditGroup(owner);
      if (!result.ok) code = 1;
      for (const row of result.survivors ?? []) {
        console.error(`Surviving fixture: PID ${row.pid}, command ${row.command}. Files: ${files.join(', ')}`);
        code = 1;
      }
    }
    // Audit is report-only. Ordinary teardown always targets the one known group,
    // with a fresh individual leader lookup even when the batch audit fails.
    const result = owner ? killProcess(owner) : { ok: false };
    if (!result.ok || !result.signaled) code = 1;
    if (child.connected) child.disconnect();
    const exit = () => {
      cleanupHerdr();
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      process.exit(code);
    };
    if (child.exitCode !== null || child.signalCode !== null) exit();
    else { child.once('exit', exit); setTimeout(exit, loadTimeout(2500, factor)); }
  }
  child.on('message', message => {
    if (finished) return;
    if (message.ready) {
      try { owner = registerProcess(child.pid, true); child.send('start'); }
      catch (error) { console.error(error); finish(1); }
    } else if (message.timeout) {
      console.error(`testTimeoutFailure: Test file exceeded ${fileTimeout}ms. File: ${message.timeout}`);
      finish(1);
    } else if (message.complete) finish(message.code, true);
  });
  child.once('error', error => { console.error(error); finish(1); });
  child.once('exit', () => { if (!finished) finish(1); });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => finish(1));
}
