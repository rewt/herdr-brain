import { fixtureEnvironment } from '../../test/helpers/fixture-environment.mjs';
import { healthyMemoryEnvironment } from '../../test/helpers/promotion-memory-fixture.mjs';
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { copyProduct } from '../../lib/product-files.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { waitForFile } from '../../test/helpers/file-wait.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';
import { processStart } from '../../test-slot/lock-support.mjs';
import { environmentFingerprint, resolveValidation, validateValidation, validationEnvironment } from '../validation.mjs';
import { resolveGateLimits } from '../../test-slot/limits.mjs';
import { validateValidation as preProfileValidation } from './fixtures/pre-profile-validation.mjs';
import { resourceStanza } from '../../test-slot/resources.mjs';

const cli = fileURLToPath(new URL('../lane.mjs', import.meta.url));
test('historical validation accepts legacy fields and refuses the current explicit policy extension', () => {
  const declaration = JSON.parse(fs.readFileSync(new URL('../../.lane.validation.json', import.meta.url), 'utf8'));
  const { review, landing_waiver, ...legacy } = declaration;
  assert.doesNotThrow(() => preProfileValidation(legacy));
  assert.throws(() => preProfileValidation({ ...legacy, review }), /unknown validation field: review/);
  assert.throws(() => preProfileValidation({ ...legacy, landing_waiver }), /unknown validation field: landing_waiver/);
  assert.doesNotThrow(() => validateValidation(declaration));
  assert.equal(review, 'parallel');
  assert.equal(landing_waiver, 'operator-20261025-until-stable-release');
  assert.throws(() => preProfileValidation({ ...legacy, resources: {} }), /unknown validation field: resources/);
  assert.equal(Object.hasOwn(declaration, 'resources'), false);
});
function fixture(t, declaration = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'validation-tiers-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), workspace = path.join(root, 'worker'), log = path.join(root, 'checks');
  fs.mkdirSync(repo);
  const config = path.join(root, 'config.json'); fs.writeFileSync(config, '{}');
  const env = { ...healthyMemoryEnvironment(fixtureEnvironment()), ORG_ACTOR: 'validation-tiers-test', LANE_CONFIG: config,
    LANE_WORKTREE_ROOT: path.join(root, 'worktrees'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    CHECK_LOG: log };
  delete env.LANE_VALIDATE;
  const run = (binary, args, cwd = repo, extra = {}) => spawnSync(binary, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: loadTimeout(12000) });
  const good = result => { assert.equal(result.status, 0, result.stderr + result.stdout); return result.stdout.trim(); };
  const git = (args, cwd = repo) => good(run('git', args, cwd));
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Validation fixture']); git(['config', 'user.email', 'validation@example.invalid']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.lane/\n');
  fs.writeFileSync(path.join(repo, 'work'), 'base\n');
  fs.writeFileSync(path.join(repo, 'check.cjs'), `const fs=require('fs');fs.appendFileSync(process.env.CHECK_LOG,process.argv[2]+'\\n');if(process.env.RED)process.exit(7);if(process.env.DIRTY)fs.writeFileSync('work','dirty');if(process.env.MOVE)require('child_process').execFileSync('git',['commit','--allow-empty','-qm','Move during validation']);`);
  if (Object.keys(declaration).length) fs.writeFileSync(path.join(repo, '.lane.validation.json'), JSON.stringify(declaration));
  git(['add', '.']); git(['commit', '-qm', 'Create scratch project']);
  git(['worktree', 'add', '-qb', 'lane/topic', workspace]);
  const lane = (args, cwd = workspace, extra = {}) => run(process.execPath, [cli, ...args], cwd, extra);
  const count = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  const gate = () => JSON.parse(fs.readFileSync(path.join(workspace, '.lane/gate.json'), 'utf8'));
  return { root, repo, workspace, log, env, lane, git, good, count, gate };
}

