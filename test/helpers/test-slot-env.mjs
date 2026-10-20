import { isolateGateHistory } from './gate-history.mjs';
import { RELEASE_TIMEOUT_ENV } from '../../test-slot/limits.mjs';
import { healthyMemoryEnvironment } from './promotion-memory-fixture.mjs';
isolateGateHistory();
// In-process limit fixtures, like child holders below, start outside a release.
delete process.env[RELEASE_TIMEOUT_ENV];

// Fixture holders must start outside any enclosing gate's slot, wait and retry
// context. Each caller adds its own scratch paths and deliberate nested values.
// Admission uses private healthy memory unless a case overrides this result.
export function testSlotEnvironment(env = process.env) {
  return healthyMemoryEnvironment(Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(MONITOR_TEST_SLOT_|BCH_CLOAK_TEST_SLOT_)/.test(key))));
}
