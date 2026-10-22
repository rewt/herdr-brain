// Foreground setup facade. Application composes the authorized session controller.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { findOrgDir, loadEvents } from '../lib/store.mjs';
import { bundleRelease, projectPin, releaseHome, selectRelease } from '../lib/releases.mjs';
import { inspect } from '../sessions/sessions.mjs';
import { parseUniqueJson } from '../sessions/json.mjs';
import { plan as sessionPlan } from '../sessions/plan.mjs';
import { createHerdrObserver } from '../sessions/observe.mjs';
import { herdrSocketPath } from '../lanes/board/herdr-client.mjs';
import { loadDiscoveredRoutes } from '../lanes/routes.mjs';
import { resolveValidation, validateValidation, fenceDeclaredMode } from '../lanes/validation.mjs';
import { readPlainFile } from '../lib/files.mjs';
import { apply as sessionApply } from '../sessions/apply.mjs';
import { checkAuthorization } from '../sessions/authorization.mjs';
import { readControllerJournal } from '../sessions/runtime.mjs';
import { digest } from '../sessions/lifecycle-evidence.mjs';

const product = fileURLToPath(new URL('../', import.meta.url));
const expectedNode = fs.readFileSync(path.join(product, '.nvmrc'), 'utf8').trim();
const reason = (code, message) => ({ code, message });
const check = (name, observed, reasons = [], state = 'held') => ({ name, state: reasons.length ? state : 'ok', observed, reasons });
const lifecyclePending = d => d.lifecycleRequested || d.lifecycleUpdate || (d.action ?? d.deferredAction)?.kind === 'lifecycle';

// Requirements describe the existing launch seam, never native enforcement.
export function capabilityHolds(entry) {
  const s = entry.resolvedSpec, reasons = [];
  if (s.role === 'logs-triage' || s.viewer === 'project-triage-status')
    reasons.push(reason('activation-unavailable', 'Triage activation is not supported by the standard-slot adapter.'));
  if (s.intent.kind === 'work-item')
    reasons.push(reason('external-launch-owner', 'Worker and reviewer launches belong to dispatch and settle.'));
  if (entry.manifest.kind !== 'Session') return reasons;
  if (!['codex', 'claude'].includes(s.resolvedRoute.kind))
    reasons.push(reason('harness-unavailable', `Standard sessions require a supported native harness: ${s.resolvedRoute.kind}.`));
  if (s.permissions.profileRef !== 'identity-default')
    reasons.push(reason('native-profile-unverified', `Native enforcement of profile ${s.permissions.profileRef} is not available in the standard-slot adapter.`));
  if (s.memory.claudeMem?.mode === 'required')
    reasons.push(reason('required-memory-unavailable', 'Required native memory enforcement is unavailable.'));
  const materialized = ['identity-instructions', 'project-cold-start', 'supervisor-protocol', 'file', 'product-file'];
  for (const c of s.context) if (c.required && !materialized.includes(c.source))
    reasons.push(reason('context-unavailable', `Required context materializer unavailable for ${c.source}.`));
  return reasons;
}

