// Slot cancellation tests use their direct Node runner; the bounded runner's
// fixture policy disables detachment and would change the behavior under test.
import { spawnSync } from 'node:child_process';
import { offlineHerdr } from '../../../../test/helpers/offline-herdr.mjs';
const cleanup = offlineHerdr();
try {
  const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], {
    env: process.env, stdio: 'inherit', timeout: 540000,
  });
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
} finally { cleanup(); }