test('defaults, legacy commands, partial tracked overrides and invalid declarations', { timeout: 20000 }, t => {
  const f = fixture(t);
  const defaults = resolveValidation({ root: f.repo, env: {} });
  assert.deepEqual(Object.values(defaults.tiers).map(v => v.command), ['npm test', 'npm test', 'npm test']);
  fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify({ fast: 'node check.cjs fast', release: 'release-check' }));
  const settings = resolveValidation({ root: f.repo, config: { validate: 'legacy-check' }, env: {} });
  assert.equal(settings.tiers.promotion.command, 'legacy-check');
  assert.equal(settings.tiers.fast.command, 'node check.cjs fast');
  assert.equal(settings.tiers.fast.source, path.join(f.repo, '.lane.validation.json'));
  const override = resolveValidation({ root: f.repo, env: { LANE_VALIDATE: 'override' } });
  assert.ok(Object.values(override.tiers).every(v => v.command === 'override'));
  for (const value of [null, [], { fast: '' }, { promotion: 1 }, { typo: 'true' }, { environment: false }]) assert.throws(() => validateValidation(value));
  const explained = f.good(f.lane(['config']));
  for (const tier of ['fast', 'promotion', 'release']) assert.match(explained, new RegExp(`validation\\.${tier}\\t`));
  assert.match(f.lane(['check', '--tier', 'release']).stderr, /release gates are run by bash herdr\/release\.sh build TAG/);
});

test('project gate timing is watch-only for promotion and release', t => {
  const declaration = JSON.parse(fs.readFileSync(new URL('../../.lane.validation.json', import.meta.url), 'utf8'));
  const f = fixture(t, declaration);
  const settings = resolveValidation({ root: f.repo, env: {} });
  const history = Array.from({ length: 3 }, () => ({ duration_s: 1001, longest_silence_s: 100 }));
  for (const [tier, wallSeconds] of [['promotion', 0], ['release', 0]]) {
    const limits = resolveGateLimits({ tier, ...settings.tiers[tier], history });
    assert.equal(limits.wall_seconds, wallSeconds);
    assert.equal(limits.wall_source, 'watch');
    assert.equal(limits.idle_seconds, 900);
    assert.equal(limits.idle_source, 'config');
  }
  assert.equal(settings.tiers.fast.timeoutSeconds, 0);
  assert.equal(settings.tiers.fast.idleTimeoutSeconds, 900);
});

test('validation looks up an exact command profile outside the legacy declaration', { timeout: 20000 }, t => {
  const f = fixture(t, { fast: 'node check.cjs profiled' });
  fs.mkdirSync(path.join(f.workspace, 'test-slot'));
  fs.writeFileSync(path.join(f.workspace, 'test-slot/validation-resources.json'), JSON.stringify({
    fast: resourceStanza('fixture/validation', 'node check.cjs profiled'),
  }));
  f.git(['add', 'test-slot/validation-resources.json'], f.workspace);
  f.git(['commit', '-qm', 'Declare validation evidence separately'], f.workspace);
  f.good(f.lane(['check']));
  const execution = () => JSON.parse(fs.readFileSync(f.gate().execution_receipt, 'utf8'));
  assert.equal(execution().resource.profile.id, 'fixture/validation');
  assert.deepEqual(execution().resource.profile.command, ['/bin/sh', '-c', 'node check.cjs profiled']);
  f.good(f.lane(['check', '--cmd', 'node check.cjs arbitrary']));
  assert.equal(execution().resource.reason, 'unprofiled');
});

test('legacy host settings are ignored even in an unborn repository', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'validation-unborn-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const init = spawnSync('git', ['init', '-qb', 'main', root], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const settings = resolveValidation({ root, env: {} });
  assert.ok(Object.values(settings.tiers).every(tier => tier.command === 'npm test'));
  // Ordinary local validation settings retain their pre-existing behavior.
  fs.writeFileSync(path.join(root, '.lane.validation.json'), JSON.stringify({ fast: 'true' }));
  assert.equal(resolveValidation({ root, env: {} }).tiers.fast.command, 'true');
  fs.writeFileSync(path.join(root, '.lane.validation.json'), JSON.stringify({ host_suites: { local: { command: 'true', pty: true } } }));
  assert.equal(resolveValidation({ root, env: {} }).tiers.fast.command, 'npm test');
  for (const key of ['host_suites', 'tier_suites']) {
    fs.writeFileSync(path.join(root, '.lane.validation.json'), JSON.stringify({ fast: 'true', [key]: 'retired-value' }));
    assert.equal(resolveValidation({ root, env: {} }).tiers.fast.command, 'true');
  }
});

