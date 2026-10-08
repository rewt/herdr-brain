import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const delay = fileURLToPath(new URL('./bridge-delay.mjs', import.meta.url));
const [repo, log, mode = 'plain', scope = 'bridge'] = process.argv.slice(2);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'R-350-batch-'));
const env = { ...process.env,
  MONITOR_TEST_SLOT_PATH: path.join(root, 'workspace.lock'),
  MONITOR_TEST_SLOT_COMPAT_PATH: path.join(root, 'legacy.lock'),
  MONITOR_TEST_SLOT_WAIT_SECONDS: '600', BCH_CLOAK_TEST_SLOT_WAIT_SECONDS: '600',
  HERDR_MONITOR_FLEET: path.join(root, 'fleet.json') };
for (const key of ['ORG_DIR', 'HERDR_AGENT_NAME', 'MONITOR_TEST_SLOT_TOKEN', 'BCH_CLOAK_TEST_SLOT_TOKEN', 'MONITOR_TEST_SLOT_TIMEOUT_RETRIED']) delete env[key];
env.NODE_OPTIONS = `--import=${repo}/test/helpers/memory-fixture.mjs` + (mode === 'loaded' ? ` --import=${delay}` : '');
const workers = mode === 'loaded' ? Array.from({ length: 4 }, () => spawn(process.execPath, ['-e', 'const end=Date.now()+180000;while(Date.now()<end) Math.sqrt(Math.random());'], { env, stdio: 'ignore' })) : [];
const args = scope === 'bridge'
  ? ['--test', '--test-name-pattern=legacy bridge during workspace migration', 'test-slot/test/test-slot.test.mjs']
  : ['--test', 'test-slot/test/test-slot.test.mjs'];
const fd = fs.openSync(log, 'w');
const run = spawn(process.execPath, ['test-slot/test-slot.mjs', 'run', 'R-350-scratch-batch', '--', process.execPath, ...args], { cwd: repo, env, stdio: ['ignore', fd, fd] });
try {
  const status = await new Promise((resolve, reject) => {
    run.once('error', reject);
    run.once('exit', (code, signal) => resolve({ code, signal }));
  });
  console.log(JSON.stringify({ repo, mode, scope, ...status, log, outer_locks_released: !fs.existsSync(env.MONITOR_TEST_SLOT_PATH) && !fs.existsSync(env.MONITOR_TEST_SLOT_COMPAT_PATH) }));
  process.exitCode = status.code ?? 1;
} finally {
  for (const worker of workers) worker.kill('SIGKILL');
  fs.closeSync(fd);
  fs.rmSync(root, { recursive: true, force: true });
}
