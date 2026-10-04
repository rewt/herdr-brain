import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { loadTimeout } from '../../lib/deadline.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { permissionArgs, sessionEnv } from '../security.mjs';
import { createVerification, safeGitArgs } from '../verify.mjs';
import { copyProduct } from '../../lib/product-files.mjs';
import { snapshot } from '../../herdr/entry-runtime.mjs';
import { copyNativeTransport } from '../transport.mjs';
import { installRuntime } from '../../housekeeping/test/helpers/cli-fixture.mjs';

const discovered = spawnSync('which', ['codex'], { encoding: 'utf8' }).stdout?.trim();
const skip = process.platform !== 'darwin' || !discovered;
function installProduct(installation) {
  copyProduct(path.resolve(import.meta.dirname, '../..'), installation);
}

// Parse imports without executing CLI entrypoints, models, services or hooks.
// Run on every platform, including machines without the native harness.
function checkInstalledImports(installation) {
  return spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', `
    import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
    import { SourceTextModule } from 'node:vm';
    const root = process.argv[1];
    function visit(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (['test', 'tests', 'node_modules'].includes(entry.name)) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.name.endsWith('.mjs')) {
          const module = new SourceTextModule(fs.readFileSync(file, 'utf8'), { identifier: file });
          for (const specifier of module.dependencySpecifiers) if (specifier.startsWith('.')) {
            const dependency = path.resolve(path.dirname(file), specifier);
            assert.ok(fs.existsSync(dependency), path.relative(root, file) + ' imports missing ' + path.relative(root, dependency));
          }
        }
      }
    }
    visit(root);
  `, installation], { encoding: 'utf8', timeout: 20000 });
}

test('installed product contains every relative module import, including fleet dependencies', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-product-imports-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installation = path.join(root, 'installed');
  installProduct(installation);
  const checked = checkInstalledImports(installation);
  assert.equal(checked.status, 0, checked.stderr || checked.error?.message);
  const plan = snapshot(installation, path.join(root, 'runtime'), 'import-regression');
  plan.prepare();
  const runtime = checkInstalledImports(plan.directory);
  assert.equal(runtime.status, 0, runtime.stderr || runtime.error?.message);
  const plugin = path.join(root, 'plugin');
  copyProduct(path.resolve(import.meta.dirname, '../..'), plugin, { includeApps: true });
  const apps = checkInstalledImports(plugin);
  assert.equal(apps.status, 0, apps.stderr || apps.error?.message);
  // These formerly maintained partial product lists independently.
  const transport = copyNativeTransport(path.join(root, 'native'));
  const native = checkInstalledImports(path.resolve(path.dirname(transport), '..'));
  assert.equal(native.status, 0, native.stderr || native.error?.message);
  const housekeeping = path.join(root, 'housekeeping'); installRuntime(housekeeping);
  const schedule = checkInstalledImports(housekeeping);
  assert.equal(schedule.status, 0, schedule.stderr || schedule.error?.message);
  // Release builders archive every tracked file without a path allowlist.
  const git = (args) => {
    const result = spawnSync('git', ['-C', plugin, ...args], { encoding: undefined, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(result.status, 0, String(result.stderr)); return result.stdout;
  };
  git(['init', '-q']); git(['add', '.']);
  git(['-c', 'user.name=Packaging test', '-c', 'user.email=packaging@example.invalid', 'commit', '-qm', 'Product']);
  const released = path.join(root, 'release'); fs.mkdirSync(released);
  const unpack = spawnSync('tar', ['-x', '-C', released], { input: git(['archive', 'HEAD']) });
  assert.equal(unpack.status, 0, String(unpack.stderr));
  const release = checkInstalledImports(released);
  assert.equal(release.status, 0, release.stderr || release.error?.message);
  // Prove the check detects the packaging regression even without executing a model.
  fs.unlinkSync(path.join(installation, 'herdr/entry-lock.mjs'));
  const missing = checkInstalledImports(installation);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /imports missing herdr\/entry-lock\.mjs/);
});
function fixture(t) {
  const previousActor = process.env.ORG_ACTOR;
  process.env.ORG_ACTOR = `acceptance-verification-${t.name}`;
  t.after(() => previousActor === undefined ? delete process.env.ORG_ACTOR : process.env.ORG_ACTOR = previousActor);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-native-')));
  const repo = path.join(root, 'project'), temp = path.join(root, 'session');
  for (const directory of [repo, temp, path.join(root, 'installed'), path.join(root, 'runtime')]) fs.mkdirSync(directory);
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { cwd: options.cwd ?? repo, env: options.isolatedEnv ?? { PATH: process.env.PATH,
      ORG_ACTOR: `acceptance-${t.name.replaceAll(/[^a-z0-9]/giu, '-').slice(0, 80)}`,
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8', timeout: loadTimeout(20000), input: options.input });
    if (options.ok !== false) assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result;
  };
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Acceptance'], ['config', 'user.email', 'acceptance@example.invalid']]) run('git', safeGitArgs(repo, args));
  fs.writeFileSync(path.join(repo, 'proof.txt'), 'seed'); run('git', safeGitArgs(repo, ['add', '.'])); run('git', safeGitArgs(repo, ['commit', '-qm', 'Seed']));
  const binary = fs.realpathSync(discovered);
  const gitBinary = fs.realpathSync(spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim());
  const spec = { name: 'verification-test', repo, temp, binary, gitBinary, runtimeHome: path.join(root, 'runtime'), installation: path.join(root, 'installed'), gitCommon: path.join(repo, '.git'),
    toolRoots: [path.resolve(path.dirname(process.execPath), '..'), path.resolve(path.dirname(binary), '..'), '/opt/homebrew'], path: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin` };
  const discoveryRoots = [];
  const scratchRoots = [root];
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); for (const directory of discoveryRoots) fs.rmSync(directory, { recursive: true, force: true }); });
  return { root, repo, temp, spec, run, discoveryRoots, scratchRoots };
}

