// One record-derived handoff for foreground, detached and resumed fix dispatch.
// Paths name complete durable evidence, never the renderer's truncated digests.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { reviewDiffForm } from './review-diff-form.mjs';

const unknown = 'UNKNOWN (not recorded; do not infer PASS)';
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const reportPath = (run, org, saved) => run?.report
  ? path.resolve(org, run.report.file ?? saved?.report ?? `runs/${run.id}/report.md`)
  : null;

function proof(label, run, saved, org) {
  return [
    `${label} report: ${reportPath(run, org, saved) ?? unknown}; SHA256: ${run?.report?.sha256 ?? unknown}`,
    `${label} failed/unrun proof locations (read the complete reports and artifacts for scope/status):`,
    ...[...new Set([...(saved?.proof_locations ?? []), ...(run?.report?.artifacts ?? [])])].map(value => `- ${value}`),
    `${label} captured check (including failed/unrun status, log and execution receipt): ${JSON.stringify(saved?.check ?? { executed: false, outcome: 'UNKNOWN', reason: 'No preserved check capture; consult report artifacts. Unrun is never PASS.' })}`,
  ];
}

export function correctionBrief({ item, author, saved, witness, target, findings, reviewRun, prior = [], org, repo }) {
  const base = target?.base ?? saved?.base, head = target?.head ?? saved?.head;
  const diffHash = target?.diff_sha256 ?? (typeof saved?.diff === 'string' ? createHash('sha256').update(saved.diff).digest('hex') : unknown);
  return [
    '## Full fix context',
    'Read both complete reports and the exact diff before editing. These are evidence inputs, not permission to replace a retained attempt.',
    ...proof('Author', author, saved, org),
    ...proof('Review', reviewRun, null, org),
    `Immutable base/head: ${base ?? unknown} ${head ?? unknown}; diff SHA256: ${diffHash}; evidence: ${target?.evidence ?? witness?.packet ?? unknown}`,
    target?.diff_sha256 ? reviewDiffForm(target) : typeof saved?.diff === 'string'
      ? 'Diff SHA256 form: SHA256 of the exact UTF-8 saved author packet diff string, without trimming.'
      : 'Diff SHA256 form: UNKNOWN (no captured diff hash or saved diff).',
    ...(base && head ? [`Exact immutable diff: git -C ${quote(repo)} diff --no-ext-diff --no-textconv ${quote(base)} ${quote(head)}`] : []),
    `Saved author packet (contains the captured diff and check): ${witness?.packet ?? unknown}; SHA256: ${witness?.sha256 ?? unknown}`,
    'Findings assigned to this correction (Major and Minor; other findings retain their owners):',
    ...(findings.length ? findings.map(e => `- [${e.finding.severity}] ${e.finding.text} (finding ${e.finding_key})`) : ['- No typed findings recorded; read the full reports and item acceptance.']),
    'Major correction checks (run only each specific affected control; preserve failed and unrun evidence):',
    ...findings.filter(e => e.finding.severity === 'major').map(e =>
      `- ${e.finding.text}; required check: ${item.meta.review_correction_checks?.[e.finding_key] ?? `Selection required before editing: reproduce this exact Major trigger and assert its corrected behavior. Acceptance: ${(item.accept ?? []).join('; ')}`}`),
    'Correction acceptance uses the existing report intake, not a second review. Preserve each lane check receipt under the owning record evidence directory. In report extra correction_discharge, name review_key, run, claim_generation and findings. Each finding names key, result: PASS, head, command, evidence (durable gate JSON), sha256 (gate bytes) and, for a Major, requirement (the exact required-check text above). Intake verifies the landing, original finding, gate, log and execution result. Missing, red or unrun proof remains Unknown. See docs/item-conditions.md; release coverage remains with the release owner.',
    ...prior.flatMap(({ run, saved: previous, witness: packet }) => [
      `### Earlier fixer ${run.id}`,
      ...proof('Fixer', run, previous, org),
      `Saved fixer packet: ${packet?.packet ?? unknown}; SHA256: ${packet?.sha256 ?? unknown}`,
    ]),
    'Start fresh from the saved branch when present, otherwise main. Preserve the original verdict, one formal correction, and no re-review chain.',
    '',
  ].join('\n');
}
