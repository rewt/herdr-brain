import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { configFixture } from './helpers/config-home-fixture.mjs';
import { homeBindings, homeProject, policyLocation, readConfigJSON, contentDigest } from '../lib/config-home.mjs';
import { readProjectPolicy, readPolicyFile, configBase } from '../lib/config-policy.mjs';
import { configSnapshot, setConfig, configCommand } from '../lib/config-command.mjs';
import { loadDiscoveredRoutes } from '../lanes/routes.mjs';
import { resolveValidation, validateTree } from '../lanes/validation.mjs';
import { discoverArchive } from '../lib/archive.mjs';
import { literalLaunch } from '../lib/owner-launch.mjs';
import { requireHomeRelease, projectPin, selectRelease } from '../lib/releases.mjs';
import { freezeReleaseValidation } from '../herdr/validation-admission.mjs';
import { adopt, adoptCommand } from '../lib/adopt-command.mjs';
import { readFleet } from '../lib/fleet.mjs';
import { initOrg, findOrgDir, transact, loadEvents } from '../lib/store.mjs';
import { inspect } from '../sessions/sessions.mjs';
import { readSessionFacts } from '../sessions/observe.mjs';
import { routesSnapshot, editProjectConfig, setProjectRoute } from '../lanes/routes-command.mjs';
import { housekeepingSnapshot } from '../housekeeping/command.mjs';
import { discoverProject } from '../housekeeping/housekeeping.mjs';
import { queueFor } from '../promote/promote.mjs';
import { resolveGateProfile } from '../promote/gate-profile.mjs';
import { readControllerJournal } from '../sessions/runtime.mjs';
import { readStandardSlots } from '../sessions/receipts.mjs';
import { plan } from '../sessions/plan.mjs';
import { pendingConfigWrite } from '../lib/config-audit.mjs';
import { readArchivalRetirementPolicy } from '../lib/retire-archive.mjs';
import { closeoutPolicy } from '../lib/closeout.mjs';
import { measureLaneEvidence } from '../lib/lane-removal.mjs';

async function commandWarnings(run) {
  const output = [], stderr = process.stderr.write, stdout = process.stdout.write;
  process.stderr.write = text => { output.push(String(text)); return true; };
  process.stdout.write = () => true;
  try { await run(); } finally { process.stderr.write = stderr; process.stdout.write = stdout; }
  return output;
}

