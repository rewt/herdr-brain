// Load controls admission only. Zero consistently means no wall-clock cap.
export function runnerLimits({ factor }) {
  if (!Number.isFinite(factor) || factor < 1) throw Error('invalid test load factor');
  return { concurrency: Math.max(1, Math.floor(4 / factor)), fileTimeout: 0, suiteTimeout: 0 };
}
