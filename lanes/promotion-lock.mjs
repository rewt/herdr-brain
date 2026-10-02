// Shared by lane promotion and closure, including queue workers.
// Crash locks fail closed:
// removing a lock requires inspecting its owner and any surviving gate first.
import fs from 'node:fs';
import path from 'node:path';

export function acquireLock(directory, { waitMs = 0 } = {}) {
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { fs.mkdirSync(directory); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`locked: ${directory}; inspect owner.json and surviving processes before removing a stale lock`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), argv: process.argv }));
  let released = false;
  return () => { if (!released) { fs.rmSync(directory, { recursive: true }); released = true; } };
}
