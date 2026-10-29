import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { configFixture } from './helpers/config-home-fixture.mjs';
import { releaseEnvironment } from './helpers/release-environment.mjs';
import { configGitEnv } from '../lib/config-home.mjs';
import { copyProduct } from '../lib/product-files.mjs';
import { acceptanceRecord, checkRelease, requireHomeRelease, requireReadyAcceptance, selectRelease } from '../lib/releases.mjs';

const source = path.resolve(import.meta.dirname, '..');
const tooling = path.join(source, 'herdr/releases.mjs');
const readManifest = root => JSON.parse(fs.readFileSync(path.join(root, '.release-manifest.json'), 'utf8'));

function manifest(root, env, { ready = false } = {}) {
  const args = [tooling, 'manifest', root];
  let summary;
  if (ready) {
    // Offline acceptance evidence only: never invoke the live harness.
    summary = Buffer.from(JSON.stringify({ ready: true,
      candidateCommit: fs.readFileSync(path.join(root, '.release-commit'), 'utf8').trim(),
      elapsedSeconds: 1, counts: { PASS: 1, FAIL: 0, PENDING: 0, SKIP: 0 } }) + '\n');
    const file = path.join(path.dirname(root), `${path.basename(root)}-summary.json`);
    fs.writeFileSync(file, summary);
    args.push(file);
  }
  execFileSync(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const value = readManifest(root);
  assert.equal(value.schema, 'herdr-release/v1');
  assert.equal(value.protocol, 1);
  assert.equal(value.commit, fs.readFileSync(path.join(root, '.release-commit'), 'utf8').trim());
  assert.deepEqual(value.acceptance, summary ? acceptanceRecord(summary, value.commit) : { ran: false, ready: false });
  if (summary) assert.deepEqual(fs.readFileSync(path.join(root, '.release-acceptance.json')), summary);
  return value;
}

test('manifest capability follows the target policy reader and preserves both acceptance modes', t => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-manifest-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const home = path.join(scratch, 'installation'), root = path.join(home, 'releases', 'snapshot');
  const env = releaseEnvironment(process.env, { HOME: scratch, HERDR_MONITOR_HOME: home });
  copyProduct(source, root);
  fs.writeFileSync(path.join(root, '.release-commit'), '1'.repeat(40) + '\n');
  const offline = manifest(root, env);
  assert.equal(offline.config_home, 1);
  const ready = manifest(root, env, { ready: true });
  assert.deepEqual({ ...ready, acceptance: offline.acceptance }, offline);
  assert.equal(requireHomeRelease('snapshot', null, home).root, root);

  // Even a target retaining home discovery cannot claim home-aware policy
  // readers from the tooling's own installation.
  fs.unlinkSync(path.join(root, 'lib/config-policy.mjs'));
  const withoutReader = manifest(root, env);
  assert.equal(Object.hasOwn(withoutReader, 'config_home'), false);
  assert.ok(withoutReader.files['lib/config-home.mjs']);
  checkRelease(home, 'snapshot', { verifyFiles: true });
});

