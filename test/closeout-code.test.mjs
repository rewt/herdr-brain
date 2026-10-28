// Module-loading witnesses use Git/files only, with finite joined children.
import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { copyProduct } from '../lib/product-files.mjs';

for (const [kind, change] of [['checkout', 'code'], ['checkout', 'main epoch'], ['checkout', 'main branch'], ['release', 'main epoch']])
test(`${kind} launch binding checks ${kind === 'checkout' ? 'the consumer graph and main branch' : 'the full main epoch'} during loading (${change})`, async t => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'closer-loading-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const code = path.join(scratch, 'code'), repo = path.join(scratch, 'project');
  const loadedRoot = kind === 'release' ? path.join(scratch, 'bundle') : code;
  const marker = path.join(scratch, 'loading'), release = path.join(scratch, 'continue');
  const env = { ...process.env, HERDR_MONITOR_FLEET: path.join(scratch, 'fleet'), HERDR_BRAIN_ROOT: loadedRoot };
  const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(scratch, ['clone', '--quiet', '--shared', fileURLToPath(new URL('../', import.meta.url)), code]);
  git(code, ['branch', '-M', 'main']);
  fs.mkdirSync(repo); git(repo, ['init', '-qb', 'main']);
  for (const cwd of [repo, code]) {
    git(cwd, ['config', 'user.name', 'Loading fixture']); git(cwd, ['config', 'user.email', 'loading@example.invalid']);
  }
  fs.writeFileSync(path.join(repo, 'seed'), 'base'); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'Base']);
  const runtime = path.join(code, 'lib/closeout-executor.mjs'), original = fs.readFileSync(runtime, 'utf8');
  fs.appendFileSync(runtime, `
fs.writeFileSync(${JSON.stringify(marker)}, 'old graph loaded');
const loadingDeadline = Date.now() + 30000;
while (!fs.existsSync(${JSON.stringify(release)})) {
  if (Date.now() > loadingDeadline) throw Error('module loading barrier expired');
  await new Promise(resolve => setTimeout(resolve, 10));
}
`);
  git(code, ['commit', '-am', 'Deterministic loading barrier']);
  const oldCode = git(code, ['rev-parse', 'HEAD']), oldEpoch = git(repo, ['rev-parse', 'HEAD']);
  if (kind === 'release') {
    copyProduct(code, loadedRoot);
    fs.writeFileSync(path.join(loadedRoot, '.release-commit'), oldCode + '\n');
    execFileSync(process.execPath, [path.join(code, 'herdr/releases.mjs'), 'manifest', loadedRoot], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const changing = change === 'code' ? code : repo;
  git(changing, ['checkout', '-qb', 'next']);
  if (change === 'code') fs.writeFileSync(runtime, original + '\n// fresh consumer implementation\n');
  else fs.writeFileSync(path.join(repo, 'seed'), 'new main');
  git(changing, ['commit', '-am', 'New landing']); git(changing, ['checkout', '-q', 'main']);
  const script = `
    const code = await import(${JSON.stringify(pathToFileURL(path.join(loadedRoot, 'lib/closeout-code.mjs')).href)});
    const project = { canonical: ${JSON.stringify(repo)} };
    const loaded = code.captureCloseoutLaunch(project);
    await import(${JSON.stringify(pathToFileURL(path.join(loadedRoot, 'lib/closeout-consumer.mjs')).href)});
    try { console.log(JSON.stringify({ binding: code.bindCloseoutCode(project, loaded).binding })); }
    catch (error) { console.log(JSON.stringify({ code: error.code, old: error.binding, current: error.current })); }
  `;
  const start = () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    return new Promise((resolve, reject) => { child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr })); });
  };
  const running = start(); let result;
  try {
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(marker)) { assert.ok(Date.now() < deadline, 'old consumer graph reached its loading barrier'); await pause(10); }
    if (change === 'main branch') git(changing, ['checkout', '-q', 'next']);
    else git(changing, ['merge', '--ff-only', 'next']);
  } finally { fs.writeFileSync(release, 'continue'); result = await running; }
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  const currentCode = git(code, ['rev-parse', 'HEAD']), currentEpoch = git(repo, ['rev-parse', 'HEAD']);
  if (change === 'main epoch' && kind === 'checkout') {
    // Only checkout bindings allow main-tip movement with the same consumer
    // graph and branch. Release bindings retain the full epoch comparison.
    assert.equal(observed.code, undefined);
    assert.equal(observed.binding.code.commit, oldCode);
    assert.equal(observed.binding.epoch.tip, oldEpoch, 'the launch capture is retained across a main fast-forward');
    assert.notEqual(currentEpoch, oldEpoch);
  } else {
    assert.equal(observed.code, 'CLOSEOUT_CODE_CHANGED');
    assert.equal(observed.old.code.commit, oldCode); assert.equal(observed.old.epoch.tip, oldEpoch);
    assert.equal(observed.current.code.commit, currentCode);
    assert.equal(observed.current.epoch.tip, currentEpoch);
    if (change === 'main branch') {
      assert.equal(observed.old.epoch.branch, 'main'); assert.equal(observed.current.epoch.branch, 'next');
    } else if (kind === 'release') {
      assert.equal(observed.old.code.kind, 'release');
      assert.deepEqual(observed.old.code, observed.current.code, 'the release bytes and manifest have not changed');
      assert.equal(observed.old.epoch.branch, observed.current.epoch.branch);
      assert.notEqual(observed.old.epoch.tip, observed.current.epoch.tip, 'only the main tip changed');
    } else assert.notEqual(observed.old.code.files, observed.current.code.files, 'consumer graph changes still invalidate the launch');
  }
  const fresh = await start(); assert.equal(fresh.status, 0, fresh.stderr);
  const freshBinding = JSON.parse(fresh.stdout).binding;
  assert.equal(freshBinding.code.kind, kind);
  assert.equal(freshBinding.code.commit, currentCode); assert.equal(freshBinding.epoch.tip, currentEpoch);
  if (change === 'main epoch' && kind === 'checkout') {
    assert.deepEqual(freshBinding.code, observed.binding.code, 'unchanged consumer bytes retain their identity');
    assert.equal(freshBinding.epoch.branch, observed.binding.epoch.branch);
  } else assert.deepEqual(freshBinding, observed.current, 'a fresh process binds the current code and main epoch');
});
