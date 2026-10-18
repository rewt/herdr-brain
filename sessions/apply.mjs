// Foreground, one journal action, explicitly enrolled and operator-authorized.
import { readPlainFile } from '../lib/files.mjs';
import { parseUniqueJson } from './json.mjs';
import { inspect } from './sessions.mjs';
import { plan, planInputs, selectionDigest } from './plan.mjs';
import { checkAuthorization } from './authorization.mjs';
import { reconcileOnce } from './reconcile.mjs';
import { createLiveActions, safeStandard } from './live.mjs';
import { experimentEvidence } from './live-observe.mjs';
import { enrolledWorkspace } from './authorization.mjs';
import { readSessionFacts } from './observe.mjs';
import { digest } from './lifecycle-evidence.mjs';
import { lifecycleEdgeVeto } from './lifecycle.mjs';

export async function apply(options = {}) {
  const { workspace, authorization, planFile, env = process.env, now = Date.now } = options;
  // No receipt means the identical read-only planner, without creating a lease,
  // journal, directory, context or mutation adapter.
  const preview = await plan(options);
  const refused = error => ({ ...preview, apply: { state: 'refused', reason: error.message } });
  let expected;
  try {
    checkAuthorization({ file: authorization, project: preview.project, workspace, action: preview.action, env, now });
    if (!workspace) throw Error('an explicit --workspace is required');
    const brakes = (options.readFacts ?? readSessionFacts)({ project: preview.project, env });
    if (brakes.stopped || brakes.closeHold || brakes.errors.length) throw Error('STOP, close hold or unreadable current facts; observe only');
    if (!planFile) throw Error('a fresh --plan FILE is required');
    const held = preview.decisions.find(d => d.decision === 'Hold' && d.holdCode);
    if (held) throw Error(held.reason);
    expected = parseUniqueJson(readPlainFile(planFile));
    const age = now() - Date.parse(expected.observedAt);
    if (!Number.isFinite(age) || age < 0 || age > 60000 || expected.workspace !== workspace ||
        expected.selectionDigest !== selectionDigest(expected) || expected.selectionDigest !== selectionDigest(preview)) throw Error('saved plan is stale or has drifted');
    if (preview.action) safeStandard(preview.action.operation ??
      (preview.action.kind === 'lifecycle' ? { participants: preview.decisions.filter(d => d.action).map(d => ({ spec: d.desired.spec })) } : preview.action));
  } catch (error) { return refused(error); }
  const inputs = planInputs(options), { inspection } = inputs, { project } = inspection;
  const read = async () => {
    const data = await inputs.read();
    try {
      checkAuthorization({ file: authorization, project, workspace, env, now });
      const current = inspect(options);
      if (!current.valid || digest(current.entries) !== digest(inspection.entries)) throw Error('desired manifests changed during apply');
    } catch (error) { data.facts.errors.push(error.message); }
    return data;
  };
  const permit = op => {
    const age = now() - Date.parse(expected.observedAt);
    if (age < 0 || age > 60000) throw Error('selected plan expired before the physical action');
    const action = op.kind === 'start-standard-slot' ? { kind: op.kind } : { kind: 'lifecycle', stage:
      ({ 'close-intent': 'close', 'respawn-intent': 'respawn', 'resume-intent': 'resume', 'inbox-intent': 'transfer' })[op.state] };
    const receipt = checkAuthorization({ file: authorization, project, workspace, action, env, now });
    if (['server', 'workspace', 'checkout'].some(k => op.target[k] !== receipt.workspace[k])) throw Error('action target differs from authorized workspace');
    const facts = (options.readFacts ?? readSessionFacts)({ project, env });
    if (facts.stopped || facts.closeHold || facts.errors.length) throw Error('STOP, close hold or unreadable current facts; action withheld');
    const current = inspect(options);
    if (!current.valid || digest(current.entries) !== digest(inspection.entries)) throw Error('desired manifests drifted before action');
    if (op.kind !== 'start-standard-slot') {
      const experiment = experimentEvidence(options.evidence, project, receipt.workspace);
      if (!experiment) throw Error('current lifecycle experiment evidence required');
      const entry = current.entries.find(e => e.manifest.metadata.uid === op.uid);
      const veto = lifecycleEdgeVeto(entry, { inspection: current, env,
        facts: { ...facts, quiescence: experiment.quiescence },
        observation: { agents: [], viewers: [], losses: experiment.losses } }, op);
      if (veto) throw Error(veto);
    }
  };
  try {
    const bound = enrolledWorkspace(project, workspace), experiment = experimentEvidence(options.evidence, project, bound);
    const actions = createLiveActions({ project, workspace, authorization, env, permit, observe: async () => (await inputs.read()).observation, inbox: experiment?.inbox });
    const result = await reconcileOnce({ inspection, read, actions, approvePlan: fresh => {
      checkAuthorization({ file: authorization, project, workspace, action: fresh.action, env, now });
      if (selectionDigest(fresh) !== expected.selectionDigest) throw Error('selected plan drifted under the controller lease');
    } });
    const rejection = result.errors?.length ? result.errors.join('; ') : result.decision === 'Hold' ? result.reason :
      result.decisions?.find(d => d.decision === 'Hold' && d.holdCode)?.reason;
    return { ...result, apply: { state: result.attemptedOperation ? 'attempted' : rejection ? 'refused' : 'observed',
      ...(rejection ? { reason: rejection } : {}) } };
  } finally { inputs.close(); }
}
