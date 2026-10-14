// Project desk settings; runtime flags and item overrides are applied at intake.
import { resolveLaunchRoute } from '../lanes/routes.mjs';
import { validateReviewScope } from './review-scope.mjs';
export const DESK_FIELDS = ['review_route', 'fix_route', 'review_round_cap', 'timeout', 'reuse', 'to'];
export const DESK_DEFAULTS = { review_round_cap: 0, timeout: 1800, reuse: false, to: 'supervisor-herdr' };
export function deskFallback(key, config) {
  if (key === 'fix_route') return 'worker route, otherwise engineer';
  const choice = config.selection_policy?.by_task_class?.review;
  if (!config.selection_policy) return 'review (default)';
  if (typeof choice === 'string') return `${choice} (selection policy)`;
  if (!choice) return 'review selection missing from policy';
  return 'by worker pool: ' + Object.entries(choice).map(([pool, route]) => `${pool} → ${route}`).join(' · ');
}
export function validateDeskSettings(settings, routes) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settle config must be an object');
  if (settings.review !== undefined) validateReviewScope(settings.review);
  for (const key of ['review_route', 'fix_route', 'to']) {
    if (settings[key] !== undefined && (typeof settings[key] !== 'string' || !settings[key].trim())) throw new Error(`settle.${key} must be a nonempty string`);
  }
  if (settings.reuse !== undefined && typeof settings.reuse !== 'boolean') throw new Error('settle.reuse must be boolean');
  if (settings.review_round_cap !== undefined && (!Number.isSafeInteger(settings.review_round_cap) || settings.review_round_cap < 0)) throw new Error('settle.review_round_cap must be a nonnegative safe integer (0 disables the cap)');
  if (settings.timeout !== undefined && (!Number.isInteger(Number(settings.timeout)) || Number(settings.timeout) < 3 || Number(settings.timeout) > 7200)) throw new Error('review timeout must be 3 through 7200 seconds');
  if (routes) for (const key of ['review_route', 'fix_route']) if (settings[key] !== undefined) resolveLaunchRoute(routes, { route: settings[key] });
  return settings;
}
export function parseDeskValue(key, text) {
  if (!DESK_FIELDS.includes(key)) throw new Error(`unknown desk field: ${key}`);
  if (key === 'reuse') {
    if (!['true', 'false'].includes(text)) throw new Error('reuse must be true or false');
    return text === 'true';
  }
  if (['timeout', 'review_round_cap'].includes(key)) {
    if (!/^\d+$/.test(text)) throw new Error(`${key} must be an integer`);
    return Number(text);
  }
  return text;
}
