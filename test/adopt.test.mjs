import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { configFixture } from './helpers/config-home-fixture.mjs';
import { adopt, adoptCommand } from '../lib/adopt-command.mjs';
import { readConfigJSON, policyLocation } from '../lib/config-home.mjs';
import { releaseAcceptance, checkRelease } from '../lib/releases.mjs';
import { readControllerJournal } from '../sessions/runtime.mjs';
import { readStandardSlots } from '../sessions/receipts.mjs';
import { validLaunchReceipt } from '../sessions/lifecycle-evidence.mjs';
import { authorize, ACTIONS } from '../sessions/authorization.mjs';
import { plan } from '../sessions/plan.mjs';
import { plan as setupPlan } from '../setup/setup.mjs';
import { digest } from '../lib/digest.mjs';
import { initOrg } from '../lib/store.mjs';

async function command(argv, options) {
  const stdout = process.stdout.write, output = [];
  process.stdout.write = text => { output.push(String(text)); return true; };
  try { await adoptCommand(argv, options); } finally { process.stdout.write = stdout; }
  return JSON.parse(output.join(''));
}

for (const compatible of [false, true]) test(`adoption checks and records the frozen project pin when its READY bundle is ${compatible ? 'compatible' : 'incompatible'}`, async t => {
  const f = configFixture(t), pinned = f.release('pinned', { compatible });
  assert.equal(releaseAcceptance(checkRelease(f.installationHome, 'pinned'), f.installationHome).ready, true);
  fs.writeFileSync(path.join(f.cwd, '.herdr-release.json'), '{"release":"pinned"}\n');
  f.git('add', '.herdr-release.json'); f.git('commit', '-qm', 'accept project pin');
  f.scope = await f.capture(); f.decision = f.question(f.scope.scope);
  const events = f.events();
  if (!compatible) {
    await assert.rejects(f.adopt(), /incompatible downgrade: pinned/);
    assert.deepEqual(f.events(), events);
    for (const file of ['.brain', '.git/sessions/standard-slots.json', '.git/sessions/controller-journal.json']) assert.equal(fs.existsSync(path.join(f.cwd, file)), false);
    assert.equal(fs.existsSync(path.join(f.home, '.herdr-monitor')), false);
  } else {
    await f.adopt();
    assert.equal(f.binding().compatible_release.root, pinned);
    assert.equal(f.binding().compatible_release.commit, '2'.repeat(40));
    assert.equal(f.events().find(e => e.type === 'config.adopted').compatible_release.root, pinned);
    assert.equal(readConfigJSON(policyLocation(f.cwd, 'pin').file).release, 'pinned');
    assert.equal(fs.realpathSync(path.join(f.installationHome, 'current')), f.bundle);
  }
});

test('the documented capture-then-execute commands retain saved standalone routing and refuse conflicting new arguments', async t => {
  const f = configFixture(t, { routing: true });
  const captured = await command(['.', '--inspect', '--routing', 'routing.json', '--expires', new Date(Date.now() + 3600000).toISOString()], f.options);
  const decision = f.question(captured.scope), args = ['.', '--scope', captured.scopeFile, '--decision', `${decision.id}:${decision.seq}`];
  const events = f.events();
  await assert.rejects(command([...args, '--routing', '.lane.json'], f.options), /routing argument conflicts with the saved scope/);
  assert.deepEqual(f.events(), events); assert.equal(fs.existsSync(path.join(f.cwd, '.brain')), false);
  const adopted = await command(args, f.options);
  assert.equal(adopted.adopted, true);
  assert.equal(f.binding().sources.routing.path, path.join(f.cwd, 'routing.json'));
  assert.equal(fs.readFileSync(policyLocation(f.cwd, 'routing').file, 'utf8'), fs.readFileSync(path.join(f.cwd, 'routing.json'), 'utf8'));
});

