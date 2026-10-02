// Trusted entry bounds, independent of agent requests and session metadata.
export const FAST_VALIDATION_TIMEOUT = 120_000;
export const PROMOTION_VALIDATION_TIMEOUT = 1_800_000;
export const VALIDATION_WRAPPER_GRACE = 25_000; // compilation and descendant cleanup
export const ENTRY_COMMAND_GRACE = 35_000; // Git preflight and final fast-forward
export const MAX_ENTRY_TIMEOUT = 3_600_000;
export const DEFAULT_REQUEST_TIMEOUT = 180_000;
export const REQUEST_REPLY_GRACE = 5_000;

export function validationTimeout(tier) {
  if (tier === 'fast') return FAST_VALIDATION_TIMEOUT;
  if (tier === 'promotion') return PROMOTION_VALIDATION_TIMEOUT;
  throw new Error('native validation tier must be fast or promotion');
}
export function entryValidationTimeout(tier, prepareCount = 0) {
  if (!Number.isSafeInteger(prepareCount) || prepareCount < 0) throw new Error('invalid preparation count');
  return Math.min(MAX_ENTRY_TIMEOUT, validationTimeout(tier) + VALIDATION_WRAPPER_GRACE + ENTRY_COMMAND_GRACE +
    prepareCount * (FAST_VALIDATION_TIMEOUT + VALIDATION_WRAPPER_GRACE));
}
export const requestTimeout = op => ['check', 'promote', 'finish'].includes(op)
  ? MAX_ENTRY_TIMEOUT + REQUEST_REPLY_GRACE : DEFAULT_REQUEST_TIMEOUT;
