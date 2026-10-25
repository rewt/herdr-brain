import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { releaseEnvironment } from './helpers/release-environment.mjs';
import { copyProduct, productFiles, captureProductCheckout, createProductCheckout, verifyProductPayload } from '../lib/product-files.mjs';
import { freezeReleaseValidation, verifyReleaseCoverage } from '../herdr/validation-admission.mjs';
import { createHash } from 'node:crypto';
import { configFixture } from './helpers/config-home-fixture.mjs';
import { policyLocation, contentDigest } from '../lib/config-home.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '../herdr/release.sh');
function scratch(t, beforeCleanup = () => {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bare-release-')));
  t.after(() => {
    beforeCleanup(root);
    execFileSync('chmod', ['-R', 'u+w', root]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const repo = path.join(root, 'repo'), home = path.join(root, 'releases-home'), bin = path.join(root, 'bin');
  copyProduct(path.resolve(import.meta.dirname, '..'), repo); fs.mkdirSync(bin);
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', timeout: 10000 });
  git('init', '-qb', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  const gateLog = path.join(root, 'gates');
  write('herdr/release.sh', fs.readFileSync(SCRIPT, 'utf8'));
  write('package.json', JSON.stringify({ scripts: { 'test:release': `node gate.cjs` } }));
  write('gate.cjs', `const fs=require('fs');fs.appendFileSync(${JSON.stringify(gateLog)},process.cwd()+'\\n');if(process.env.FIXTURE_GATE_FAIL)process.exit(7);`);
  write('contrib/settle-watch.mjs', '// compatibility');
  write('acceptance/run.mjs', `import fs from 'node:fs';import {execFileSync} from 'node:child_process';fs.appendFileSync(${JSON.stringify(gateLog)},'live:'+process.cwd()+'\\n');if(process.env.FIXTURE_LIVE_FAIL)process.exit(8);fs.writeFileSync(process.argv[process.argv.indexOf('--summary-file')+1],JSON.stringify({ready:true,candidateCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),elapsedSeconds:1,counts:{PASS:1,FAIL:0,PENDING:0,SKIP:0}}));`);
  for (const tag of ['t1', 't2']) {
    write('bin/org.mjs', `console.log('${tag}');`); write('lanes/lane.mjs', `console.log('lane ${tag}');`);
    git('add', '.'); git('commit', '-qm', tag); git('tag', tag);
  }
  const herdr = path.join(bin, 'herdr'), pluginState = path.join(root, 'plugin'), calls = path.join(root, 'herdr-calls');
  fs.writeFileSync(pluginState, 'linked');
  fs.writeFileSync(herdr, `#!${process.execPath}
const fs=require('fs'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},a.join(' ')+'\\n');
if(a[1]==='list')console.log(JSON.stringify({result:{plugins:fs.readFileSync(${JSON.stringify(pluginState)},'utf8')==='linked'?[{plugin_root:'/old'}]:[]}}));
else if(a[1]==='unlink'){if(process.env.FIXTURE_UNLINK_FAIL)process.exit(9);fs.writeFileSync(${JSON.stringify(pluginState)},'unlinked');}
`, { mode: 0o755 });
  // Use a .cjs extension for the fake Node CLI under any parent package type.
  fs.renameSync(herdr, `${herdr}.cjs`);
  const plist = path.join(root, 'old.plist');
  const env = releaseEnvironment(process.env, { HOME: root, HERDR_MONITOR_REPO: repo, HERDR_MONITOR_HOME: home,
    HERDR_MONITOR_BIN: bin, HERDR_MONITOR_PLIST: plist, HERDR_BIN_PATH: `${herdr}.cjs`, HERDR_MONITOR_FLEET: path.join(root, 'fleet') });
  // This is an independent mock release, with its own durable observations.
  for (const key of ['MONITOR_TEST_TIMINGS_PATH', 'MONITOR_TEST_WATCH_OWNER', 'MONITOR_TEST_TIMING_DEPTH']) delete env[key];
  const run = (a, extra = {}) => spawnSync('bash', [SCRIPT, ...a], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
  const ok = (a, extra) => { const r = run(a, extra); assert.equal(r.status, 0, r.stdout + r.stderr); return r; };
  const release = tag => path.join(home, 'releases', tag);
  const checkout = tag => path.join(home, 'builds', tag, 'checkout');
  return { root, repo, home, bin, plist, env, run, ok, release, checkout, gateLog, calls, git, write };
}
test('build gates a genuine tagged checkout once, then publishes an equal read-only archive', t => {
  const f = scratch(t); f.write('bin/org.mjs', "console.log('uncommitted');");
  f.ok(['build', 't1']);
  assert.equal(fs.readFileSync(path.join(f.release('t1'), 'bin/org.mjs'), 'utf8'), "console.log('t1');");
  assert.equal(fs.readFileSync(path.join(f.release('t1'), '.nvmrc'), 'utf8'), '20.19.4\n');
  assert.equal(fs.readFileSync(f.gateLog, 'utf8'), `${f.checkout('t1')}\n`);
  assert.equal(fs.existsSync(path.join(f.checkout('t1'), '.git')), true);
  assert.equal(fs.existsSync(path.join(f.checkout('t1'), '.release-commit')), false);
  const proof = JSON.parse(fs.readFileSync(path.join(f.release('t1'), '.release-validation.json'))).validation;
  assert.equal(proof.cwd, f.checkout('t1')); assert.equal(proof.commit, f.git('rev-parse', 't1').trim());
  assert.equal(fs.statSync(path.join(f.release('t1'), 'bin/org.mjs')).mode & 0o222, 0);
  assert.match(fs.readFileSync(path.join(f.release('t1'), '.release-commit'), 'utf8'), /^[a-f0-9]{40}\n$/);
  const receipts = path.join(f.repo, '.git/lane-validation');
  const receipt = JSON.parse(fs.readFileSync(path.join(receipts, fs.readdirSync(receipts).find(name => name.endsWith('.execution.json')))));
  assert.equal(receipt.exit_code, 0); assert.equal(receipt.limits.wall_seconds, 0);
  assert.ok(receipt.duration_s >= 0); assert.ok(receipt.longest_silence_s >= 0);
  assert.ok(receipt.timings_path.startsWith(receipts + path.sep), 'release observations survive the temporary snapshot runner');
  assert.match(f.run(['build', 't1']).stderr, /already exists/);
  assert.match(f.run(['build', 'main']).stderr, /no tag/);
  assert.match(f.run(['build', '../escape']).stderr, /invalid release/);
});
test('a failed gate retains partial evidence and never makes an activatable release or reruns it', t => {
  const f = scratch(t), r = f.run(['build', 't1'], { FIXTURE_GATE_FAIL: '1' });
  assert.notEqual(r.status, 0); assert.equal(fs.existsSync(f.release('t1')), false);
  assert.equal(fs.existsSync(`${f.release('t1')}.partial`), true);
  assert.notEqual(f.run(['activate', 't1']).status, 0);
  assert.match(f.run(['build', 't1']).stderr, /inspect the unfinished build/);
  assert.equal(fs.readFileSync(f.gateLog, 'utf8').trim().split('\n').length, 1);
});
test('a covered build retains one full execution, refuses stale or unresolved evidence, and runs actual live acceptance', async t => {
  const f = scratch(t);
  f.ok(['build', 't1']);
  const work = path.join(f.home, 'builds/t1'), identityFile = path.join(work, 'identity.json');
  const identity = JSON.parse(fs.readFileSync(identityFile)).identity;
  const frozen = JSON.parse(fs.readFileSync(path.join(work, 'validation.json')));
  const execution = JSON.parse(fs.readFileSync(path.join(work, 'execution.json')));
  const sha = value => createHash('sha256').update(value).digest('hex');
  const reconciliation = Object.fromEntries(['source', 'runner', 'environment', 'dependencies', 'cleanup'].map(key =>
    [key, `The private fixture retains identical ${key} inputs; no source or dependency change occurred.`]));
  const base = { schema: 'release-full-coverage/v1', commit: identity.commit, tree: identity.tree, common: frozen.common,
    command: 'npm run test:release', admissionSha256: frozen.sha256, complete: true, unresolved: [],
    runtime: { executable: process.execPath, version: process.version, sha256: sha(fs.readFileSync(process.execPath)), platform: process.platform, arch: process.arch },
    evidence: [{ id: 'full', file: execution.receipt, sha256: execution.sha256, source: identity.commit, identityFile,
      identitySha256: sha(fs.readFileSync(identityFile)), changedFiles: [], reconciliation }],
    files: [{ file: 'command:npm run test:release', receipts: ['full'], scope: 'The entire custom full release command completed in the genuine private checkout.' }] };
  const cli = path.resolve(import.meta.dirname, '../bin/org.mjs');
  const org = path.join(f.repo, '.org'), env = { ...f.env, ORG_DIR: org, ORG_ACTOR: 'fixture-supervisor' };
  const record = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: f.repo, env, encoding: 'utf8' });
  record('init', org); record('add', 'Coverage fixture');
  const publish = value => {
    const attestationDigest = sha(JSON.stringify(value));
    record('note', 'ENG-1', `Release full coverage reconciled: ${attestationDigest}`, '--decision');
    const events = fs.readFileSync(path.join(org, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const file = path.join(f.root, 'coverage.json');
    fs.writeFileSync(file, JSON.stringify({ ...value, attestationDigest, attestationSeq: events.at(-1).seq }) + '\n');
    return file;
  };
  const verify = file => verifyReleaseCoverage(file, { identity, frozen, canonical: f.repo, env });
  await assert.rejects(verify(publish({ ...base, files: [] })), /full inventory/);
  await assert.rejects(verify(publish({ ...base, commit: 'f'.repeat(40) })), /mismatched/);
  await assert.rejects(verify(publish({ ...base, unresolved: ['real failure remains'] })), /incomplete/);
  const red = path.join(f.root, 'red.execution.json');
  fs.writeFileSync(red, JSON.stringify({ ...JSON.parse(fs.readFileSync(execution.receipt)), exit_code: 1 }));
  const redBase = { ...base, evidence: [{ ...base.evidence[0], file: red, sha256: sha(fs.readFileSync(red)) }] };
  await assert.rejects(verify(publish(redBase)), /known-red/);
  await assert.rejects(verify(publish({ ...base, evidence: [{ ...base.evidence[0], changedFiles: ['invented.mjs'] }] })), /reconciliation is stale/);
  const file = publish(base);
  const proof = await verify(file);
  assert.equal(proof.kind, 'supervisor-reconciled-full-coverage');
  f.git('tag', 'covered', identity.commit);
  f.ok(['build', 'covered', '--live', '--coverage', file]);
  const validation = JSON.parse(fs.readFileSync(path.join(f.release('covered'), '.release-validation.json'))).validation;
  assert.equal(validation.execution, undefined, 'a continuation never pretends a whole command executed');
  assert.equal(validation.coverage.kind, 'supervisor-reconciled-full-coverage');
  assert.equal(fs.existsSync(path.join(f.home, 'builds/covered/execution.json')), false);
  assert.deepEqual(fs.readFileSync(f.gateLog, 'utf8').trim().split('\n'), [f.checkout('t1'), `live:${f.checkout('covered')}`]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.release('covered'), '.release-manifest.json'))).acceptance.ready, true);
});
test('the release gate queues for the host test slot by default; an explicit wait wins', t => {
  const f = scratch(t), seen = path.join(f.root, 'slot-wait');
  f.write('gate.cjs', `require('fs').appendFileSync(${JSON.stringify(seen)},String(process.env.MONITOR_TEST_SLOT_WAIT_SECONDS)+'\\n');`);
  f.git('add', '.'); f.git('commit', '-qm', 'slot'); f.git('tag', 't3'); f.git('tag', 't4'); f.git('tag', 't5');
  const unset = { MONITOR_TEST_SLOT_WAIT_SECONDS: undefined, BCH_CLOAK_TEST_SLOT_WAIT_SECONDS: undefined };
  f.ok(['build', 't3'], unset);
  f.ok(['build', 't4'], { ...unset, MONITOR_TEST_SLOT_WAIT_SECONDS: '0' });
  f.ok(['build', 't5'], { ...unset, BCH_CLOAK_TEST_SLOT_WAIT_SECONDS: '60' });
  assert.equal(fs.readFileSync(seen, 'utf8'), '3600\n0\n60\n');
});
test('build uses the tagged release declaration instead of the npm fallback or working copy', t => {
  const f = scratch(t);
  f.write('.lane.validation.json', JSON.stringify({ release: 'node gate.cjs && node declared.cjs', timeout_seconds: { release: 10 } }));
  f.write('declared.cjs', `require('fs').appendFileSync(${JSON.stringify(f.gateLog)},'declared\\n');`);
  f.git('add', '.'); f.git('commit', '-qm', 'Declared release gate'); f.git('tag', 'declared');
  f.write('.lane.validation.json', JSON.stringify({ release: 'exit 9' }));
  f.ok(['build', 'declared'], { LANE_VALIDATE: 'exit 9' });
  assert.equal(fs.readFileSync(f.gateLog, 'utf8'), `${f.checkout('declared')}\ndeclared\n`);
});
test('legacy scalar and release-specific wall allowances never stop a progressing gate', t => {
  const f = scratch(t);
  f.write('slow.cjs', `require('fs').appendFileSync(${JSON.stringify(f.gateLog)},process.cwd()+'\\n');setTimeout(()=>console.log('completed past old cap'),700);`);
  for (const [tag, timeout] of [['scalar', 0.5], ['tier', { release: 0.5 }]]) {
    f.write('.lane.validation.json', JSON.stringify({ release: 'node slow.cjs', timeout_seconds: timeout }));
    f.git('add', '.'); f.git('commit', '-qm', tag); f.git('tag', tag);
    const r = f.run(['build', tag]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stderr, /GATE_TIMEOUT:/);
    assert.equal(fs.existsSync(f.release(tag)), true);
    assert.equal(fs.existsSync(`${f.release(tag)}.partial`), false);
  }
  assert.equal(fs.readFileSync(f.gateLog, 'utf8'), `${f.checkout('scalar')}\n${f.checkout('tier')}\n`);
});
test('an invalid release declaration refuses before running a gate', t => {
  const f = scratch(t);
  f.write('.lane.validation.json', JSON.stringify({ release: 'node gate.cjs', timeout_seconds: { release: -1 } }));
  f.git('add', '.'); f.git('commit', '-qm', 'Invalid gate'); f.git('tag', 'invalid');
  assert.match(f.run(['build', 'invalid']).stderr, /non-negative.*number of seconds/);
  assert.equal(fs.existsSync(f.gateLog), false);
});
test('--live is explicit, follows the offline gate, and a live failure prevents completion', t => {
  const f = scratch(t); f.ok(['build', 't1', '--live']);
  assert.equal(fs.readFileSync(f.gateLog, 'utf8'), `${f.checkout('t1')}\nlive:${f.checkout('t1')}\n`);
  assert.notEqual(f.run(['build', 't2', '--live'], { FIXTURE_LIVE_FAIL: '1' }).status, 0);
  assert.equal(fs.existsSync(f.release('t2')), false);
  assert.ok(fs.existsSync(f.checkout('t2')), 'failed acceptance retains its original source');
  assert.equal(fs.existsSync(path.join(`${f.release('t2')}.partial`, '.release-manifest.json')), false);
});
test('activation switches three launchers, retires the old plugin once, and rollback preserves previous on repeat', t => {
  const f = scratch(t); f.ok(['build', 't1']); f.ok(['build', 't2']);
  f.ok(['activate', 't1']);
  for (const name of ['org', 'record', 'lane']) {
    assert.ok(fs.readlinkSync(path.join(f.bin, name)).startsWith(path.join(f.home, 'routing') + path.sep));
    const result = spawnSync(process.execPath, [path.join(f.bin, name), '--help'], { cwd: f.root, env: f.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /t1/);
  }
  f.ok(['activate', 't2']); f.ok(['activate', 't2']);
  assert.equal(fs.readlinkSync(path.join(f.home, 'previous')), f.release('t1'));
  f.ok(['rollback']); assert.equal(fs.readlinkSync(path.join(f.home, 'current')), f.release('t1'));
  assert.equal((fs.readFileSync(f.calls, 'utf8').match(/plugin unlink/g) ?? []).length, 1);
  assert.doesNotMatch(f.ok(['status']).stderr, /warning/);
  assert.equal(fs.existsSync(path.join(f.home, 'before')), false);
  for (const action of ['restore', 'dev']) assert.notEqual(f.run([action]).status, 0);
});
test('a regular launcher refuses activation before any links switch', t => {
  const f = scratch(t); f.ok(['build', 't1']);
  fs.writeFileSync(path.join(f.bin, 'lane'), 'mine');
  assert.match(f.run(['activate', 't1']).stderr, /not a link; refusing/);
  assert.equal(fs.existsSync(path.join(f.home, 'current')), false);
});
test('activation retires the old Brain LaunchAgent plist by moving it aside, then switches links', t => {
  const f = scratch(t); f.ok(['build', 't1']);
  fs.writeFileSync(f.plist, 'legacy plist');
  const r = f.ok(['activate', 't1']);
  assert.match(r.stdout, /retired the Brain watch LaunchAgent/);
  assert.equal(fs.existsSync(f.plist), false);
  const aside = fs.readdirSync(path.dirname(f.plist)).filter(name => name.startsWith(`${path.basename(f.plist)}.retired-`));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(f.plist), aside[0]), 'utf8'), 'legacy plist');
  assert.equal(fs.readlinkSync(path.join(f.home, 'current')), f.release('t1'));
});
test('ship builds, activates and checks the installed launchers in one command', t => {
  const f = scratch(t); f.ok(['ship', 't1']);
  const r = f.ok(['ship', 't2']);
  assert.match(r.stdout, /shipped t2/);
  assert.equal(fs.readlinkSync(path.join(f.home, 'current')), f.release('t2'));
  assert.equal(fs.readlinkSync(path.join(f.home, 'previous')), f.release('t1'));
});
test('ship rolls back to the previous release when the installed launchers fail their check', t => {
  const f = scratch(t); f.ok(['ship', 't1']);
  f.write('bin/org.mjs', 'process.exit(3);'); f.git('add', '.'); f.git('commit', '-qm', 't3'); f.git('tag', 't3');
  const r = f.run(['ship', 't3']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /installed org failed to start/);
  assert.match(r.stderr, /rolling back/);
  assert.match(r.stderr, /rolled back to t1/);
  assert.equal(fs.readlinkSync(path.join(f.home, 'current')), f.release('t1'));
  assert.equal(fs.existsSync(path.join(f.home, 'previous')), false, 'the broken tag never becomes previous');
  f.ok(['ship', 't2']);
  f.write('bin/org.mjs', 'process.exit(4);'); f.git('add', '.'); f.git('commit', '-qm', 't4'); f.git('tag', 't4');
  assert.notEqual(f.run(['ship', 't4']).status, 0);
  assert.equal(fs.readlinkSync(path.join(f.home, 'current')), f.release('t2'));
  assert.equal(fs.readlinkSync(path.join(f.home, 'previous')), f.release('t1'), 'previous still names the last good release');
});
test('a failed first ship with no previous release says the tag stays active', t => {
  const f = scratch(t);
  f.write('bin/org.mjs', 'process.exit(5);'); f.git('add', '.'); f.git('commit', '-qm', 't5'); f.git('tag', 't5');
  const r = f.run(['ship', 't5']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no previous release; t5 stays active/);
  assert.equal(fs.readlinkSync(path.join(f.home, 'current')), f.release('t5'));
});
test('a scratch HOME or an empty plist setting never reaches launchctl', t => {
  const f = scratch(t); f.ok(['build', 't1']); f.ok(['build', 't2']);
  const stub = path.join(f.root, 'stub'), calls = path.join(f.root, 'launchctl-calls');
  fs.mkdirSync(stub); fs.writeFileSync(path.join(stub, 'launchctl'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\n`, { mode: 0o755 });
  const agents = path.join(f.root, 'Library', 'LaunchAgents'); fs.mkdirSync(agents, { recursive: true });
  const scratchPlist = path.join(agents, 'com.rewt.herdr-brain.plist'); fs.writeFileSync(scratchPlist, 'scratch plist');
  const PATH = `${stub}:${process.env.PATH}`;
  f.ok(['activate', 't1'], { HERDR_MONITOR_PLIST: undefined, PATH });
  assert.equal(fs.existsSync(scratchPlist), false, 'the scratch HOME plist is moved aside');
  f.ok(['activate', 't2'], { HERDR_MONITOR_PLIST: '', PATH });
  assert.equal(fs.existsSync(calls), false, 'launchctl only ever acts on the real account plist');
});
test('failed plugin unlink warns and leaves the launchers usable', t => {
  const f = scratch(t); f.ok(['build', 't1']);
  const r = f.ok(['activate', 't1'], { FIXTURE_UNLINK_FAIL: '1' });
  assert.match(r.stderr, /warning: could not unlink/);
  assert.equal(fs.readlinkSync(path.join(f.home, 'current')), f.release('t1'));
});
test('distribution inventory retains bch-cloak launch dependencies', () => {
  const files = productFiles(path.resolve(import.meta.dirname, '..'));
  for (const file of ['.nvmrc', 'contrib/settle-watch.mjs', 'lib/cli-help.mjs', 'supervisor/reconcile.mjs', 'supervisor/request.mjs', 'lib/releases.mjs', 'herdr/releases.mjs']) assert.ok(files.includes(file));
  assert.ok(!files.some(file => file.startsWith('release/')));
});

test('installed release commands can inspect and switch launchers without Git metadata', t => {
  const f = scratch(t); f.ok(['build', 't1']); f.ok(['build', 't2']);
  const script = path.join(f.release('t1'), 'herdr/release.sh');
  const installed = args => {
    const r = spawnSync('bash', [script, ...args], { cwd: f.release('t1'), env: { ...f.env, HERDR_MONITOR_REPO: '' }, encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 0, r.stdout + r.stderr); return r;
  };
  assert.equal(fs.existsSync(path.join(f.release('t1'), '.git')), false);
  assert.match(installed(['status']).stdout, /current:.*none/);
  installed(['activate', 't1']); installed(['activate', 't2']);
  assert.equal(fs.readlinkSync(path.join(f.home, 'current')), f.release('t2'));
  installed(['rollback']);
  assert.equal(fs.readlinkSync(path.join(f.home, 'current')), f.release('t1'));
  assert.equal(fs.readlinkSync(path.join(f.home, 'previous')), f.release('t2'));
  for (const name of ['org', 'record', 'lane'])
    assert.ok(fs.readlinkSync(path.join(f.bin, name)).startsWith(path.join(f.home, 'routing') + path.sep));
});

test('pin validates a complete bundle and only a canonical commit accepts activation or rollback', t => {
  const f = scratch(t); f.ok(['build', 't1', '--live']); f.ok(['build', 't2', '--live']); f.ok(['activate', 't2']);
  const project = path.join(f.root, 'project'); fs.mkdirSync(project);
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { env: f.env, encoding: 'utf8' });
  git('init', '-qb', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('commit', '--allow-empty', '-qm', 'initial');
  const launch = () => spawnSync(process.execPath, [path.join(f.bin, 'record'), 'help'], { cwd: project, env: f.env, encoding: 'utf8' });
  const commit = () => { git('add', '.herdr-release.json'); git('commit', '-qm', 'accept pin'); };
  f.ok(['pin', 't1', project]); assert.equal(launch().stdout.trim(), 't2');
  commit(); assert.equal(launch().stdout.trim(), 't1');
  f.ok(['pin', 't2', project]); commit(); assert.equal(launch().stdout.trim(), 't2');
  f.ok(['pin', 't1', project]); commit(); assert.equal(launch().stdout.trim(), 't1');
  f.ok(['unpin', project]); commit(); assert.equal(launch().stdout.trim(), 't2');
  assert.notEqual(f.run(['pin', 'missing', project]).status, 0);
  fs.chmodSync(path.join(f.release('t1'), 'bin'), 0o755); fs.unlinkSync(path.join(f.release('t1'), 'bin/org.mjs'));
  assert.notEqual(f.run(['pin', 't1', project]).status, 0);
});

test('activation and rollback retain every pinned or operation-referenced release', t => {
  const f = scratch(t); f.ok(['build', 't1']); f.ok(['build', 't2']);
  f.write('.herdr-release.json', JSON.stringify({ release: 't1' }));
  fs.writeFileSync(path.join(f.root, 'operation.json'), JSON.stringify({ release: { root: f.release('t2') } }));
  for (const args of [['activate', 't1'], ['activate', 't2'], ['rollback']]) f.ok(args);
  for (const tag of ['t1', 't2']) assert.ok(fs.existsSync(path.join(f.release(tag), '.release-manifest.json')));
  assert.notEqual(f.run(['prune']).status, 0, 'there is deliberately no release deletion command');
});
test('build refuses a tag missing the installed settle-watch dependency before spending a gate', t => {
  const f = scratch(t); f.git('rm', 'contrib/settle-watch.mjs'); f.git('commit', '-qm', 'Incomplete distribution'); f.git('tag', 'missing');
  assert.match(f.run(['build', 'missing']).stderr, /release is missing contrib\/settle-watch.mjs/);
  assert.equal(fs.existsSync(f.gateLog), false); assert.equal(fs.existsSync(f.release('missing')), false);
});

test('build verifies its full manifest before publishing the immutable directory', t => {
  const f = scratch(t), probe = path.join(f.root, 'change-after-manifest.mjs');
  fs.writeFileSync(probe, `import fs from 'node:fs';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';const write=fs.writeFileSync;fs.writeFileSync=function(file,...args){const result=write.call(this,file,...args);if(process.argv[2]==='manifest'&&path.basename(String(file))==='.release-manifest.json'){fs.appendFileSync(path.join(path.dirname(file),'lib/state.mjs'),'\\n// changed after manifest\\n');}return result};syncBuiltinESMExports();`);
  const failed = f.run(['build', 't1'], { NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(probe)}` });
  assert.notEqual(failed.status, 0); assert.match(failed.stderr, /incomplete release t1\.partial: lib\/state\.mjs/);
  assert.equal(fs.existsSync(f.release('t1')), false); assert.ok(fs.existsSync(`${f.release('t1')}.partial`));
  f.ok(['build', 't2']); assert.ok(fs.existsSync(path.join(f.release('t2'), '.release-manifest.json')));
});

function archiveCommit(f, commit, destination) {
  fs.mkdirSync(destination);
  const bytes = execFileSync('git', ['-C', f.repo, 'archive', commit], { env: f.env, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', destination], { input: bytes, env: f.env });
}
test('captured C survives tag movement through checkout, freezing and archive; home input keeps its exact bytes', async t => {
  const f = scratch(t);
  f.write('bin/org.mjs', "console.log('t1');"); f.write('.lane.validation.json', '{"release":"node gate.cjs"}\n');
  f.git('add', '.'); f.git('commit', '-qm', 'Captured payload and declaration'); const commit = f.git('rev-parse', 'HEAD').trim();
  f.write('bin/org.mjs', "console.log('late');"); f.write('.lane.validation.json', '{"release":"exit 19"}\n');
  f.git('add', '.'); f.git('commit', '-qm', 'Moved payload and declaration'); f.git('tag', '-f', 't1', 'HEAD');
  const frozen = freezeReleaseValidation(f.repo, 't1', path.join(f.root, 'frozen.json'), f.env, { commit });
  const identity = createProductCheckout({ source: f.repo, commit, destination: path.join(f.root, 'checkout'), ownedRoot: f.root });
  const packaged = path.join(f.root, 'package'); archiveCommit(f, commit, packaged);
  verifyProductPayload(packaged, identity);
  assert.equal(frozen.payloadCommit, commit); assert.equal(identity.commit, commit);
  assert.equal(frozen.declaration.release, 'node gate.cjs');
  assert.equal(fs.readFileSync(path.join(packaged, 'bin/org.mjs'), 'utf8'), "console.log('t1');");
  const previousOrg = process.env.ORG_DIR;
  t.after(() => { if (previousOrg === undefined) delete process.env.ORG_DIR; else process.env.ORG_DIR = previousOrg; });
  const h = configFixture(t); await h.adopt(); h.git('tag', 'home-input');
  const selected = policyLocation(h.cwd, 'validation', h.env), original = fs.readFileSync(selected.file);
  assert.equal(selected.home, true);
  const home = freezeReleaseValidation(h.cwd, 'home-input', path.join(h.scratch, 'frozen.json'), h.env, { commit: h.git('rev-parse', 'HEAD').trim() });
  assert.equal(home.source, selected.file); assert.equal(home.sha256, contentDigest(original));
  assert.deepEqual(Buffer.from(home.inputBase64, 'base64'), original);
});

for (const mutation of ['omission', 'extra', 'tamper', 'redirect', 'root redirect', 'mode']) test(`committed package equality refuses ${mutation}`, t => {
  const f = scratch(t), commit = f.git('rev-parse', 'HEAD').trim(), identity = captureProductCheckout(f.repo, commit, { all: true });
  const packaged = path.join(f.root, 'package'); archiveCommit(f, commit, packaged); verifyProductPayload(packaged, identity);
  const file = path.join(packaged, 'lib/state.mjs');
  if (mutation === 'omission') fs.unlinkSync(file);
  if (mutation === 'extra') fs.writeFileSync(path.join(packaged, 'lib/untracked.mjs'), 'untracked');
  if (mutation === 'tamper') fs.appendFileSync(file, '\n// tampered\n');
  if (mutation === 'redirect') { const foreign = path.join(f.root, 'foreign'); fs.renameSync(path.dirname(file), foreign); fs.symlinkSync(foreign, path.dirname(file)); }
  if (mutation === 'root redirect') { const foreign = path.join(f.root, 'foreign'); fs.renameSync(packaged, foreign); fs.symlinkSync(foreign, packaged); }
  if (mutation === 'mode') fs.chmodSync(file, 0o755);
  assert.throws(() => verifyProductPayload(packaged, identity), /payload|inventory/);
});
for (const stage of ['source mutation', 'archive omission']) test(`${stage} after successful validation never publishes`, t => {
  const f = scratch(t);
  if (stage === 'source mutation') f.write('gate.cjs', "require('fs').appendFileSync('lib/state.mjs','\\n// changed after validation started\\n');");
  else f.write('.gitattributes', 'lib/state.mjs export-ignore\n');
  f.git('add', '.'); f.git('commit', '-qm', stage); f.git('tag', 'refused');
  const result = f.run(['build', 'refused']); assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(f.release('refused')), false);
  assert.equal(fs.existsSync(path.join(`${f.release('refused')}.partial`, '.release-manifest.json')), false);
  assert.ok(fs.existsSync(f.checkout('refused')), 'original executing source and evidence retained');
});
for (const mutation of ['manifest', 'inventory', 'mode', 'validation']) test(`activation preflight refuses ${mutation} before all effects`, t => {
  const f = scratch(t); f.ok(['build', 't1']); fs.writeFileSync(f.plist, 'keep service');
  const root = f.release('t1'); execFileSync('chmod', ['-R', 'u+w', root]);
  const manifest = path.join(root, '.release-manifest.json');
  if (mutation === 'manifest') fs.unlinkSync(manifest);
  if (mutation === 'inventory') { const value = JSON.parse(fs.readFileSync(manifest)); delete value.files['lib/state.mjs']; fs.writeFileSync(manifest, JSON.stringify(value)); }
  if (mutation === 'mode') fs.chmodSync(path.join(root, 'lib/state.mjs'), 0o755);
  if (mutation === 'validation') fs.appendFileSync(path.join(root, '.release-validation.json'), 'tampered');
  assert.notEqual(f.run(['activate', 't1']).status, 0);
  assert.equal(fs.readFileSync(f.plist, 'utf8'), 'keep service');
  assert.equal(fs.existsSync(path.join(f.home, 'current')), false); assert.equal(fs.existsSync(f.calls), false);
});
test('interrupted sealed partial cannot activate or change service and links', t => {
  const f = scratch(t); f.ok(['build', 't1']); fs.writeFileSync(f.plist, 'keep service');
  fs.renameSync(f.release('t1'), `${f.release('t1')}.partial`);
  assert.notEqual(f.run(['activate', 't1.partial']).status, 0);
  assert.equal(fs.readFileSync(f.plist, 'utf8'), 'keep service');
  assert.equal(fs.existsSync(path.join(f.home, 'current')), false); assert.equal(fs.existsSync(f.calls), false);
});

test('genuine source and completed sealed package execute real consumer removal, owner claim and bound continuation', t => {
  const source = path.resolve(import.meta.dirname, '..'), stages = [];
  const evidenceRoot = process.env.MONITOR_TEST_TIMINGS_PATH ? path.dirname(process.env.MONITOR_TEST_TIMINGS_PATH) : path.join(source, '.lane');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const evidence = fs.mkdtempSync(path.join(evidenceRoot, 'release-consumer-'));
  t.diagnostic(`release consumer evidence: ${evidence}`);
  const f = scratch(t, root => {
    fs.writeFileSync(path.join(evidence, 'stages.json'), JSON.stringify(stages, null, 2) + '\n');
    for (const name of ['validation.json', 'identity.json', 'execution.json']) {
      const file = path.join(root, 'releases-home/builds/consumer', name);
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(evidence, name));
    }
    for (const name of ['.release-validation.json', '.release-manifest.json', '.release-commit']) {
      const file = path.join(root, 'releases-home/releases/consumer', name);
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(evidence, `sealed${name}`));
    }
    const execution = path.join(evidence, 'execution.json');
    if (fs.existsSync(execution)) {
      const { receipt } = JSON.parse(fs.readFileSync(execution));
      fs.copyFileSync(receipt, path.join(evidence, 'execution-receipt.json'));
      const timings = JSON.parse(fs.readFileSync(receipt)).timings_path;
      if (timings && fs.existsSync(timings)) fs.copyFileSync(timings, path.join(evidence, 'execution.timings.jsonl'));
    }
    if (fs.existsSync(f.gateLog)) fs.copyFileSync(f.gateLog, path.join(evidence, 'gates'));
  });
  // Independent nested Node runners must not inherit the enclosing test-worker sentinel.
  delete f.env.NODE_TEST_CONTEXT;
  const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.rmSync(f.repo, { recursive: true, force: true });
  createProductCheckout({ source, commit, destination: f.repo, ownedRoot: f.root });
  f.git('config', 'user.name', 'Fixture'); f.git('config', 'user.email', 'fixture@example.invalid');
  const probe = path.join(f.root, 'actual-owner.test.mjs');
  fs.writeFileSync(probe, `import path from 'node:path';import fs from 'node:fs';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
const root=process.cwd(), load=file=>import(pathToFileURL(path.join(root,file)).href);
const {default:test}=await load('test/helpers/bounded-test.mjs'); const {fixture}=await load('settle/test/fixture.mjs');
const {readOwnedRun,continueOwnerRelease}=await load('lib/run-owner.mjs'); const {bundleRelease,operationFile}=await load('lib/releases.mjs');
if (!fs.existsSync(path.join(root, '.release-commit'))) {
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '..', 'validation.json'))), JSON.parse(fs.readFileSync(${JSON.stringify(path.join(evidence, 'frozen-before-build.json'))})));
}
fs.appendFileSync(${JSON.stringify(f.gateLog)},root+'\\n');
test('actual executing root retains its real owner and continuation',t=>{
 const f=fixture(t,{source:root}), run=f.start(), owned=readOwnedRun(f.org,run), release=bundleRelease();
 assert.equal(owned.owner.release.root,root); assert.equal(owned.owner.release.commit,release.commit);
 if(!release.commit)assert.equal(owned.owner.release.identity,fs.realpathSync(path.join(root,'.git')));
 assert.equal(operationFile('bin/org.mjs',release),path.join(root,'bin/org.mjs'));
 assert.equal(continueOwnerRelease('bin/org.mjs',owned),null);
 fs.appendFileSync(${JSON.stringify(path.join(evidence, 'owner-claims.jsonl'))},JSON.stringify({root,run,owner:owned.owner,release})+'\\n');
});\n`);
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = `${quote(process.execPath)} --test ${quote(probe)} && ${quote(process.execPath)} --test ${quote('--test-name-pattern=^herdr-brain: a landed event immediately releases and removes its exact lane, branch and empty workspace$')} test/closeout.test.mjs`;
  const input = JSON.stringify({ release: command });
  f.write('.lane.validation.json', input);
  f.git('add', '.lane.validation.json'); f.git('commit', '-qm', 'Focused real consumer declaration'); f.git('tag', 'consumer');
  const capturedCommit = f.git('rev-parse', 'consumer^{commit}').trim();
  const frozen = freezeReleaseValidation(f.repo, 'consumer', path.join(evidence, 'frozen-before-build.json'), f.env, { commit: capturedCommit });
  assert.equal(frozen.payloadCommit, capturedCommit);
  assert.equal(frozen.declaration.release, command);
  assert.deepEqual(Buffer.from(frozen.inputBase64, 'base64'), Buffer.from(input));
  const build = f.run(['build', 'consumer']);
  stages.push({ stage: 'source-build', argv: ['bash', SCRIPT, 'build', 'consumer'], cwd: source, command, ...build, error: build.error?.message });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'builds/consumer/validation.json'))), frozen);
  const identity = JSON.parse(fs.readFileSync(path.join(f.home, 'builds/consumer/identity.json'))).identity;
  assert.equal(identity.root, f.checkout('consumer'));
  assert.equal(identity.commit, capturedCommit);
  assert.equal(fs.readFileSync(f.gateLog, 'utf8'), `${f.checkout('consumer')}\n`);
  const sealed = f.release('consumer'), result = spawnSync('/bin/sh', ['-c', command], { cwd: sealed, env: f.env, encoding: 'utf8' });
  stages.push({ stage: 'sealed-consumer', argv: ['/bin/sh', '-c', command], cwd: sealed, ...result, error: result.error?.message });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const output of [build.stdout, result.stdout]) {
    assert.match(output, /ok \d+ - actual executing root retains its real owner and continuation\n/);
    assert.match(output, /ok \d+ - herdr-brain: a landed event immediately releases and removes its exact lane, branch and empty workspace\n/);
  }
  assert.equal(fs.readFileSync(f.gateLog, 'utf8'), `${f.checkout('consumer')}\n${sealed}\n`);
  assert.ok(fs.existsSync(path.join(f.checkout('consumer'), '.git')), 'sealing retains source origin');
  assert.equal(fs.existsSync(path.join(sealed, '.git')), false);
});
