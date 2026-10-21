import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configFixture } from './helpers/config-home-fixture.mjs';
import { homeProject, policyLocation, readConfigJSON, contentDigest } from '../lib/config-home.mjs';
import { readProjectPolicy, configBase } from '../lib/config-policy.mjs';
import { configSnapshot, setConfig, configCommand } from '../lib/config-command.mjs';
import { loadDiscoveredRoutes } from '../lanes/routes.mjs';
import { resolveValidation, validateTree } from '../lanes/validation.mjs';
import { discoverArchive } from '../lib/archive.mjs';
import { literalLaunch } from '../lib/owner-launch.mjs';
import { requireHomeRelease, projectPin } from '../lib/releases.mjs';
import { freezeReleaseValidation } from '../herdr/validation-admission.mjs';
import { adoptCommand } from '../lib/adopt-command.mjs';
import { readFleet } from '../lib/fleet.mjs';
import { initOrg } from '../lib/store.mjs';
import { inspect } from '../sessions/sessions.mjs';
import { readSessionFacts } from '../sessions/observe.mjs';
import { routesSnapshot } from '../lanes/routes-command.mjs';
import { housekeepingSnapshot } from '../housekeeping/command.mjs';
import { discoverProject } from '../housekeeping/housekeeping.mjs';
import { queueFor } from '../promote/promote.mjs';
import { resolveGateProfile } from '../promote/gate-profile.mjs';

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
  setConfig('retirement.closeout_queue', 'true', { cwd: f.cwd, scope: 'identity' });
  assert.ok(!configSnapshot({ cwd: f.cwd }).values.some(v => v.key === 'retirement.closeout_queue'));
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

test('home pins precede Git absence prechecks; compatible release rollback and frozen release declarations retain canonical bases', async t => {
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
