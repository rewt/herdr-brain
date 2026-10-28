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
import * as timingJournal from '../../test-slot/timings.mjs';
const { TIMINGS_ENV, startTiming, timing } = timingJournal;

const cleanupHerdr = offlineHerdr();

const script = fileURLToPath(import.meta.url);
const policy = fileURLToPath(new URL('./fixture-policy.mjs', import.meta.url));
const argv = process.argv.slice(2);
const worker = argv[0] === '--worker';
if (worker) argv.shift();
// Bound output flushing only, never execution or the wait for a live leader.
const outputDrainMs = 5_000;
const selected = new Set(JSON.parse(process.env.MONITOR_PROMOTION_TEST_FILES ?? '[]'));
const files = argv.filter(arg => !arg.startsWith('--')).filter(file => !argv.some(arg => arg.startsWith('--test-name-pattern=')) || !selected.has(file));
const nameOption = argv.find(arg => arg.startsWith('--test-name-pattern='));
const testNamePatterns = nameOption ? [new RegExp(nameOption.slice('--test-name-pattern='.length))] : undefined;
const factorOption = argv.find(arg => arg.startsWith('--load-factor='));
const factor = factorOption ? Number(factorOption.split('=')[1]) : testLoadFactor();
// Legacy deadline options stay inert; only the explicit environment opts in.
const { concurrency, fileTimeout } = runnerLimits({ factor });
if (!files.length && selected.size) { cleanupHerdr(); process.exit(0); }
if (!files.length) throw Error('usage: node test/helpers/run.mjs [--test-name-pattern=REGEX] TEST_FILES...');

