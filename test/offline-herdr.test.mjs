import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitProject } from '../lib/project.mjs';
import { identityRootAt } from '../messages/journal.mjs';
import { digest } from '../messages/schema.mjs';

const fixtureIdentity = 'fixture';
const checkout = path.resolve(import.meta.dirname, '..');
const hasGitCheckout = !!fs.lstatSync(path.join(checkout, '.git'), { throwIfNoEntry: false });
function identityPartitionGuard() {
  // Release snapshots have no Git identity; the fixture-HOME fallback
  // assertions below remain their isolation guard.
  if (!hasGitCheckout) return () => {};
  const commonDir = gitProject(checkout).identity;
  const identityRoot = identityRootAt(commonDir);
  // Unmarked checkouts have no identity-local default; the fixture HOME
  // fallback assertions below remain their isolation guard.
  if (!identityRoot) return () => {};
  const partition = path.join(identityRoot, '.herdr-brain/logs', fixtureIdentity, digest(commonDir));
  // Cover every owned log file, including stage 5 segments and subscriber
  // cursors, rather than observing only the stage 7 shadow journal.
  const snapshot = () => {
    const files = [];
    function visit(directory) {
      for (const name of fs.readdirSync(directory).sort()) {
        const file = path.join(directory, name), stat = fs.lstatSync(file);
        if (stat.isDirectory()) visit(file);
        else files.push([path.relative(partition, file), stat.mode, stat.isFile() ? digest(fs.readFileSync(file)) : 'non-regular']);
      }
    }
    if (fs.existsSync(partition)) visit(partition);
    return { exists: fs.existsSync(partition), files };
  };
  const before = snapshot();
  return () => assert.deepEqual(snapshot(), before, 'child must leave the fixture identity partition unchanged');
}

function shadowFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offline-shadow-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), offline = path.join(root, 'offline');
  fs.mkdirSync(home); fs.mkdirSync(offline, { mode: 0o700 });
  return { root, home, offline };
}

for (const mode of ['fresh', 'inherited', 'explicit']) test(`shadow isolation supplies private defaults and child environments: ${mode}`, t => {
  const f = shadowFixture(t), helper = path.resolve(import.meta.dirname, 'helpers/offline-herdr.mjs');
  // Clear the inherited root inside the child, after test-only preloads have
  // propagated containment. This exercises a genuinely unset shared default.
  const code = `
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
    import {spawn, spawnSync} from 'node:child_process';
    import {offlineHerdr} from ${JSON.stringify(helper)};
    delete process.env.BRAIN_SHADOW_ROOT;
    if (${JSON.stringify(mode)} === 'fresh') delete process.env.HERDR_TEST_OFFLINE_ROOT;
    else process.env.HERDR_TEST_OFFLINE_ROOT = ${JSON.stringify(f.offline)};
    if (${JSON.stringify(mode)} === 'explicit') process.env.BRAIN_SHADOW_ROOT = ${JSON.stringify(path.join(f.root, 'explicit'))};
    const cleanup = offlineHerdr(), root = process.env.BRAIN_SHADOW_ROOT;
    assert.equal(root, ${JSON.stringify(mode)} === 'explicit' ? ${JSON.stringify(path.join(f.root, 'explicit'))} : path.join(process.env.HERDR_TEST_OFFLINE_ROOT, 'shadow'));
    assert.equal(fs.statSync(process.env.HERDR_TEST_OFFLINE_ROOT).mode & 0o077, 0);
    const {LogJournal} = await import(${JSON.stringify(new URL('../logs/journal.mjs', import.meta.url).href)});
    const commonDir = path.join(${JSON.stringify(f.root)}, 'project/.git');
    fs.mkdirSync(commonDir, {recursive:true});
    const journal = new LogJournal({identity:'fixture',commonDir});
    assert.ok(journal.directory.startsWith(root + path.sep));
    await journal.append({schema:'brain.log/v1',eventId:'isolation',producer:{id:'fixture',epoch:'isolation',sequence:1},occurredAt:'2026-10-16T00:00:00Z',type:'herdr.observation',level:'info',identity:'fixture',project:{commonDir},payload:{}});
    const args = ['-e', 'process.stdout.write(process.env.BRAIN_SHADOW_ROOT || "missing")'];
    // Minimal envs and ordinary inherited envs must both retain isolation.
    for (const env of [undefined, {HOME: process.env.HOME, PATH: process.env.PATH, BRAIN_IDENTITY: process.env.BRAIN_IDENTITY}]) {
      const sync = spawnSync(process.execPath, args, {env, encoding: 'utf8'});
      assert.equal(sync.status, 0, sync.stderr); assert.equal(sync.stdout, root);
      const child = spawn(process.execPath, args, {env, stdio: ['ignore', 'pipe', 'pipe']});
      let out = '', err = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
      const status = await new Promise((resolve, reject) => {child.on('error', reject); child.on('close', resolve);});
      assert.equal(status, 0, err); assert.equal(out, root);
    }
    const override = spawnSync(process.execPath, args, {env: {...process.env, BRAIN_SHADOW_ROOT: ${JSON.stringify(path.join(f.root, 'child-override'))}}, encoding: 'utf8'});
    assert.equal(override.status, 0, override.stderr); assert.equal(override.stdout, ${JSON.stringify(path.join(f.root, 'child-override'))});
    cleanup();
  `;
  const unchanged = identityPartitionGuard();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: f.home, BRAIN_IDENTITY: fixtureIdentity }, encoding: 'utf8' });
  unchanged();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(f.home, '.local/state/herdr-brain/logs')), false);
});

