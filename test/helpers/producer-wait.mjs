import { setTimeout as pause } from 'node:timers/promises';

// No elapsed cutoff: an owned producer may take arbitrarily long. A terminal
// producer gets one final evidence read, including writes racing the lookup.
export async function waitForChange(_files, predicate, { producer, signal, description = 'expected fixture evidence' } = {}) {
  for (;;) {
    signal?.throwIfAborted();
    const value = predicate();
    if (value) return value;
    const outcome = producer?.();
    if (!outcome || !['live', 'exited'].includes(outcome.state))
      throw Error(`Cannot confirm producer for ${description}: ${outcome?.detail ?? 'missing owned producer'}`);
    signal?.throwIfAborted();
    if (outcome.state === 'exited') {
      const final = predicate();
      if (final) return final;
      throw Error(`Producer exited without ${description}: ${outcome.detail}`);
    }
    await pause(30, undefined, { signal });
  }
}

export const until = (predicate, options) => waitForChange([], predicate, options);

// Birth and command changes mean the captured producer is gone. UNKNOWN is
// never promoted to exit or permission to signal a replacement.
export function producerOutcome(entries, lookup) {
  let live = false;
  for (const entry of entries) {
    if (entry.exited) continue;
    const current = lookup(entry.pid);
    if (!current.ok) return { state: 'unknown', detail: current.error };
    const row = current.value;
    if (row && !/^Z/.test(row.state) && row.identity === entry.identity && row.command === entry.command) live = true;
  }
  return { state: live ? 'live' : 'exited', detail: `owned PIDs ${entries.map(entry => entry.pid).join(', ') || '(none)'}` };
}