test('an older shell inventory refuses a newer home pin; invoking the accepted root admits dispatch without replay',async t=>{
  const f=configFixture(t);
  await f.adopt();
  execFileSync(process.execPath,[tooling,'pin',f.installationHome,f.cwd,'compatible'],{cwd:f.cwd,env:f.env,stdio:['ignore','pipe','pipe']});
  const older=f.release('older-tools'),inventory=path.join(older,'lib/product-files.mjs');
  // Reproduce d993883a63's inventory rule: the three later ENG-864 assets
  // exist in the selected bundle but are absent from the caller's recipe.
  const original=fs.readFileSync(inventory,'utf8');
  const reduced=original.replace(/\.\.\.\['r1176', 'sol-research', 'claude-research'\]\.map\(id => `docs\/evidence\/ENG-864\/\$\{id\}\.json`\)/,"...[]");
  assert.notEqual(reduced,original);fs.writeFileSync(inventory,reduced);
  const env={...f.env,PATH:path.dirname(process.execPath)+path.delimiter+f.env.PATH,HERDR_MONITOR_HOME:path.join(f.scratch,'wrong-installation')};
  const run=root=>spawnSync('bash',[path.join(root,'herdr/release.sh'),'exec','dispatch/dispatch.mjs','--repo',f.cwd,'--help'],{
    cwd:f.cwd,env,encoding:'utf8'});
  const refused=run(older);assert.notEqual(refused.status,0);assert.match(refused.stderr,/incomplete release compatible: inventory/);
  assert.ok(refused.stderr.includes(`invoking tools ${older}`));assert.ok(refused.stderr.includes(`use the pinned release.sh at ${f.bundle}/herdr/release.sh`));
  const accepted=run(f.bundle);assert.equal(accepted.status,0,accepted.stderr);assert.match(accepted.stdout,/Usage: node dispatch\/dispatch.mjs/);
  // Simulate the reported PATH Node version before the tooling module loads;
  // no dependency on a second host Node installation and no dispatch effect.
  const preload=path.join(f.scratch,'node22.mjs');fs.writeFileSync(preload,"Object.defineProperty(process,'version',{value:'v22.22.3'});\n");
  for(const args of [['run','dispatch/dispatch.mjs','--help'],['exec',f.installationHome,'dispatch/dispatch.mjs','--help']]){
    const wrongNode=spawnSync(process.execPath,['--import',preload,path.join(f.bundle,'herdr/releases.mjs'),...args],{cwd:f.cwd,env,encoding:'utf8'});
    assert.notEqual(wrongNode.status,0);assert.equal(wrongNode.stdout,'');assert.match(wrongNode.stderr,/requires Node 20\.19\.4; running v22\.22\.3/);
  }
  const manifestFile=path.join(f.bundle,'.release-manifest.json'),before=fs.readFileSync(manifestFile);
  // Selecting the correct verifier retains integrity checks; a removed
  // manifest entry cannot become a successful help/dispatch invocation.
  const drift=JSON.parse(before);delete drift.files['lib/state.mjs'];fs.writeFileSync(manifestFile,JSON.stringify(drift));
  const damaged=run(f.bundle);assert.notEqual(damaged.status,0);assert.match(damaged.stderr,/inventory/);
  fs.writeFileSync(manifestFile,before);
});

function archiveSnapshot(f, ref, id) {
  const env = configGitEnv(f.env);
  const commit = execFileSync('git', ['-C', source, 'rev-parse', `${ref}^{commit}`], { env, encoding: 'utf8' }).trim();
  const archive = path.join(f.scratch, `${id}.tar`), root = path.join(f.installationHome, 'releases', id);
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['-C', source, 'archive', '--format=tar', '--output', archive, commit], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('tar', ['-xf', archive, '-C', root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(root, '.release-commit'), commit + '\n');
  return { root, commit };
}

test('current tooling refuses an actual pre-config-home archive for an adopted project', async t => {
  if (!fs.existsSync(path.join(source, '.git'))) {
    t.skip('historical archive witness requires repository metadata; release snapshots have none');
    return;
  }
  const f = configFixture(t);
  await f.adopt();
  const binding = f.binding();
  assert.ok(binding, 'the refusal must exercise an adopted project');
  const legacyId = 'legacy-5d37aa00', legacy = archiveSnapshot(f, '5d37aa00a414718cf45f50a8c4303936ac8ab8cf', legacyId);
  assert.equal(fs.existsSync(path.join(legacy.root, 'lib/config-policy.mjs')), false);
  assert.equal(Object.hasOwn(manifest(legacy.root, f.env), 'config_home'), false);
  assert.equal(Object.hasOwn(manifest(legacy.root, f.env, { ready: true }), 'config_home'), false);
  const release = checkRelease(f.installationHome, legacyId, { verifyFiles: true });
  assert.equal(requireReadyAcceptance(release, f.installationHome).commit, legacy.commit);
  const refusal = { message: `incompatible downgrade: ${legacyId} cannot read adopted home policy` };
  assert.throws(() => requireHomeRelease(legacyId, binding, f.installationHome), refusal);
  const current = path.join(f.installationHome, 'current');
  fs.unlinkSync(current); fs.symlinkSync(legacy.root, current);
  assert.throws(() => selectRelease(f.cwd, f.installationHome), refusal);

  // Current immutable input and both already-shipped home-capable revisions
  // retain the same capability and admission contract with today's tooling.
  for (const ref of ['HEAD', '99817e2c3d2e4cb7cfe12db6088701323ce69a72', 'd9ae1e1b7aed7469c80aaad335df6dd9a54fc857']) {
    const id = ref === 'HEAD' ? 'current-snapshot' : ref.slice(0, 10);
    const snapshot = archiveSnapshot(f, ref, id);
    const value = manifest(snapshot.root, f.env, { ready: true });
    assert.equal(value.config_home, 1, ref);
    const before = fs.readFileSync(path.join(snapshot.root, '.release-manifest.json'));
    assert.equal(requireHomeRelease(id, binding, f.installationHome).commit, snapshot.commit);
    assert.deepEqual(fs.readFileSync(path.join(snapshot.root, '.release-manifest.json')), before);
  }
});