test('native direct session can commit/worktree/ref but cannot write common or worktree config and hooks', { skip }, (t) => {
  const { root, repo, temp, spec, run } = fixture(t);
  const marker = path.join(temp, 'hook-called');
  fs.writeFileSync(path.join(repo, '.git/hooks/pre-commit'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const script = path.join(temp, 'proof.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
    const git=(cwd,args)=>{const r=spawnSync(${JSON.stringify(spec.gitBinary)},${JSON.stringify(safeGitArgs(repo, []))}.map(x=>x===${JSON.stringify(repo)}?cwd:x).concat(args),{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
    const worktree=${JSON.stringify(path.join(temp, 'proof-worktree'))};git(${JSON.stringify(repo)},['worktree','add','-b','proof',worktree]);fs.writeFileSync(worktree+'/proof.txt','changed');git(worktree,['commit','-am','Sandbox proof']);const head=git(worktree,['rev-parse','HEAD']);git(worktree,['update-ref','refs/acceptance/proof',head]);
    for(const file of ${JSON.stringify([path.join(repo, '.git/config'), path.join(repo, '.git/config.lock'), path.join(repo, '.git/hooks/pre-commit'), path.join(repo, '.git/worktrees/proof-worktree/config.worktree')])}){let denied=false;try{fs.writeFileSync(file,'unsafe')}catch(e){denied=['EPERM','EACCES'].includes(e.code)}assert.ok(denied,file)}
    assert.ok(!fs.existsSync(${JSON.stringify(marker)}));console.log('commit/worktree/ref pass; config/hooks writes denied');`);
  const checked = run(spec.binary, ['sandbox', '-C', repo, '-P', 'acceptance', ...permissionArgs(spec), '--', process.execPath, script], { isolatedEnv: sessionEnv({}, spec) });
  assert.match(checked.stdout, /config\/hooks writes denied/);
});

test('model-controlled tests and Git filters execute only sandboxed; fsmonitor/hooks stay disabled', { skip }, async (t) => {
  const { root, repo, spec, run, discoveryRoots, scratchRoots } = fixture(t);
  const verifier = createVerification(spec, { root, scratchRoots, discoveryRoots, run });
  const outside = path.join(root, 'operator-canary'), filterMarker = path.join(verifier.temp, 'filter-ran'), monitorMarker = path.join(verifier.temp, 'fsmonitor-ran');
  const socket = path.join(root, 'operator.sock'), server = net.createServer((connection) => { connection.destroy(); assert.fail('sandbox connected to operator socket'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  fs.writeFileSync(path.join(repo, 'monitor.cjs'), `require('fs').writeFileSync(${JSON.stringify(monitorMarker)},'called');`);
  fs.writeFileSync(path.join(repo, 'filter.cjs'), `const fs=require('fs');let denied=false;try{fs.writeFileSync(${JSON.stringify(outside)},'escape')}catch(e){denied=['EPERM','EACCES'].includes(e.code)}require('assert').ok(denied);fs.writeFileSync(${JSON.stringify(filterMarker)},'sandboxed');process.stdin.pipe(process.stdout);`);
  // Deliberately poisoned fixture. No host Git call occurs after these writes.
  fs.appendFileSync(path.join(repo, '.git/config'), `\n[core]\n fsmonitor = "${process.execPath} ${path.join(repo, 'monitor.cjs')}"\n[filter "attack"]\n clean = "${process.execPath} ${path.join(repo, 'filter.cjs')}"\n`);
  fs.writeFileSync(path.join(repo, '.gitattributes'), 'proof.txt filter=attack\n'); fs.writeFileSync(path.join(repo, 'proof.txt'), 'changed');
  verifier.git(['status', '--porcelain']);
  verifier.execute(spec.gitBinary, safeGitArgs(repo, ['hash-object', '--path=proof.txt', '--stdin']), { input: 'filter input' });
  assert.ok(fs.existsSync(filterMarker)); assert.ok(!fs.existsSync(outside)); assert.ok(!fs.existsSync(monitorMarker));
  fs.mkdirSync(path.join(repo, 'test'));
  fs.writeFileSync(path.join(repo, 'test/attack.test.mjs'), `import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import net from 'node:net';test('execution boundary',async()=>{
    assert.throws(()=>fs.writeFileSync(${JSON.stringify(outside)},'escape'),e=>['EPERM','EACCES'].includes(e.code));
    assert.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(repo, '.git/config'))},'escape'),e=>['EPERM','EACCES'].includes(e.code));
    assert.ok(!Object.keys(process.env).some(k=>/^(HERDR_SOCKET|HERDR_PANE|ACCEPTANCE)/.test(k)));
    await new Promise((resolve,reject)=>{const s=net.createConnection(${JSON.stringify(socket)});s.once('connect',()=>{s.destroy();reject(Error('socket allowed'))});s.once('error',e=>['EPERM','EACCES'].includes(e.code)?resolve():reject(e))});});`);
  const checked = verifier.execute(process.execPath, ['--test']); assert.match(checked.stdout, /# pass 1/);
  assert.ok(!fs.existsSync(outside));
});

test('record verification and scripted answer are kernel-confined even if model output redirects .org', { skip }, (t) => {
  const { root, repo, spec, run, discoveryRoots, scratchRoots } = fixture(t);
  installProduct(spec.installation);
  run(process.execPath, [path.join(spec.installation, 'bin/org.mjs'), 'init', path.join(repo, '.org')]);
  const verifier = createVerification(spec, { root, scratchRoots, discoveryRoots, run });
  const parent = verifier.record(['add', 'Routing decision', '--role', 'architect']).trim().split('\n')[0];
  const question = verifier.record(['ask', 'Configure routes?', '--parent', parent, '--category', 'other', '--recommend', 'yes', '--why', 'A concrete sandbox regression recommendation']).trim().split('\n')[0];
  assert.match(question, /^HUM-\d+/);
  assert.ok(!JSON.parse(verifier.record(['status', '--json'])).items.find((item) => item.id === question).meta?.answer, 'fresh other question must await a human');
  verifier.record(['answer', question, 'yes'], { ORG_ACTOR: 'human' });
  assert.match(verifier.record(['show', question]), /yes/);
  const outside = path.join(root, 'foreign-record'); fs.mkdirSync(outside);
  const foreign = path.join(outside, 'events.jsonl'); fs.writeFileSync(foreign, 'unchanged');
  fs.rmSync(path.join(repo, '.org'), { recursive: true }); fs.symlinkSync(outside, path.join(repo, '.org'));
  assert.throws(() => verifier.record(['answer', question, 'no']));
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'unchanged');
});
