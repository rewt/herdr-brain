// The slot launches this finite phase runner. Reuse the host watchdog's parent
// walk and identity-confirmed signalling for children that leave its group.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lookupProcess } from '../lib/processes.mjs';
import { descendants, stopGateGroup } from '../test-slot/watchdog.mjs';
import { run as runBounded, slotPathOf, COMPAT_PATH_ENV, TEST_SLOT_PATH } from '../test-slot/test-slot.mjs';
import { writeFileAtomic } from '../lib/files.mjs';
import { isMain } from '../lib/cli-help.mjs';

const SELF = fileURLToPath(import.meta.url);
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const lookup = (...args) => {
  const result = lookupProcess(...args);
  if (!result.ok) return result;
  return { ok: true, value: result.value instanceof Map ? new Map([...result.value].filter(([, row]) => !/^Z/.test(row.state))) : /^Z/.test(result.value?.state ?? '') ? null : result.value };
};
// No live root is assumed: an impossible PID prevents a new parent walk from
// granting ownership to any replacement. Saved birth identities authorize each
// individual signal through the existing watchdog, including observed orphans.
const stopTracked = (tracked, reaped, save = () => {}) => stopGateGroup(2147483647, { tracked, ownsGroup: false, lookup,
  signal: (pid, signal) => { process.kill(pid, signal); reaped.push({ pid, signal, identity: tracked.get(pid)?.identity }); save(); } });

