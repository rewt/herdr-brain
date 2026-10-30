// One authoring/dispatch shape. This adds no authority or readiness gate.
// Complete authored prompts pass through; older acceptance stays verbatim.
import { roleIs } from './roles.mjs';

export const DISPATCH_TEMPLATE = `Why: <intended benefit, linked to dated evidence>.
Question: <the outcome or uncertainty this owner can resolve>?
Measure: <observable change, owned seam and named consumer>.
Hard limits: AGENTS.md; <only limits particular to this slice>.
Out of scope: <adjacent work and its owner>.
Challenge the question, measures or targets with reasons in the record; choose the method and any authorized help within the recorded authority and hard limits.

How we will know it works:
- Baseline: <dated source fact or measurement and evidence; say unmeasured when it is>.
- Witness: <bounded observation, target and a failure and recovery case>.
- Handoff: <exact evidence, unresolved responsibility and next owner; name one tempting false proof>.
`;

const labels = ['Why', 'Question', 'Measure', 'Hard limits', 'Out of scope', 'How we will know it works'];
export function isDispatchPrompt(value) {
  return typeof value === 'string' && labels.every(label => new RegExp(`^${label}:`, 'm').test(value)) &&
    ['Baseline', 'Witness', 'Handoff'].every(label => new RegExp(`^\\s*- ${label}:`, 'm').test(value)) && /\bchallenge\b/i.test(value);
}

export function dispatchPrompt(item) {
  const accept = item.accept ?? [];
  if (accept.length === 1 && isDispatchPrompt(accept[0])) return accept[0];
  const meta = item.meta ?? {}, rationale = item.created?.why ?? item.why ?? meta.purpose;
  const correction = Boolean(meta.review_fix_of), review = roleIs(item, 'REV');
  const decision = roleIs(item, 'DEC'), question = roleIs(item, 'HUM');
  const checks = Object.values(meta.review_correction_checks ?? {});
  const target = meta.review_target;
  return [
    `Why: ${rationale || 'Not recorded separately; use the current acceptance and owning intent, and record any changed premise.'}`,
    `Question: ${question ? item.title : decision ? `What decision resolves “${item.title}” within the recorded delegation?` : review ? `Does the captured change for “${item.title}” meet its intended outcome?` : `Can this owner deliver “${item.title}” within the current acceptance?`}`,
    `Measure: ${correction ? 'Resolve the assigned immutable findings; the existing correction/release owner consumes the specific correction evidence.' : review ? 'Record the verdict and specific findings against the captured diff and inherited producer evidence.' : question ? `Record an authorized answer and its disposition for ${item.parent || 'the owning work'}; a recommendation is not an answer.` : 'Not recorded separately. Name the observable change, owned seam, consumer and target in the normal work note; do not invent a measurement.'}`,
    `Hard limits: AGENTS.md; ${correction ? 'retain original findings, required Major correction checks and the one formal correction; no re-review chain.' : review ? 'immutable diff and evidence only; zero reviewer suites or source edits.' : question || decision ? 'the existing category policy, reserved decisions and recorded delegation govern the answer and any dependent effect.' : 'retain the current acceptance and recorded effect and ownership boundaries.'}`,
    `Out of scope: ${meta.unchanged || 'Adjacent work outside the current acceptance; name its owner if a missing boundary matters.'}`,
    'Challenge the question, measures or targets with reasons in the record; choose the method and any authorized help within the recorded authority and hard limits.',
    '',
    'How we will know it works:',
    `- Baseline: ${correction ? `The assigned review findings remain the source defect; read their original report and captured source (${meta.review_fix_of}).` : target ? `Captured source ${target.base}..${target.head}; inherited evidence may contain failed or unrun checks.` : 'Unmeasured unless the current acceptance supplies dated evidence; record the source baseline or the next measurement in the normal work note.'}`,
    `- Witness: ${checks.length ? checks.join('\n  ') : review ? 'Compare the exact diff and producer evidence with the intended outcome, including missing or negative proof; do not rerun suites.' : question ? 'The existing answer owner records the answer under the current policy; pending or refused effects remain pending or refused.' : 'Use the current acceptance to select a bounded observation and target, including a failure and recovery case. Missing proof stays unproven; unrun is never PASS.'}`,
    '- Handoff: Put exact evidence, unrun limits and unresolved responsibility with its next owner and event in the owning record or report. A completed template or persuasive summary alone does not prove the outcome.',
    '',
    'Current acceptance (verbatim source; still governs scope):',
    ...(accept.length ? accept : ['No acceptance recorded; resolve the missing outcome against the owning intent before dependent work.']),
  ].join('\n');
}

// Apply only while filing a genuinely new item. Never map historical events,
// amendments, source proposals or retained UNKNOWN/recovery bindings through it.
export function intentFirstCreation(event) {
  return event.type === 'item.added' && event.kind !== 'goal'
    ? { ...event, accept: [dispatchPrompt(event)] } : event;
}
