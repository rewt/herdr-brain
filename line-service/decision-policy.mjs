// Retire automatic judgment work, not its evidence or original native attempt.
// This extension is held on the worker branch until the closeout proof clears.
export function recordOnlyJudgment(item) {
  const meta = item?.meta ?? {};
  if (meta.backlog_batch !== undefined) return true;
  const key = meta.uncertain_outcome?.check?.key;
  return typeof key === 'string' &&
    ['review:', 'dispatch:', 'closeout:', 'source-complete:'].some(prefix => key.startsWith(prefix));
}
