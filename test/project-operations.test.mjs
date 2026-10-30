import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configFixture } from './helpers/config-home-fixture.mjs';
import { contentDigest, policyLocation } from '../lib/config-home.mjs';
import { selectRelease } from '../lib/releases.mjs';
import { productFiles, releaseMetadata } from '../lib/product-files.mjs';
import { ROUTE_PRESET } from '../lanes/preset.mjs';
import { loadDiscoveredRoutes, resolveLaunchRoute } from '../lanes/routes.mjs';

// Offline record admission only. Adoption's native observer and human answer
// are isolated fixture inputs, not a live owner's authorization or acceptance.
test('one audited project route revision reaches the next record admission on the same release and rolls back', async t => {
  const f = configFixture(t);
  const repoFile = path.join(f.cwd, '.lane.json');
  const policy = JSON.parse(fs.readFileSync(repoFile));
  policy.routes = { engineer: { ...ROUTE_PRESET.routes.engineer } };
  fs.writeFileSync(repoFile, JSON.stringify(policy, null, 2) + '\n');
  f.git('add', '.lane.json'); f.git('commit', '-qm', 'Project-owned demonstration route');
  await f.adopt();
  const binding = f.binding(), file = policyLocation(f.cwd, 'lane', f.env).file;
  const original = fs.readFileSync(file), revision = contentDigest(original);
  const selected = selectRelease(f.cwd, f.installationHome);
  assert.equal(selected.id, 'compatible'); assert.equal(selected.root, f.bundle);
  // Include the entire installed runtime and its acceptance/manifest metadata.
  const releaseFiles = [...productFiles(f.bundle), ...releaseMetadata.filter(name => fs.existsSync(path.join(f.bundle, name)))];
  const stableFiles = [...releaseFiles.map(name => path.join(f.bundle, name)), repoFile,
    binding.file, binding.identityFile, policyLocation(f.cwd, 'pin', f.env).file,
    path.join(f.cwd, '.herdr-release.json')];
  const stable = () => stableFiles.map(name => [name, contentDigest(fs.readFileSync(name))]);
  const unchanged = stable();
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [path.join(selected.root, 'bin/org.mjs'), ...args], {
      cwd: f.cwd, env: f.env, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
  };
  const view = () => JSON.parse(cli('config', '--json').stdout);
  const row = snapshot => snapshot.values.find(value => value.key === 'routes.engineer.effort');
  const before = view();
  const launch = () => resolveLaunchRoute(loadDiscoveredRoutes({ cwd: f.cwd, env: f.env }).config, { route: 'engineer' });
  const originalLaunch = launch();
  assert.equal(before.binding, binding.file);
  assert.deepEqual([row(before).value, row(before).source, row(before).source_key, row(before).scope],
    ['high', file, 'routes.engineer.effort', 'project']);
  assert.equal(before.warnings.some(warning => warning.includes(file)), false);
  const admit = title => {
    const item = cli('add', title, '--role', 'engineer').stdout.trim();
    const output = cli('start', item, '--route', 'engineer').stdout;
    const id = output.match(/^(R-\d+) started/m)[1];
    const run = JSON.parse(cli('show', id, '--json').stdout);
    return { id, run, brief: fs.readFileSync(run.brief_path) };
  };
  const old = admit('Work admitted before the operating revision');
  assert.equal(old.run.meta.effort, 'high');
  assert.ok(old.brief.includes(`# Brief: run ${old.id} on ${old.run.item}`));
  assert.equal(originalLaunch.effort, 'high');
  const oldEvent = f.events().find(event => event.type === 'run.started' && event.id === old.id);
  const who = 'ENG-1041 offline fixture owner: raise engineer effort';
  const edit = cli('config', 'set', 'routes.engineer.effort', 'xhigh', '--expect', revision, '--who-asked', who, '--json');
  assert.equal(JSON.parse(edit.stdout).file, file);
  assert.match(edit.stderr, /repo-reading project scripts will not see this change/);
  const after = view(), nextRevision = contentDigest(fs.readFileSync(file));
  const values = snapshot => Object.fromEntries(snapshot.values.map(value => [value.key, value.value]));
  assert.deepEqual(values(after), { ...values(before), 'routes.engineer.effort': 'xhigh' });
  assert.equal(row(after).source, file);
  assert.ok(after.warnings.some(warning => warning.includes(file) && warning.includes(repoFile) && warning.includes('differs from retained repo copy')));
  const audit = f.events().findLast(event => event.type === 'config.changed' && event.file === file);
  assert.deepEqual(audit.changes, [{ key: 'routes.engineer.effort', old_value: 'high', new_value: 'xhigh' }]);
  assert.equal(audit.by, 'fixture-supervisor'); assert.equal(audit.scope, 'project');
  assert.equal(audit.caller, binding.common); assert.equal(audit.who_asked, who);
  assert.equal(audit.old_digest, revision); assert.equal(audit.new_digest, nextRevision);
  assert.equal(audit.origin, 'command');
  const fresh = admit('Work admitted after the operating revision');
  assert.notEqual(fresh.id, old.id); assert.equal(fresh.run.meta.effort, 'xhigh');
  assert.ok(fresh.brief.includes(`# Brief: run ${fresh.id} on ${fresh.run.item}`));
  assert.deepEqual(launch(), { ...originalLaunch, effort: 'xhigh' });
  assert.deepEqual(selectRelease(f.cwd, f.installationHome), selected);
  assert.deepEqual(JSON.parse(cli('show', old.id, '--json').stdout), old.run);
  assert.deepEqual(fs.readFileSync(old.run.brief_path), old.brief);
  assert.deepEqual(f.events().find(event => event.type === 'run.started' && event.id === old.id), oldEvent);
  assert.deepEqual(stable(), unchanged);
  // Roll back only the operating key through the same audited CAS writer.
  cli('config', 'set', 'routes.engineer.effort', 'high', '--expect', nextRevision,
    '--who-asked', 'ENG-1041 offline fixture owner: restore original effort');
  assert.deepEqual(fs.readFileSync(file), original);
  const restored = view();
  assert.deepEqual(values(restored), values(before)); assert.deepEqual(restored.warnings, before.warnings);
  assert.deepEqual(launch(), originalLaunch);
  assert.deepEqual(JSON.parse(cli('show', fresh.id, '--json').stdout), fresh.run);
  assert.deepEqual(fs.readFileSync(fresh.run.brief_path), fresh.brief);
  assert.deepEqual(JSON.parse(cli('show', old.id, '--json').stdout), old.run);
  assert.deepEqual(fs.readFileSync(old.run.brief_path), old.brief);
  assert.deepEqual(selectRelease(f.cwd, f.installationHome), selected);
  assert.deepEqual(stable(), unchanged);
  const rollback = f.events().findLast(event => event.type === 'config.changed' && event.file === file);
  assert.equal(rollback.old_digest, nextRevision); assert.equal(rollback.new_digest, revision);
  assert.equal(rollback.by, audit.by); assert.equal(rollback.caller, audit.caller);
  assert.deepEqual(rollback.changes, [{ key: 'routes.engineer.effort', old_value: 'xhigh', new_value: 'high' }]);
  t.diagnostic(JSON.stringify({ proof: 'offline config/record-brief control; no native session acceptance',
    release: selected.id, release_commit: selected.commit, immutable_release_files: releaseFiles.length,
    before: { run: old.id, effort: old.run.meta.effort, revision },
    after: { run: fresh.id, effort: fresh.run.meta.effort, revision: nextRevision },
    audit: { actor: audit.by, caller: audit.caller, seq: audit.seq, changes: audit.changes },
    rollback: { seq: rollback.seq, revision: rollback.new_digest } }));
});
