// Foreground, read-only adoption facade. No mutation adapter or setup writer.
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
import { resolveValidation, validateValidation } from '../lanes/validation.mjs';

const product = fileURLToPath(new URL('../', import.meta.url));
const expectedNode = fs.readFileSync(path.join(product, '.nvmrc'), 'utf8').trim();
const reason = (code, message) => ({ code, message });
const check = (name, observed, reasons = [], state = 'held') => ({ name, state: reasons.length ? state : 'ok', observed, reasons });

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
    const create = d.decision === 'WouldStart' && d.action?.kind === 'start-standard-slot';
    // Preserve proven live incarnations while reporting capability holds.
    return { uid: d.uid, workspaceRef: d.desired.spec.workspaceRef, role: d.desired.spec.role,
      standardSlot: d.desired.spec.standardSlot ?? null, paneSlot: d.desired.spec.paneSlot ?? 'primary',
      outcome: keep ? 'keep' : create && !reasons.length ? 'create' : 'refuse',
      operation: create ? 'start-standard-slot' : null, target: d.action?.target ?? d.observed?.binding ?? null,
      reasons: [...reasons, ...(!keep && !create ? [reason(d.phase === 'NotEnrolled' ? 'workspace-not-enrolled' : 'session-held', d.reason)] : [])],
      advisories,
      observed: { phase: d.phase, decision: d.decision, reason: d.reason } };
  });
  return { schema: 'project-setup-plan/v1', outcome: !preview.valid ? 'refused' :
    diagnosis.outcome === 'held' || preview.errors.length || changes.some(c => c.outcome === 'refuse') ? 'held' :
      changes.some(c => c.outcome === 'create') ? 'planned' : 'unchanged',
    project: preview.project, doctor: diagnosis, diagnostics: preview.diagnostics, errors: preview.errors,
    changes, observedAt: preview.observedAt };
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    project: { type: 'string', default: process.cwd() }, workspace: { type: 'string', default: 'home' },
  }, usage: 'Usage: node setup/setup.mjs doctor|plan [--project PATH] [--workspace REF]\nRead-only prerequisite checks and create/keep/refuse preview. No init or apply.' });
  if (positionals.length !== 1 || !['doctor', 'plan'].includes(positionals[0])) throw Error('expected doctor or plan; no init or apply is available');
  const result = await (positionals[0] === 'doctor' ? doctor : plan)({ cwd: values.project, workspace: values.workspace });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (['held', 'refused'].includes(result.outcome)) process.exitCode = 1;
}
if (isMain(import.meta.url)) main().catch(error => { process.stderr.write(`setup: ${error.message}\n`); process.exitCode = 1; });
