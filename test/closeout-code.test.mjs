// Module-loading witnesses use Git/files only, with finite joined children.
import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';

for (const change of ['code', 'main epoch']) test(`launch binding survives a fast-forward during consumer graph loading (${change})`, async t => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'closer-loading-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const code = path.join(scratch, 'code'), repo = path.join(scratch, 'project');
  const marker = path.join(scratch, 'loading'), release = path.join(scratch, 'continue');
  const env = { ...process.env, HERDR_MONITOR_FLEET: path.join(scratch, 'fleet') };
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
  const changing = change === 'code' ? code : repo;
  git(changing, ['checkout', '-qb', 'next']);
  if (change === 'code') fs.writeFileSync(runtime, original + '\n// fresh consumer implementation\n');
  else fs.writeFileSync(path.join(repo, 'seed'), 'new main');
  git(changing, ['commit', '-am', 'New landing']); git(changing, ['checkout', '-q', 'main']);
  const script = `
    const code = await import(${JSON.stringify(pathToFileURL(path.join(code, 'lib/closeout-code.mjs')).href)});
    const project = { canonical: ${JSON.stringify(repo)} };
    const loaded = code.captureCloseoutLaunch(project);
    await import(${JSON.stringify(pathToFileURL(path.join(code, 'lib/closeout-consumer.mjs')).href)});
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
    git(changing, ['merge', '--ff-only', 'next']);
  } finally { fs.writeFileSync(release, 'continue'); result = await running; }
  assert.equal(result.status, 0, result.stderr);
  const stale = JSON.parse(result.stdout);
  assert.equal(stale.code, 'CLOSEOUT_CODE_CHANGED');
  assert.equal(stale.old.code.commit, oldCode); assert.equal(stale.old.epoch.tip, oldEpoch);
  assert.equal(stale.current.code.commit, git(code, ['rev-parse', 'HEAD']));
  assert.equal(stale.current.epoch.tip, git(repo, ['rev-parse', 'HEAD']));
  const fresh = await start(); assert.equal(fresh.status, 0, fresh.stderr);
  assert.deepEqual(JSON.parse(fresh.stdout).binding, stale.current, 'a fresh process binds the newly loaded bytes and main epoch');
});