function localChecks({ cwd, workspace, env, home, nodeVersion }) {
  fenceDeclaredMode(cwd, { env });
  const checks = [check('node', { actual: nodeVersion, required: expectedNode }, nodeVersion === expectedNode ? []
    : [reason('node-version', `Use the pinned Node ${expectedNode}.`)])];
  let inspection = null;
  try {
    inspection = inspect({ cwd, workspace, env });
    checks.push(check('project', inspection.project));
    checks.push(check('manifests', { valid: inspection.valid, workspaces: inspection.workspaces,
      diagnostics: inspection.diagnostics, routeFiles: inspection.routeFiles, suggestedRoutes: inspection.suggestedRoutes },
    inspection.valid ? [] : [reason('invalid-manifests', 'Fix invalid desired manifests before planning actions.')]));
  } catch (error) { checks.push(check('project', null, [reason('project-unavailable', error.message)])); }
  if (!inspection) return { checks, inspection };
  const { project } = inspection;
  try {
    const org = findOrgDir({ cwd: project.root, env });
    if (!org) throw Error('No project record found; the owner must establish its record location.');
    const loaded = loadEvents(org);
    if (loaded.tornTail) throw Error('Project record has an incomplete tail.');
    checks.push(check('record', { path: fs.realpathSync(org), events: loaded.events.length }));
  } catch (error) { checks.push(check('record', null, [reason('record-unavailable', error.message)])); }
  try {
    const routes = loadDiscoveredRoutes({ cwd: project.root, env });
    const config = {}, sources = {};
    // The routing loader exposes the existing canonical layer order, but its
    // merged config intentionally contains only routing-owned fields.
    for (const file of routes.files) {
      const layer = parseUniqueJson(fs.readFileSync(file, 'utf8'));
      if (layer.validation !== undefined) validateValidation(layer.validation);
      for (const key of ['validation', 'validate']) if (Object.hasOwn(layer, key)) { config[key] = layer[key]; sources[key] = file; }
    }
    const validation = resolveValidation({ root: project.root, config, sources, env });
    checks.push(check('profiles', { routeProfileRef: 'project-default', routeFiles: routes.files,
      suggestedRoutes: Boolean(routes.suggested), validationProfileRef: 'project-default', validation }));
  } catch (error) { checks.push(check('profiles', null, [reason('profiles-unavailable', error.message)])); }
  let pin = null;
  try {
    pin = projectPin(project.root);
    checks.push(check('release', { pin: pin?.release ?? null, pinCommit: pin?.config_commit ?? null,
      selected: selectRelease(project.root, home), executing: bundleRelease() }));
  } catch (error) { checks.push(check('release', { pin: pin?.release ?? null, executing: bundleRelease() },
    [reason('release-unavailable', error.message)])); }
  const sessions = inspection.entries.filter(e => e.manifest.kind === 'Session').map(e => e.manifest.metadata.uid);
  checks.push(check('native-trust', { sessions, verified: false }, sessions.length ? [reason('native-trust-unverified',
    'Native project trust and authentication cannot be verified by this read-only interface. The project owner must verify them in the native harness before launch; manifest assertions are not proof.')] : [], 'advisory'));
  const requirements = inspection.entries.map(e => ({ uid: e.manifest.metadata.uid, reasons: capabilityHolds(e) }));
  checks.push(check('capabilities', requirements, requirements.flatMap(e => e.reasons.map(r => ({ ...r, uid: e.uid })))));
  return { checks, inspection };
}

export async function doctor({ cwd = process.cwd(), workspace = 'home', env = process.env, home = releaseHome(),
  nodeVersion = process.versions.node, observer } = {}) {
  const { checks, inspection } = localChecks({ cwd, workspace, env, home, nodeVersion });
  const owned = !observer;
  observer ??= createHerdrObserver({ socketPath: herdrSocketPath(env) });
  let observation;
  try {
    observation = await observer.observe();
    checks.push(check('herdr', { server: observation.server, complete: observation.complete },
      observation.complete && !observation.errors?.length ? [] : [reason('herdr-unavailable',
        observation.errors?.join('; ') || 'Incomplete Herdr snapshot.')]));
  } catch (error) { checks.push(check('herdr', null, [reason('herdr-unavailable', error.message)])); }
  finally { if (owned) observer.close(); }
  return { schema: 'project-setup-doctor/v1', outcome: checks.some(c => c.state === 'held') ? 'held' : 'ready',
    project: inspection?.project ?? null, checks };
}

