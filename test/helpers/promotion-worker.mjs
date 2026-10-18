import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupProcess } from '../../lib/processes.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';

const cli = fileURLToPath(new URL('../../promote/promote.mjs', import.meta.url));

// A result or an empty-queue lock release precedes final retirement catch-up.
// Pin the acknowledged worker's birth; a reused PID is already complete.
export function promotionWorkers(repo) {
  const entries = new Map();
  return {
    remember(reply) {
      if (!reply?.worker?.pid) return;
      const { pid } = reply.worker, current = lookupProcess(pid);
      assert.ok(current.ok, current.error);
      const row = current.value;
      if (!row || /^Z/.test(row.state) || row.command !== `${process.execPath} ${cli} --drain --repo ${path.resolve(repo)}`) return;
      entries.set(`${pid}:${row.identity}`, row);
    },
    async wait() {
      const deadline = Date.now() + loadTimeout(30000);
      let uncertainty;
      for (;;) {
        for (const [key, entry] of entries) {
          const current = lookupProcess(entry.pid);
          // An inconclusive read during exec/exit never proves completion.
          // Keep waiting for confirmed absence, with the same bounded failure.
          if (!current.ok) { uncertainty = current.error; continue; }
          const row = current.value;
          if (!row || /^Z/.test(row.state) || row.identity !== entry.identity || row.command !== entry.command) entries.delete(key);
        }
        if (!entries.size) return;
        assert.ok(Date.now() < deadline, `finite promotion owner exited${uncertainty ? `; last inconclusive read: ${uncertainty}` : ''}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    },
  };
}
