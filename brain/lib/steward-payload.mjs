// Explicit outbound schemas shared by local alerts and the Messages transport.
export const QUESTION_TEXT_LIMIT = 240;
export const RECOMMENDATION_LIMIT = 80;
const line = (value, limit) => String(value ?? '').replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, limit).replace(/[\uD800-\uDBFF]$/u, '');

export function alertPayload(payload, config = {}) {
  if (payload.kind !== 'operator-question') return {
    project: String(payload.project ?? 'unresolved'), session: String(payload.session ?? 'unresolved'), kind: String(payload.kind ?? 'steward'),
  };
  const result = { project: line(payload.project, 160), question: line(payload.question, 80), kind: 'operator-question',
    category: line(payload.category ?? 'other', 80), blocked_items: payload.blocked_items, blocked_runs: payload.blocked_runs };
  if (config.question_text === true) {
    result.text = line(payload.text, QUESTION_TEXT_LIMIT);
    result.recommendation = line(payload.recommendation, RECOMMENDATION_LIMIT);
  }
  validateAlertPayload(result);
  return result;
}

export function validateAlertPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('alert JSON must be an object');
  const keys = Object.keys(payload).sort().join(',');
  if (payload.kind !== 'operator-question') {
    if (keys !== 'kind,project,session' || Object.values(payload).some(v => typeof v !== 'string')) throw Error('project/session/kind JSON required');
    return;
  }
  if (!['blocked_items,blocked_runs,category,kind,project,question', 'blocked_items,blocked_runs,category,kind,project,question,recommendation,text'].includes(keys)) throw Error('invalid operator question alert fields');
  for (const [key, limit] of [['project', 160], ['question', 80], ['category', 80], ['text', QUESTION_TEXT_LIMIT], ['recommendation', RECOMMENDATION_LIMIT]]) {
    if (payload[key] === undefined && ['text', 'recommendation'].includes(key)) continue;
    if (typeof payload[key] !== 'string' || payload[key].length > limit || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(payload[key])) throw Error(`invalid question alert ${key}`);
  }
  for (const key of ['blocked_items', 'blocked_runs']) if (!Number.isSafeInteger(payload[key]) || payload[key] < 0) throw Error(`invalid question alert ${key}`);
}