export async function plan(options = {}) {
  const diagnosis = await doctor(options);
  if (!diagnosis.project) return { schema: 'project-setup-plan/v1', outcome: 'refused', doctor: diagnosis, changes: [] };
  // The existing planner owns canonical enrollment, foreign/manual protection,
  // journals, brakes, and incarnation evidence. It only observes here.
  let preview;
  try { preview = await sessionPlan(options); }
  catch (error) { return { schema: 'project-setup-plan/v1', outcome: 'refused', doctor: diagnosis,
    reasons: [reason('plan-unavailable', error.message)], changes: [] }; }
  const globalHolds = diagnosis.checks.filter(c => c.state === 'held' && c.name !== 'capabilities').flatMap(c => c.reasons);
  const trust = diagnosis.checks.find(c => c.name === 'native-trust');
  const changes = preview.decisions.map(d => {
    const kind = d.desired.spec.viewer ? 'LogViewer' : 'Session';
    const reasons = [...globalHolds, ...capabilityHolds({ manifest: { kind }, resolvedSpec: d.desired.spec })];
    const advisories = kind === 'Session' ? (trust?.reasons.length ? trust.reasons : [reason('native-trust-unverified',
      'Native project trust and authentication require owner verification before launch.')]) : [];
    const keep = ['KEEP', 'NoOp'].includes(d.decision) && ['Running', 'ParkedAwaitingReview'].includes(d.phase) && !d.action;
    const action = d.action ?? d.deferredAction;
    const lifecycle = lifecyclePending(d);
    const operation = lifecycle ? 'lifecycle' : action?.kind ?? null;
    const actionable = ['create-standard-slot', 'start-standard-slot'].includes(operation);
    const skip = d.decision === 'Observe' && d.reason === 'creation unsupported: logs layout awaits triage activation';
    // Preserve proven live incarnations while reporting capability holds.
    return { uid: d.uid, workspaceRef: d.desired.spec.workspaceRef, role: d.desired.spec.role,
      standardSlot: d.desired.spec.standardSlot ?? null, paneSlot: d.desired.spec.paneSlot ?? 'primary',
      generation: d.desired.generation, specDigest: d.desired.specDigest,
      outcome: lifecycle ? 'refuse' : keep ? 'keep' : skip && !globalHolds.length ? 'skip' : actionable && !reasons.length
        ? operation === 'create-standard-slot' ? 'create' : 'start' : 'refuse',
      operation, target: action?.target ?? d.observed?.binding ?? null,
      reasons: lifecycle ? [reason('lifecycle-action-out-of-scope', 'Workspace apply never performs lifecycle actions.')] :
        [...(skip ? globalHolds : reasons), ...(!keep && !skip && !actionable ? [reason(d.phase === 'NotEnrolled' ? 'workspace-not-enrolled' : 'session-held', d.reason)] : [])],
      advisories,
      observed: { phase: d.phase, decision: d.decision, reason: d.reason } };
  });
  return { schema: 'project-setup-plan/v1', outcome: !preview.valid ? 'refused' :
    globalHolds.length || preview.errors.length || changes.some(c => c.outcome === 'refuse' || c.outcome === 'keep' && c.reasons.length) ? 'held' :
      changes.some(c => ['create', 'start'].includes(c.outcome)) ? 'planned' : 'unchanged',
    project: preview.project, doctor: diagnosis, diagnostics: preview.diagnostics, errors: preview.errors,
    changes, observedAt: preview.observedAt };
}

