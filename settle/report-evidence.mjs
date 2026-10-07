import path from 'node:path';
import { createHash } from 'node:crypto';
import { readPlainFile } from '../lib/files.mjs';

export const RECORD_CHECK_CLAIM = '- Report record-check validation not independently executed.';
// Existing reviewers used this whole entry before briefs carried the receipt.
// The receipt proves validity of these bytes, not when the worker ran a command.
export const LEGACY_RECORD_CHECK_CLAIM = '- The report says it passed `record check` before being committed; that step leaves no in-repository receipt, so this review could not confirm it.';
// lane review escapes prose markup when projecting its public record.
const recordCheckEntries = new Set([RECORD_CHECK_CLAIM, LEGACY_RECORD_CHECK_CLAIM, LEGACY_RECORD_CHECK_CLAIM.replaceAll('`', '\\`')]);
const hash = text => createHash('sha256').update(text).digest('hex');

export function reportIngestReceipt({ run, runId, org, report, reportText, reportHash }) {
  if (!run?.report || run.id !== runId || run.abandoned || run.report.sha256 !== reportHash) throw new Error('Report ingest receipt does not match the reviewed report');
  const ingested = path.join(org, run.report.file);
  if (hash(reportText) !== reportHash || hash(readPlainFile(report, null)) !== reportHash || hash(readPlainFile(ingested, null)) !== reportHash)
    throw new Error('Reviewed or ingested report bytes do not match the report ingest receipt');
  return { schema: 'report-ingest/v1', run: run.id, report, ingested_report: ingested, sha256: reportHash,
    validation: { result: 'passed', via: 'record ingest', equivalent_to: 'record check' } };
}

export function remainingUnverified(text, receipt) {
  if (!receipt) return text;
  // Exact whole entries only: an appended claim or another non-test uncertainty
  // still needs the reviewer's independent assessment and supervisor handoff.
  return text.split('\n').filter(line => !recordCheckEntries.has(line)).join('\n');
}
