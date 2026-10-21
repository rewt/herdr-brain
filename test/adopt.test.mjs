import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { configFixture } from './helpers/config-home-fixture.mjs';
import { adopt } from '../lib/adopt-command.mjs';
import { readControllerJournal } from '../sessions/runtime.mjs';
import { readStandardSlots } from '../sessions/receipts.mjs';
import { validLaunchReceipt } from '../sessions/lifecycle-evidence.mjs';
import { authorize, ACTIONS } from '../sessions/authorization.mjs';
import { plan } from '../sessions/plan.mjs';
import { plan as setupPlan } from '../setup/setup.mjs';
import { digest } from '../lib/digest.mjs';

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
