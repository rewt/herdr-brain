// The runner preloads this only for an admitted file. Node 20's test harness
// handles SIGINT/SIGTERM with process.exit(), which can otherwise exit zero
// and erase the signal before the parent observes the native child exit.
const signalReceipt = process.env.MONITOR_TEST_FILE_SIGNAL_RECEIPT;
delete process.env.MONITOR_TEST_FILE_SIGNAL_RECEIPT;
if (signalReceipt && process.env.NODE_TEST_CONTEXT === 'child-v8') {
  const [{ default: fs }, { constants }] = await Promise.all([import('node:fs'), import('node:os')]);
  let recorded = false;
  const pending = new Map(), kill = process.kill;
  process.kill = function (pid, signal) {
    const sent = kill.call(this, pid, signal);
    const name = typeof signal === 'number'
      ? Object.keys(constants.signals).find(name => constants.signals[name] === signal) : signal ?? 'SIGTERM';
    if (sent && pid === process.pid && ['SIGINT', 'SIGTERM'].includes(name) && !pending.has(name)) {
      // A self-signal queues JS delivery. With no remaining handles Node can
      // exit zero before dispatching it; retain one bounded handle until the
      // actual signal observer runs. Never mistake the request for delivery.
      process.exitCode ||= 1;
      pending.set(name, setTimeout(() => {
        pending.delete(name);
        throw Error(`Self-signal ${name} was not observed`);
      }, 5000));
    }
    return sent;
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.prependOnceListener(signal, () => {
      clearTimeout(pending.get(signal)); pending.delete(signal);
      if (!recorded) {
        fs.writeFileSync(signalReceipt, JSON.stringify({ pid: process.pid, signal,
          handlers: process.listeners(signal).map(listener => listener.name) }) + '\n', { flag: 'wx', mode: 0o600 });
        recorded = true;
      }
      process.exitCode ||= 1;
      // Observing a signal must not swallow its default native termination.
      // Existing harness or fixture handlers still run after this observer.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  }
}

// Load controls admission only. Zero consistently means no wall-clock cap.
// A nonzero fileTimeout is enforced by Node's file cancellation, handed back
// through fixture-policy to that file's owned-group teardown and drain. Capped
// multi-file selections allocate separate groups, never a suite-wide deadline.
export function runnerLimits({ factor, env = process.env }) {
  if (!Number.isFinite(factor) || factor < 1) throw Error('invalid test load factor');
  const cap = Number(env.MONITOR_TEST_CONCURRENCY ?? 4);
  const fileTimeout = Number(env.MONITOR_TEST_FILE_TIMEOUT_MS ?? 0);
  if (!Number.isSafeInteger(cap) || cap < 1) throw Error('invalid MONITOR_TEST_CONCURRENCY');
  if (!Number.isSafeInteger(fileTimeout) || fileTimeout < 0 || fileTimeout > 2_147_483_647) throw Error('invalid MONITOR_TEST_FILE_TIMEOUT_MS');
  return { concurrency: Math.max(1, Math.floor(cap / factor)), fileTimeout, suiteTimeout: 0 };
}
