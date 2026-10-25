// Test context and fixture isolation; elapsed execution limits are not added.
import nodeTest from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { offlineHerdr } from './offline-herdr.mjs';
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

// Legacy exports retained for callers; neither value configures an execution cap.
export const TEST_TIMEOUT = 60_000;
export const COMMAND_TIMEOUT = 15_000;
const context = new AsyncLocalStorage();
export const currentTest = () => {
  const t = context.getStore();
  if (!t) throw new Error('fixture child must be spawned inside a test');
  return t;
};

export default function test(name, options, body) {
  if (typeof options === 'function') { body = options; options = {}; }
  const { timeout: _timeout, ...nodeOptions } = options ?? {};
  return nodeTest(name, nodeOptions,
    body && ((t) => context.run(t, () => body(t))));
}
Object.assign(test, nodeTest, { test });
for (const flag of ['only', 'skip', 'todo']) test[flag] = (name, options, body) => {
  if (typeof options === 'function') { body = options; options = {}; }
  return test(name, { ...options, [flag]: true }, body);
};
