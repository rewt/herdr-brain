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
import { readSessionFacts } from '../sessions/observe.mjs';
import { canonicalProject } from '../sessions/project.mjs';

async function command(argv, options) {
  const stdout = process.stdout.write, output = [];
  process.stdout.write = text => { output.push(String(text)); return true; };
  try { await adoptCommand(argv, options); } finally { process.stdout.write = stdout; }
  return JSON.parse(output.join(''));
}

for (const spelling of ['relative', 'symlink']) test(`adopt canonicalizes a ${spelling} scope argument before publishing its binding`, async t => {
  const f = configFixture(t);
  f.scope = await f.capture(); f.decision = f.question(f.scope.scope);
  let scopeFile = f.scope.scopeFile;
  if (spelling === 'symlink') {
    const alias = path.join(f.cwd, '.git/scope-alias.json');
    fs.symlinkSync(scopeFile, alias); scopeFile = alias;
  }
  const result = await command(['.', '--scope', path.relative(f.cwd, scopeFile), '--decision', `${f.decision.id}:${f.decision.seq}`], f.options);
  assert.equal(result.adopted, true);
  const binding = f.binding();
  assert.equal(binding.adoption.scope_file, fs.realpathSync(scopeFile));
  assert.equal(f.events().find(e => e.type === 'config.adopted').scope, binding.adoption.scope_file);
  assert.ok(binding.adoption.completed);
  assert.equal(readStandardSlots(binding.common).slots.length, 1);
});

test('routing aliases and nonexistent worktree destinations freeze canonical paths without changing policy bytes', async t => {
  const f = configFixture(t, { custom: true, routing: true });
  const routing = path.join(f.cwd, 'routing.json'), alias = path.join(f.cwd, '.git/routing-alias.json');
  fs.symlinkSync(routing, alias);
  const destination = path.join(f.scratch, 'actual-worktrees'); fs.mkdirSync(destination);
  fs.symlinkSync(destination, path.join(f.ownerRoot, 'worktree-alias'));
  const parent = path.join(f.ownerRoot, '.lane.json'), defaults = readConfigJSON(parent);
  fs.writeFileSync(parent, JSON.stringify({ ...defaults, worktree_root: 'worktree-alias/future' }));
  const captured = await command(['.', '--inspect', '--routing', '.git/routing-alias.json', '--expires', new Date(Date.now() + 3600000).toISOString()], f.options);
  const decision = f.question(captured.scope);
  await command(['.', '--scope', captured.scopeFile, '--routing', '.git/routing-alias.json', '--decision', `${decision.id}:${decision.seq}`], f.options);
  const binding = f.binding();
  assert.equal(binding.sources.routing.path, routing);
  assert.equal(binding.sources.routing.base, f.cwd);
  assert.equal(binding.worktrees, path.join(destination, 'future/project'));
  assert.equal(fs.existsSync(binding.worktrees), false);
  assert.equal(fs.readFileSync(policyLocation(f.cwd, 'routing').file, 'utf8'), fs.readFileSync(routing, 'utf8'));
});

for (const [field, inject, message] of [
  ['binding', ({ binding }) => { binding.worktrees = 'relative'; }, /invalid config-home-project\/v1 binding/],
  ['identity metadata', ({ defaults }) => { defaults.identity_root = 'relative'; }, /identity_root must be a canonical absolute directory/],
  ['identity policy', ({ defaults }) => { defaults.dispatch = { max_sessions: 0 }; }, /max_sessions/],
]) test(`an injected invalid assembled ${field} refuses before any home file or config intent`, async t => {
  const f = configFixture(t);
  f.scope = await f.capture(); f.decision = f.question(f.scope.scope);
  const events = f.events();
  await assert.rejects(f.adopt({ beforePublish: inject }), message);
  assert.deepEqual(f.events(), events);
  assert.equal(fs.existsSync(path.join(f.home, '.herdr-monitor')), false, 'no identity record, policy, project staging or binding');
  for (const file of ['.brain', '.git/sessions/standard-slots.json', '.git/sessions/controller-journal.json'])
    assert.equal(fs.existsSync(path.join(f.cwd, file)), false, file);
  assert.equal(f.git('status', '--short'), '');
});

