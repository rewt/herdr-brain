// Category guidance and a deliberately conservative lexical backstop. No model,
// authorization or status changes: a match is evidence to review, not a verdict.
export const CATEGORY_CHECKLIST = `Choose a category by the action being authorized, in this order (first match wins):
1. security: handle keys, credentials or trust pins; change cryptography, permissions,
   security boundaries, or respond to a vulnerability.
2. funds-and-chain: spend or move funds, sign a transaction, or broadcast to a chain.
3. publish: push to a remote, publish, deploy, release, or distribute outside the project.
4. delete-data: delete user/project data, history, backups, or other irreplaceable state.
5. licensing: change a license or accept legal/distribution obligations.
6. priorities: change the operator's ordering or commitments between outcomes.
7. Otherwise use design (implementation/architecture), prover (proof mechanics),
   tooling (local tools), goals (goal structure), or other (no clear fit).
Check project authority and category policy; a technical topic does not make a risky
action design/tooling. Categories are routed by the project's approvals config.
When unsure, pause the dependent action and ask with --wait, a recommendation and
the reason for uncertainty; never guess an auto category. For an uncertain report
question, first run record ask --wait and include its id in questions.
Do not perform an operator-reserved action while its answer is pending.`;

export function approvalPolicy(config, category) {
  const approvals = config.approvals;
  return (approvals.categories[category] ?? approvals.default) === 'auto' ? 'auto' : 'ask';
}

const SIGNALS = [
  ['keys', /\b(?:keys?|credentials?|secrets?|(?:private|public|api)[-_ ]?keys?)\b/i],
  ['pins', /\b(?:pins?|pinned|pinning)\b/i],
  ['push', /\bpush(?:es|ed|ing)?\b/i],
  ['publish', /\b(?:publish(?:es|ed|ing)?|publication|deploy(?:s|ed|ing|ment)?|releases?)\b/i],
  ['broadcast', /\bbroadcast(?:s|ed|ing)?\b/i],
  ['vulnerability', /\b(?:vulnerabilit(?:y|ies)|vulnerable|CVE[-_ ]?\d{4}[-_]\d+)\b/i],
  ['deletion', /\b(?:delet(?:e|es|ed|ing|ion|ions)|remov(?:e|es|ed|ing|al)|eras(?:e|es|ed|ing|ure)|wipe(?:s|d)?|wiping|drop(?:s|ped|ping)?)\b/i],
];

function prose(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(prose).join('\n');
  if (value && typeof value === 'object') return Object.entries(value)
    .filter(([key]) => !['category', 'wait', 'memo', 'blocks', 'parent', 'id'].includes(key))
    .map(([, part]) => prose(part)).join('\n');
  return '';
}

export function categoryFlag(config, entry, source, { wait = false } = {}) {
  if (!entry?.category || wait || approvalPolicy(config, entry.category) !== 'auto') return null;
  const text = prose(entry);
  const signals = SIGNALS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return signals.length ? { category: entry.category, source, signals } : null;
}

// Accept both today's lenient extra fields and normalized fields in newer reports.
export function reportCategoryFlags(config, report) {
  const out = [];
  for (const field of ['decisions', 'questions']) {
    const value = report[field] ?? report.extra?.[field];
    const entries = value == null ? [] : Array.isArray(value) ? value : [value];
    entries.forEach((entry, index) => {
      const flag = categoryFlag(config, entry, `${field}[${index}]`);
      if (flag) out.push(flag);
    });
  }
  return out;
}

export function categoryFlagText(flag) {
  return `Category review: ${flag.category} is auto but ${flag.run ? `${flag.run} ` : ''}${flag.source} mentions ${flag.signals.join(', ')}; check operator authority`;
}