test('a worker check, promotion check and promotion reuse their exact commands; release never runs', { timeout: 20000 }, t => {
  const f = fixture(t, { fast: 'node check.cjs fast', promotion: 'node check.cjs promotion', release: 'node check.cjs release' });
  f.good(f.lane(['check'])); f.good(f.lane(['check']));
  f.good(f.lane(['check', '--tier', 'promotion'])); f.good(f.lane(['check', '--tier', 'promotion']));
  assert.deepEqual(f.count(), ['fast', 'promotion']);
  const result = f.good(f.lane(['promote', 'topic'], f.repo));
  assert.match(result, /REUSE/); assert.deepEqual(f.count(), ['fast', 'promotion']);
  assert.equal(f.git(['rev-parse', 'main']), f.gate().head);
  assert.equal(f.gate().tier, 'promotion');
});

test('pane identities are absent from preparation, validation and fingerprints', { timeout: 20000 }, t => {
  const f = fixture(t, { fast: 'node check.cjs same' });
  const identities = { HERDR_PANE_ID: 'worker-pane', HERDR_TAB_ID: 'worker-tab', HERDR_WORKSPACE_ID: 'worker-workspace' };
  assert.deepEqual(validationEnvironment({ ...identities, PROJECT_INPUT: 'kept' }), { PROJECT_INPUT: 'kept' });
  assert.equal(environmentFingerprint({ env: identities }), environmentFingerprint({ env: {} }));
  assert.notEqual(environmentFingerprint({ env: { PROJECT_INPUT: 'changed' } }), environmentFingerprint({ env: {} }));
  const probe = "for(const key of ['HERDR_PANE_ID','HERDR_TAB_ID','HERDR_WORKSPACE_ID'])require('assert').equal(process.env[key],undefined);";
  fs.appendFileSync(path.join(f.workspace, 'check.cjs'), probe);
  fs.writeFileSync(path.join(f.root, 'config.json'), JSON.stringify({ prepare: [{ run: `${process.execPath} -e ${JSON.stringify(probe)}` }] }));
  f.git(['add', 'check.cjs'], f.workspace); f.git(['commit', '-qm', 'Assert normalized validation environment'], f.workspace);
  f.good(f.lane(['check'], f.workspace, identities));
  assert.match(f.good(f.lane(['check'], f.workspace, { ...identities, HERDR_PANE_ID: 'supervisor-pane' })), /REUSE/);
  assert.match(f.good(f.lane(['check'], f.workspace, { HERDR_PANE_ID: undefined, HERDR_TAB_ID: undefined, HERDR_WORKSPACE_ID: undefined })), /REUSE/);
  assert.deepEqual(f.count(), ['same']);
});

test('same tree after empty commits and a clean rebase reuses validation across tiers', { timeout: 20000 }, t => {
  const f = fixture(t, { fast: 'node check.cjs same', promotion: 'node check.cjs same' });
  fs.writeFileSync(path.join(f.workspace, 'work'), 'worker\n');
  f.git(['add', 'work'], f.workspace); f.git(['commit', '-qm', 'Implement worker tree'], f.workspace);
  f.good(f.lane(['check'])); const original = f.gate();
  const originalBytes = fs.readFileSync(original.history_receipt);
  f.git(['commit', '--allow-empty', '-qm', 'Integration metadata']);
  const output = f.good(f.lane(['promote', 'topic'], f.repo));
  assert.match(output, /rebased/); assert.match(output, /REUSE/);
  assert.notEqual(f.gate().head, original.head); assert.equal(f.gate().tree, original.tree);
  assert.equal(f.gate().validated_head, original.head); assert.deepEqual(f.count(), ['same']);
  assert.notEqual(f.gate().history_receipt, original.history_receipt);
  assert.equal(JSON.parse(fs.readFileSync(f.gate().history_receipt)).head, f.gate().head);
  assert.deepEqual(fs.readFileSync(original.history_receipt), originalBytes, 'reuse retains the actual earlier receipt');
});