for (const [custom, name] of [[false, 'p'], ['p', 'project'], ['p', 'fleet.json']]) test(`binding metadata discovers accepted identity/project names ${custom || 'default'}/${name}`, async t => {
  const f = configFixture(t, { custom });
  // Legacy installation entries without binding metadata remain ignorable.
  if (!custom) fs.mkdirSync(path.join(f.home, '.herdr-monitor/p/legacy-install'), { recursive: true });
  fs.mkdirSync(path.join(f.home, '.herdr-monitor'), { recursive: true });
  const legacyFleet = path.join(f.scratch, 'legacy-fleet.json');
  fs.writeFileSync(legacyFleet, '{"version":1,"session_limit":6,"projects":{}}');
  fs.symlinkSync(legacyFleet, path.join(f.home, '.herdr-monitor/fleet.json'));
  await f.adopt({ name });
  assert.equal(f.binding().project, name);
  assert.equal(fs.realpathSync(path.join(f.cwd, '.brain')), f.binding().directory);
  assert.equal(readStandardSlots(path.join(f.cwd, '.git')).slots.length, 1);
});

test('native owner authorization yields KEEP without synthetic launch evidence, and a second adoption changes no bytes/events', async t => {
  const f = configFixture(t); await f.adopt();
  const common = path.join(f.cwd, '.git'), journal = readControllerJournal(common), op = journal.operations[0];
  assert.equal(op.kind, 'adopt-standard-slot'); assert.equal(op.origin, 'observed-adoption');
  assert.equal(op.receipt, undefined); assert.equal(validLaunchReceipt(op, { binding: op.binding }), false);
  assert.equal(readStandardSlots(common).slots.length, 1);
  const planned = await plan({ cwd: f.cwd, observer: f.observer, env: f.env });
  assert.equal(planned.decisions.find(d => d.uid === op.uid).decision, 'KEEP');
  const setup = await setupPlan({ cwd: f.cwd, observer: f.observer, env: f.env, home: f.installationHome });
  assert.ok(!JSON.stringify(setup.changes.find(c => c.uid === op.uid)).includes('workspace-not-enrolled'));
  const files = [f.binding().file, path.join(common, 'sessions/controller-journal.json'), path.join(common, 'sessions/standard-slots.json')];
  const bytes = files.map(file => fs.readFileSync(file, 'utf8')), count = f.events().length;
  const again = await f.adopt({ now: () => Date.now() + 7200000 });
  assert.equal(again.unchanged, true); assert.equal(f.events().length, count);
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), bytes);
  assert.throws(() => authorize({ cwd: f.cwd, workspace: 'home', actions: ['start-standard-slot'], role: 'supervisor', actor: 'fixture-supervisor', env: f.env,
    operatorDecision: f.decision, expiresAt: new Date(Date.now() + 3600000).toISOString() }), /session_authorization/);
  const scope = { schema: 'session-authorization-scope/v1', common, server: f.observation.server, workspace: 'workspace', checkout: f.cwd, actions: ACTIONS };
  const decision = f.question(scope, 'session_authorization');
  assert.equal(authorize({ cwd: f.cwd, workspace: 'home', actions: ['start-standard-slot'], role: 'supervisor', actor: 'fixture-supervisor', env: f.env,
    operatorDecision: decision, expiresAt: new Date(Date.now() + 3600000).toISOString() }).receipt.actions[0], 'start-standard-slot');
});

for (const boundary of ['afterPublish', 'afterIntent', 'afterKeep']) test(`adoption resumes ${boundary} without duplicating durable enrollment`, async t => {
  const f = configFixture(t); let interrupted = false;
  await assert.rejects(f.adopt({ [boundary]() { if (!interrupted) { interrupted = true; throw Error('fixture interrupted'); } } }), /fixture interrupted/);
  await f.adopt();
  const journal = readControllerJournal(path.join(f.cwd, '.git'));
  assert.equal(journal.operations.length, 1); assert.equal(journal.operations[0].state, 'acknowledged');
  assert.equal(readStandardSlots(path.join(f.cwd, '.git')).slots.length, 1);
  assert.equal(f.events().filter(e => e.type === 'config.adopted').length, 1);
});

