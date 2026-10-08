// Run focused slot tests in the same inherited slot context as a merge batch,
// while holding only a disposable scratch slot. No real host slot is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testSlotEnvironment } from '../../../../test/helpers/test-slot-env.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ENG-274-outer-')));
const slot = path.join(root, 'slot'), receipt = path.join(root, 'outer.json');
const files = process.argv.slice(2);
if (!files.length) files.push('test-slot/test/watchdog.test.mjs', 'test-slot/test/test-slot.test.mjs');
try {
  const result = spawnSync(process.execPath, ['test-slot/test-slot.mjs', 'run', 'outer',
    '--project-common', root, '--timeout-seconds', '100', '--result-path', receipt,
    '--', process.execPath, '--test', ...files], {
    cwd: repo, stdio: 'inherit', timeout: 120000,
    env: { ...testSlotEnvironment(), MONITOR_TEST_SLOT_PATH: slot,
      MONITOR_TEST_SLOT_COMPAT_PATH: slot, MONITOR_TEST_SLOT_WAIT_SECONDS: '7200',
      BCH_CLOAK_TEST_SLOT_WAIT_SECONDS: '7200', MONITOR_TEST_SLOT_TIMEOUT_RETRIED: '1' },
  });
  if (result.error) throw result.error;
  assert.equal(fs.existsSync(slot), false, 'outer scratch slot released');
  const execution = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(execution.command_started, true);
  assert.equal(execution.gate_timeout, null);
  console.log(`Outer scratch gate exit=${result.status}, attempts=${execution.attempts}; slot released`);
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
