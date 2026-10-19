// Test-only defaults. The outer runner also bounds blocked event loops/files.
import { loadTimeout } from '../../lib/deadline.mjs';
import nodeTest from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { offlineHerdr } from './offline-herdr.mjs';
import { commandAllowance } from './command-allowance.mjs';
import { ownFixtureLifetime } from './fixture-lifetime.mjs';

offlineHerdr();
ownFixtureLifetime();
// Fixture promotions/releases never contend with the machine's real slot or
// another test file. Every descendant inherits this test file's temporary slot.
const slotScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'test-slot-offline-'));
process.once('exit', () => fs.rmSync(slotScratch, { recursive: true, force: true }));
process.env.MONITOR_TEST_SLOT_PATH = path.join(slotScratch, 'slot.lock');
process.env.MONITOR_TEST_SLOT_COMPAT_PATH = process.env.MONITOR_TEST_SLOT_PATH;
for (const key of ['MONITOR_TEST_SLOT_TOKEN', 'BCH_CLOAK_TEST_SLOT_TOKEN', 'MONITOR_TEST_SLOT_WAIT_SECONDS', 'MONITOR_TEST_SLOT_TIMEOUT_RETRIED', 'MONITOR_TEST_SLOT_RELEASE_TIMEOUT_SECONDS', 'BCH_CLOAK_TEST_SLOT_WAIT_SECONDS']) delete process.env[key];

export const TEST_TIMEOUT = 60_000;
export const COMMAND_TIMEOUT = 15_000;
const context = new AsyncLocalStorage();
export const currentTest = () => {
  const t = context.getStore();
  if (!t) throw new Error('fixture child must be spawned inside a test');
  return t;
};

// A JS test timer cannot interrupt spawnSync (or execSync). Bound those at the
// OS call, including calls in product modules imported by a test.
for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
  const original = childProcess[name];
  childProcess[name] = function (...args) {
    const index = name === 'execSync' ? 1 : Array.isArray(args[1]) ? 2 : 1;
    const options = args[index] ?? {};
    // Native child_process timeouts are absolute response allowances. Product
    // code may already have scaled them; only the default test cap is a base.
    const ceiling = options[commandAllowance] ?? loadTimeout(COMMAND_TIMEOUT);
    if (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > loadTimeout(TEST_TIMEOUT))
      throw Error('invalid compound fixture command allowance');
    const { [commandAllowance]: _allowance, ...nativeOptions } = options;
    args[index] = { ...nativeOptions, timeout: Math.min(options.timeout || ceiling, ceiling), killSignal: 'SIGKILL' };
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();

export default function test(name, options, body) {
  if (typeof options === 'function') { body = options; options = {}; }
  return nodeTest(name, { ...options, timeout: loadTimeout(Math.min(options?.timeout || TEST_TIMEOUT, TEST_TIMEOUT)) },
    body && ((t) => context.run(t, () => body(t))));
}
Object.assign(test, nodeTest, { test });
for (const flag of ['only', 'skip', 'todo']) test[flag] = (name, options, body) => {
  if (typeof options === 'function') { body = options; options = {}; }
  return test(name, { ...options, [flag]: true }, body);
};