async function hold(spec, directory) {
  // Carry the admitted snapshot through argv at both process boundaries. The
  // recorded spec.json is evidence, never a mutable source of execution authority.
  const job = JSON.parse(spec), resultPath = path.join(directory, 'job-result.json');
  const git = (...args) => execFileSync('git', ['-C', job.desk, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
  try {
    // Slot waits may be long. A checkout inspected before the wait is not
    // evidence that the actual prepared/tested snapshot still matches it.
    if (git('status', '--porcelain', '--untracked-files=all')) throw Error('desk is dirty at slot grant');
    if (git('rev-parse', 'HEAD') !== job.sha || git('rev-parse', 'HEAD^{tree}') !== job.tree) throw Error('desk snapshot changed while waiting for the slot');
  } catch (error) {
    writeFileAtomic(path.join(directory, 'phases.json'), JSON.stringify({ error: error.message, desk_refused: true }) + '\n', 0o600);
    process.exitCode = 1; return;
  }
  // This watchdog nests in the host hold. The coordinator remains alive inside
  // that hold after a job timeout. Keep its final walk outside the stopped tree,
  // so a delayed phase observer cannot lose the escaped children's identities.
  const captured = path.join(directory, 'captured.json');
  const exit = await runBounded({ positional: [`${job.label} bounds`],
    options: { resultPath, lockPath: slotPathOf(), compatPath: process.env[COMPAT_PATH_ENV] ?? TEST_SLOT_PATH,
      timeoutSeconds: job.timeout_seconds, idleTimeoutSeconds: job.idle_timeout_seconds,
      common: job.identity, tier: 'verify-job',
      onCapture: tracked => {
        const captured_at = new Date().toISOString();
        writeFileAtomic(captured, JSON.stringify([...tracked.values()].map(row => ({ ...row, captured_at }))) + '\n', 0o600);
      } },
    child: [process.execPath, SELF, spec, directory] });
  const wrapper = { exit, signal: read(resultPath)?.signal ?? null };
  const execution = read(resultPath), file = path.join(directory, 'phases.json');
  const phases = read(file) ?? { prepare: job.prepare ? { argv: job.prepare } : 'none', command: { argv: job.argv } };
  phases.reaped ??= [];
  const save = () => writeFileAtomic(file, JSON.stringify(phases) + '\n', 0o600);
  try {
    const tracked = new Map((phases.tracked ?? []).map(row => [row.pid, row]));
    for (const row of read(captured) ?? []) tracked.set(row.pid, row);
    phases.tracked = [...tracked.values()]; save();
    await stopTracked(tracked, phases.reaped, save);
    if (execution?.gate_timeout) for (const row of tracked.values()) {
      // A descendant may share the phase's group. Group membership does not
      // replace evidence that this captured birth was stopped by the watchdog.
      if (phases.reaped.some(entry => entry.pid === row.pid && entry.identity === row.identity)) continue;
      const now = lookup(row.pid, { identityOnly: true });
      if (!now.ok) throw Error(`cannot confirm captured process cleanup: ${now.error}`);
      if (!now.value || now.value.identity !== row.identity) {
        // The unchanged job watchdog protocol has no individual signal receipt.
        phases.reaped.push({ pid: row.pid, identity: row.identity, signal: null, source: 'job-watchdog', confirmed_gone: true });
      }
    }
    if (execution?.cleanup_error || phases.cleanup_error) throw Error(execution?.cleanup_error ?? phases.cleanup_error);
    phases.cleanup_confirmed = true;
    phases.wrapper = wrapper; save();
  } catch (error) {
    phases.cleanup_error = error.message; save();
    // Unknown ownership cannot authorize releasing the outer host hold. Its
    // bounded envelope watchdog remains the final fail-closed backstop.
    setInterval(() => {}, 1000); await new Promise(() => {});
  }
}

export async function execute(job, directory) {
  const file = path.join(directory, 'phases.json');
  const root = lookup(process.pid, { identityOnly: true }).value;
  const state = { prepare: job.prepare ? { argv: job.prepare } : 'none', command: { argv: job.argv }, pgid: root?.pgid ?? null, tracked: [], reaped: [] };
  const save = () => writeFileAtomic(file, JSON.stringify(state) + '\n', 0o600);
  let cancelled;
  const cancel = signal => { cancelled ??= signal; state.signal = cancelled; save(); };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, cancel);
  async function phase(name, argv) {
    const row = state[name], tracked = new Map();
    const log = fs.openSync(path.join(directory, `${name}.log`), 'wx', 0o600);
    const start = process.hrtime.bigint();
    row.started_at = new Date().toISOString(); save();
    let child, monitor, trackingError, stopping;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: job.desk, stdio: ['ignore', 'pipe', 'pipe'] });
      const closed = new Promise(resolve => child.once('close', () => resolve(true)));
      const completed = new Promise(resolve => {
        child.once('error', error => resolve({ exit: null, signal: null, error: error.message }));
        child.once('exit', (exit, signal) => resolve({ exit, signal }));
      });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { fs.writeSync(log, bytes); process.stdout.write(bytes); });
      const observe = () => {
        if (!child.pid) return;
        const snapshot = lookup(undefined, { identityOnly: true });
        if (!snapshot.ok) {
          if (trackingError === undefined) {
            trackingError = snapshot.error;
            state.tracking_error_at = new Date().toISOString(); save();
          }
          return;
        }
        let changed = false;
        for (const [pid, entry] of descendants(snapshot.value, child.pid)) {
          const prior = tracked.get(pid);
          if (prior?.identity !== entry.identity || prior?.pgid !== entry.pgid) { tracked.set(pid, entry); changed = true; }
        }
        if (changed) { state.tracked = [...tracked.values()]; save(); }
        if (cancelled && !stopping) {
          stopping = stopTracked(tracked, state.reaped, save);
          stopping.catch(() => {}); // observed again below after the child exits
        }
      };
      observe(); monitor = setInterval(observe, 50);
      Object.assign(row, await completed);
      clearInterval(monitor);
      try {
        if (stopping) await stopping;
        else if (child.pid) await stopTracked(tracked, state.reaped, save);
        if (trackingError) {
          const captured = read(path.join(directory, 'captured.json'));
          // The watchdog may terminate a measurement helper after its own
          // completed walk. A later capture cannot cover an earlier gap, and
          // only the runner's confirmed birth ties that walk to this phase.
          const ownCapture = root?.identity && captured?.find(row => row.pid === process.pid && row.identity === root.identity);
          if (/^process source unavailable: terminated by (SIGTERM|SIGINT|SIGHUP)$/.test(trackingError) && ownCapture && Date.parse(state.tracking_error_at) >= Date.parse(ownCapture.captured_at)) {
            state.tracking_interrupted = { error: trackingError, seen_at: state.tracking_error_at, captured_at: ownCapture.captured_at };
          }
          else throw Error(trackingError);
        }
      } catch (error) { state.cleanup_error = error.message; save(); throw error; }
      // Drain all bytes before hashing. An unobserved daemon retaining a pipe
      // must produce an explicit error instead of silently truncating its log.
      let drainTimer;
      const drained = await Promise.race([closed, new Promise(resolve => { drainTimer = setTimeout(() => resolve(false), 1000); })]);
      clearTimeout(drainTimer);
      child.stdout.destroy(); child.stderr.destroy();
      if (!drained) throw Error('phase output pipes did not close; log may be incomplete');
    } finally {
      clearInterval(monitor); fs.closeSync(log);
      row.finished_at = new Date().toISOString();
      row.duration_s = Number(process.hrtime.bigint() - start) / 1e9; save();
    }
    return row.exit === 0 && !row.signal && !row.error && !cancelled;
  }
  save();
  try {
    if (job.prepare && !await phase('prepare', job.prepare)) return;
    if (!cancelled) await phase('command', job.argv);
  } catch (error) {
    state.error = error.message; save();
    if (state.cleanup_error) {
      // Preserve a live member of the slot's group until its bounded watchdog
      // takes over. Exiting here could release a slot with unknown escapees.
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
    throw error;
  }
  finally { for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.off(signal, cancel); }
}
if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2), coordinator = args[0] === '--hold';
    const [spec, directory] = coordinator ? args.slice(1) : args;
    if (coordinator) await hold(spec, directory);
    else await execute(JSON.parse(spec), directory);
  } catch (error) { console.error(`verify execute: ${error.message}`); process.exitCode = 1; }
}