test('tree, command, environment, preparation and declared environment changes invalidate reuse', { timeout: 20000 }, t => {
  const f = fixture(t, { fast: 'node check.cjs first' });
  f.good(f.lane(['check']));
  f.good(f.lane(['check'], f.workspace, { CHECK_VARIANT: 'changed' }));
  f.good(f.lane(['check', '--cmd', 'node check.cjs second']));
  fs.writeFileSync(path.join(f.workspace, 'work'), 'new tree'); f.git(['add', 'work'], f.workspace); f.git(['commit', '-qm', 'New tree'], f.workspace);
  f.good(f.lane(['check']));
  fs.writeFileSync(f.env.LANE_CONFIG, JSON.stringify({ prepare: [{ run: 'true' }] })); f.good(f.lane(['check']));
  fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify({ fast: 'node check.cjs first', environment: 'container-v2' })); f.good(f.lane(['check']));
  assert.deepEqual(f.count(), ['first', 'first', 'second', 'first', 'first', 'first']);
  const a = environmentFingerprint({ env: { ORG_ACTOR: 'worker', PWD: '/worker', SECRET: 'one' } });
  assert.equal(a, environmentFingerprint({ env: { ORG_ACTOR: 'settle', PWD: '/canonical', SECRET: 'one' } }));
  assert.notEqual(a, environmentFingerprint({ env: { SECRET: 'two' } }));
  assert.equal(a, environmentFingerprint({ env: { SECRET: 'one', MONITOR_TEST_SLOT_TIMEOUT_RETRIED: '1' } }));
  assert.equal(a, environmentFingerprint({ env: { SECRET: 'one', MONITOR_TEST_SLOT_OCCUPANCY_PATH: '/fixture/slot.occupancy/holder.json' } }));
  assert.equal(fs.readFileSync(path.join(f.workspace, '.lane/gate.json'), 'utf8').includes('SECRET'), false);
});

test('red, signal, dirty and moved-head executions never supply reusable green evidence', { timeout: 20000 }, t => {
  const f = fixture(t, { fast: 'node check.cjs check' });
  let original, originalBytes;
  for (let i = 0; i < 2; i++) {
    assert.equal(f.lane(['check'], f.workspace, { RED: '1' }).status, 7);
    if (!original) { original = f.gate(); originalBytes = fs.readFileSync(original.history_receipt); }
  }
  assert.notEqual(f.gate().history_receipt, original.history_receipt);
  assert.deepEqual(fs.readFileSync(original.history_receipt), originalBytes, 'a second execution cannot replace earlier red evidence');
  assert.deepEqual(f.count(), ['check', 'check']);
  assert.equal(f.lane(['check', '--cmd', 'kill -9 $$']).status, 137);
  assert.equal(f.gate().exit_code, 137);
  assert.match(f.lane(['check'], f.workspace, { DIRTY: '1' }).stderr, /not clean/);
  f.git(['checkout', '--', 'work'], f.workspace);
  assert.match(f.lane(['check'], f.workspace, { MOVE: '1' }).stderr, /changed during validation/);
  f.good(f.lane(['check'])); assert.equal(f.gate().reused, false);
  fs.writeFileSync(path.join(f.workspace, 'work'), 'user dirt');
  assert.match(f.lane(['check']).stderr, /not clean/);
});