// No durable setup state. Every step uses the existing lease, journal, adapter
// and context receipts; the saved preview bounds the entire invocation.
export async function apply(options = {}) {
  const workspace = options.workspace ?? 'home', now = options.now ?? Date.now;
  options = { ...options, workspace };
  const preview = await plan(options);
  const result = { ...preview, schema: 'project-setup-apply/v1', workspace,
    observedAt: new Date(now()).toISOString(), digest: digest(preview.changes), steps: [] };
  const stop = (code, message, uid = null, operation = null, operationId = null, state = 'refused') => {
    result.outcome = state === 'held' ? 'held' : state === 'stopped' ? 'stopped' : 'refused';
    result.steps.push({ uid, operation, operationId, state, reason: `${code}: ${message}` });
    return result;
  };
  if (!options.execute) return result;
  const refusal = preview.changes.find(c => c.operation === 'lifecycle') ??
    preview.changes.find(c => c.reasons.some(r => r.message.includes('unowned live occupant'))) ?? preview.changes.find(c => c.outcome === 'refuse');
  if (refusal) return stop(refusal.reasons[0]?.code ?? 'session-held',
    refusal.reasons.map(r => r.message).join('; '), refusal.uid, refusal.operation);
  if (['held', 'refused'].includes(preview.outcome)) return stop('setup-held', JSON.stringify(preview.reasons ?? preview.errors ?? preview.doctor));
  let expected;
  try {
    if (!options.planFile) throw Error('a fresh --plan DRYRUN.json is required');
    expected = parseUniqueJson(readPlainFile(options.planFile));
    const age = now() - Date.parse(expected.observedAt);
    if (expected.schema !== result.schema || expected.workspace !== workspace || digest(expected.project) !== digest(result.project) ||
        !Array.isArray(expected.steps) || expected.steps.length || !['planned', 'unchanged'].includes(expected.outcome) ||
        !Number.isFinite(age) || age < 0 || age > 60000 || expected.digest !== digest(expected.changes) || expected.digest !== result.digest)
      throw Error('saved dry run is stale or has drifted');
    checkAuthorization({ file: options.authorization, project: preview.project, workspace, env: options.env, now });
    for (const c of expected.changes.filter(c => ['create', 'start'].includes(c.outcome))) {
      const receipt = checkAuthorization({ file: options.authorization, project: preview.project, workspace, action: { kind: c.operation }, env: options.env, now });
      if (['server', 'workspace', 'checkout'].some(k => c.target?.[k] !== receipt.workspace[k])) throw Error('plan action target differs from authorized workspace');
    }
  } catch (error) { return stop('apply-refused', error.message); }
  const allowed = new Map(expected.changes.filter(c => ['create', 'start'].includes(c.outcome)).map(c => [c.uid, c]));
  const attempted = new Set();
  for (let n = 0; n < expected.changes.length; n++) {
    let fresh;
    try { fresh = await sessionPlan(options); }
    catch (error) { return stop('plan-unavailable', error.message); }
    const lifecycle = fresh.decisions.find(lifecyclePending);
    if (lifecycle) return stop('lifecycle-action-out-of-scope', lifecycle.reason, lifecycle.uid, 'lifecycle', null, 'stopped');
    const held = fresh.decisions.find(d => d.decision === 'Hold' || d.phase === 'NotEnrolled');
    if (held || fresh.errors.length || !fresh.valid) return stop('session-held', held?.reason ?? fresh.errors.join('; '), held?.uid, null, null, 'held');
    const action = fresh.action;
    if (!action) { result.outcome = result.steps.length ? 'applied' : 'unchanged'; return result; }
    const original = allowed.get(action.uid);
    if (!original || attempted.has(action.uid) || !['create-standard-slot', 'start-standard-slot'].includes(action.kind) || action.kind !== original.operation ||
        action.specDigest !== original.specDigest || action.generation !== original.generation)
      return stop('plan-drift', 'action was not a create or start row in the saved dry run', action.uid, action.kind, null, 'stopped');
    let step;
    attempted.add(action.uid);
    try { step = await sessionApply({ ...options, savedPlan: fresh }); }
    catch (error) { return stop('adapter-error', error.message, action.uid, action.kind, null, 'stopped'); }
    const operationId = step.attemptedOperation ?? null;
    const lifecycleStep = step.decisions?.find(lifecyclePending);
    if (lifecycleStep) return stop('lifecycle-action-out-of-scope', lifecycleStep.reason, lifecycleStep.uid, 'lifecycle', operationId, 'stopped');
    if (!operationId && step.apply.state === 'refused' && /drift|manifests changed/u.test(step.apply.reason ?? ''))
      return stop('plan-drift', step.apply.reason, action.uid, action.kind, null, 'stopped');
    const op = operationId && readControllerJournal(preview.project.common).operations.find(op => op.id === operationId);
    if (step.adapterError || step.apply.state === 'refused' || !op || op.state !== 'acknowledged')
      return stop(step.adapterError ? 'adapter-error' : 'operation-unacknowledged',
        step.adapterError ?? step.apply.reason ?? 'operation has no exact acknowledgement', action.uid, action.kind, operationId, 'stopped');
    result.steps.push({ uid: action.uid, operation: action.kind, operationId, state: op.state, reason: 'exact adapter receipt acknowledged' });
  }
  // Each step consumes a unique saved row, so the loop can never grow with a
  // moving manifest. A final read proves completion without another apply.
  let final;
  try { final = await sessionPlan(options); }
  catch (error) { return stop('plan-unavailable', error.message, null, null, null, 'stopped'); }
  const lifecycle = final.decisions.find(lifecyclePending);
  if (lifecycle) return stop('lifecycle-action-out-of-scope', lifecycle.reason, lifecycle.uid, 'lifecycle', null, 'stopped');
  if (final.action || final.errors.length || final.decisions.some(d => d.decision === 'Hold' || d.phase === 'NotEnrolled'))
    return stop('plan-drift', 'workspace did not converge within the saved desired entries', null, null, null, 'stopped');
  result.outcome = result.steps.length ? 'applied' : 'unchanged';
  return result;
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    project: { type: 'string', default: process.cwd() }, workspace: { type: 'string', default: 'home' },
    execute: { type: 'boolean' }, authorization: { type: 'string' }, plan: { type: 'string' }, evidence: { type: 'string' },
  }, usage: 'Usage: node setup/setup.mjs doctor|plan|apply [--project PATH] [--workspace REF]\napply is a dry run by default; --execute --authorization FILE --plan DRYRUN.json [--evidence FILE] creates or starts missing standard sessions.' });
  if (positionals.length !== 1 || !['doctor', 'plan', 'apply'].includes(positionals[0])) throw Error('expected doctor, plan or apply');
  if (positionals[0] !== 'apply' && ['execute', 'authorization', 'plan', 'evidence'].some(k => values[k] !== undefined)) throw Error('execute, authorization, plan and evidence are apply options only');
  const result = await ({ doctor, plan, apply })[positionals[0]]({ cwd: values.project, workspace: values.workspace,
    execute: values.execute, authorization: values.authorization, planFile: values.plan, evidence: values.evidence });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (['held', 'refused', 'stopped'].includes(result.outcome)) process.exitCode = 1;
}
if (isMain(import.meta.url)) main().catch(error => { process.stderr.write(`setup: ${error.message}\n`); process.exitCode = 1; });
