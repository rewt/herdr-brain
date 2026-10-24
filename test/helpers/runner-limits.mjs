import { loadTimeout } from '../../lib/deadline.mjs';

export function runnerLimits({ factor, fixedDeadlines = false, fileTimeout = 300_000, suiteTimeout = 360_000 }) {
  if (!Number.isFinite(factor) || factor < 1) throw Error('invalid test load factor');
  const concurrency = Math.max(1, Math.floor(4 / factor));
  // Whole-suite throughput also falls in steps as fewer files are admitted.
  // File timers start on admission, so only the suite includes this queue cost.
  const suiteFactor = Math.max(factor, 4 / concurrency);
  const bound = (name, value, maximum, scale) => {
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw Error(`${name} must be 1..${maximum} milliseconds`);
    return fixedDeadlines ? value : loadTimeout(value, scale);
  };
  return { concurrency,
    fileTimeout: bound('file-timeout', fileTimeout, 480_000, factor),
    suiteTimeout: bound('suite-timeout', suiteTimeout, 7_200_000, suiteFactor) };
}