test('commands that start and exit 75 record failed receipts in both validation tiers', { timeout: 20000 }, t => {
  const f = fixture(t, { fast: 'node check.cjs fast; exit 75', promotion: 'node check.cjs promotion; exit 75' });
  for (const tier of ['fast', 'promotion']) {
    const result = f.lane(['check', '--tier', tier]);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stdout, /GATE .* exit=75/);
    assert.equal(f.gate().exit_code, 75);
    assert.equal(f.gate().tier, tier);
    const receipt = path.join(f.repo, '.git/lane-validation', f.gate().key + '.json');
    assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).exit_code, 75);
    const repeated = f.lane(['check', '--tier', tier]);
    assert.equal(repeated.status, 1);
    assert.doesNotMatch(repeated.stdout, /REUSE/);
  }
  assert.deepEqual(f.count(), ['fast', 'fast', 'promotion', 'promotion']);
});

test('worker gate files, corrupt receipts and modified evidence logs cannot authorize reuse', { timeout: 20000 }, t => {
  const f = fixture(t, { fast: 'node check.cjs check' });
  fs.mkdirSync(path.join(f.workspace, '.lane')); fs.writeFileSync(path.join(f.workspace, '.lane/gate.json'), JSON.stringify({ exit_code: 0 }));
  f.good(f.lane(['check'])); const first = f.gate();
  const receipt = path.join(f.repo, '.git/lane-validation', first.key + '.json');
  fs.writeFileSync(receipt, JSON.stringify({ ...first, schema: 'old-gate' }));
  f.good(f.lane(['check']));
  fs.writeFileSync(receipt, 'broken json'); f.good(f.lane(['check']));
  fs.writeFileSync(f.gate().log, 'different evidence'); f.good(f.lane(['check']));
  assert.deepEqual(f.count(), ['check', 'check', 'check', 'check']);
});

test('a started command exiting 75 is a failure in check and promote, never a slot refusal', { timeout: 20000 }, t => {
  const f = fixture(t, { fast: 'node check.cjs fast; exit 75', promotion: 'node check.cjs promotion; exit 75' });
  const lock = path.join(f.root, 'slot.lock');
  Object.assign(f.env, { MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock,
    MONITOR_TEST_SLOT_WAIT_SECONDS: '0', MONITOR_TEST_SLOT_TOKEN: '', BCH_CLOAK_TEST_SLOT_TOKEN: '' });
  const main = f.git(['rev-parse', 'main']);
  for (const tier of ['fast', 'promotion']) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = f.lane(['check', '--tier', tier]);
      assert.equal(result.status, 1, result.stderr + result.stdout);
      assert.match(result.stdout, /GATE .* exit=75/);
      assert.doesNotMatch(result.stdout + result.stderr, /TEST_SLOT_HELD|REUSE/);
      assert.equal(f.gate().exit_code, 75);
      const receipt = path.join(f.repo, '.git/lane-validation', f.gate().key + '.json');
      assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).exit_code, 75);
    }
  }
  const promotion = f.lane(['promote', 'topic'], f.repo);
  assert.equal(promotion.status, 1, promotion.stderr + promotion.stdout);
  assert.match(promotion.stderr, /validation failed \(exit 75\); nothing merged/);
  assert.equal(f.gate().exit_code, 75);
  assert.equal(f.git(['rev-parse', 'main']), main);
  assert.deepEqual(f.count(), ['fast', 'fast', 'promotion', 'promotion', 'promotion']);
});

