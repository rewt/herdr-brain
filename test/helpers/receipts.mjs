import { createProcessTracker } from './processes.mjs';

// The runner keeps this leader alive through teardown. Receipt cleanup cannot
// adopt arbitrary processes when it first sees a historical PID.
export function createReceiptTracker({
  tracker = createProcessTracker(),
  suitePid = Number(process.env.HERDR_TEST_SUITE_PID),
} = {}) {
  const suite = tracker.registerProcess(suitePid, true);
  const entries = new Map();
  return {
    remember(pid, command) {
      if (entries.has(pid)) return entries.get(pid);
      const entry = tracker.registerProcess(pid, false, { suite, command });
      if (entry) entries.set(pid, entry);
      return entry;
    },
    cleanup(signal = 'SIGKILL') {
      for (const entry of entries.values()) tracker.killProcess(entry, signal);
    },
  };
}
