// Retire automatic judgment work, not its evidence or original native attempt.
// Cleanup holds need the original effect owner/evidence, not a zero-effect judge.
export function recordOnlyJudgment(item) {
  const meta = item?.meta ?? {};
  if (meta.backlog_batch !== undefined) return true;
  const key = meta.uncertain_outcome?.check?.key;
  return typeof key === 'string' &&
    ['review:', 'dispatch:', 'closeout:'].some(prefix => key.startsWith(prefix));
}

// A retained exact-input effect may use its guarded continuation. A READY
// record alone cannot create new judgment work or justify an idle repair.
export function judgmentDispatchAllowed(item, input, actions = {}) {
  return !recordOnlyJudgment(item) || Boolean(actions[`dispatch:${item.id}:${input}`]);
}