for (const scenario of ['leaf retries', 'leaf retry exhausted', 'leaf declines', 'earlier timeout text']) {
  test(`promotion holds the slot without replaying the chain when ${scenario}`, { timeout: 20000 }, t => {
    const f = fixture(t, { promotion: 'node chain.cjs' });
    const slot = fileURLToPath(new URL('../../test-slot/test-slot.mjs', import.meta.url));
    const lock = path.join(f.root, 'slot.lock'), preload = path.join(f.root, 'load.mjs');
    // The adapter sees high load; only the leaf's sample varies.
    fs.writeFileSync(preload, `import os from 'node:os';os.loadavg=()=>process.argv[3]==='leaf'&&${JSON.stringify(scenario)}!=='leaf retries'&&${JSON.stringify(scenario)}!=='leaf retry exhausted'?[0,0,0]:[1000,1000,1000];`);
    Object.assign(f.env, { MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock,
      MONITOR_TEST_SLOT_WAIT_SECONDS: '0', MONITOR_TEST_SLOT_TOKEN: '', BCH_CLOAK_TEST_SLOT_TOKEN: '',
      MONITOR_TEST_SLOT_TIMEOUT_RETRIED: '', NODE_OPTIONS: `--import=${preload}` });
    fs.writeFileSync(path.join(f.workspace, 'leaf.cjs'), `const fs=require('fs');const before=fs.existsSync(process.env.CHECK_LOG)?fs.readFileSync(process.env.CHECK_LOG,'utf8'):'';fs.appendFileSync(process.env.CHECK_LOG,'leaf\\n');console.error('ETIMEDOUT');process.exit(${JSON.stringify(scenario)}==='earlier timeout text'||(before.includes('leaf')&&${JSON.stringify(scenario)}!=='leaf retry exhausted')?0:124);`);
    fs.writeFileSync(path.join(f.workspace, 'chain.cjs'), `const fs=require('fs');fs.appendFileSync(process.env.CHECK_LOG,'chain\\n');const r=require('child_process').spawnSync(process.execPath,[${JSON.stringify(slot)},'run','leaf','--retry-timeout-under-load','--',process.execPath,'leaf.cjs'],{stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);fs.appendFileSync(process.env.CHECK_LOG,'after\\n');process.exit(${JSON.stringify(scenario)}==='earlier timeout text'?7:0);`);
    f.git(['add', '.'], f.workspace); f.git(['commit', '-qm', 'Promotion failure-path fixture'], f.workspace);
    const result = f.lane(['check', '--tier', 'promotion']);
    assert.equal(result.status, scenario === 'leaf retries' ? 0 : scenario !== 'earlier timeout text' ? 124 : 7, result.stderr + result.stdout);
    assert.deepEqual(f.count(), scenario === 'leaf retries' ? ['chain', 'leaf', 'leaf', 'after'] :
      scenario === 'leaf retry exhausted' ? ['chain', 'leaf', 'leaf'] : scenario === 'leaf declines' ? ['chain', 'leaf'] : ['chain', 'leaf', 'after']);
    assert.equal((result.stdout.match(/TEST_SLOT_TIMEOUT_RETRY:/g) ?? []).length, scenario.startsWith('leaf retr') ? 1 : 0);
    assert.equal(fs.existsSync(lock), false);
  });
}

test('a worker declaration cannot weaken canonical checks and a changed rebase tree needs a fresh check', { timeout: 20000 }, t => {
  const f = fixture(t, { fast: 'node check.cjs canonical', promotion: 'node check.cjs canonical' });
  fs.writeFileSync(path.join(f.workspace, '.lane.validation.json'), JSON.stringify({ fast: 'true', promotion: 'true' }));
  f.git(['add', '.'], f.workspace); f.git(['commit', '-qm', 'Worker override'], f.workspace);
  f.good(f.lane(['check'])); assert.equal(f.gate().command, 'node check.cjs canonical');
  fs.writeFileSync(path.join(f.repo, 'upstream'), 'new main file'); f.git(['add', 'upstream']); f.git(['commit', '-qm', 'Upstream tree change']);
  f.good(f.lane(['promote', 'topic'], f.repo));
  assert.deepEqual(f.count(), ['canonical', 'canonical']);
});

