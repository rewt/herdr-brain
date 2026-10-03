import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnChild } from './child.mjs';
import { createProcessTracker } from './processes.mjs';

const launcher = fileURLToPath(new URL('./detached-fixture.mjs', import.meta.url));
export async function waitForDetachedCleanup(root) {
  const tracker = createProcessTracker();
  // Report-only enumeration covers cancellation before a receipt is published.
  // Include live producers, so a middle process cannot spawn an unseen leaf
  // after a fixed receipt snapshot. No PID here ever authorizes a signal.
  const executable = path.join(root, 'fixture-deadline');
  const deadline = Date.now() + 14000; // Two six-second detached generations.
  let empty = 0;
  for (;;) {
    const result = tracker.snapshot();
    assert.ok(result.ok, result.error);
    const live = [...result.value.values()].filter(row => !/^Z/.test(row.state) && row.command.includes(root) &&
      (row.command.includes(executable) || row.command.includes(' -e ') || row.command.includes('--owner-worker')));
    empty = live.length ? 0 : empty + 1;
    if (empty === 3) return;
    assert.ok(Date.now() < deadline, `detached fixture survived native deadline: ${live.map(row => row.pid).join(', ')}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
export function spawnDetachedFixture(t, mode, suppliedRoot, timeoutMs = 15000) {
  const root = suppliedRoot ?? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-detached-'));
  const child = spawnChild(t, process.execPath, [launcher, root, mode], {}, timeoutMs);
  // Child cleanup runs first, then the independently bounded descendants finish,
  // then removal. A failed assertion/abort cannot race directory teardown.
  t.after(async () => {
    await waitForDetachedCleanup(root);
    if (!suppliedRoot) fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, child };
}
