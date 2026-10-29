// Retire automatic judgment work, not its evidence or original native attempt.
// Closeout outcome decisions retain their exact behavior while its proof runs.
export function recordOnlyJudgment(item) {
  const meta = item?.meta ?? {};
  if (meta.backlog_batch !== undefined) return true;
  const key = meta.uncertain_outcome?.check?.key;
  return typeof key === 'string' &&
    ['review:', 'dispatch:'].some(prefix => key.startsWith(prefix));
}