for (const negative of ['foreign-common', 'linked-workspace', 'extra-pane', 'changed-session', 'pane-checkout', 'agent-answer', 'STOP']) test(`native enrollment refuses ${negative}`, async t => {
  const f = configFixture(t); f.scope = await f.capture(); f.decision = f.question(f.scope.scope, 'adoption_authorization', negative === 'agent-answer' ? 'agent' : 'human');
  if (negative === 'foreign-common') f.observation.workspaces[0].worktree.repo_key = path.join(f.scratch, 'foreign/.git');
  if (negative === 'linked-workspace') f.observation.workspaces[0].worktree.is_linked_worktree = true;
  if (negative === 'extra-pane') f.observation.panes.push({ ...f.observation.panes[0], pane_id: 'extra', terminal_id: 'extra-terminal' });
  if (negative === 'changed-session') f.observation.agents[0].agent_session.value = 'changed';
  if (negative === 'pane-checkout') f.observation.panes[0].foreground_cwd = f.scratch;
  if (negative === 'STOP') fs.writeFileSync(path.join(f.env.ORG_DIR, 'STOP'), 'stop');
  await assert.rejects(f.adopt(), /held|scope|human|STOP/);
  assert.equal(fs.existsSync(path.join(f.cwd, '.git/sessions/standard-slots.json')), false);
});

test('linked invocation, tracked links and prepared committed-policy edits cannot adopt', async t => {
  const f = configFixture(t), lane = path.join(f.scratch, 'lane'); f.git('worktree', 'add', '-qb', 'lane/work', lane);
  await assert.rejects(adopt({ ...f.options, cwd: lane, project: '.' }), /canonical checkout/);
  fs.writeFileSync(path.join(f.cwd, '.promote.json'), '{"max_batch":99}');
  await assert.rejects(f.capture(), /prepared promote edit/);
  f.git('checkout', '--', '.promote.json');
  fs.writeFileSync(path.join(f.cwd, '.brain'), 'tracked'); f.git('add', '.brain'); f.git('commit', '-qm', 'tracked conflict');
  await assert.rejects(f.capture(), /tracked|conflicting/);
});

test('an explicitly selected missing routing source refuses scope capture', async t => {
  const f = configFixture(t, { routing: true }); fs.unlinkSync(path.join(f.cwd, 'routing.json'));
  await assert.rejects(f.capture(), /explicitly selected routing source is missing/);
});

test('an ambient foreign record cannot replace the existing owning record in adoption scope', async t => {
  const f = configFixture(t), foreign = path.join(f.scratch, 'foreign-record'); initOrg(foreign);
  await assert.rejects(adopt({ ...f.options, env: { ...f.env, ORG_DIR: foreign }, inspectOnly: true, expiresAt: new Date(Date.now() + 3600000).toISOString() }), /ORG_DIR differs from the existing owning record/);
  assert.equal(fs.existsSync(path.join(f.cwd, '.brain')), false);
});

test('completed adoption rejects a replacement scope and cannot hide a pending controller intent', async t => {
  const f = configFixture(t); await f.adopt();
  const scope = { ...f.scope.scope, requester: 'a different later request' };
  const scopeFile = path.join(f.cwd, '.git/config-home/scopes', `${digest(scope)}.json`);
  fs.writeFileSync(scopeFile, JSON.stringify(scope));
  await assert.rejects(f.adopt({ scopeFile, decision: f.question(scope) }), /scope differs from the original binding/);
  const common = path.join(f.cwd, '.git'), journal = readControllerJournal(common), file = path.join(common, 'sessions/controller-journal.json');
  journal.operations.push({ ...journal.operations[0], id: 'pending-other', uid: 'pending-other', state: 'intent' });
  fs.writeFileSync(file, JSON.stringify(journal)); const before = fs.readFileSync(file, 'utf8');
  await assert.rejects(f.adopt(), /pending controller operation/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(f.events().filter(e => e.type === 'config.adopted').length, 1);
});