for (const publication of ['identity', 'binding', 'lane', 'validation', 'promote', 'housekeeping', 'pin']) test(`adoption resumes after ${publication} publication with the same scope and decision`, async t => {
  const f = configFixture(t);
  await assert.rejects(f.adopt({ afterPublish(kind) { if (kind === publication) throw Error('publication interrupted'); } }), /publication interrupted/);
  const home = path.join(f.home, '.herdr-monitor'), files = [];
  const collect = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(file);
    else if (entry.name !== 'project.json') files.push([file, fs.readFileSync(file), fs.statSync(file).ino]);
  } };
  collect(home);
  const before = f.events(), scopeBytes = fs.readFileSync(f.scope.scopeFile);
  await f.adopt();
  assert.deepEqual(f.events().slice(0, before.length), before);
  assert.deepEqual(fs.readFileSync(f.scope.scopeFile), scopeBytes);
  for (const [file, bytes, inode] of files) {
    // Audit records may append missing steps; already published policy is kept.
    if (file.includes(`${path.sep}.org${path.sep}`)) continue;
    assert.deepEqual(fs.readFileSync(file), bytes, file);
    assert.equal(fs.statSync(file).ino, inode, file);
  }
  const binding = f.binding();
  assert.deepEqual(binding.published.sort(), Object.keys(binding.sources).filter(k => binding.sources[k].present).sort());
  const events = [...f.events(), ...fs.readFileSync(path.join(path.dirname(binding.identityFile), '.org/events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)];
  for (const type of ['config.change-intent', 'config.changed']) {
    const operations = events.filter(e => e.type === type).map(e => e.operation);
    assert.equal(new Set(operations).size, operations.length, type);
  }
  assert.equal(f.events().filter(e => e.type === 'config.adopted').length, 1);
  const journal = readControllerJournal(binding.common);
  assert.equal(journal.operations.length, 1); assert.equal(journal.operations[0].state, 'acknowledged');
  assert.equal(readStandardSlots(binding.common).slots.length, 1);
});

for (const target of ['identity.json', 'lane.json']) for (const replaced of [false, true]) test(`adoption recovers ${target} intent ${replaced ? 'after' : 'before'} replacement without duplicating its audit`, async t => {
  const f = configFixture(t), rename = fs.renameSync;
  let interrupted = false;
  fs.renameSync = function(from, to) {
    if (!interrupted && path.basename(to) === target) {
      interrupted = true;
      if (replaced) rename.call(this, from, to);
      throw Error('baseline publication interrupted');
    }
    return rename.call(this, from, to);
  };
  try { await assert.rejects(f.adopt(), /baseline publication interrupted/); }
  finally { fs.renameSync = rename; }
  assert.equal(interrupted, true);
  const identity = path.join(f.home, '.herdr-monitor', f.scope.scope.identity), record = target === 'identity.json' ? path.join(identity, '.org') : f.env.ORG_DIR;
  const events = () => fs.readFileSync(path.join(record, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const intent = events().find(e => e.type === 'config.change-intent' && path.basename(e.file) === target);
  assert.ok(intent); assert.equal(fs.existsSync(intent.file), replaced);
  assert.ok(!events().some(e => e.type === 'config.changed' && e.operation === intent.operation));
  await f.adopt();
  assert.equal(events().filter(e => e.type === 'config.change-intent' && e.operation === intent.operation).length, 1);
  const completed = events().filter(e => e.type === 'config.changed' && e.operation === intent.operation);
  assert.equal(completed.length, 1); assert.equal(completed[0].who_asked, intent.who_asked);
  assert.ok(f.binding().adoption.completed);
});

test('adopt inspect ignores terminal promotion history and refuses every live writer position', async t => {
  const f = configFixture(t), project = canonicalProject(f.cwd), file = path.join(project.common, 'promote/queue.json');
  fs.mkdirSync(path.dirname(file));
  const job = { id: 'writer', item: 'ENG-1', run: 'R-1', cwd: f.cwd };
  const idle = { identity: project.common, pending: [], current: null, interrupted: [],
    results: ['refused', 'timeout', 'promoted', 'cancelled'].map(outcome => ({ ...job, id: `old-${outcome}`, outcome })) };
  const inspectArgs = ['.', '--inspect', '--expires', new Date(Date.now() + 3600000).toISOString()];
  const save = queue => { const bytes = JSON.stringify(queue); fs.writeFileSync(file, bytes); return bytes; };
  const bytes = save(idle);
  assert.deepEqual(readSessionFacts({ project, env: f.env }).references, []);
  const captured = await command(inspectArgs, f.options);
  assert.equal(captured.scope.common, project.common); assert.deepEqual(captured.native_actions, []);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);

  const batch = result => ({ id: 'batch', phase: 'batching', jobs: [job],
    ...(result ? { results: [{ job, result }] } : {}) });
  const cases = [
    { pending: [job] },
    { current: batch() },
    { interrupted: [batch({ outcome: 'interrupted' })] },
    { interrupted: [{ ...batch({ outcome: 'interrupted', code: 'PROMOTE_NATIVE_PTMX_REFUSED' }), native_refusal: { code: 'PROMOTE_NATIVE_PTMX_REFUSED' } }] },
    { current: batch({ outcome: 'promoted', reconciliation: { state: 'pending' } }) },
    { current: batch({ outcome: 'promoted', reconciliation: { state: 'complete' }, replacement_pending: true }) },
  ];
  for (const active of cases) {
    const before = save({ ...idle, ...active });
    assert.deepEqual(readSessionFacts({ project, env: f.env }).references, [{ kind: 'promotion', job: job.id, item: job.item, run: job.run, cwd: job.cwd }]);
    await assert.rejects(command(inspectArgs, f.options), /adopt requires owner drain of queued\/current promotion writers/);
    await assert.rejects(adopt(f.options), /adopt requires owner drain of queued\/current promotion writers/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  save(idle);
  assert.equal((await command(inspectArgs, f.options)).scope.common, project.common);
});

test('identity metadata names refuse before policy, audit, staging, scope or link publication', async t => {
  const f = configFixture(t), events = f.events();
  const observer = { observe() { assert.fail('reserved name reached native observation'); } };
  for (const name of ['identity.json', 'Identity.JSON']) for (const inspectOnly of [true, false]) {
    await assert.rejects(adopt({ ...f.options, name, inspectOnly, observer }), /reserved config-home project name.*identity metadata/);
    assert.deepEqual(f.events(), events);
    assert.equal(fs.existsSync(path.join(f.home, '.herdr-monitor')), false, 'no identity policy, audit baseline or project staging directory');
    for (const file of ['.brain', '.git/config-home', '.git/sessions/standard-slots.json', '.git/sessions/controller-journal.json'])
      assert.equal(fs.existsSync(path.join(f.cwd, file)), false, file);
    assert.equal(f.git('status', '--short'), '');
  }
});

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
