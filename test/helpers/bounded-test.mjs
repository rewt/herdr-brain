// Test-only defaults. The outer runner also bounds blocked event loops/files.
import nodeTest from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';

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
    args[index] = { ...options, timeout: Math.min(options.timeout || COMMAND_TIMEOUT, COMMAND_TIMEOUT), killSignal: 'SIGKILL' };
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();

export default function test(name, options, body) {
  if (typeof options === 'function') { body = options; options = {}; }
  return nodeTest(name, { ...options, timeout: Math.min(options?.timeout || TEST_TIMEOUT, TEST_TIMEOUT) },
    body && ((t) => context.run(t, () => body(t))));
}
Object.assign(test, nodeTest, { test });
for (const flag of ['only', 'skip', 'todo']) test[flag] = (name, options, body) => {
  if (typeof options === 'function') { body = options; options = {}; }
  return test(name, { ...options, [flag]: true }, body);
};
