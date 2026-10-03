import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ownerTargets, bundledOwner, prepareOwner, sha256, verifyOwner } from '../owner.mjs';
import { snapshot } from '../../herdr/entry-runtime.mjs';
import { validationTransport } from '../../acceptance/validation.mjs';
import { sandboxCommand } from '../confinement.mjs';
import { lifetimeScope, closeScope } from '../lifetime.mjs';
import { spawnDetachedFixture } from '../../test/helpers/detached.mjs';
import { waitForExit } from '../../test/helpers/child.mjs';
import { copyProduct as installProduct } from '../../lib/product-files.mjs';

const product = path.resolve(import.meta.dirname, '../..');
const host = `${process.platform}-${process.arch}`;
const actorTest = (name, fn, options = {}) => test(name, { timeout: 25000, ...options }, t => {
  process.env.ORG_ACTOR = `eng105-${name.replaceAll(/[^a-z0-9]/giu, '-').slice(0, 80)}`;
  return fn(t);
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-owner-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function copyProduct(root) {
  installProduct(product, root);
}
function invoke(root, compiler = 'missing', extra = {}) {
  const marker = path.join(root, 'executed'), calls = path.join(root, 'compiler.jsonl');
  const preload = path.join(root, 'compiler.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const original=cp.spawnSync;cp.spawnSync=(binary,args,options)=>{
  if(binary!=='/usr/bin/cc')return original(binary,args,options);
  fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({binary,args,options})+'\\n');
  ${compiler === 'success' ? `fs.copyFileSync(${JSON.stringify(path.join(product, 'discovery/native', `owner-${host}`))},args[args.indexOf('-o')+1]);return {status:0};`
    : compiler === 'failure' ? "return {status:1,stderr:'injected compilation failure'};"
      : compiler === 'timeout' ? "return {status:null,error:Object.assign(Error('injected compilation deadline'),{code:'ETIMEDOUT'})};"
        : "return {status:null,error:Object.assign(Error('injected missing /usr/bin/cc'),{code:'ENOENT'})};"}
};syncBuiltinESMExports();`);
  const source = `import {runBounded} from ${JSON.stringify(new URL(`file://${root}/discovery/bounded.mjs`).href)};
process.exitCode=await runBounded(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`)}],{timeoutMs:5000});`;
  const result = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 12000, env: { ...process.env, ORG_ACTOR: process.env.ORG_ACTOR, ...extra },
  });
  return { result, marker, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

actorTest('each bundled target matches its checksum, current source and native architecture', () => {
  for (const target of ownerTargets) {
    const [platform, arch] = target.split('-'), bytes = bundledOwner(platform, arch);
    verifyOwner(bytes, platform, arch);
    assert.throws(() => verifyOwner(bytes, platform, arch === 'arm64' ? 'x64' : 'arm64'), /target mismatch/u);
  }
  assert.throws(() => bundledOwner('win32', 'x64'), /no bundled owner target/u);
  assert.throws(() => bundledOwner('linux', 'riscv64'), /no bundled owner target/u);
});
actorTest('validation runs with no compiler and ignores CC, flags and TMPDIR overrides', t => {
  const root = fixture(t); copyProduct(root);
  const { result, marker, calls } = invoke(root, 'missing', { CC: '/untrusted/cc', CFLAGS: '-untrusted', TMPDIR: '/untrusted/tmp' });
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.ok(fs.existsSync(marker));
  assert.deepEqual(calls, []); assert.doesNotMatch(result.stderr, /trying \/usr\/bin\/cc/u);
});
actorTest('verified owner bytes are copied into private scratch with restricted modes', t => {
  const owner = prepareOwner(); t.after(owner.cleanup);
  assert.notEqual(path.dirname(owner.executable), path.join(product, 'discovery/native'));
  assert.equal(fs.statSync(path.dirname(owner.executable)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(owner.executable).mode & 0o777, 0o755);
  assert.equal(sha256(fs.readFileSync(owner.executable)), sha256(bundledOwner()));
  owner.cleanup(); assert.equal(fs.existsSync(owner.executable), false);
});
actorTest('staged owner preserves the installed validation transport lifetime protocol', t => {
  const root = fixture(t), owner = prepareOwner(), scope = lifetimeScope();
  t.after(owner.cleanup); t.after(() => closeScope(scope));
  const repo = path.join(root, 'project'), temp = path.join(root, 'session'), shared = path.join(repo, '.org');
  fs.mkdirSync(shared, { recursive: true }); fs.mkdirSync(temp); fs.mkdirSync(path.join(repo, '.git'));
  const guard = sandboxCommand('/native/codex', repo, { sharedPaths: [shared], lifetime: scope });
  const result = validationTransport({ repo, temp, installation: product, toolRoots: [], gitCommon: path.join(repo, '.git') },
    [...guard.args, owner.executable, '--enter', scope.allowed, scope.denied, '/usr/bin/true'], repo);
  assert.equal(result.lifetime, true);
}, { skip: process.platform !== 'darwin' && 'macOS installed validation transport' });
actorTest('installed runtime snapshot carries the verified owner and validates without a compiler', t => {
  const root = fixture(t), plan = snapshot(product, path.join(root, 'runtime'), 'owner-test');
  plan.prepare();
  for (const target of ownerTargets) {
    const [platform, arch] = target.split('-'); bundledOwner(platform, arch, path.join(plan.directory, 'discovery/native'));
  }
  const { result, marker, calls } = invoke(plan.directory);
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.ok(fs.existsSync(marker)); assert.deepEqual(calls, []);
});

const defects = {
  'missing binary': root => fs.unlinkSync(path.join(root, 'discovery/native', `owner-${host}`)),
  'missing manifest': root => fs.unlinkSync(path.join(root, 'discovery/native/manifest.json')),
  'invalid manifest': root => fs.writeFileSync(path.join(root, 'discovery/native/manifest.json'), '{}'),
  'corrupt binary': root => fs.appendFileSync(path.join(root, 'discovery/native', `owner-${host}`), 'corrupt'),
  'stale source': root => fs.appendFileSync(path.join(root, 'discovery/process-supervisor.c'), '\n// changed\n'),
  'symlink binary': root => {
    const file = path.join(root, 'discovery/native', `owner-${host}`); fs.unlinkSync(file);
    fs.symlinkSync(path.join(product, 'discovery/native', `owner-${host}`), file);
  },
  'redirected bundle directory': root => {
    fs.renameSync(path.join(root, 'discovery/native'), path.join(root, 'elsewhere'));
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'discovery/native'));
  },
};
for (const [name, defect] of Object.entries(defects)) actorTest(`${name} uses only the bounded source-build fallback`, t => {
  const root = fixture(t); copyProduct(root); defect(root);
  const { result, marker, calls } = invoke(root, 'success', { CC: '/untrusted/cc', CFLAGS: '-untrusted', TMPDIR: '/untrusted/tmp' });
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.ok(fs.existsSync(marker));
  assert.match(result.stderr, /validation prebuilt owner unavailable.*trying \/usr\/bin\/cc/u);
  assert.equal(calls.length, 1); const call = calls[0];
  assert.equal(call.binary, '/usr/bin/cc'); assert.equal(call.options.timeout, 15000);
  assert.deepEqual(Object.keys(call.options.env).sort(), ['PATH', 'TMPDIR']);
  assert.equal(call.options.env.PATH, '/usr/bin:/bin'); assert.notEqual(call.options.env.TMPDIR, '/untrusted/tmp');
  assert.equal(fs.existsSync(call.options.env.TMPDIR), false, 'exit removes private scratch');
});
for (const compiler of ['missing', 'failure', 'timeout']) actorTest(`unavailable bundle and ${compiler} compiler refuse project execution`, t => {
  const root = fixture(t); copyProduct(root); defects['missing binary'](root);
  const { result, marker, calls } = invoke(root, compiler);
  assert.equal(result.status, 125, result.stdout + result.stderr); assert.equal(fs.existsSync(marker), false);
  assert.match(result.stderr, /validation owner unavailable: no verified prebuilt owner.*source build failed/u);
  assert.equal(calls.length, 1); assert.equal(fs.existsSync(calls[0].options.env.TMPDIR), false);
});
actorTest('owner verification rejects a checksummed binary for the wrong architecture', t => {
  const root = fixture(t); copyProduct(root);
  const other = `${process.platform}-${process.arch === 'arm64' ? 'x64' : 'arm64'}`;
  const bytes = fs.readFileSync(path.join(root, 'discovery/native', `owner-${other}`));
  fs.writeFileSync(path.join(root, 'discovery/native', `owner-${host}`), bytes);
  const file = path.join(root, 'discovery/native/manifest.json'), manifest = JSON.parse(fs.readFileSync(file));
  manifest.targets[host].sha256 = sha256(bytes); fs.writeFileSync(file, JSON.stringify(manifest));
  const { result, marker } = invoke(root);
  assert.equal(result.status, 125); assert.equal(fs.existsSync(marker), false); assert.match(result.stderr, /target mismatch/u);
});

for (const mode of ['completion', 'deadline', 'wrapper-death']) actorTest(`no compiler preserves detached descendant cleanup after ${mode}`, async t => {
  const root = fixture(t), preload = path.join(root, 'no-compiler.mjs'), attempted = path.join(root, 'compiler-attempt');
  fs.writeFileSync(preload, `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const original=cp.spawnSync;cp.spawnSync=(binary,args,options)=>{
if(binary==='/usr/bin/cc'&&args.some(arg=>arg.endsWith('/process-supervisor.c'))){fs.writeFileSync(${JSON.stringify(attempted)},'called');return {status:null,error:Error('compiler absent')};}
return original(binary,args,options);};syncBuiltinESMExports();`);
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${previous ?? ''} --import=${JSON.stringify(preload)}`;
  try {
    const { child } = spawnDetachedFixture(t, mode);
    const result = await waitForExit(child);
    assert.equal(result.code, 0, result.stdout + result.stderr); assert.equal(fs.existsSync(attempted), false);
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
  }
});
