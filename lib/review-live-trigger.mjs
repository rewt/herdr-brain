// Conditional findings remain obligations; selection is not a live observation.
export const REVIEW_LIVE_WITNESS_PREFIX = 'review-live-witness: ';
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
// Semicolons and sentence boundaries end the condition; dots inside paths do
// not. Keep legacy inference narrow; other wording uses explicit live_trigger.
const clause = String.raw`(?:[^.!?;\n]|\.(?=\S))*?`;
const fix = String.raw`fix[\s-]+forward(?:[\s-]+only)?`;
const forward = new RegExp(String.raw`\b${fix}[\s-]+(?:if|when|once)\b${clause}\blive\b${clause}(?:[.!?](?=\s|$)|$)`, 'i');
const reversed = new RegExp(String.raw`\b(?:if|when|once)\b${clause}\blive\b${clause}[,:—]\s*(?:then\s+)?${fix}\b[.!?]?`, 'i');

export function conditionalMinorTrigger(finding) {
  if (String(finding?.severity).toLowerCase() !== 'minor') return null;
  if (nonempty(finding.live_trigger)) return finding.live_trigger.trim();
  const text = String(finding.text ?? '');
  return (text.match(forward) ?? text.match(reversed))?.[0].trim() ?? null;
}

export function conditionalMinorDeferrals(item) {
  const bindings = item?.finding_bindings ?? [];
  // Historical mixed corrections retain their immediate obligations. New intake
  // separates conditional Minors so they cannot hold an immediate correction.
  if (bindings.some(binding => !conditionalMinorTrigger(binding.finding))) return [];
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