function withGitSelectors(run) {
  const keys = ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE'], before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const key of keys) process.env[key] = '/missing-repository-selector';
  try { return run(); } finally { for (const key of keys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
}

async function neighboringProject(f, { adopted = false, outsideIdentity = false } = {}) {
  const cwd = path.join(outsideIdentity ? f.scratch : f.ownerRoot, 'neighbor'), record = path.join(cwd, '.org');
  fs.mkdirSync(cwd);
  const env = { ...f.env, ORG_DIR: record };
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-qb', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(cwd, '.git/info/exclude'), '.org/\n');
  fs.writeFileSync(path.join(cwd, '.lane.json'), '{"main":"main"}');
  git('add', '.'); git('commit', '-qm', 'neighbor policy'); initOrg(record);
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [path.join(f.bundle, 'bin/org.mjs'), ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  if (adopted) {
    const observation = structuredClone(f.observation);
    Object.assign(observation.workspaces[0].worktree, { repo_key: path.join(cwd, '.git'), repo_root: cwd, checkout_path: cwd });
    observation.panes[0].foreground_cwd = cwd; observation.agents[0].cwd = cwd;
    const options = { ...f.options, cwd, env, observer: { observe: async () => structuredClone(observation) } };
    const captured = await adopt({ ...options, inspectOnly: true, expiresAt: new Date(Date.now() + 3600000).toISOString() });
    transact(record, () => ({ add: [{ type: 'item.added', id: 'HUM-1', title: 'Authorize neighbor adoption?', role: 'human', meta: { category: 'security', adoption_authorization: JSON.stringify(captured.scope) } }] }), { actor: 'fixture-supervisor' });
    const answer = spawnSync(process.execPath, [path.join(f.bundle, 'bin/org.mjs'), 'answer', 'HUM-1', 'yes'], { cwd, env: { ...env, ORG_ACTOR: 'human' }, encoding: 'utf8' });
    assert.equal(answer.status, 0, answer.stderr);
    const decision = loadEvents(record).events.find(e => e.id === 'HUM-1' && e.kind === 'answer');
    await adopt({ ...options, scopeFile: captured.scopeFile, decision: { id: decision.id, seq: decision.seq } });
  }
  return { cwd, record, env, cli };
}

for (const adopted of [false, true]) test(`an invalid project binding holds its owner while a neighbor with ${adopted ? 'a valid' : 'no'} home binding reads and writes`, async t => {
  const f = configFixture(t); await f.adopt();
  const binding = f.binding(), original = readConfigJSON(binding.file), neighbor = await neighboringProject(f, { adopted });
  for (const omitted of [null, 'common', 'checkout', 'record']) {
    const invalid = { ...original, adoption: { ...original.adoption, scope_file: '.git/relative-scope.json' } };
    if (omitted) delete invalid[omitted];
    fs.writeFileSync(binding.file, JSON.stringify(invalid));
    const error = `${binding.file}: invalid config-home-project/v1 binding`;
    assert.throws(() => homeProject(f.cwd, f.env), { message: error });
    for (const selected of [{ common: path.join(neighbor.cwd, '.git') }, { checkout: neighbor.cwd }, { record: neighbor.record }, {}]) {
      assert.deepEqual(homeBindings(neighbor.env, selected).errors, [{ file: binding.file, error }]);
    }
    assert.equal(homeProject(neighbor.cwd, neighbor.env)?.checkout ?? null, adopted ? neighbor.cwd : null);
    assert.equal(findOrgDir({ cwd: neighbor.cwd, env: neighbor.env }), neighbor.record);
    assert.equal(findOrgDir({ cwd: neighbor.cwd, env: { ...neighbor.env, ORG_DIR: undefined } }), neighbor.record);
    neighbor.cli('snapshot');
    neighbor.cli('add', `isolated write with ${omitted ?? 'all claims'}`, '--role', 'engineer');
    assert.equal(loadEvents(neighbor.record).events.at(-1).type, 'item.added');
    if (omitted !== 'record') assert.throws(() => findOrgDir({ cwd: f.cwd, env: f.env }), { message: error });
  }
});

test('unidentifiable JSON or ownership fields never hold a project they cannot positively claim', async t => {
  const f = configFixture(t); await f.adopt();
  const binding = f.binding(), neighbor = await neighboringProject(f);
  for (const bytes of ['{', '{"common":"/a","common":"/b"}', '{}', '{"common":"relative","checkout":null}']) {
    fs.writeFileSync(binding.file, bytes);
    assert.equal(homeProject(neighbor.cwd, neighbor.env), null);
    assert.equal(homeBindings(neighbor.env, { record: neighbor.record }).errors.length, 1);
    neighbor.cli('snapshot'); neighbor.cli('add', 'write despite an unidentifiable foreign binding');
    assert.throws(() => homeProject(f.cwd, f.env), /unrelated or damaged home link/);
  }
});

test('record ownership matches canonical aliases and a shared record remains held by the duplicate-record contract', async t => {
  const f = configFixture(t); await f.adopt();
  const binding = f.binding(), raw = readConfigJSON(binding.file), neighbor = await neighboringProject(f);
  fs.writeFileSync(binding.file, JSON.stringify({ ...raw, adoption: { ...raw.adoption, scope_file: 'relative' } }));
  const alias = path.join(f.scratch, 'shared-record'); fs.symlinkSync(binding.record, alias);
  const error = `${binding.file}: invalid config-home-project/v1 binding`;
  // CONFIG-HOME.md:66-67 explicitly holds duplicate record claims for repair.
  assert.throws(() => homeBindings(f.env, { record: alias }), { message: error });
  assert.throws(() => findOrgDir({ cwd: neighbor.cwd, env: { ...neighbor.env, ORG_DIR: alias } }), { message: error });
  for (const key of ['common', 'checkout']) {
    const claimAlias = path.join(f.scratch, `${key}-alias`); fs.symlinkSync(raw[key], claimAlias);
    fs.writeFileSync(binding.file, JSON.stringify({ ...raw, [key]: claimAlias, adoption: { ...raw.adoption, scope_file: 'relative' } }));
    assert.throws(() => homeBindings(f.env, { [key]: raw[key] }), { message: error });
  }
});

test('conflicting home ownership holds the claimed project and is isolated from an unrelated record', async t => {
  const f = configFixture(t); await f.adopt();
  const binding = f.binding(), neighbor = await neighboringProject(f);
  fs.unlinkSync(path.join(f.cwd, '.brain'));
  const duplicate = path.join(path.dirname(binding.directory), 'duplicate'); fs.mkdirSync(duplicate);
  const raw = readConfigJSON(binding.file);
  // A completed receipt names its original file. Use a valid partial binding
  // so both claims reach the ownership-conflict check under test.
  const { completed, ...adoption } = raw.adoption;
  fs.writeFileSync(path.join(duplicate, 'project.json'), JSON.stringify({ ...raw, project: 'duplicate', adoption }));
  assert.throws(() => homeProject(f.cwd, f.env), /conflicting config-home ownership/);
  assert.equal(homeBindings(neighbor.env, { record: neighbor.record }).errors.length, 2);
  assert.equal(homeProject(neighbor.cwd, neighbor.env), null);
  neighbor.cli('snapshot'); neighbor.cli('add', 'unrelated record survives conflicting foreign ownership');
});

for (const damage of ['metadata', 'policy', 'JSON', 'missing']) test(`a real identity folder with ${damage} damage holds only the projects its bindings positively claim`, async t => {
  const f = configFixture(t, { custom: true }); await f.adopt();
  const binding = f.binding(), defaults = readConfigJSON(binding.identityFile), neighbor = await neighboringProject(f, { outsideIdentity: true });
  if (damage === 'missing') fs.unlinkSync(binding.identityFile);
  else fs.writeFileSync(binding.identityFile, damage === 'JSON' ? '{' : JSON.stringify({ ...defaults,
    ...(damage === 'metadata' ? { identity_root: 'relative' } : { dispatch: { max_sessions: 0 } }) }));
  const message = damage === 'metadata' ? /identity_root must be a canonical absolute directory/ : damage === 'policy' ? /max_sessions/ : damage === 'missing' ? /missing identity.json/ : /JSON/;
  assert.throws(() => homeProject(f.cwd, f.env), message);
  assert.throws(() => homeBindings(f.env, { record: binding.record }), message);
  assert.equal(homeProject(neighbor.cwd, neighbor.env), null);
  assert.equal(findOrgDir({ cwd: neighbor.cwd, env: { ...neighbor.env, ORG_DIR: undefined } }), neighbor.record);
  assert.equal(homeBindings(neighbor.env, { record: neighbor.record }).errors.length, 1);
  neighbor.cli('snapshot'); neighbor.cli('add', 'neighbor writes despite a foreign invalid identity');
});

test('home discovery ignores held, renamed and invalid identity names beside a valid identity', async t => {
  const f = configFixture(t); await f.adopt();
  const binding = f.binding(), home = path.join(f.home, '.herdr-monitor'), source = path.dirname(binding.identityFile);
  const neighbor = await neighboringProject(f);
  for (const name of [`${binding.identity}.held-20261022`, 'bad name', 'bad..name', '.hidden', 'brain']) {
    const held = path.join(home, name);
    fs.cpSync(source, held, { recursive: true });
    fs.writeFileSync(path.join(held, 'identity.json'), '{');
  }
  assert.equal(f.binding().file, binding.file);
  assert.equal(Object.keys(readFleet(f.env).projects).length, 1);
  assert.deepEqual(homeBindings(f.env, { common: binding.common }).errors, []);
  assert.equal(homeProject(neighbor.cwd, neighbor.env), null);
  neighbor.cli('snapshot'); neighbor.cli('add', 'neighbor writes despite ignored holding folders');
});

test('legacy p worktree and t temporary roots remain untouched and are not discovered as identity homes', async t => {
  const f = configFixture(t), home = path.join(f.home, '.herdr-monitor');
  const roots = [path.join(home, 'p/c55c0e01688fa2f8/worktrees'), path.join(home, 't/2dad55753d30b5f3')];
  for (const directory of roots) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'keep.txt'), directory);
    // A nested temporary/project artifact is not identity binding metadata.
    fs.mkdirSync(path.join(directory, 'nested-project'));
    fs.writeFileSync(path.join(directory, 'nested-project/project.json'), '{}');
  }
  const files = roots.flatMap(directory => ['keep.txt', 'nested-project/project.json'].map(name => path.join(directory, name)));
  const bytes = files.map(file => fs.readFileSync(file)), inodes = roots.map(directory => fs.statSync(directory).ino);
  assert.equal(homeProject(f.cwd, f.env), null);
  await f.adopt();
  assert.deepEqual(homeBindings(f.env, { common: f.binding().common }).errors, []);
  assert.equal(Object.keys(readFleet(f.env).projects).length, 1);
  assert.deepEqual(files.map(file => fs.readFileSync(file)), bytes);
  assert.deepEqual(roots.map(directory => fs.statSync(directory).ino), inodes);
});

test('a dangling foreign identity alias cannot fail the absence precheck or unrelated record reads', async t => {
  const f = configFixture(t), home = path.join(f.home, '.herdr-monitor');
  fs.mkdirSync(home); fs.symlinkSync(path.join(f.scratch, 'missing-identity'), path.join(home, 'foreign'));
  assert.equal(homeProject(f.cwd, f.env), null);
  assert.equal(homeBindings(f.env, { record: f.env.ORG_DIR }).errors.length, 1);
  assert.equal(findOrgDir({ cwd: f.cwd, env: f.env }), f.env.ORG_DIR);
});

test('the adoption writer rejects the same dotted identity names that home discovery ignores', async t => {
  const f = configFixture(t, { custom: 'alex.held-20261022' }), events = f.events();
  await assert.rejects(f.capture(), /invalid config-home identity name/);
  assert.deepEqual(f.events(), events);
  assert.equal(fs.existsSync(path.join(f.home, '.herdr-monitor')), false);
});

