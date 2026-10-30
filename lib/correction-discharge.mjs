// Evidence intake for the existing single formal correction, not another judge.
// Missing/red/unrun controls leave acceptance Unknown and retain the report.
import fs from './record-observation.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function correctionDischargeEvents({ state, run, report, sha256, org }) {
  const item = state.items.get(run.item), declaration = report.extra?.correction_discharge;
  if (!item?.meta.review_fix_of || !declaration || report.outcome !== 'done' ||
      declaration.review_key !== item.meta.review_fix_of || declaration.run !== run.id ||
      declaration.claim_generation !== run.owner_generation || run.owner_generation == null) return [];
  const keys = item.meta.review_finding_keys ?? [], bindings = item.finding_bindings ?? [];
  if (!keys.length || item.runs.at(-1) !== run.id) return [];
  const verified = [];
  try {
    for (const key of keys) {
      const finding = declaration.findings?.find(f => f.key === key);
      const original = bindings.find(b => b.finding_key === key && b.correction_item === item.id &&
        b.source_item === item.meta.review_source_item && b.review_run === item.created.run &&
        item.meta.review_fix_of === `${b.source_item}:${b.head}`);
      const reviewer = state.runs.get(original?.review_run), review = state.items.get(original?.review_item);
      if (!original || finding?.result !== 'PASS' || !finding.command?.trim() ||
          reviewer?.report?.sha256 !== original.report_sha256 || reviewer?.item !== original.review_item ||
          review?.meta.review_source_run !== item.meta.review_source_run ||
          original.finding.severity === 'major' && finding.requirement !== item.meta.review_correction_checks?.[key]) return [];
      const landing = run.landings?.at(-1);
      if (!landing || landing.head !== finding.head || landing.project !== run.meta.dispatch_project ||
          landing.producer?.ownership_generation !== run.owner_generation) return [];
      // Require durable proof in this owning record, independent of lane cleanup.
      const file = fs.realpathSync(finding.evidence), root = fs.realpathSync(path.join(org, 'evidence'));
      if (!file.startsWith(root + path.sep) || !fs.lstatSync(file).isFile()) return [];
      const bytes = fs.readFileSync(file), gate = JSON.parse(bytes);
      if (digest(bytes) !== finding.sha256 || gate.schema !== 'lane-validation/v1' || gate.head !== finding.head ||
          gate.command !== finding.command || gate.executed !== true || gate.exit_code !== 0 || gate.signal != null ||
          gate.outcome !== 'green' || gate.gate_timeout || gate.tap_totals?.fail > 0) return [];
      const output = fs.readFileSync(gate.log), execution = JSON.parse(fs.readFileSync(gate.execution_receipt));
      if (digest(output) !== gate.log_hash || execution.command_started !== true || execution.exit_code !== 0 ||
          execution.signal != null || execution.gate_timeout || execution.cleanup_error || !(execution.attempts >= 1)) return [];
      verified.push({ key, head: finding.head, command: finding.command, evidence: file, sha256: finding.sha256,
        finding_seq: original.seq, execution_receipt: gate.execution_receipt });
    }
  } catch { return []; }
  return [{ type: 'correction.discharged', item: item.id, run: run.id, report_sha256: sha256,
    claim_generation: run.owner_generation, review_key: item.meta.review_fix_of, findings: verified }];
}
