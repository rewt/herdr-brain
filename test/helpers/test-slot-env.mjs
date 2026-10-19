import { isolateGateHistory } from './gate-history.mjs';
import { RELEASE_TIMEOUT_ENV } from '../../test-slot/limits.mjs';
isolateGateHistory();
// In-process limit fixtures, like child holders below, start outside a release.
delete process.env[RELEASE_TIMEOUT_ENV];

// Fixture holders must start outside any enclosing gate's slot, wait and retry
// context. Each caller adds its own scratch paths and deliberate nested values.
export function testSlotEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(MONITOR_TEST_SLOT_|BCH_CLOAK_TEST_SLOT_)/.test(key)));
}
