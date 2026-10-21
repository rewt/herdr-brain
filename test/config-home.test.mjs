import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configFixture } from './helpers/config-home-fixture.mjs';
import { homeProject, policyLocation, readConfigJSON, configDrift } from '../lib/config-home.mjs';
import { readProjectPolicy, configBase } from '../lib/config-policy.mjs';
import { configSnapshot, setConfig, configCommand } from '../lib/config-command.mjs';
import { loadDiscoveredRoutes } from '../lanes/routes.mjs';
import { resolveValidation, validateTree } from '../lanes/validation.mjs';
import { discoverArchive } from '../lib/archive.mjs';
import { literalLaunch } from '../lib/owner-launch.mjs';
import { requireHomeRelease, projectPin } from '../lib/releases.mjs';
import { freezeReleaseValidation } from '../herdr/validation-admission.mjs';

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
  const output = []; const original = process.stderr.write;
  process.stderr.write = text => { output.push(String(text)); return true; };
  const stdout = process.stdout.write; process.stdout.write = () => true;
  try { await configCommand([], { cwd: f.cwd }); } finally { process.stderr.write = original; process.stdout.write = stdout; }
  assert.ok(output.some(line => line.includes(repo) && line.includes(policyLocation(f.cwd, 'lane').file)));
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
});
