// validateValidation copied unchanged from main 5d32007fceff8444134eade409616a21e9abad47.
import { limitSeconds } from '../../../test-slot/limits.mjs';
const VALIDATION_TIERS = ['fast', 'promotion', 'release'];

export function validateValidation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('validation must be an object');
  for (const [key, command] of Object.entries(value)) {
    if (['host_suites', 'tier_suites'].includes(key)) continue;
    if (['timeout_seconds', 'idle_timeout_seconds'].includes(key)) {
      const values = typeof command === 'object' && command !== null && !Array.isArray(command) ? Object.entries(command) : [[null, command]];
      for (const [tier, seconds] of values) {
        if (tier !== null && !VALIDATION_TIERS.includes(tier)) throw Error(`unknown watchdog tier: ${tier}`);
        limitSeconds(seconds, `validation.${key}`, { idle: key === 'idle_timeout_seconds' });
      }
      continue;
    }
    if (![...VALIDATION_TIERS, 'environment', 'promotion_tests'].includes(key)) throw new Error(`unknown validation field: ${key}`);
    if (typeof command !== 'string' || !command.trim()) throw new Error(`validation.${key} must be a nonempty string`);
  }
  return value;
}