test('overlapping checks serialize evidence without running the same command twice', { timeout: 20000 }, async t => {
  const f = fixture(t, { fast: 'node wait.cjs' });
  const ready = path.join(f.root, 'ready'), release = path.join(f.root, 'release');
  fs.writeFileSync(path.join(f.workspace, 'wait.cjs'), `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');let deadline=Date.now()+8000;while(!fs.existsSync(${JSON.stringify(release)})&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);if(!fs.existsSync(${JSON.stringify(release)}))process.exit(8);`);
  f.git(['add', 'wait.cjs'], f.workspace); f.git(['commit', '-qm', 'Bounded blocking check'], f.workspace);
  const child = spawnChild(t, process.execPath, [cli, 'check'], { cwd: f.workspace, env: f.env });
  const done = waitForExit(child);
  try {
    await waitForFile(ready, text => text === 'ready', { timeoutMs: 5000 });
    const second = f.lane(['check']); assert.equal(second.status, 1); assert.match(second.stderr, /locked/);
  } finally { fs.writeFileSync(release, 'finish'); }
  const result = await done; assert.equal(result.code, 0, result.stderr);
  assert.match(f.good(f.lane(['check'])), /REUSE/);
});

test('shared promotion checks in different projects overlap and a nested command takes nothing', { timeout: 30000 }, async t => {
  const first = fixture(t, { promotion: 'node block.cjs' });
  const second = fixture(t, { promotion: 'node check.cjs second' });
  const lock = path.join(first.root, 'shared.lock'), ready = path.join(first.root, 'ready'), release = path.join(first.root, 'release');
  const slotCLI = fileURLToPath(new URL('../../test-slot/test-slot.mjs', import.meta.url));
  fs.writeFileSync(path.join(first.workspace, 'block.cjs'), `const fs=require('fs');const r=require('child_process').spawnSync(process.execPath,[${JSON.stringify(slotCLI)},'run','nested','--',process.execPath,'-e',''],{env:process.env});if(r.status!==0)process.exit(9);fs.writeFileSync(${JSON.stringify(ready)},'nested passed');const deadline=Date.now()+10000;while(!fs.existsSync(${JSON.stringify(release)})&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);if(!fs.existsSync(${JSON.stringify(release)}))process.exit(8);`);
  first.git(['add', 'block.cjs'], first.workspace); first.git(['commit', '-qm', 'Bounded nested promotion gate'], first.workspace);
  for (const f of [first, second]) Object.assign(f.env, { MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock, MONITOR_TEST_SLOT_WAIT_SECONDS: '10' });
  const a = spawnChild(t, process.execPath, [cli, 'check', '--tier', 'promotion'], { cwd: first.workspace, env: first.env });
  const aDone = waitForExit(a);
  await waitForFile(ready, text => text === 'nested passed', { timeoutMs: 5000 });
  const b = spawnChild(t, process.execPath, [cli, 'check', '--tier', 'promotion'], { cwd: second.workspace, env: second.env });
  const bDone = waitForExit(b);
  try {
    const completed = await bDone; assert.equal(completed.code, 0, completed.stderr);
    assert.deepEqual(second.count(), ['second'], 'second project completes while the first still runs');
    assert.equal(fs.existsSync(lock), false);
  } finally { fs.writeFileSync(release, 'finish'); }
  for (const result of await Promise.all([aDone, bDone])) assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.deepEqual(second.count(), ['second']);
  assert.equal(fs.existsSync(lock), false);
});

