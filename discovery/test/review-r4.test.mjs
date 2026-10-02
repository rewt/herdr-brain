import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandboxCommand, selectSandbox, EXPERIMENTAL_BUBBLEWRAP } from '../confinement.mjs';
import { quote } from '../runtime.mjs';
const product = new URL('../../', import.meta.url).pathname;
const actorTest = (name, fn, options = {}) => test(name, { timeout: 20000, ...options }, (t) => {
  process.env.ORG_ACTOR = `r99-${name.replaceAll(/[^a-z0-9]/giu, '-').slice(0, 90)}`;
  return fn(t);
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-r99-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), bin = path.join(root, 'bin'), outside = path.join(root, 'outside');
  for (const dir of [repo, bin, outside, path.join(repo, '.git'), path.join(repo, '.org')]) fs.mkdirSync(dir);
  const invoked = path.join(root, 'provider-called'), bwrap = path.join(bin, 'bwrap'), native = path.join(bin, 'native-codex');
  const stub = `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(invoked)},'called');process.exit(99);\n`;
  for (const executable of [bwrap, native]) fs.writeFileSync(executable, stub, { mode: 0o755 });
  return { root, repo, bin, outside, invoked, bwrap, native };
}
const invoke = (args, options = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000, env: process.env, ...options });
const linuxImport = ['--import', `data:text/javascript,${encodeURIComponent("Object.defineProperty(process,'platform',{value:'linux'});")}`];
actorTest('Linux auto refuses even with bubblewrap and Codex on PATH; explicit Codex remains available', (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.native, path.join(f.bin, 'codex'));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = f.bin + path.delimiter + originalPath;
    assert.throws(() => selectSandbox('auto', { platform: 'linux' }), /no native validation sandbox.*disabled by default/u);
    assert.equal(selectSandbox(f.native, { platform: 'linux' }), f.native);
  } finally { process.env.PATH = originalPath; }
  assert.ok(!fs.existsSync(f.invoked));
});
actorTest('bare bubblewrap and renamed symlink aliases require experimental selection', (t) => {
  const f = fixture(t), alias = path.join(f.bin, 'renamed-provider'); fs.symlinkSync(f.bwrap, alias);
  for (const provider of ['bwrap', f.bwrap, alias]) {
    assert.throws(() => selectSandbox(provider), /experimental.*disabled by default/u);
    assert.throws(() => sandboxCommand(provider, f.repo, { sharedPaths: [path.join(f.repo, '.org')] }), /experimental.*disabled by default/u);
  }
});
actorTest('explicit experimental selection survives repeated selection and builds the gated provider command', (t) => {
  const f = fixture(t), selector = EXPERIMENTAL_BUBBLEWRAP + f.bwrap;
  assert.equal(selectSandbox(selectSandbox(selector)), selector);
  for (const payload of ['', 'bwrap', 'relative/bwrap', '/tmp/bwrap\0'])
    assert.throws(() => selectSandbox(EXPERIMENTAL_BUBBLEWRAP + payload), /absolute executable path/u);
  const guard = sandboxCommand(selector, f.repo, { sharedPaths: [path.join(f.repo, '.org')] });
  assert.equal(guard.binary, process.execPath);
  assert.equal(guard.args[1], '--experimental-bubblewrap'); assert.equal(guard.args[2], f.bwrap);
  assert.ok(guard.args.includes('--unshare-net')); assert.ok(guard.args.includes('--unshare-pid'));
  assert.ok(!fs.existsSync(f.invoked), 'construction is not kernel proof');
});
actorTest('direct bubblewrap launcher requires opt-in before launching a provider', (t) => {
  const f = fixture(t);
  const result = invoke([path.join(product, 'discovery/bubblewrap.mjs'), f.bwrap, '--', process.execPath, '-e', '']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /disabled by default/u); assert.ok(!fs.existsSync(f.invoked));
  const experimental = invoke([path.join(product, 'discovery/bubblewrap.mjs'), '--experimental-bubblewrap', f.bwrap, '--', process.execPath, '-e', '']);
  assert.equal(experimental.status, 99, experimental.stderr);
  assert.equal(fs.readFileSync(f.invoked, 'utf8'), 'called', 'explicit opt-in reaches the selected stub, without claiming Linux kernel proof');
});
actorTest('Linux preparation, validation and Git filters refuse default bubblewrap before executing project code', (t) => {
  const f = fixture(t), called = path.join(f.repo, 'project-called');
  const command = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(called)},'unsafe')`].map(quote).join(' ');
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ validate: command, prepare: [{ run: command }] }));
  for (const provider of ['auto', f.bwrap]) {
    const validation = invoke([...linuxImport, path.join(product, 'discovery/validate.mjs'), provider, f.repo, JSON.stringify([path.join(f.repo, '.org')])], { cwd: f.repo });
    assert.notEqual(validation.status, 0); assert.match(validation.stderr, /disabled by default/u);
    const filter = invoke([...linuxImport, path.join(product, 'discovery/git-driver.mjs'), provider, JSON.stringify([path.join(f.repo, '.org')]), Buffer.from(command).toString('base64')], { cwd: f.repo, input: 'bytes' });
    assert.notEqual(filter.status, 0); assert.match(filter.stderr, /disabled by default/u);
  }
  assert.ok(!fs.existsSync(called)); assert.ok(!fs.existsSync(f.invoked));
});
actorTest('installation requires and preserves experimental selection while Codex installs keep their native default', (t) => {
  const f = fixture(t), installed = path.join(f.root, 'installed'), installer = path.join(product, 'discovery/install.mjs');
  const refused = invoke([installer, '--bin', installed, '--claude', f.native, '--validator', f.bwrap]);
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /disabled by default/u); assert.ok(!fs.existsSync(installed));
  const selector = EXPERIMENTAL_BUBBLEWRAP + f.bwrap;
  const optedIn = invoke([installer, '--bin', installed, '--claude', f.native, '--validator', selector]);
  assert.equal(optedIn.status, 0, optedIn.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(installed, '.monitor-entry.json'))).validator, selector);
  assert.ok(fs.readFileSync(path.join(installed, 'monitor-claude'), 'utf8').includes(`--validator '${selector}'`));
  const stable = path.join(f.root, 'stable-install');
  const codex = invoke([installer, '--bin', stable, '--codex', f.native, '--claude', f.native]);
  assert.equal(codex.status, 0, codex.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stable, '.monitor-entry.json'))).validator, f.native);
  assert.ok(fs.readFileSync(path.join(stable, 'monitor-claude'), 'utf8').includes(`--validator '${f.native}'`));
  assert.ok(!fs.existsSync(f.invoked));
});
for (const [name, provider] of [['macOS', process.env.MONITOR_TEST_ALTERNATIVE], ['Codex', process.env.MONITOR_TEST_SANDBOX]])
  actorTest(`${name} copies nonempty files and refuses a redirected temporary root after profile construction`, (t) => {
    const f = fixture(t), temp = path.join(f.repo, '.lane/validation-tmp'); fs.mkdirSync(temp, { recursive: true });
    const source = path.join(f.repo, 'source'), copy = path.join(f.repo, 'copy'), marker = path.join(f.repo, 'executed');
    const sentinel = path.join(f.outside, 'sentinel'), bytes = Buffer.from([0, 255, 65, 66, 0, 127]);
    fs.writeFileSync(source, bytes); fs.writeFileSync(sentinel, 'keep');
    const guard = sandboxCommand(provider, f.repo, { sharedPaths: [path.join(f.repo, '.org'), path.join(f.repo, '.lane')], writablePaths: [temp] });
    const run = (script) => spawnSync(guard.binary, [...guard.args, process.execPath, '-e', script], { cwd: f.repo, encoding: 'utf8', timeout: 8000, env: process.env });
    const positive = run(`const fs=require('fs');fs.copyFileSync(${JSON.stringify(source)},${JSON.stringify(copy)});fs.copyFileSync(${JSON.stringify(source)},${JSON.stringify(path.join(temp, 'copy'))});`);
    assert.equal(positive.status, 0, positive.stderr); assert.deepEqual(fs.readFileSync(copy), bytes); assert.deepEqual(fs.readFileSync(path.join(temp, 'copy')), bytes);
    fs.renameSync(temp, temp + '-original'); fs.symlinkSync(f.outside, temp);
    const redirected = run(`const fs=require('fs'),assert=require('assert');fs.writeFileSync(${JSON.stringify(marker)},'called');assert.throws(()=>fs.copyFileSync(${JSON.stringify(source)},${JSON.stringify(path.join(temp, 'sentinel'))}),e=>['EPERM','EACCES'].includes(e.code));`);
    if (name === 'macOS') { assert.equal(redirected.status, 0, redirected.stderr); assert.ok(fs.existsSync(marker)); }
    else { assert.notEqual(redirected.status, 0); assert.ok(!fs.existsSync(marker), 'native provider refuses before project execution'); assert.match(redirected.stderr, /symlink/u); }
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  }, { skip: process.platform !== 'darwin' || !provider ? 'set the actual macOS/native provider for host-only applicability proof' : false });
