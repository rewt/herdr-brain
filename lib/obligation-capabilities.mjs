// Reviewed admission floor, not effect authority or identical inventory status.
// DEC-476: exact bytes identify a profile; EACH present event still needs its
// capabilities. Add requirements for new event/payload semantics before shipping
// a producer. Compatible implementation revisions can join a reviewed profile
// without deleting older source digests. Never normalize or execute target code.
import { createHash } from 'node:crypto';

const named = [
  'report.available', 'report.ingested', 'change.landed',
  'closeout.binding-kept', 'closeout.evaluated', 'closeout.waiting',
  'closeout.producer-status', 'closeout.wait-classified', 'dispatch.completed',
];
const contracts = [
  // Deliberately independent of the requirement selectors above: adding a new
  // producer requirement must NEVER implicitly grant it to reviewed old bytes.
  'report.available/v1', 'report.ingested/v1', 'change.landed/v1',
  'closeout.binding-kept/v1', 'closeout.evaluated/v1', 'closeout.waiting/v1',
  'closeout.producer-status/v1', 'closeout.wait-classified/v1', 'dispatch.completed/v1',
  'report.completion/v1', 'review.capture/v1', 'dispatch.start/v1',
  'closeout.targets/v1', 'closeout.binding-errors/v1',
  'native.intent/v1', 'native.result/v1', 'source.completion/v1',
  'source.state/v1', 'pending.retention/v1',
];

// 6dc33698 / ab671e8986 and a84da588 respectively. The shared contract set is an
// accepted admission floor, not proof of identical per-contract reconciliation.
// Legacy lacks item.closed/reopened source-completion reconciliation and the
// closeout.evaluated-to-wait linkage. Those compact-status differences (and the
// report/review differences documented in PROBATION-SUCCESSOR.md) are reviewed
// acceptances; original guarded consumers remain authoritative for effects.
const profiles = new Map([
  ['8f4e3cc3ce09ebf632d5a21b0eda28edf505e556480cb5044cf849e02d2b04f0', 'legacy'],
  ['7d96691e48bcb8fbf1096a99a204c4284e6cec89847198646587870af8911b6e', 'current'],
]);
export function obligationProfile(source) {
  const name = source === null ? undefined : profiles.get(createHash('sha256').update(source).digest('hex'));
  return name ? { name, capabilities: new Set(contracts) } : { name: null, capabilities: new Set() };
}

export function obligationRequirements(e) {
  const required = [];
  if (named.includes(e.type)) required.push(`${e.type}/v1`);
  if (e.type === 'report.ingested' && e.report?.outcome === 'done') required.push('report.completion/v1');
  if (e.type === 'item.added' && e.meta?.review_source_run) required.push('review.capture/v1');
  if (e.type === 'run.started' && e.meta?.dispatch_attempt) required.push('dispatch.start/v1');
  for (const [field, capability] of [['closeout_targets', 'closeout.targets/v1'], ['closeout_binding_errors', 'closeout.binding-errors/v1']]) {
    if (e[field] != null && !Array.isArray(e[field])) throw Error(`unknown ${field} payload contract`);
    if (e[field]?.length) required.push(capability);
  }
  if (e.type === 'closeout.effect' && ['agent-exit-requested', 'shell-close-requested', 'workspace-close-requested', 'git-removal-started'].includes(e.outcome?.action))
    required.push('native.intent/v1');
  // Completions require a reader even when no matching open row is present.
  if (e.intent && ['closeout.effect', 'closeout.command-failed', 'closeout.command-not-started', 'closeout.exit-settled'].includes(e.type))
    required.push('native.result/v1');
  if (e.type === 'item.closed' && e.completed_run) required.push('source.completion/v1');
  if (['item.closed', 'item.reopened'].includes(e.type)) required.push('source.state/v1');
  if ((/\.(waiting|requested)$/.test(e.type) && e.type !== 'closeout.waiting') || e.pending === true)
    required.push('pending.retention/v1');
  return required;
}