test('watch, request and promotion suites mirror fixtures without writing default state roots', t => {
  const f = shadowFixture(t);
  const files = ['watch/test/watch.test.mjs', 'supervisor/test/request.test.mjs', 'promote/test/promote.test.mjs'];
  const pattern = '^(a valid report is checked and delivered without Herdr being present|a delivered identity request mirrors its marked non-Git desk on the supervisor path|idle supervisor receives a default queued promotion notice without a false alert)$';
  const code = `
    import {spawnSync} from 'node:child_process';
    delete process.env.BRAIN_SHADOW_ROOT; delete process.env.NODE_TEST_CONTEXT;
    process.env.HERDR_TEST_OFFLINE_ROOT = ${JSON.stringify(f.offline)};
    const result = spawnSync(process.execPath, ['--test', ${JSON.stringify(`--test-name-pattern=${pattern}`)}, ...${JSON.stringify(files)}], {env: process.env, encoding: 'utf8'});
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    process.exitCode = result.status ?? 1;
  `;
  const unchanged = identityPartitionGuard();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, HOME: f.home, BRAIN_IDENTITY: fixtureIdentity }, encoding: 'utf8',
  });
  unchanged();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass 3\b/);
  assert.equal(fs.existsSync(path.join(f.home, '.local/state/herdr-brain/logs')), false, 'suite notices must never reach the default home state root');
  const entries = [];
  function journals(directory) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      if (fs.statSync(file).isDirectory()) journals(file);
      else if (name === 'shadow.jsonl') entries.push(...fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse));
    }
  }
  journals(path.join(f.offline, 'shadow'));
  // This watcher resolves its project from the product checkout's Git;
  // request and promotion fixtures supply their own project identities.
  if (hasGitCheckout) assert.ok(entries.some(entry => entry.payload?.legacy?.id === 'watch:R-7:final'), 'pre-existing watcher fixture actually mirrored');
  assert.ok(entries.some(entry => entry.payload?.kind === 'request' && entry.shadow.path === 'supervisor'), 'real request helper actually mirrored');
  assert.ok(entries.some(entry => entry.payload?.legacy?.id.startsWith('promote:')), 'pre-existing promotion fixture actually mirrored');
});

test('offline boundary shields an inherited operator CLI, socket and pane IDs, but permits fixture fakes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-herdr-control-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const touched = path.join(root, 'operator-touched');
  fs.writeFileSync(path.join(root, 'herdr'), `#!/bin/sh\ntouch '${touched}'\nexit 0\n`, { mode: 0o755 });
  const module = path.resolve(import.meta.dirname, 'helpers/offline-herdr.mjs');
  const code = `import {offlineHerdr} from ${JSON.stringify(module)};import {spawnSync} from 'node:child_process';import assert from 'node:assert/strict';import fs from 'node:fs';
    delete process.env.HERDR_TEST_OFFLINE_ROOT;offlineHerdr();assert.ok(!process.env.HERDR_PANE_ID);assert.ok(!process.env.HERDR_WORKSPACE_ID);assert.ok(!process.env.HERDR_ENV);
    assert.notEqual(process.env.HERDR_SOCKET_PATH,'/operator.sock');assert.match(process.env.ORG_ACTOR,/offline-test/);
    for(const args of [['workspace','create'],['workspace','close','operator'],['agent','prompt','operator','bad']])assert.equal(spawnSync('herdr',args).status,1);
    assert.equal(spawnSync('sh',['-c','herdr workspace create']).status,1);
    assert.ok(!fs.existsSync(${JSON.stringify(touched)}),'inherited operator CLI was touched');
    assert.equal(spawnSync('herdr',['workspace','create'],{env:{...process.env,PATH:${JSON.stringify(root)}+':'+process.env.PATH}}).status,0);`;
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, HERDR_ENV: '1', HERDR_PANE_ID: 'operator', HERDR_WORKSPACE_ID: 'operator', HERDR_SOCKET_PATH: '/operator.sock' };
  delete env.HERDR_TEST_OFFLINE_ROOT;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(touched), 'explicit fixture fake was invoked');
});
