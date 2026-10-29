// One live group leader per suite, or per capped file; no fixture reapers.
import { testLoadFactor } from '../../test-slot/load.mjs';
import { spawn } from 'node:child_process';
import { run } from 'node:test';
import { tap } from 'node:test/reporters';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { registerProcess, killProcess, auditGroup } from './processes.mjs';
import { offlineHerdr } from './offline-herdr.mjs';
import { ownFixtureLifetime } from './fixture-lifetime.mjs';
import { runnerLimits } from './runner-limits.mjs';
import path from 'node:path';
import { watchRun } from '../../test-slot/watch.mjs';
import { silenceNotice } from '../../test-slot/watch-notice.mjs';
import * as timingJournal from '../../test-slot/timings.mjs';
const { TIMINGS_ENV, startTiming, timing } = timingJournal;

const cleanupHerdr = offlineHerdr();
// Chain coordinator -> suite leader -> test file -> product fixture. Native
// writer death covers abrupt exits even when JS/IPC cleanup cannot execute.
const lifetimeGuard = ownFixtureLifetime();

const script = fileURLToPath(import.meta.url);
const policy = fileURLToPath(new URL('./fixture-policy.mjs', import.meta.url));
const argv = process.argv.slice(2);
const worker = argv[0] === '--worker';
if (worker) argv.shift();
const fileGroup = argv.includes('--file-group');
// Bound output flushing only, never execution or the wait for a live leader.
const outputDrainMs = 5_000;
async function copyOutput(source, output) {
  // A pipeline into shared stdio retains destination listeners after each
  // file. Await each write callback instead: it handles backpressure and
  // errors without adding listeners or ending the shared destination.
  for await (const bytes of source) {
    await new Promise((resolve, reject) => output.write(bytes, error => error ? reject(error) : resolve()));
  }
}
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
    const { ChildProcess } = await import('node:child_process');
    const stderrCaptures = new Map(), originalSpawn = ChildProcess.prototype.spawn;
    ChildProcess.prototype.spawn = function (options) {
      const capture = options.envPairs.includes('NODE_TEST_CONTEXT=child-v8') &&
        stderrCaptures.get(path.resolve(options.args.at(-1)));
      if (capture) {
        options.args.splice(1, 0, `--import=${fileURLToPath(new URL('./runner-limits.mjs', import.meta.url))}`);
        options.envPairs.push(`MONITOR_TEST_FILE_SIGNAL_RECEIPT=${capture.signalReceipt}`);
      }
      const result = originalSpawn.call(this, options);
      if (capture && this.stderr) {
        capture.started = true;
        capture.pid = this.pid;
        this.once('exit', (exit_code, signal) => {
          capture.nativeExit = { exit_code, signal, pid: this.pid, at: new Date().toISOString() };
        });
        // Node 20's test:stderr events are line-normalized, and its file runner
        // waits for stdout but not stderr. Retain bytes at the native pipe.
        this.stderr.on('data', bytes => { if (capture.fd !== null) fs.writeFileSync(capture.fd, bytes); });
        this.stderr.once('close', capture.resolve);
        this.stderr.once('error', capture.reject);
      }
      return result;
    };
    // Independent reporter streams retain each admitted file before copying
    // completed TAP to the build log.
    // Keep artifacts beside the durable journal, outside disposable fixtures.
    const directory = fs.mkdtempSync(path.join(process.env[TIMINGS_ENV]
      ? path.dirname(path.resolve(process.env[TIMINGS_ENV])) : tmpdir(), 'test-file-tap-'));
    let code = 0;
    let next = 0, allFilesDone = false, wakeOutput, copyingFileOutput = false;
    const completed = [];
    async function* completedOutput() {
      while (!allFilesDone || completed.length) {
        if (!completed.length) { await new Promise(resolve => { wakeOutput = resolve; }); continue; }
        const entry = completed.shift();
        copyingFileOutput = true;
        try {
          if (entry.stderr) await copyOutput(fs.createReadStream(entry.stderr), process.stderr);
          yield* fs.createReadStream(entry.artifact);
        } finally { copyingFileOutput = false; }
      }
    }
    // One output pipeline avoids accumulating stdio listeners per file.
    const output = pipeline(completedOutput(), process.stdout, { end: false })
      .catch(error => { console.error(error); code = 1; });
    async function cappedFile(file, index) {
      // fixture-policy hands Node's file cancellation to an owned group kill.
      // Give each capped file the existing single-file coordinator/worker pair:
      // its live leader, identity checks, crash recovery and drain then cover
      // only that file and its descendants. The coordinator stays in this
      // scheduler's group, so outer cancellation still disconnects every owner.
      const artifact = path.join(directory, `${index + 1}.output`);
      const fd = fs.openSync(artifact, 'wx', 0o600);
      const stderr = `${artifact}.stderr`, stderrFD = fs.openSync(stderr, 'wx', 0o600);
      const env = { ...process.env, MONITOR_TEST_FILE_TIMEOUT_MS: String(fileTimeout) };
      delete env.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, [script, '--file-group', '--load-factor=1', ...(nameOption ? [nameOption] : []), file], {
        detached: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env,
      });
      child.on('message', message => {
        if (message.fileGroupProgress) {
          // The gate may own the enclosing watcher. Give it actual activity
          // without inserting metadata into a file currently being copied.
          if (!copyingFileOutput) console.error(`FILE_GROUP_PROGRESS: ${JSON.stringify(message.fileGroupProgress)}`);
        } else if (message.fileTap || message.fileTapComplete) process.send(message);
      });
      child.stdout.on('data', bytes => fs.writeFileSync(fd, bytes));
      // Serialize raw stderr too: concurrent metadata or another file's output
      // must not split a crash diagnostic, including one without a newline.
      child.stderr.on('data', bytes => fs.writeFileSync(stderrFD, bytes));
      child.on('error', error => { console.error(error); code = 1; });
      // close includes both physical output pipes, not just leader exit.
      const status = await new Promise(resolve => child.once('close', status => resolve(status)));
      fs.closeSync(fd); fs.closeSync(stderrFD);
      if (status !== 0) code = 1;
      completed.push({ artifact, stderr }); wakeOutput?.(); wakeOutput = undefined;
    }
    async function admit() {
      while (next < files.length) {
        const index = next++, file = files[index];
        if (fileTimeout && files.length > 1) {
          await cappedFile(file, index);
          continue;
        }
        const artifact = path.join(directory, `${index + 1}.tap`);
        const reference = { file: path.resolve(file), artifact, stderr_artifact: `${artifact}.stderr`, completion_artifact: `${artifact}.complete.json` };
        console.error(`FILE_TAP: ${JSON.stringify(reference)}`);
        const fd = fs.openSync(artifact, 'wx', 0o600);
        const stderrFD = fs.openSync(reference.stderr_artifact, 'wx', 0o600);
        const capture = { fd: stderrFD, started: false, signalReceipt: `${artifact}.signal.json` };
        capture.closed = new Promise((resolve, reject) => { capture.resolve = resolve; capture.reject = reject; });
        capture.closed.catch(() => {});
        stderrCaptures.set(reference.file, capture);
        let fileCode = 0, failure, runnerError;
        let bytes = 0, lastProgress = Date.now();
        try {
          // Publish admission before starting a file that could kill the worker.
          await new Promise((resolve, reject) => process.send({ fileTap: reference }, error => error ? reject(error) : resolve()));
          const stream = run({ files: [file], concurrency: 1, testNamePatterns, timeout: fileTimeout || undefined });
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
          if (capture.started) await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error(`File stderr drain exceeded ${outputDrainMs}ms`)), outputDrainMs);
            capture.closed.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
          });
          // Reporter events alone cannot prove a successful file. Preserve the
          // native exit even if Node emits no failure event, and any delivered
          // signal that its in-process termination handler would otherwise hide.
          if (!capture.nativeExit) throw Error('File process exit was not observed');
          if (fs.existsSync(capture.signalReceipt)) {
            const receipt = JSON.parse(fs.readFileSync(capture.signalReceipt, 'utf8'));
            if (receipt.pid !== capture.pid || !['SIGINT', 'SIGTERM'].includes(receipt.signal)) throw Error('Invalid file signal receipt');
            capture.nativeExit.received_signal = receipt.signal;
            capture.nativeExit.signal_handlers = receipt.handlers;
          }
          const signal = capture.nativeExit.signal ?? capture.nativeExit.received_signal;
          if (capture.nativeExit.exit_code !== 0 || signal) {
            fileCode = 1;
            failure = { ...(failure ?? { message: 'File process failed', failureType: 'testCodeFailure' }),
              exit_code: capture.nativeExit.exit_code, ...(signal ? { signal } : {}) };
          }
        } catch (error) { console.error(error); fileCode = 1; runnerError = error.stack ?? String(error); }
        finally { capture.fd = null; stderrCaptures.delete(reference.file); fs.closeSync(fd); fs.closeSync(stderrFD); }
        const completion = { ...reference, exit_code: fileCode, tap_complete: !runnerError, observed_by: 'worker',
          ...(capture.nativeExit ? { native_exit: capture.nativeExit } : {}),
          ...(failure ? { failure } : {}), ...(runnerError ? { reason: 'reporter-error', runner_error: runnerError } : {}) };
        // The durable terminal receipt survives a lost final IPC reply.
        fs.writeFileSync(reference.completion_artifact, JSON.stringify(completion) + '\n', { flag: 'wx', mode: 0o600 });
        process.send({ fileTapComplete: completion });
        if (fileCode) code = 1;
        // Serialize whole completed files, never wait behind an unfinished one.
        // Admission and artifact retention continue even if log output is slow.
        completed.push({ artifact, stderr: fileCode ? reference.stderr_artifact : null }); wakeOutput?.(); wakeOutput = undefined;
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
  process.send({ ready: true, lifetimeGuard }, error => { if (error) cleanup(); });
} else {
  // Isolated file groups are execution details of the enclosing suite. Keep
  // its file timing IDs/depth and one suite finish, rather than nesting suites.
  const finishTiming = fileGroup
    ? Object.assign(() => {}, { id: process.env.MONITOR_TEST_TIMING_SUITE })
    : startTiming('suite', process.env.MONITOR_TEST_SUITE_NAME ?? 'selected', { files, tier: process.env.MONITOR_TEST_TIER });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(policy)} --import=${JSON.stringify(fileURLToPath(new URL('./file-timing.mjs', import.meta.url)))}`;
  env.MONITOR_TEST_TIMING_FILES = JSON.stringify(files.map(file => path.resolve(file)));
  env.MONITOR_TEST_TIMING_SUITE = finishTiming.id;
  env.MONITOR_TEST_TIMING_DEPTH = String(Number(process.env.MONITOR_TEST_TIMING_DEPTH ?? 0) + (fileGroup ? 0 : 1));
  env.MONITOR_TEST_WATCH_OWNER ??= String(process.pid);
  const child = spawn(process.execPath, [script, '--worker', ...argv.filter(arg => !arg.startsWith('--load-factor=')), `--load-factor=${factor}`], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env,
  });
  let owner, workerLifetimeGuard, finished = false, watcher, timedOutFile;
  const fileArtifacts = new Map(), fileCompletions = new Map();
  function recoverFileTiming(completion) {
    const native = completion.native_exit;
    if (!native) return;
    // The native exit is later than the file's last possible exit hook. Only
    // its own coordinator fills a missing finish before forwarding completion;
    // enclosing coordinators and lost-IPC recovery then see the same closed ID.
    const rows = timingJournal.readTimings(process.env[TIMINGS_ENV]);
    const closed = new Set(rows.filter(row => row.event === 'finish').map(row => row.id));
    for (const row of rows.filter(row => row.kind === 'file' && row.event === 'start' &&
        row.suite === finishTiming.id && row.pid === native.pid &&
        path.resolve(row.name) === completion.file && !closed.has(row.id))) {
      const signal = native.signal ?? native.received_signal;
      timing({ ...row, event: 'finish', file_pid: row.pid,
        duration_s: Math.max(0, (Date.parse(native.at) - Date.parse(row.at)) / 1000),
        exit_code: completion.exit_code, native_exit: native, ...(signal ? { signal } : {}),
        observed_by: 'coordinator', reason: 'native-exit' });
      closed.add(row.id);
    }
  }
  let pendingOutput = 0, outputFailed = false, checkDrain = () => {};
  let lastGroupProgress = 0, groupOutputBytes = 0;
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
    // A failed write also emits 'error' on the destination. Keep that event on
    // the normal drain/cleanup path instead of letting it escape uncaught.
    output.on('error', () => { outputFailed = true; checkDrain(); });
    input.on('data', data => {
      watcher?.output();
      groupOutputBytes += data.length;
      // Staging complete per-file stderr must not make live artifact activity
      // invisible to the enclosing gate's one existing output watcher.
      if (fileGroup && process.connected && Date.now() - lastGroupProgress >= 1000) {
        process.send({ fileGroupProgress: { file: path.resolve(files[0]), bytes: groupOutputBytes } }); lastGroupProgress = Date.now();
      }
      forwardOutput(data, output);
    });
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
        // This exact birth/command was verified before admitting any files.
        // Its target is the still-live suite leader; group teardown ends both.
        // Other guards, changed identities and fixture survivors remain red.
        if (workerLifetimeGuard && row.pid === workerLifetimeGuard.pid && row.ppid === owner.pid &&
            row.identity === workerLifetimeGuard.identity && row.command === workerLifetimeGuard.command) continue;
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
          for (const row of rows.filter(row => row.kind === 'file' && row.event === 'start' && row.suite === finishTiming.id &&
              files.some(file => path.resolve(file) === path.resolve(row.name)) && !closed.has(row.id))) {
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
        // IPC can overtake raw output. Publish terminal markers only after the
        // physical pipes drain, so they cannot interrupt a raw diagnostic.
        for (const completion of fileCompletions.values()) forwardOutput(`\nFILE_TAP_COMPLETE: ${JSON.stringify(completion)}\n`, process.stderr);
        fileCompletions.clear();
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
          recoverFileTiming(completion);
          // The worker may never have copied this file to the build log. Its
          // raw stderr and partial TAP remain separate durable artifacts too.
          if (fileGroup && process.connected) process.send({ fileTapComplete: completion });
          else forwardOutput(`\nFILE_TAP_COMPLETE: ${JSON.stringify(completion)}\n`, process.stderr);
          await copyOutput(fs.createReadStream(reference.stderr_artifact), process.stderr);
          await copyOutput(fs.createReadStream(reference.artifact), process.stdout);
        }
        fileArtifacts.clear();
      }
      checkDrain = () => {
        if (recovering || !pipes.every(pipe => closedPipes.has(pipe)) || pendingOutput !== 0) return;
        if (!fileArtifacts.size && !fileCompletions.size) { exit(outputFailed ? 1 : code); return; }
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
    if (message.fileTap) {
      fileArtifacts.set(message.fileTap.file, message.fileTap);
      if (fileGroup && process.connected) process.send(message);
      return;
    }
    if (message.fileTapComplete) {
      const completion = message.fileTapComplete;
      if (fileArtifacts.delete(completion.file)) {
        recoverFileTiming(completion);
        if (fileGroup && process.connected) process.send(message);
        else fileCompletions.set(completion.file, completion);
      }
      return;
    }
    if (finished) return;
    if (message.ready) {
      try {
        owner = registerProcess(child.pid, true);
        const command = [process.env.HERDR_FIXTURE_LIFETIME_EXECUTABLE, '--watch',
          process.env.HERDR_FIXTURE_LIFETIME_FIFO, process.env.HERDR_FIXTURE_LIFETIME_SECONDS, String(child.pid)].join(' ');
        if (message.lifetimeGuard?.command !== command) throw Error('Suite lifetime guard receipt differs from coordinator ownership');
        workerLifetimeGuard = registerProcess(message.lifetimeGuard.pid, false, { suite: owner, command });
        if (!workerLifetimeGuard) throw Error('Suite lifetime guard is absent before file admission');
        child.send('start');
      }
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
