// Load controls admission only. Zero consistently means no wall-clock cap.
// A nonzero fileTimeout is enforced by Node's file cancellation, handed back
// through fixture-policy to the coordinator's owned-group teardown and drain.
export function runnerLimits({ factor, env = process.env }) {
  if (!Number.isFinite(factor) || factor < 1) throw Error('invalid test load factor');
  const cap = Number(env.MONITOR_TEST_CONCURRENCY ?? 4);
  const fileTimeout = Number(env.MONITOR_TEST_FILE_TIMEOUT_MS ?? 0);
  if (!Number.isSafeInteger(cap) || cap < 1) throw Error('invalid MONITOR_TEST_CONCURRENCY');
  if (!Number.isSafeInteger(fileTimeout) || fileTimeout < 0 || fileTimeout > 2_147_483_647) throw Error('invalid MONITOR_TEST_FILE_TIMEOUT_MS');
  return { concurrency: Math.max(1, Math.floor(cap / factor)), fileTimeout, suiteTimeout: 0 };
}