test('unadopted canonical, linked and nested lookups need no Git probes; a damaged canonical link still holds', t => {
  const f = configFixture(t), lane = path.join(f.scratch, 'linked');
  f.git('worktree', 'add', '-qb', 'lane/absence', lane);
  const nested = path.join(lane, 'nested'); fs.mkdirSync(nested);
  const script = `
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { homeProject } from ${JSON.stringify(new URL('../lib/config-home.mjs', import.meta.url).href)};
    let probes = 0;
    for (const name of ['execFileSync', 'spawnSync']) {
      const original = cp[name];
      cp[name] = function (...args) { if (args[0] === 'git') probes++; return original.apply(this, args); };
    }
    syncBuiltinESMExports();
    for (const cwd of ${JSON.stringify([f.cwd, lane, nested])}) assert.equal(homeProject(cwd), null);
    assert.equal(probes, 0, 'absence discovery must not add subprocess cost to legacy commands');
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: f.cwd, env: f.env });
  fs.symlinkSync(path.join(f.scratch, 'missing-binding'), path.join(f.cwd, '.brain'));
  for (const cwd of [f.cwd, lane, nested]) assert.throws(() => homeProject(cwd, f.env), /unrelated or damaged home link/);
});

test('absence discovery observes a new adoption and a missing link without retaining cached authority', async t => {
  const f = configFixture(t);
  assert.equal(homeProject(f.cwd, f.env), null);
  await f.adopt();
  const binding = homeProject(f.cwd, f.env);
  assert.equal(binding.checkout, f.cwd);
  fs.unlinkSync(path.join(f.cwd, '.brain'));
  assert.equal(homeProject(f.cwd, f.env).directory, binding.directory);
});

for (const custom of [false, true]) test(`${custom ? 'custom' : 'default'} identity, unchanged source bytes and canonical linked-worktree policy`, async t => {
  const f = configFixture(t, { custom }); await f.adopt();
  const b = f.binding();
  assert.equal(b.identity, custom ? 'alex' : os.userInfo().username);
  for (const [kind, source] of Object.entries(b.sources)) if (source.present) assert.equal(fs.readFileSync(policyLocation(f.cwd, kind).file, 'utf8'), fs.readFileSync(source.path, 'utf8'));
  const lane = path.join(f.scratch, 'linked'); f.git('worktree', 'add', '-qb', 'lane/example', lane);
  fs.writeFileSync(path.join(lane, '.lane.json'), '{"dispatch":{"max_sessions":99}}');
  assert.equal(homeProject(lane).directory, b.directory);
  assert.equal(loadDiscoveredRoutes({ cwd: lane }).config.dispatch.max_sessions, 4);
  assert.equal(loadDiscoveredRoutes({ cwd: lane }).config.dispatch.max_unlanded, 8);
  assert.deepEqual(discoverArchive({ cwd: lane }).dirs, [path.join(f.cwd, 'archive')]);
  assert.equal(configBase(b.identityFile, f.cwd, process.env, 'worktree_root'), f.ownerRoot);
  assert.match(fs.readFileSync(path.join(f.cwd, '.git/info/exclude'), 'utf8'), /keep-existing-entry\n\/.brain\n/u);
  assert.equal(f.git('status', '--short'), '');
  const hostile = { ...f.env, GIT_DIR: '/missing-selector', GIT_COMMON_DIR: '/missing-selector', GIT_WORK_TREE: '/missing-selector', LANE_CONFIG: '/missing-policy' };
  assert.equal(configSnapshot({ cwd: lane, env: hostile }).values.find(v => v.key === 'main').value, 'main');
});

for (const [key, malformed, message] of [
  ['project_access', {}, /project_access requires canonical source and target common directories/],
  ['brain_write', [], /brain_write must map canonical common directories to boolean consent/],
]) test(`adoption refuses malformed parent ${key} before identity intent or home policy publication`, async t => {
  const f = configFixture(t, { custom: true, routing: true });
  const parent = path.join(f.ownerRoot, '.lane.json'), defaults = readConfigJSON(parent);
  const identityHome = path.join(f.home, '.herdr-monitor/alex'), identityFile = path.join(identityHome, 'identity.json');
  const identityRecord = path.join(identityHome, '.org'), projectHome = path.join(identityHome, 'project');
  fs.writeFileSync(parent, JSON.stringify({ ...defaults, [key]: malformed }));
  let published = false;
  await assert.rejects(f.adopt({ afterPublish() { published = true; } }), message);
  assert.equal(published, false);
  assert.equal(fs.existsSync(identityRecord), false, 'no identity record or change intent');
  assert.equal(fs.existsSync(identityFile), false, 'no invalid shared identity defaults');
  assert.equal(fs.existsSync(projectHome), false, 'no project binding or policy files');
  assert.equal(fs.existsSync(path.join(f.cwd, '.brain')), false);
  assert.ok(!f.events().some(e => ['config.change-intent', 'config.changed', 'config.adopted'].includes(e.type)));
  assert.equal(homeProject(f.cwd, f.env), null, 'refusal must not hold subsequent discovery');

  const common = path.join(f.cwd, '.git');
  const valid = key === 'project_access' ? [{ source: common, target: common }] : { [common]: true };
  fs.writeFileSync(parent, JSON.stringify({ ...defaults, [key]: valid }));
  f.scope = await f.capture(); f.decision = f.question(f.scope.scope);
  await f.adopt();
  assert.deepEqual(f.binding().defaults[key], valid, 'valid parent defaults still publish');
});

test('file-by-file partial publication keeps each independent repo fallback and refuses loss of published policy', async t => {
  const f = configFixture(t);
  await assert.rejects(f.adopt({ afterPublish(kind) { if (kind === 'lane') throw Error('fixture interruption'); } }), /fixture interruption/);
  assert.equal(policyLocation(f.cwd, 'lane').home, true);
  assert.equal(policyLocation(f.cwd, 'validation').home, false);
  assert.equal(resolveValidation({ root: f.cwd }).tiers.fast.command, 'node --version');
  fs.unlinkSync(policyLocation(f.cwd, 'lane').file);
  assert.throws(() => readProjectPolicy(f.cwd, 'lane'), /published home file is missing/);
});

test('invalid home policy is refused without fallback and malformed/duplicate/symlink revisions are audited without raw bytes', async t => {
  const f = configFixture(t); await f.adopt();
  const file = policyLocation(f.cwd, 'lane').file;
  for (const bad of ['{"dispatch":{"max_sessions":0}}', '{"main":1,"main":2}', '{"secret_token":"do-not-audit-me"']) {
    fs.writeFileSync(file, bad);
    assert.throws(() => readProjectPolicy(f.cwd, 'lane'), /held/);
    assert.equal(f.events().at(-1).new_value.unavailable, 'invalid');
    assert.ok(!JSON.stringify(f.events()).includes('do-not-audit-me'));
  }
  fs.unlinkSync(file); fs.symlinkSync(path.join(f.cwd, '.lane.json'), file);
  assert.throws(() => readProjectPolicy(f.cwd, 'lane'), /held/);
});

for (const standalone of [false, true]) test(`hand-edited ${standalone ? 'standalone-routing' : 'layered'} references hold direct policy readers and the lane CLI`, async t => {
  const f = configFixture(t, { routing: standalone }); await f.adopt();
  const binding = f.binding(), file = policyLocation(f.cwd, 'lane').file;
  const linked = path.join(f.scratch, 'linked'); f.git('worktree', 'add', '-qb', 'lane/held', linked);
  const config = readConfigJSON(file);
  config.retirement = { archival_retirement: true, closeout_queue: true, protected_paths: [] };
  // The route lives in another selected document, so per-file reference
  // validation would incorrectly reject this positive control.
  config.settle = { review_route: 'engineer' };
  if (standalone) {
    const routing = policyLocation(f.cwd, 'routing').file, selected = readConfigJSON(routing);
    selected.routes['standalone-only'] = { kind: 'codex' };
    fs.writeFileSync(routing, JSON.stringify(selected));
    config.settle.fix_route = 'standalone-only';
  }
  fs.writeFileSync(file, JSON.stringify(config));
  const options = { common: binding.common, lane: linked, topic: 'held', tip: f.git('rev-parse', 'HEAD'), tracked: new Set(f.git('ls-files', '-z').split('\0').filter(Boolean)), env: { ...f.env, LANE_CONFIG: '/ignored-caller-policy' } };
  const cli = () => spawnSync(process.execPath, [path.join(f.bundle, 'lanes/lane.mjs'), 'config'], { cwd: linked, env: options.env, encoding: 'utf8' });
  assert.equal(readProjectPolicy(linked, 'lane', options.env).config.settle.review_route, 'engineer');
  assert.deepEqual(discoverArchive({ cwd: linked, env: options.env }), { dirs: [path.join(f.cwd, 'archive')], source: file });
  const loaded = loadDiscoveredRoutes({ cwd: linked, env: options.env });
  assert.deepEqual(loaded.layers.map(layer => layer.file), [binding.identityFile, file,
    ...(standalone ? [policyLocation(f.cwd, 'routing').file] : [])]);
  assert.equal(loaded.layers[1].config.settle.fix_route, standalone ? 'standalone-only' : undefined);
  assert.equal(closeoutPolicy(f.cwd), true);
  assert.equal(readArchivalRetirementPolicy(f.cwd).archivalRetirementPolicy, true);
  assert.equal(measureLaneEvidence(options).bytes, 0);
  let run = cli(); assert.equal(run.status, 0, run.stderr);
  const valid = fs.readFileSync(file);
  const held = route => {
    assert.throws(() => readProjectPolicy(linked, 'lane', options.env), error => /held/.test(error.message) && error.message.includes(route));
    assert.throws(() => closeoutPolicy(f.cwd), error => /invalid/.test(error.message) && error.message.includes(route));
    assert.throws(() => discoverArchive({ cwd: linked, env: options.env }), error => error.message.includes(route));
    const archival = readArchivalRetirementPolicy(f.cwd);
    assert.equal(archival.archivalRetirementPolicy, false);
    assert.ok(archival.archivalRetirementPolicyError.includes(route), archival.archivalRetirementPolicyError);
    assert.throws(() => measureLaneEvidence(options), /protected path configuration unavailable; lane kept/);
    run = cli(); assert.notEqual(run.status, 0, run.stdout);
    assert.ok(run.stderr.includes(route), run.stderr); assert.match(run.stderr, /held/);
    assert.equal(fs.existsSync(linked), true);
    assert.equal(fs.existsSync(path.join(binding.common, 'lane-archive')), false);
  };
  config.settle.review_route = 'unknown-hand-edit'; fs.writeFileSync(file, JSON.stringify(config));
  held('unknown-hand-edit');
  fs.writeFileSync(file, valid);
  if (standalone) {
    // A route removed from the standalone declaration cannot be resurrected
    // from identity defaults, even though they still declare engineer.
    const routing = policyLocation(f.cwd, 'routing').file, selected = readConfigJSON(routing);
    selected.selection_policy = { by_task_class: { review: 'retained' } };
    selected.routes = { retained: { kind: 'codex' } };
    fs.writeFileSync(routing, JSON.stringify(selected));
    held('engineer');
  } else {
    const identity = readConfigJSON(binding.identityFile);
    identity.settle = { review_route: 'unknown-identity-edit' };
    fs.writeFileSync(binding.identityFile, JSON.stringify(identity));
    delete config.settle; fs.writeFileSync(file, JSON.stringify(config));
    held('unknown-identity-edit');
  }
});

test('whole home files do not resurrect removed repo keys; provenance/history include command, hand edit, identity record and recovery', async t => {
  const f = configFixture(t); await f.adopt();
  const file = policyLocation(f.cwd, 'lane').file;
  fs.writeFileSync(file, '{"main":"home-main"}\n');
  let view = configSnapshot({ cwd: f.cwd });
  assert.equal(view.values.find(v => v.key === 'main').source, file);
  assert.equal(loadDiscoveredRoutes({ cwd: f.cwd }).config.dispatch.max_sessions, undefined);
  const count = f.events().length; configSnapshot({ cwd: f.cwd }); assert.equal(f.events().length, count);
  const who = 'operator fixture request';
  assert.throws(() => setConfig('main', 'recovered-main', { cwd: f.cwd, who, afterReplace() { throw Error('power-loss'); } }), /power-loss/);
  view = configSnapshot({ cwd: f.cwd });
  assert.equal(view.values.find(v => v.key === 'main').value, 'recovered-main');
  const recovered = f.events().findLast(e => e.type === 'config.changed' && e.origin === 'command');
  assert.equal(recovered.who_asked, who); assert.equal(recovered.old_value.main, 'home-main');
  assert.equal(recovered.new_value.main, 'recovered-main');
  setConfig('launch', '["owner-launch","literal $(not-executed)"]', { cwd: f.cwd, scope: 'identity' });
  const identityRecord = path.join(path.dirname(f.binding().identityFile), '.org/events.jsonl');
  assert.match(fs.readFileSync(identityRecord, 'utf8'), /owner-launch/u);
  assert.ok(!f.events().some(e => e.new_value?.launch));
  assert.deepEqual(literalLaunch('herdr', ['agent', 'start'], f.binding().defaults.launch), { command: 'owner-launch', args: ['literal $(not-executed)', 'herdr', 'agent', 'start'] });
  view = configSnapshot({ cwd: f.cwd });
  assert.deepEqual(view.values.find(v => v.key === 'launch').value, ['owner-launch', 'literal $(not-executed)']);
  assert.equal(view.values.find(v => v.key === 'launch').scope, 'identity');
  for (const enabled of [true, false]) {
    setConfig('retirement.closeout_queue', JSON.stringify(enabled), { cwd: f.cwd, scope: 'identity' });
    assert.ok(!configSnapshot({ cwd: f.cwd }).values.some(v => v.key === 'retirement.closeout_queue'));
    assert.equal(closeoutPolicy(f.cwd), false, 'reference validation does not inherit identity retirement activation');
  }
  setConfig('retirement.closeout_queue', 'true', { cwd: f.cwd });
  assert.equal(closeoutPolicy(f.cwd), true, 'only the selected project policy can opt in to closeout');
});

for (const mode of ['legacy', 'home', 'standalone']) test(`config set validates complete ${mode} policy references before any intent, replacement or audit`, async t => {
  const f = configFixture(t, { routing: mode === 'standalone' });
  if (mode !== 'legacy') await f.adopt();
  const binding = f.binding(), lane = policyLocation(f.cwd, 'lane').file;
  const files = [path.join(f.env.ORG_DIR, 'events.jsonl'), lane,
    ...(binding ? [binding.identityFile, path.join(path.dirname(binding.identityFile), '.org/events.jsonl')] : []),
    ...(mode === 'standalone' ? [policyLocation(f.cwd, 'routing').file] : [])];
  const bytes = () => files.map(file => fs.readFileSync(file, 'utf8'));
  for (const key of ['settle.review_route', 'settle.fix_route']) {
    const before = bytes();
    assert.throws(() => setConfig(key, 'unknown', { cwd: f.cwd }), /unknown route: unknown/);
    assert.deepEqual(bytes(), before);
    if (binding) {
      assert.throws(() => setConfig(key, 'unknown', { cwd: f.cwd, scope: 'identity' }), /unknown route: unknown/);
      assert.deepEqual(bytes(), before);
    }
  }
  // A desk can use an inherited route, but removing its selected standalone
  // declaration must not resurrect the identity's routes or discard the desk.
  setConfig('settle.review_route', 'engineer', { cwd: f.cwd });
  if (mode === 'standalone') {
    setConfig('routes.desk-only', '{"kind":"codex"}', { cwd: f.cwd });
    setConfig('settle.review_route', 'desk-only', { cwd: f.cwd });
    const before = bytes();
    assert.throws(() => setConfig('routes.desk-only', undefined, { cwd: f.cwd, unset: true }), /unknown route: desk-only/);
    assert.deepEqual(bytes(), before);
    assert.throws(() => setConfig('routing.selection_policy.by_task_class.review', 'unknown', { cwd: f.cwd }), /unknown route unknown/);
    assert.deepEqual(bytes(), before);
  }
  assert.equal(loadDiscoveredRoutes({ cwd: f.cwd }).config.routes.engineer.kind, 'codex');
});

test('a stale recovery cannot complete its captured intent twice when another reader recovers it and a later writer interleaves', async t => {
  const f = configFixture(t); await f.adopt();
  const file = policyLocation(f.cwd, 'lane').file;
  assert.throws(() => setConfig('main', 'first', { cwd: f.cwd, who: 'first request', afterReplace() { throw Error('first interruption'); } }), /first interruption/);
  const first = pendingConfigWrite(f.env.ORG_DIR, file)[0];
  const mkdir = fs.mkdirSync; let interleaved = false;
  fs.mkdirSync = function(directory, ...args) {
    if (!interleaved && directory === path.join(f.env.ORG_DIR, 'lock')) {
      interleaved = true; fs.mkdirSync = mkdir;
      assert.equal(readProjectPolicy(f.cwd, 'lane').config.main, 'first');
      assert.throws(() => setConfig('main', 'second', { cwd: f.cwd, who: 'second request', afterIntent() { throw Error('second interruption'); } }), /second interruption/);
    }
    return mkdir.call(this, directory, ...args);
  };
  try { assert.equal(readProjectPolicy(f.cwd, 'lane').config.main, 'first'); }
  finally { fs.mkdirSync = mkdir; }
  assert.equal(interleaved, true);
  assert.equal(f.events().filter(e => e.type === 'config.changed' && e.operation === first.operation).length, 1);
  const second = pendingConfigWrite(f.env.ORG_DIR, file)[0];
  assert.notEqual(second.operation, first.operation);
  setConfig('main', 'second', { cwd: f.cwd, who: 'retry must preserve original' });
  assert.deepEqual(pendingConfigWrite(f.env.ORG_DIR, file), []);
  const completions = f.events().filter(e => e.type === 'config.changed' && [first.operation, second.operation].includes(e.operation));
  assert.deepEqual(completions.map(e => [e.new_value.main, e.who_asked]), [['first', 'first request'], ['second', 'second request']]);
});

test('partial-move pin fallback and the shared reader both refuse duplicate keys, invalid UTF-8 and open pin shapes', async t => {
  const f = configFixture(t);
  await assert.rejects(f.adopt({ afterPublish(kind) { if (kind === 'lane') throw Error('partial move'); } }), /partial move/);
  assert.equal(policyLocation(f.cwd, 'pin').home, false);
  const file = path.join(f.cwd, '.herdr-release.json');
  for (const [bytes, reason] of [
    ['{"release":"first","release":"compatible"}', /duplicate JSON key "release"/],
    [Buffer.concat([Buffer.from('{"release":"'), Buffer.from([0xc0]), Buffer.from('"}')]), /encoded data was not valid/],
    ['{"release":null,"extra":true}', /pin requires exactly/],
  ]) {
    fs.writeFileSync(file, bytes); f.git('add', '.herdr-release.json'); f.git('commit', '-qm', 'invalid fallback pin witness');
    assert.throws(() => readProjectPolicy(f.cwd, 'pin'), reason);
    assert.throws(() => projectPin(f.cwd), reason);
  }
});

test('config and adopt warn with both divergent paths; config set warns repo-reading scripts and retains repo bytes', async t => {
  const f = configFixture(t); await f.adopt();
  const repo = path.join(f.cwd, '.lane.json'), before = fs.readFileSync(repo, 'utf8');
  const result = setConfig('archive.dirs', '["other-archive"]', { cwd: f.cwd });
  assert.match(result.warnings[0], /repo-reading project scripts will not see this change/u);
  const drift = configSnapshot({ cwd: f.cwd }).warnings.join('\n');
  assert.ok(drift.includes(repo)); assert.ok(drift.includes(policyLocation(f.cwd, 'lane').file));
  const adopted = await f.adopt(); assert.equal(adopted.unchanged, true);
  assert.ok(adopted.warnings.some(w => w.includes(repo) && w.includes(policyLocation(f.cwd, 'lane').file)));
  assert.equal(fs.readFileSync(repo, 'utf8'), before);
  const output = await commandWarnings(() => configCommand([], { cwd: f.cwd }));
  assert.ok(output.some(line => line.includes(repo) && line.includes(policyLocation(f.cwd, 'lane').file)));
});

test('adopt prints one-line divergence warnings naming the retained repo and selected home paths', async t => {
  const f = configFixture(t); await f.adopt();
  const repo = path.join(f.cwd, '.lane.json'), before = fs.readFileSync(repo, 'utf8');
  setConfig('main', 'home-main', { cwd: f.cwd });
  const output = await commandWarnings(() => adoptCommand(['.', '--scope', f.scope.scopeFile, '--decision', `${f.decision.id}:${f.decision.seq}`], f.options));
  const warning = output.filter(line => line.includes(repo) && line.includes(policyLocation(f.cwd, 'lane').file));
  assert.equal(warning.length, 1); assert.equal(warning[0].trim().split('\n').length, 1);
  assert.equal(fs.readFileSync(repo, 'utf8'), before);
});

test('config set prints the repo-reading project-script warning and leaves its retained input unchanged', async t => {
  const f = configFixture(t); await f.adopt();
  const repo = path.join(f.cwd, '.lane.json'), before = fs.readFileSync(repo, 'utf8');
  const output = await commandWarnings(() => configCommand(['set', 'main', 'home-main'], { cwd: f.cwd }));
  assert.ok(output.some(line => /repo-reading project scripts will not see this change/u.test(line)));
  assert.equal(fs.readFileSync(repo, 'utf8'), before);
});

test('an explicit legacy config inspection reports the actual selected values and override', t => {
  const f = configFixture(t), file = path.join(f.scratch, 'inspection.json');
  fs.writeFileSync(file, '{"main":"explicit-main"}');
  const view = configSnapshot({ cwd: f.cwd, env: { ...f.env, LANE_CONFIG: file } });
  assert.equal(view.values.find(v => v.key === 'main').value, 'explicit-main');
  assert.deepEqual(view.invocation_override, { file, effective: true });
  const result = setConfig('main', 'edited-main', { cwd: f.cwd, env: { ...f.env, LANE_CONFIG: file } });
  assert.deepEqual(result.warnings, []);
  assert.equal(readConfigJSON(path.join(f.cwd, '.lane.json')).main, 'edited-main');
  assert.equal(readConfigJSON(file).main, 'explicit-main');
});

test('folder discovery proves Git ownership, scope and record evidence and cannot isolate a conflicting record claim', async t => {
  const f = configFixture(t); await f.adopt(); const binding = f.binding(), raw = readConfigJSON(binding.file);
  assert.equal(Object.values(readFleet(f.env).projects)[0].identity, binding.common);
  for (const patch of [{ common: path.join(f.scratch, 'foreign.git') }, { adoption: { ...raw.adoption, scope_sha256: '0'.repeat(64) } }, { record: path.join(f.scratch, 'missing-record'), adoption: { ...raw.adoption, authorization: { ...raw.adoption.authorization, record: path.join(f.scratch, 'missing-record') } } }]) {
    fs.writeFileSync(binding.file, JSON.stringify({ ...raw, ...patch }));
    assert.throws(() => readFleet(f.env), /Git identity|provenance|record is missing/);
  }
  fs.writeFileSync(binding.file, JSON.stringify(raw));
  const other = path.join(path.dirname(binding.directory), 'other'); fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'project.json'), JSON.stringify({ ...raw, project: 'other', common: path.join(f.scratch, 'foreign.git'), checkout: path.join(f.scratch, 'foreign') }));
  assert.throws(() => homeProject(f.cwd, f.env), /canonical checkout unavailable/);
});

test('a hand edit during release admission cannot separate the frozen declaration from its input digest', async t => {
  const f = configFixture(t); await f.adopt(); f.git('tag', 'snapshot');
  const file = policyLocation(f.cwd, 'validation').file, original = fs.readFileSync(file), identity = fs.statSync(file);
  const read = fs.readFileSync; let changed = false;
  fs.readFileSync = function(target, ...args) {
    const bytes = read.call(this, target, ...args);
    if (!changed && typeof target === 'number') {
      const stat = fs.fstatSync(target);
      if (stat.dev === identity.dev && stat.ino === identity.ino) { changed = true; fs.writeFileSync(file, '{"fast":"node --help"}\n'); }
    }
    return bytes;
  };
  let frozen;
  try { frozen = freezeReleaseValidation(f.cwd, 'snapshot', path.join(f.scratch, 'frozen-once.json')); }
  finally { fs.readFileSync = read; }
  assert.equal(changed, true); assert.equal(frozen.declaration.fast, 'node --version');
  assert.equal(frozen.sha256, contentDigest(original));
  assert.equal(readProjectPolicy(f.cwd, 'validation').config.fast, 'node --help');
});

test('a partial move edits the accepted committed fallback with its expected revision and retains prepared repo bytes', async t => {
  const f = configFixture(t);
  await assert.rejects(f.adopt({ afterPublish(kind) { if (kind === 'lane') throw Error('partial move'); } }), /partial move/);
  const selected = readProjectPolicy(f.cwd, 'promote'), repo = selected.file;
  assert.equal(selected.home, false);
  withGitSelectors(() => assert.equal(resolveGateProfile(f.cwd), null));
  fs.writeFileSync(repo, '{"max_batch":99,"to":"prepared-copy"}');
  assert.throws(() => setConfig('promote.max_batch', '4', { cwd: f.cwd, expect: '0'.repeat(64) }), /changed since inspection/);
  setConfig('promote.max_batch', '4', { cwd: f.cwd, expect: selected.source_digest });
  assert.deepEqual(readProjectPolicy(f.cwd, 'promote').config, { max_batch: 4 });
  assert.equal(readConfigJSON(repo).max_batch, 99);
});

test('native project consumers use the adopted Git identity and record despite ambient selectors and foreign record inputs', async t => {
  const f = configFixture(t); await f.adopt(); const binding = f.binding(), foreign = path.join(f.scratch, 'foreign-record'); initOrg(foreign);
  fs.writeFileSync(path.join(binding.record, 'STOP'), 'fixture stop');
  withGitSelectors(() => {
    const inspected = inspect({ cwd: f.cwd });
    assert.equal(inspected.project.common, binding.common);
    assert.equal(routesSnapshot(f.cwd).root, f.cwd);
    assert.equal(housekeepingSnapshot({ cwd: f.cwd, org: foreign }).record, binding.record);
    assert.equal(discoverProject(f.cwd, foreign).common, binding.common);
    assert.equal(discoverProject(f.cwd, foreign).org, binding.record);
    const facts = readSessionFacts({ project: inspected.project, env: { ...f.env, ORG_DIR: foreign } });
    assert.equal(facts.stopped, true); assert.deepEqual(facts.errors, []);
    assert.equal(queueFor(f.cwd).project.identity, binding.common);
  });
});

test('a worker dry-run cannot use a named config copy to bypass invalid selected home housekeeping policy', async t => {
  const f = configFixture(t); await f.adopt(); const file = policyLocation(f.cwd, 'housekeeping').file;
  fs.writeFileSync(file, '{"enabled":"invalid"}');
  const copy = path.join(f.scratch, 'copied-config.json'); fs.writeFileSync(copy, '{"enabled":false}');
  const run = spawnSync(process.execPath, [path.join(f.bundle, 'housekeeping/housekeeping.mjs'), '--once', '--dry-run', '--state-dir', path.join(f.scratch, 'preview'), '--config', copy], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
  assert.equal(run.status, 1); assert.ok(run.stderr.includes(file)); assert.match(run.stderr, /enabled must be true\|false/);
});

test('an external project record and its existing local link remain in place through adoption', async t => {
  const f = configFixture(t), external = path.join(f.scratch, 'external-record'), alias = path.join(f.cwd, '.org');
  fs.renameSync(alias, external); fs.symlinkSync(external, alias, 'dir'); const before = f.events();
  await f.adopt();
  assert.equal(f.binding().record, external); assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(alias), external); assert.deepEqual(f.events().slice(0, before.length), before);
});

test('home pins precede Git absence prechecks; incompatible bundles refuse and frozen release declarations retain canonical bases', async t => {
  const f = configFixture(t); await f.adopt();
  assert.equal(projectPin(f.cwd).file, policyLocation(f.cwd, 'pin').file);
  assert.equal(requireHomeRelease(null, f.binding(), f.installationHome).id, 'compatible');
  const manifest = path.join(f.bundle, '.release-manifest.json'), data = readConfigJSON(manifest);
  delete data.config_home; fs.writeFileSync(manifest, JSON.stringify(data));
  assert.throws(() => requireHomeRelease('compatible', f.binding(), f.installationHome), /incompatible downgrade/);
  fs.writeFileSync(manifest, JSON.stringify({ ...data, config_home: 1 }));
  assert.equal(requireHomeRelease(null, f.binding(), f.installationHome).id, 'compatible');
  f.git('tag', 'snapshot');
  const frozen = freezeReleaseValidation(f.cwd, 'snapshot', path.join(f.scratch, 'frozen.json'));
  assert.equal(frozen.source, policyLocation(f.cwd, 'validation').file);
  assert.equal(frozen.declaration.fast, 'node --version');
  assert.equal(readConfigJSON(path.join(f.cwd, '.herdr-release.json')).release, null);
});

test('owner-controlled rollback selects divergent retained repo policy and another compatible release while preserving audit and KEEP evidence', async t => {
  const f = configFixture(t); await f.adopt();
  setConfig('main', 'home-main', { cwd: f.cwd });
  const binding = f.binding(), common = binding.common, record = binding.record;
  const repo = path.join(f.cwd, '.lane.json'), home = policyLocation(f.cwd, 'lane').file;
  assert.equal(readProjectPolicy(f.cwd, 'lane').config.main, 'home-main');
  assert.equal(readPolicyFile(repo, 'lane', { cwd: f.cwd, env: f.env }).main, 'main');
  assert.ok(configSnapshot({ cwd: f.cwd }).warnings.some(w => w.includes(repo) && w.includes(home)));

  // These are the owner's explicit procedure steps in an isolated native
  // fixture, not an automatic fallback or a new rollback command.
  const stopped = path.join(record, 'STOP'); fs.writeFileSync(stopped, 'Owner stopped new admissions for rollback\n');
  const facts = readSessionFacts({ project: inspect({ cwd: f.cwd, env: f.env }).project, env: f.env });
  assert.equal(facts.stopped, true); assert.deepEqual(facts.errors, []);
  assert.deepEqual(facts.dispatches, {}); assert.deepEqual(facts.references, []);
  assert.ok(readControllerJournal(common).operations.every(op => op.state === 'acknowledged'));
  const rollback = f.release('rollback-compatible');
  assert.equal(requireHomeRelease('rollback-compatible', binding, f.installationHome).root, rollback);
  fs.writeFileSync(path.join(f.cwd, '.herdr-release.json'), '{"release":"rollback-compatible"}\n');
  f.git('add', '.herdr-release.json'); f.git('commit', '-qm', 'owner accepts retained policy rollback release');
  assert.equal(selectRelease(f.cwd, f.installationHome).root, f.bundle, 'home policy still wins until explicitly disabled');

  const disabled = path.join(path.dirname(binding.directory), '.rollback-project');
  const scope = { common, record, binding: binding.file, preserved_home: disabled, selected_policy: repo,
    home_main: 'home-main', repo_main: 'main', release: 'rollback-compatible', release_root: rollback };
  const decision = f.question(scope, 'config_rollback');
  const history = f.events(), identityHistory = fs.readFileSync(path.join(path.dirname(binding.identityFile), '.org/events.jsonl'), 'utf8');
  const journal = readControllerJournal(common), op = journal.operations[0];
  const evidence = [path.join(common, 'sessions/controller-journal.json'), path.join(common, 'sessions/standard-slots.json'),
    op.evidence.file, binding.adoption.scope_file];
  const before = evidence.map(file => fs.readFileSync(file, 'utf8'));
  const homeFiles = [binding.file, ...Object.keys(binding.sources).filter(kind => binding.sources[kind].present).map(kind => policyLocation(f.cwd, kind).file)];
  const homeBytes = homeFiles.map(file => fs.readFileSync(file, 'utf8'));

  fs.unlinkSync(path.join(f.cwd, '.brain'));
  assert.equal(readProjectPolicy(f.cwd, 'lane').config.main, 'home-main', 'a missing link alone does not roll back');
  fs.renameSync(binding.directory, disabled);
  assert.equal(homeProject(f.cwd, f.env), null);
  assert.equal(findOrgDir({ cwd: f.cwd, env: f.env }), record);
  assert.equal(readProjectPolicy(f.cwd, 'lane', f.env).config.main, 'main');
  assert.equal(selectRelease(f.cwd, f.installationHome).root, rollback);
  assert.equal(selectRelease(f.cwd, f.installationHome).selection, 'project');
  assert.deepEqual(evidence.map(file => fs.readFileSync(file, 'utf8')), before);
  assert.deepEqual(homeFiles.map(file => fs.readFileSync(path.join(disabled, path.relative(binding.directory, file)), 'utf8')), homeBytes);
  assert.equal(fs.readFileSync(path.join(path.dirname(binding.identityFile), '.org/events.jsonl'), 'utf8'), identityHistory);
  assert.deepEqual(f.events(), history);

  const text = `Rollback authorized by ${decision.id}:${decision.seq}: selected retained repo ${repo} (main) instead of ${home} (home-main); selected ${rollback}; preserved home at ${disabled}, owning record, audit, enrollment and KEEP evidence.`;
  execFileSync(process.execPath, [path.join(rollback, 'bin/org.mjs'), 'note', decision.id, text, '--decision'], { cwd: f.cwd, env: { ...f.env, ORG_ACTOR: 'human' }, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.deepEqual(f.events().slice(0, history.length), history);
  assert.equal(f.events().at(-1).text, text); assert.equal(f.events().at(-1).decision, true);
  fs.unlinkSync(stopped);
  assert.equal(readStandardSlots(common).slots.length, 1);
  const planned = await plan({ cwd: f.cwd, observer: f.observer, env: f.env });
  assert.equal(planned.decisions.find(d => d.uid === op.uid).decision, 'KEEP');
  assert.deepEqual(evidence.map(file => fs.readFileSync(file, 'utf8')), before);
});

test('a home authority-input change cannot inherit a source-only validation witness', async t => {
  const f = configFixture(t); await f.adopt();
  const options = { cwd: f.cwd, common: path.join(f.cwd, '.git'), command: 'node --version', tier: 'fast' };
  const before = validateTree(options);
  setConfig('archive.dirs', '["changed"]', { cwd: f.cwd });
  const after = validateTree(options);
  assert.equal(before.head, after.head); assert.equal(before.tree, after.tree);
  assert.notEqual(before.key, after.key); assert.notEqual(before.config_home_inputs, after.config_home_inputs);
});

test('an interrupted identity write holds readers and the exact retry preserves its original requester', async t => {
  const f = configFixture(t); await f.adopt();
  assert.throws(() => setConfig('launch', '["owner-launch"]', { cwd: f.cwd, scope: 'identity', who: 'original identity request', afterIntent() { throw Error('before replacement'); } }), /before replacement/);
  assert.throws(() => configSnapshot({ cwd: f.cwd }), /unresolved/);
  setConfig('launch', '["owner-launch"]', { cwd: f.cwd, scope: 'identity', who: 'later retry' });
  const events = fs.readFileSync(path.join(path.dirname(f.binding().identityFile), '.org/events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.findLast(e => e.type === 'config.changed').who_asked, 'original identity request');
});

test('standalone routing keeps its route set and origin while full dispatch retains admission keys', async t => {
  const f = configFixture(t, { routing: true }); await f.adopt();
  const selected = policyLocation(f.cwd, 'routing').file;
  fs.writeFileSync(selected, '{"routes":{"solo":{"kind":"codex"}},"dispatch":{"kind":"codex"}}');
  const routes = loadDiscoveredRoutes({ cwd: f.cwd });
  assert.deepEqual(Object.keys(routes.config.routes), ['solo']);
  assert.equal(routes.config.dispatch.max_unlanded, 8);
  assert.equal(routes.config.dispatch.max_sessions, 4);
  assert.equal(configBase(selected, f.cwd), f.cwd);
  const view = configSnapshot({ cwd: f.cwd });
  assert.ok(view.values.filter(v => v.key.startsWith('routes.')).every(v => v.key.startsWith('routes.solo.')));
  assert.equal(view.values.find(v => v.key === 'routes.solo.kind').source, selected);
  assert.equal(view.values.find(v => v.key === 'dispatch.max_unlanded').source, policyLocation(f.cwd, 'lane').file);
});

for (const fallback of [false, true]) test(`selected ${fallback ? 'repo fallback' : 'home'} routing refuses every identity-only setting at read`, async t => {
  const f = configFixture(t, { routing: true });
  if (fallback) await assert.rejects(f.adopt({ afterPublish(kind) { if (kind === 'lane') throw Error('partial adoption'); } }), /partial adoption/);
  else await f.adopt();
  const selected = policyLocation(f.cwd, 'routing'), original = readConfigJSON(selected.file);
  assert.equal(selected.home, !fallback);
  assert.equal(loadDiscoveredRoutes({ cwd: f.cwd }).config.routes.engineer.kind, 'codex');
  for (const [key, value] of Object.entries({ launch: ['project-launch'], identity_root: f.ownerRoot, defaults_origin: {}, project_access: [], brain_write: {} })) {
    fs.writeFileSync(selected.file, JSON.stringify({ ...original, [key]: value }));
    assert.throws(() => readProjectPolicy(f.cwd, 'routing'), /identity-only settings belong in identity.json/, key);
    assert.throws(() => loadDiscoveredRoutes({ cwd: f.cwd }), /identity-only settings belong in identity.json/, key);
    const run = spawnSync(process.execPath, [path.join(f.bundle, 'lanes/lane.mjs'), 'config'], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
    assert.notEqual(run.status, 0, key);
    assert.match(run.stderr, /identity-only settings belong in identity.json/);
  }
});

for (const mode of ['legacy', 'home', 'standalone', 'routing-fallback']) test(`${mode} config and route editors reject identity settings before any intent or replacement`, async t => {
  const routing = ['standalone', 'routing-fallback'].includes(mode), f = configFixture(t, { routing });
  if (mode === 'routing-fallback') await assert.rejects(f.adopt({ afterPublish(kind) { if (kind === 'lane') throw Error('partial adoption'); } }), /partial adoption/);
  else if (mode !== 'legacy') await f.adopt();
  const binding = f.binding(), kind = routing ? 'routing' : 'lane';
  const selected = policyLocation(f.cwd, kind).file, target = policyLocation(f.cwd, kind, f.env, { write: true }).file;
  configSnapshot({ cwd: f.cwd });
  const files = [...new Set([path.join(f.env.ORG_DIR, 'events.jsonl'), selected, target, policyLocation(f.cwd, 'lane').file, path.join(f.cwd, '.lane.json'),
    ...(binding ? [binding.identityFile, path.join(path.dirname(binding.identityFile), '.org/events.jsonl')] : [])])];
  const bytes = () => files.map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  for (const [key, value] of Object.entries({ launch: ['project-launch'], identity_root: f.ownerRoot, defaults_origin: {}, project_access: [], brain_write: {} })) {
    const before = bytes(); let intent = false, replacement = false;
    const options = { cwd: f.cwd, afterIntent() { intent = true; }, afterReplace() { replacement = true; } };
    assert.throws(() => setConfig(`${kind}.${key}`, JSON.stringify(value), options), /identity-only settings belong in identity.json/, key);
    assert.equal(intent, false); assert.equal(replacement, false);
    assert.deepEqual(bytes(), before);
    for (const adoptRoutes of routing ? [true, false] : [true]) {
      assert.throws(() => editProjectConfig(next => { next[key] = value; }, { cwd: f.cwd, adoptRoutes }), /identity-only settings belong in identity.json/, key);
      assert.deepEqual(bytes(), before);
    }
    assert.deepEqual(pendingConfigWrite(f.env.ORG_DIR, target), []);
  }
  const before = bytes();
  const refused = spawnSync(process.execPath, [path.join(f.bundle, 'bin/org.mjs'), 'config', 'set', `${kind}.launch`, '["project-launch"]'], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /identity-only settings belong in identity.json/);
  assert.deepEqual(bytes(), before);
  // The same writers still accept project-owned route changes.
  setConfig('routes.engineer.model', 'configured-project-model', { cwd: f.cwd });
  setProjectRoute('engineer', { model: 'edited-project-model' }, { cwd: f.cwd });
  const saved = spawnSync(process.execPath, [path.join(f.bundle, 'bin/org.mjs'), 'routes', 'set', 'engineer', '--model', 'cli-project-model', '--json'], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(loadDiscoveredRoutes({ cwd: f.cwd }).config.routes.engineer.model, 'cli-project-model');
  assert.equal(fs.existsSync(path.join(f.cwd, '.config.lock')), false);
});

test('a first legacy route edit materializes suggested routes without copying the identity launcher', t => {
  const f = configFixture(t), prefix = [process.execPath, 'identity-launch.mjs'];
  fs.writeFileSync(path.join(f.ownerRoot, '.lane.json'), JSON.stringify({ launch: prefix }));
  fs.writeFileSync(path.join(f.cwd, '.lane.json'), '{"main":"main"}');
  assert.equal(routesSnapshot(f.cwd).suggested, true);
  setProjectRoute('engineer', { model: 'confirmed-project-model' }, { cwd: f.cwd });
  const own = readConfigJSON(path.join(f.cwd, '.lane.json'));
  assert.equal(Object.hasOwn(own, 'launch'), false);
  assert.ok(own.routes.review); assert.ok(own.selection_policy);
  assert.deepEqual(loadDiscoveredRoutes({ cwd: f.cwd }).config.launch, prefix);
});
