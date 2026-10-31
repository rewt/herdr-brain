import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { copyProduct } from '../../lib/product-files.mjs';
import { captureCandidate, fixtureInventory } from '../installed-candidate.mjs';
import { harnessEnvironment } from '../run.mjs';
import { enterScratchHomes } from '../environment.mjs';
import { makeSnapshotWritable } from '../snapshot.mjs';
import { createReceiptTracker } from '../../test/helpers/receipts.mjs';

const source = path.resolve(import.meta.dirname, '../..');
const historical = [
  ['broken', '210148248782979c4311117158c27742e3231227'],
  ['fixed', 'b60217468d776bd119451d62a4fe37246f8019a9'],
];
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

for (const [mode, revision] of [...historical, ['current', 'HEAD'], ['canary', null]]) {
  test(`installed-only ${mode} consumer ${mode === 'canary' ? 'exercises the frozen candidate S0-S8 and shared observation' : mode === 'current' ? 'completes the original review and retains uncertain input' : 'witnesses ENG-1020 dispatch'}`,
    { skip: mode === 'canary' && !process.env.INSTALLED_CYCLE_BUNDLE }, t => {
    assert.equal(process.platform, 'darwin', 'this installed-consumer boundary requires macOS sandbox-exec');
    assert.equal(process.version, 'v20.19.4', 'use the project-pinned runtime');
    const root = fs.realpathSync(fs.mkdtempSync('/tmp/ic-'));
    const evidence = path.join(root, 'evidence'), development = path.join(root, 'development-unavailable');
    const env = harnessEnvironment(process.env, root);
    const savedHome = os.userInfo().homedir;
    // Runtime children receive only scratch configuration and installed paths.
    delete env.NODE_OPTIONS;
    Object.assign(env, { PATH: `${root}/bin:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      ORG_DIR: path.join(root, 'project/.org'), INSTALLED_CYCLE_ROOT: root,
      HERDR_SOCKET_PATH: path.join(root, 'absent.sock'), HERDR_TEST_OFFLINE_ROOT: root,
      BRAIN_SHADOW_ROOT: path.join(root, 'shadow'), HERDR_TEST_SCRATCH_ROOTS: '[]' });
    for (const name of ['bin', 'project', 'evidence', 'harness', 'home']) fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, '.identity-root'), 'installed-scratch\n');
    let success = false;
    const receipts = createReceiptTracker();
    t.after(async () => {
      const jobs = path.join(root, 'project/.org/dispatch');
      for (const name of fs.existsSync(jobs) ? fs.readdirSync(jobs) : []) {
        if (!name.endsWith('.json') || name.endsWith('.routes.json')) continue;
        const job = JSON.parse(fs.readFileSync(path.join(jobs, name)));
        if (job.watcher?.pid) receipts.remember(job.watcher.pid, [process.execPath, job.release.root + '/watch/watch.mjs', job.run,
          '--controller', job.ownership.owner.controller, '--org', job.org, '--to', job.to, '--cwd', job.repo, '--log', job.watcher.log,
          '--record-only', '--retry-after', '0.02', '--start-grace', '0'].join(' '));
      }
      receipts.cleanup();
      // A watcher can have one short synchronous native lookup in flight.
      await new Promise(resolve => setTimeout(resolve, 100));
      // Preserve failed scratch and its original requests. Successful cases
      // retain evidence before their disposable payloads are removed.
      if (process.env.INSTALLED_CYCLE_EVIDENCE) {
        const destination = path.join(path.resolve(process.env.INSTALLED_CYCLE_EVIDENCE), mode);
        fs.mkdirSync(destination, { recursive: true });
        for (const name of ['evidence', 'config.json', 'sandbox.sb', 'native.json', 'native-calls.jsonl', 'project',
          ...(mode==='canary'?['worktrees','missing-allocation-retained']:[])]) {
          const file = path.join(root, name);
          if (fs.existsSync(file)) fs.cpSync(file, path.join(destination, name), { recursive: true });
        }
        fs.writeFileSync(path.join(destination, 'cleanup.json'), JSON.stringify({ root, success, scratchRemoved: success,
          uncertainFixtureDestroyedOnlyAfterRetentionProof: success && ['current','canary'].includes(mode) }, null, 2) + '\n');
      }
      if (success) { makeSnapshotWritable(root, path.dirname(root)); fs.rmSync(root, { recursive: true, force: true }); }
      else t.diagnostic(`Original failed scratch retained at ${root}`);
    });
    const restore = enterScratchHomes(env, [root]);
    t.after(restore);
    const run = (exe, args, options = {}) => {
      const result = spawnSync(exe, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
      assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout); return result.stdout;
    };
    const candidate = mode === 'canary' ? captureCandidate(process.env.INSTALLED_CYCLE_BUNDLE, {
      commit: process.env.INSTALLED_CYCLE_COMMIT, manifestSha256: process.env.INSTALLED_CYCLE_MANIFEST_SHA256,tree:process.env.INSTALLED_CYCLE_TREE }) : null;
    const commit = candidate?.commit ?? run('git', ['-C', source, 'rev-parse', revision]).trim();
    // Archive the exact objects, then copy the same runtime inventory used by
    // releases. No shared Git metadata, alternates, links or maintained repo.
    const home = env.HERDR_MONITOR_HOME, bundle = path.join(home, 'releases/scenario');
    if (candidate) {
      fs.mkdirSync(evidence, {recursive:true});
      fs.writeFileSync(path.join(evidence,'original-candidate.json'), JSON.stringify(candidate,null,2)+'\n');
      for (const name of ['.release-manifest.json','.release-commit','.release-validation.json','.release-acceptance.json']) {
        if (fs.existsSync(path.join(candidate.root,name))) fs.copyFileSync(path.join(candidate.root,name),path.join(evidence,'original'+name));
      }
      copyProduct(candidate.root, bundle);
      // Negative controls precede all consumer effects. The original remains
      // read-only; mutation is confined to this disposable fixture copy.
      assert.throws(()=>captureCandidate(candidate.root,{commit:'0'.repeat(40),manifestSha256:candidate.manifestSha256}),/candidate commit/);
      assert.throws(()=>captureCandidate(candidate.root,{commit,manifestSha256:'0'.repeat(64)}),/manifest digest/);
      const probe=path.join(bundle,'bin/org.mjs'), bytes=fs.readFileSync(probe),modeBits=fs.statSync(probe).mode;
      fs.chmodSync(probe,modeBits|0o200);
      fs.appendFileSync(probe,'\n// injected drift\n');
      assert.throws(()=>fixtureInventory(bundle,candidate),/inventory/);
      fs.writeFileSync(probe,bytes);fs.chmodSync(probe,modeBits);fixtureInventory(bundle,candidate);
    } else {
      const archive = spawnSync('git', ['-C', source, 'archive', '--format=tar', commit], { env, maxBuffer: 64 * 1024 * 1024 });
      assert.equal(archive.status, 0, archive.stderr?.toString());
      fs.mkdirSync(development);
      run('/usr/bin/tar', ['-xf', '-', '-C', development], { input: archive.stdout });
      copyProduct(development, bundle);
    }
    fs.writeFileSync(path.join(bundle, '.release-commit'), commit + '\n');
    // Explicit synthetic acceptance is fixture input to the installed resolver,
    // never a release qualification or a claim that a release suite ran.
    const summary = path.join(root, 'fixture-acceptance.json');
    fs.writeFileSync(summary, JSON.stringify({ ready: true, candidateCommit: commit, elapsedSeconds: 1,
      counts: { PASS: 1, FAIL: 0, PENDING: 0, SKIP: 0 }, fixtureOnly: true }));
    run(process.execPath, [path.join(bundle, 'herdr/releases.mjs'), 'manifest', bundle, summary]);
    fs.copyFileSync(path.join(bundle, '.release-manifest.json'), path.join(evidence, 'fixture-release-manifest.json'));
    fs.rmSync(development, { recursive: true, force:true });
    const freeze = file => { const s = fs.lstatSync(file); if (s.isDirectory()) for (const name of fs.readdirSync(file)) freeze(path.join(file, name)); fs.chmodSync(file, s.mode & ~0o222); };
    freeze(bundle);
    let successor;
    if(mode==='current' || mode==='canary') {
      successor=path.join(home,'releases/successor');
      copyProduct(bundle,successor);
      fs.writeFileSync(path.join(successor,'.release-commit'),commit+'\n');
      run(process.execPath,[path.join(successor,'herdr/releases.mjs'),'manifest',successor,summary]);
      freeze(successor);
    }
    fs.symlinkSync(bundle, path.join(home, 'current'));
    for (const name of ['installed-cycle.mjs', 'installed-canary.mjs', 'installed-native.mjs', 'installed-observations.mjs']) fs.copyFileSync(path.join(source, 'acceptance', name), path.join(root, 'harness', name));
    for (const name of ['fixture-policy.mjs', 'memory-fixture.mjs']) fs.copyFileSync(path.join(source, 'test/helpers', name), path.join(root, 'harness', name));
    env.NODE_OPTIONS = `--import=${path.join(root, 'harness/fixture-policy.mjs')} --import=${path.join(root, 'harness/installed-observations.mjs')}`;
    fs.writeFileSync(path.join(root, 'bin/herdr'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, 'harness/installed-native.mjs'))} "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'bin/watch'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(bundle, 'watch/watch.mjs'))} "$@" --record-only --retry-after 0.02 --start-grace 0\n`, { mode: 0o755 });
    if(successor)fs.writeFileSync(path.join(root,'bin/watch-successor'),`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(successor,'watch/watch.mjs'))} "$@" --record-only --retry-after 0.02 --start-grace 0\n`,{mode:0o755});
    for (const name of ['codex', 'claude']) fs.writeFileSync(path.join(root, 'bin', name), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
    const repo = path.join(root, 'project'), org = path.join(repo, '.org');
    run('git', ['init', '-qb', 'main', repo]);
    run('git', ['-C', repo, 'config', 'user.name', 'Installed scenario']);
    run('git', ['-C', repo, 'config', 'user.email', 'installed@example.invalid']);
    fs.writeFileSync(path.join(repo, '.git/info/exclude'), '.org/\n.lane/\n');
    fs.writeFileSync(path.join(repo, '.herdr-release.json'), '{"release":"scenario"}\n');
    fs.writeFileSync(path.join(repo, '.lane.json'), JSON.stringify({ main: 'main', validate: 'true', worktree_root: path.join(root, 'worktrees'),
      routes: { engineer: { kind: 'codex' }, reviewer: { kind: 'codex' } },
      dispatch: { max_sessions: mode==='canary'?8:4, max_unlanded: 8 }, retirement: { closeout_queue: false, line_service_cleanup: ['current','canary'].includes(mode) } }));
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'Independent installed consumer\n');
    run('git', ['-C', repo, 'add', '.']); run('git', ['-C', repo, 'commit', '-qm', 'Independent scratch project']);
    fs.writeFileSync(path.join(root, 'native.json'), JSON.stringify({ repo, workspaces: {}, next: 0 }));
    const forbidden = [path.join(source, 'package.json'), path.join(savedHome, 'development/rewt/.org/config.json')];
    const config = { root, repo, org, home, bundle, successor, commit, mode, development, forbidden, candidate };
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2));
    // Deny the entire real home except the pinned interpreter. Descendants
    // inherit the boundary; no host test preload or live socket is accessible.
    const profile = `(version 1) (allow default) (deny network*)\n` +
      `(deny file-read* file-write* (require-all (subpath ${JSON.stringify(savedHome)}) (require-not (subpath ${JSON.stringify(path.dirname(process.execPath))})) ))\n`;
    fs.writeFileSync(path.join(root, 'sandbox.sb'), profile);
    const result = spawnSync('/usr/bin/sandbox-exec', ['-f', path.join(root, 'sandbox.sb'), process.execPath, '--import', path.join(root, 'harness/fixture-policy.mjs'), '--import', path.join(root, 'harness/installed-observations.mjs'),
      path.join(root, 'harness/installed-cycle.mjs'), path.join(root, 'config.json')], { cwd: repo, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    fs.writeFileSync(path.join(evidence, 'scenario-output.json'), JSON.stringify({ status: result.status, signal: result.signal,
      error: result.error?.message, stdout: result.stdout, stderr: result.stderr }, null, 2));
    assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
    success = true;
    t.diagnostic(JSON.stringify({ mode, commit, evidence, result: ['current','canary'].includes(mode) ? JSON.parse(fs.readFileSync(path.join(evidence, 'outcome.json'))) : 'historical dispatch witnessed' }));
  });
}
