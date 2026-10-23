// Request settings belong to the outer promotion, never a disposable project.
// Sanitize at environment construction, then apply each fixture's own settings
// and deliberate per-test overrides (including LANE_VALIDATE) afterward.
export const PROMOTION_REQUEST_KEYS = [
  'LANE_VALIDATE', 'LANE_CONFIG', 'ORG_DIR', 'HERDR_RETIRE_HERDR',
  'MONITOR_PROMOTION_TEST_FILES',
];

export function fixtureEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of PROMOTION_REQUEST_KEYS) delete env[key];
  return env;
}