test('bch-cloak-compatible holder refuses declared-exclusive proving promotion with 75 and supplies no failed receipt', { timeout: 20000 }, async t => {
  const f = fixture(t, { promotion: 'node check.cjs forbidden', fast: 'node check.cjs fast' });
  fs.mkdirSync(path.join(f.workspace, 'test-slot'));
  fs.writeFileSync(path.join(f.workspace, 'test-slot/validation-resources.json'), JSON.stringify({
    proving: resourceStanza('fixture/proving', 'node check.cjs forbidden', 'EXCLUSIVE'),
  }));
  f.git(['add', '.'], f.workspace); f.git(['commit', '-qm', 'Declare proving fixture'], f.workspace);
  const lock = path.join(f.root, 'bch-cloak-test-slot.lock');
  const holder = spawnChild(t, process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: f.env });
  // Same on-disk schema and UTC/C start identity as the existing bch-cloak slot.
  fs.writeFileSync(lock, JSON.stringify({ pid: holder.pid, processStart: processStart(holder.pid), pgid: null, groupStart: null,
    token: 'bch-holder', label: 'bch-cloak full gate', cwd: '/other-project', acquiredAt: new Date().toISOString() }));
  const env = { MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock, MONITOR_TEST_SLOT_WAIT_SECONDS: '0', MONITOR_TEST_SLOT_TOKEN: '', BCH_CLOAK_TEST_SLOT_TOKEN: '' };
  const result = f.lane(['check', '--tier', 'promotion'], f.workspace, env);
  assert.equal(result.status, 75, result.stderr + result.stdout);
  assert.match(result.stderr, /^TEST_SLOT_HELD:.*bch-cloak full gate/m);
  assert.equal((result.stderr.match(/TEST_SLOT_HELD:/g) ?? []).length, 1);
  assert.deepEqual(f.count(), []);
  assert.equal(fs.existsSync(path.join(f.workspace, '.lane/gate.json')), false);
  assert.deepEqual(fs.readdirSync(path.join(f.repo, '.git/lane-validation')).filter(name => name.endsWith('.json')), []);
  const refusedPromotion = f.lane(['promote', 'topic'], f.repo, env);
  assert.equal(refusedPromotion.status, 75, refusedPromotion.stderr + refusedPromotion.stdout);
  assert.match(refusedPromotion.stderr, /^TEST_SLOT_HELD:/m);
  assert.doesNotMatch(refusedPromotion.stdout, /GATE/);
  assert.deepEqual(f.count(), []);
  assert.equal(fs.existsSync(path.join(f.workspace, '.lane/gate.json')), false);
  f.good(f.lane(['check'], f.workspace, env)); // Fast checks remain available.
  assert.deepEqual(f.count(), ['fast']);
  holder.kill('SIGTERM'); await waitForExit(holder);
});

test('validation reuses proof across bundle roots and preserves pre-pin green receipt keys', async t => {
  const f = fixture(t), starts = [];
  const roots = ['blue', 'green'].map((name, index) => {
    const root = path.join(f.root, name);
    copyProduct(fileURLToPath(new URL('../../', import.meta.url)), root);
    fs.writeFileSync(path.join(root, '.release-commit'), String(index + 1).repeat(40) + '\n');
    return root;
  });
  const [blue, green] = await Promise.all(roots.map(root => import(pathToFileURL(path.join(root, 'lanes/validation.mjs')).href)));
  const options = { cwd: f.workspace, common: path.join(f.repo, '.git'), command: 'node check.cjs same', env: f.env,
    onStart: evidence => starts.push(evidence) };
  const first = blue.validateTree({ ...options, tier: 'fast' });
  const oldKey = createHash('sha256').update(JSON.stringify({ schema: 'lane-validation/v1', tree: first.tree,
    command: first.command, fingerprint: first.environment_fingerprint })).digest('hex');
  assert.equal(first.key, oldKey, 'keep the exact pre-pin cache key');
  assert.equal(first.release.root, roots[0]); assert.equal(starts[0].release.root, roots[0]);
  const second = green.validateTree({ ...options, tier: 'promotion' });
  assert.equal(second.reused, true); assert.equal(second.key, first.key);
  assert.equal(second.release.root, roots[0], 'reused evidence names the bundle that executed the proof');
  assert.equal(starts.length, 1); assert.deepEqual(f.count(), ['same']);
  const receipt = path.join(f.repo, '.git/lane-validation', `${oldKey}.json`);
  const legacy = JSON.parse(fs.readFileSync(receipt, 'utf8')); delete legacy.release;
  fs.writeFileSync(receipt, JSON.stringify(legacy));
  assert.equal(green.validateTree({ ...options, tier: 'fast' }).reused, true, 'older receipts without release metadata remain reusable');
  assert.equal(starts.length, 1); assert.deepEqual(f.count(), ['same']);
});