if (worker) {
  // Selection above consumes the train's request; test files start with their
  // own project settings. Keep containment, slot ownership and retry state.
  for (const key of ['LANE_VALIDATE', 'LANE_CONFIG', 'ORG_DIR', 'HERDR_RETIRE_HERDR', 'MONITOR_PROMOTION_TEST_FILES', 'MONITOR_TEST_CONCURRENCY', 'MONITOR_TEST_FILE_TIMEOUT_MS']) delete process.env[key];
  // This leader never exits voluntarily with fixtures running in its group.
  const owner = registerProcess(process.pid, true);
  process.env.HERDR_TEST_SUITE_PID = String(process.pid);
  const cleanup = () => {
    const result = killProcess(owner);
    if (!result.ok || !result.signaled) { console.error('Suite group cleanup unconfirmed'); process.exit(1); }
  };
  process.once('disconnect', cleanup);
  process.once('message', async () => {
    const fs = await import('node:fs');
    const { tmpdir } = await import('node:os');
    // A multi-file run() buffers later files behind the first unfinished file.
    // Its owned-group cap can kill that buffer. Independent reporter streams
    // retain each admitted file before copying completed TAP to the build log.
    // Keep artifacts beside the durable journal, outside disposable fixtures.
    const directory = fs.mkdtempSync(path.join(process.env[TIMINGS_ENV]
      ? path.dirname(path.resolve(process.env[TIMINGS_ENV])) : tmpdir(), 'test-file-tap-'));
    let code = 0;
    let next = 0, allFilesDone = false, wakeOutput;
    const completed = [];
    async function* completedOutput() {
      while (!allFilesDone || completed.length) {
        if (!completed.length) { await new Promise(resolve => { wakeOutput = resolve; }); continue; }
        yield* fs.createReadStream(completed.shift());
      }
    }
    // One output pipeline avoids accumulating stdio listeners per file.
    const output = pipeline(completedOutput(), process.stdout, { end: false })
      .catch(error => { console.error(error); code = 1; });
    async function admit() {
      while (next < files.length) {
        const index = next++, file = files[index];
        const artifact = path.join(directory, `${index + 1}.tap`);
        const reference = { file: path.resolve(file), artifact, stderr_artifact: `${artifact}.stderr`, completion_artifact: `${artifact}.complete.json` };
        console.error(`FILE_TAP: ${JSON.stringify(reference)}`);
        const fd = fs.openSync(artifact, 'wx', 0o600);
        const stderrFD = fs.openSync(reference.stderr_artifact, 'wx', 0o600);
        let fileCode = 0, failure, runnerError;
        let bytes = 0, lastProgress = Date.now();
        try {
          // Publish admission before starting a file that could kill the worker.
          await new Promise((resolve, reject) => process.send({ fileTap: reference }, error => error ? reject(error) : resolve()));
          const stream = run({ files: [file], concurrency: 1, testNamePatterns, timeout: fileTimeout || undefined });
          stream.on('test:stderr', data => fs.writeFileSync(stderrFD, data.message));
          stream.on('test:fail', data => {
            fileCode = 1;
            const error = data.details?.error;
            if (error) failure = { message: error.message, code: error.code, failureType: error.failureType,
              exit_code: error.exitCode, signal: error.signal, stack: error.stack };
          });
          await pipeline(stream.compose(tap), async source => {
            // No pending artifact writes may be lost to the coordinator's cap.
            for await (const chunk of source) {
              fs.writeFileSync(fd, chunk); bytes += Buffer.byteLength(chunk);
              // Retained TAP is real activity even before a file completes.
              // Keep the existing output/silence watcher informed, without
              // interleaving TAP from live files or adding a background timer.
              if (Date.now() - lastProgress >= 1000) {
                console.error(`FILE_TAP_PROGRESS: ${JSON.stringify({ ...reference, bytes })}`);
                lastProgress = Date.now();
              }
            }
          });
        } catch (error) { console.error(error); fileCode = 1; runnerError = error.stack ?? String(error); }
        finally { fs.closeSync(fd); fs.closeSync(stderrFD); }
        const completion = { ...reference, exit_code: fileCode, tap_complete: !runnerError, observed_by: 'worker',
          ...(failure ? { failure } : {}), ...(runnerError ? { reason: 'reporter-error', runner_error: runnerError } : {}) };
        // The durable terminal receipt survives a lost final IPC reply.
        fs.writeFileSync(reference.completion_artifact, JSON.stringify(completion) + '\n', { flag: 'wx', mode: 0o600 });
        process.send({ fileTapComplete: completion });
        if (fileCode) code = 1;
        // Serialize whole completed files, never wait behind an unfinished one.
        // Admission and artifact retention continue even if log output is slow.
        completed.push(artifact); wakeOutput?.(); wakeOutput = undefined;
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, admit));
    allFilesDone = true; wakeOutput?.();
    await output;
    // IPC can overtake pipe data. Flush both writable queues before authorizing
    // group teardown; the coordinator still has to consume their readable ends.
    const outputFlushed = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), outputDrainMs);
      Promise.all([process.stdout, process.stderr].map(output => new Promise((resolve, reject) => {
        output.write('', error => error ? reject(error) : resolve());
      }))).then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(false); });
    });
    if (!outputFlushed) code = 1;
    if (process.connected) process.send({ complete: true, code, outputFlushed }, error => { if (error) cleanup(); });
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
  let owner, finished = false, watcher, timedOutFile;
  const fileArtifacts = new Map();
  let pendingOutput = 0, outputFailed = false, checkDrain = () => {};
  const pipes = [child.stdout, child.stderr], closedPipes = new Set();
  function forwardOutput(data, output) {
    pendingOutput += 1;
    output.write(data, error => {
      pendingOutput -= 1;
      if (error) outputFailed = true;
      checkDrain();
    });
  }
  for (const [input, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    input.on('data', data => { watcher?.output(); forwardOutput(data, output); });
    input.once('error', () => { outputFailed = true; });
    input.once('close', () => {
      if (!input.readableEnded) outputFailed = true;
      closedPipes.add(input); checkDrain();
    });
  }
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
    const teardown = owner ? killProcess(owner) : { ok: false };
    if (!teardown.ok || !teardown.signaled) code = 1;
    if (child.connected) child.disconnect();
    const drain = () => {
      // Keep slot occupancy until actual leader exit, both physical pipe closes
      // and all forwarded writes. A retained descriptor or blocked sink is red.
      const timer = setTimeout(() => {
        console.error(`Runner output drain exceeded ${outputDrainMs}ms; output may be incomplete`);
        exit(1);
      }, outputDrainMs);
      let drained = false, recovering = false;
      const exit = result => {
        if (drained) return;
        drained = true; clearTimeout(timer); checkDrain = () => {};
        // SIGKILL cannot run file-timing's exit hook. Pair every still-open
        // file observation only after confirmed group teardown and leader exit;
        // peer files cancelled by the same signal must not remain "running".
        if (timedOutFile && result !== 0 &&
            teardown.ok && teardown.signaled && child.signalCode === 'SIGKILL') {
          const rows = timingJournal.readTimings(process.env[TIMINGS_ENV]);
          const closed = new Set(rows.filter(row => row.event === 'finish').map(row => row.id));
          for (const row of rows.filter(row => row.kind === 'file' && row.event === 'start' && row.suite === finishTiming.id && !closed.has(row.id))) {
            timing({ ...row, event: 'finish', file_pid: row.pid,
              duration_s: Math.max(0, (Date.now() - Date.parse(row.at)) / 1000),
              exit_code: 1, signal: 'SIGKILL', observed_by: 'coordinator',
              reason: path.resolve(row.name) === timedOutFile ? 'file-timeout' : 'suite-cancelled',
              file_timeout_ms: fileTimeout });
          }
        }
        finishTiming({ exit_code: result, ...(watcher ? watcher.snapshot() : {}) });
        cleanupHerdr();
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        process.exit(result);
      };
      async function recoverFileArtifacts() {
        const fs = await import('node:fs');
        for (const reference of fileArtifacts.values()) {
          let completion;
          if (fs.existsSync(reference.completion_artifact)) {
            // Retain a worker's finished evidence if its last IPC reply was lost.
            completion = JSON.parse(fs.readFileSync(reference.completion_artifact, 'utf8'));
          } else {
            completion = { ...reference, exit_code: 1, tap_complete: false,
              observed_by: 'coordinator', signal: teardown.ok && teardown.signaled ? child.signalCode : null,
              worker_signal: child.signalCode, group_teardown_confirmed: Boolean(teardown.ok && teardown.signaled),
              reason: timedOutFile ? (reference.file === timedOutFile ? 'file-timeout' : 'suite-cancelled') : 'worker-exit' };
            fs.writeFileSync(reference.completion_artifact, JSON.stringify(completion) + '\n', { flag: 'wx', mode: 0o600 });
          }
          // The worker may never have copied this file to the build log. Its
          // raw stderr and partial TAP remain separate durable artifacts too.
          forwardOutput(`FILE_TAP_COMPLETE: ${JSON.stringify(completion)}\n`, process.stderr);
          await pipeline(fs.createReadStream(reference.stderr_artifact), process.stderr, { end: false });
          await pipeline(fs.createReadStream(reference.artifact), process.stdout, { end: false });
        }
        fileArtifacts.clear();
      }
      checkDrain = () => {
        if (recovering || !pipes.every(pipe => closedPipes.has(pipe)) || pendingOutput !== 0) return;
        if (!fileArtifacts.size) { exit(outputFailed ? 1 : code); return; }
        // Only confirmed leader exit and drained pipes authorize synthetic
        // completion. Recovery shares the same bounded output-drain allowance.
        recovering = true;
        recoverFileArtifacts().catch(error => {
          console.error(`File evidence recovery failed: ${error.stack ?? error}`);
          outputFailed = true; fileArtifacts.clear();
        }).finally(() => { recovering = false; checkDrain(); });
      };
      checkDrain();
    };
    if (child.exitCode !== null || child.signalCode !== null) drain();
    else child.once('exit', drain);
  }
  child.on('message', message => {
    if (message.fileTap) { fileArtifacts.set(message.fileTap.file, message.fileTap); return; }
    if (message.fileTapComplete) {
      const completion = message.fileTapComplete;
      if (fileArtifacts.delete(completion.file)) forwardOutput(`FILE_TAP_COMPLETE: ${JSON.stringify(completion)}\n`, process.stderr);
      return;
    }
    if (finished) return;
    if (message.ready) {
      try { owner = registerProcess(child.pid, true); child.send('start'); }
      catch (error) { console.error(error); finish(1); }
    } else if (message.timeout) {
      // fixture-policy keeps the file and leader alive for this coordinator's
      // fresh owned-group signal. Waiting for run()'s stream here can hang on
      // either a test body or an after-hook even after Node cancels the file.
      timedOutFile = path.resolve(message.timeout);
      console.error(`FILE_TIMEOUT: ${timedOutFile} exceeded ${fileTimeout}ms; ending owned suite group`);
      timing({ kind: 'file-timeout', name: timedOutFile, suite: finishTiming.id, file_timeout_ms: fileTimeout });
      finish(1);
    } else if (message.complete) {
      if (message.outputFlushed === false) console.error('Worker output flush failed or exceeded its drain limit; output may be incomplete');
      finish(message.outputFlushed === false ? 1 : message.code, true);
    }
  });
  child.once('error', error => { console.error(error); finish(1); });
  child.once('exit', () => { if (!finished) finish(1); });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => finish(1));
}
