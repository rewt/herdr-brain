// Conditional findings remain obligations; selection is not a live observation.
export const REVIEW_LIVE_WITNESS_PREFIX = 'review-live-witness: ';
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function conditionalMinorTrigger(finding) {
  if (String(finding?.severity).toLowerCase() !== 'minor') return null;
  if (nonempty(finding.live_trigger)) return finding.live_trigger.trim();
  return String(finding.text ?? '').match(/\bfix[\s-]+forward(?:[\s-]+only)?[\s-]+(?:if|when|once)\b[^.!?\n]*\blive\b[^.!?\n]*[.!?]?/i)?.[0].trim() ?? null;
}

export function conditionalMinorDeferrals(item) {
  const bindings = item?.finding_bindings ?? [];
  // Historical mixed corrections retain their Major obligation. New intake
  // separates conditional Minors so they cannot hold an immediate correction.
  if (bindings.some(binding => binding.finding?.severity === 'major')) return [];
  return bindings.flatMap(binding => {
    const trigger = conditionalMinorTrigger(binding.finding);
    if (!trigger) return [];
    const witnessed = (item.notes ?? []).some(note => {
      if (!note.text?.startsWith(REVIEW_LIVE_WITNESS_PREFIX) || !(note.seq > binding.seq)) return false;
      let witness;
      try { witness = JSON.parse(note.text.slice(REVIEW_LIVE_WITNESS_PREFIX.length)); } catch { return false; }
      const observed = Date.parse(witness?.observed_at), recorded = Date.parse(note.at);
      return witness?.schema === 'brain.review-live-witness/v1' && witness.finding_key === binding.finding_key &&
        witness.trigger === trigger && nonempty(witness.evidence) &&
        /(?:Z|[+-]\d\d:\d\d)$/.test(witness.observed_at ?? '') &&
        Number.isFinite(observed) && Number.isFinite(recorded) && observed <= recorded;
    });
    return witnessed ? [] : [{ finding_key: binding.finding_key, trigger }];
  });
}
