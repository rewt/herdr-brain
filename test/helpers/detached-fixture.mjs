// Fixed test entrypoint. Stay in the suite group, preserve real detachment in
// the scenario, and put a native deadline on every detached Node descendant.
import { loadTimeout } from '../../lib/deadline.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [root, mode] = process.argv.slice(2);
const watchdog = ['gate-pgid', 'gate-leftover-pipes', 'gate-leftover-ignore'].includes(mode);
if (mode !== 'inbox' && !watchdog) throw Error('unknown detached fixture');
const executable = path.join(root, 'fixture-deadline');
const source = fileURLToPath(new URL('./fixture-deadline.c', import.meta.url));
const built = spawnSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-o', executable, source], {
  encoding: 'utf8', timeout: loadTimeout(10000), killSignal: 'SIGKILL', env: { PATH: '/usr/bin:/bin', TMPDIR: root },
});
if (built.error || built.status) throw Error(built.error?.message ?? built.stderr);
if (mode === 'inbox') {
  delete process.env.NODE_TEST_CONTEXT;
  await import('../../settle/test/helpers/detached-inbox.mjs');
}
if (watchdog) {
  delete process.env.NODE_TEST_CONTEXT;
  await import('../../test-slot/test/helpers/detached-watchdog.mjs');
}
