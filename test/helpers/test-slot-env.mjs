// Fixture holders must start outside any enclosing gate's slot, wait and retry
// context. Each caller adds its own scratch paths and deliberate nested values.
export function testSlotEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(MONITOR_TEST_SLOT_|BCH_CLOAK_TEST_SLOT_)/.test(key)));
}
