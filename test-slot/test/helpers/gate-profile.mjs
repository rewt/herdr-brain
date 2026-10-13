import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runProjectGateSync } from '../../../promote/gate-profile.mjs';
import { spawnChild } from '../../../test/helpers/child.mjs';
import { fixtureFleet } from '../../../test/helpers/offline-herdr.mjs';
import { testSlotEnvironment } from '../../../test/helpers/test-slot-env.mjs';
import { loadTimeout } from '../../../lib/deadline.mjs';
import { commandAllowance } from '../../../test/helpers/command-allowance.mjs';
import { stopFixtureInbox } from '../../../test/helpers/inbox.mjs';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const host = path.join(source, 'promote/host-gate.mjs');
async function until(fn) {
  const deadline = Date.now() + loadTimeout(10000);
  while (Date.now() < deadline) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('fixture did not become ready');
}

export function fixture(t, { externalLock = false, ...changes } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-profile-'))), repo = path.join(root, 'repo');
  fixtureFleet(t, root);
  fs.mkdirSync(repo);
  // These lifecycle cases inspect synchronous delivery; opt into a bounded wait.
  const env = { ...testSlotEnvironment(), HOME: path.join(root, 'home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', SUPERVISOR_INPUT_WAIT_SECONDS: '10' };
  env.HERDR_FIXTURE_GATE_LIFETIME = '1';
  for (const key of Object.keys(env)) if (/^(LANE_|ORG_|GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE)|MONITOR_PROMOTION_|.*TEST_SLOT_TOKEN)/.test(key)) delete env[key];
  const slot = path.join(root, 'slot'); env.MONITOR_TEST_SLOT_PATH = env.MONITOR_TEST_SLOT_COMPAT_PATH = slot;
  env.PROFILE_EVIDENCE = path.join(root, 'evidence');
  const bin = path.join(env.HOME, '.nvm/versions/node', `v${process.versions.node}`, 'bin');
  fs.mkdirSync(bin, { recursive: true }); fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const git = (args, cwd = repo) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', timeout: loadTimeout(15000) }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Profile']); git(['config', 'user.email', 'profile@example.invalid']);
  fs.writeFileSync(path.join(repo, '.nvmrc'), process.versions.node);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n');
  fs.writeFileSync(path.join(repo, 'prep.cjs'), `const fs=require('fs'),assert=require('assert/strict');assert(process.env.BCH_CLOAK_TEST_SLOT_TOKEN);assert.equal(JSON.parse(fs.readFileSync(${JSON.stringify(slot)})).token,process.env.BCH_CLOAK_TEST_SLOT_TOKEN);const lock=JSON.parse(fs.readFileSync('.promote.json')).gate.external_lock;if(lock){const r=require('child_process').spawnSync('/bin/zsh',['-f','-c','zmodload zsh/system; zsystem flock -t 0 -f fd "$1"','probe',lock],{env:process.env,timeout:${loadTimeout(5000)}});assert.notEqual(r.status,null,'legacy kernel lock probe completes within its bound');assert.notEqual(r.status,0,'legacy kernel lock stays held during preparation');}fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/prepared','prepared');`);
  fs.writeFileSync(path.join(repo, 'gate.cjs'), `const fs=require('fs'),assert=require('assert/strict'),net=require('net');assert.equal(fs.readFileSync('dist/prepared','utf8'),'prepared');assert.equal(process.env.PROFILE_VALUE,'declared');assert.equal(process.env.BCH_CLOAK_TEST_SLOT_WAIT_SECONDS,'7200');assert.equal(JSON.parse(fs.readFileSync(${JSON.stringify(slot)})).token,process.env.BCH_CLOAK_TEST_SLOT_TOKEN);const fd=fs.openSync('/dev/ptmx','r+');fs.closeSync(fd);const s=net.createServer();s.listen(0,'127.0.0.1',()=>s.close(()=>fs.appendFileSync(process.env.PROFILE_EVIDENCE,JSON.stringify({node:process.execPath,version:process.version,token:process.env.BCH_CLOAK_TEST_SLOT_TOKEN})+'\\n')));`);
  const gate = { node_version_file: '.nvmrc', env: { PROFILE_VALUE: 'declared', BCH_CLOAK_TEST_SLOT_WAIT_SECONDS: '7200' },
    prepare: [{ run: 'node prep.cjs' }], wait_seconds: 1,
    ...(externalLock ? { external_lock: path.join(root, 'promote.flock') } : {}), ...changes };
  const declare = () => { fs.writeFileSync(path.join(repo, '.promote.json'), JSON.stringify({ gate })); git(['add', '.']); git(['commit', '-qm', 'Profile']); };
  fs.writeFileSync(path.join(repo, '.lane.validation.json'), JSON.stringify({ promotion: 'node gate.cjs' })); declare();
  const lane = path.join(root, 'lane'); git(['worktree', 'add', '-qb', 'lane/profile', lane]);
  fs.writeFileSync(path.join(lane, 'change'), 'change'); git(['add', '.'], lane); git(['commit', '-qm', 'Lane'], lane);
  const head = git(['rev-parse', 'HEAD'], lane), before = git(['rev-parse', 'main']);
  const directory = path.join(repo, '.git/promote/batches/profile'); fs.mkdirSync(directory, { recursive: true });
  const receipt = path.join(directory, 'train.json');
  fs.writeFileSync(receipt, JSON.stringify({ schema: 'promotion-train/v1', id: 'profile', identity: path.join(repo, '.git'), jobs: [{ id: 'job', topic: 'profile', expectedHead: head }] }));
  const argv = [path.join(source, 'lanes/lane.mjs'), 'promote-batch', receipt];
  const run = ({ compound = false } = {}) => {
    // Five sequential bisection gates plus preparation/Git work need their own
    // finite response window below the enclosing 60-second test allowance.
    const timeout = loadTimeout(compound ? 55000 : 15000);
    return runProjectGateSync({ canonical: repo, receipt, argv, cwd: repo, env, encoding: 'utf8', timeout,
      ...(compound ? { [commandAllowance]: timeout } : {}) });
  };
  const asyncRun = () => spawnChild(t, process.execPath, [host, repo, receipt, ...argv], { cwd: repo, env });
  const saved = () => JSON.parse(fs.readFileSync(path.join(directory, 'host-gate.json')));
  const slotSaved = () => JSON.parse(fs.readFileSync(path.join(directory, 'test-slot-wait.json')));
  t.after(async () => {
    await until(() => !fs.existsSync(path.join(repo, '.git/promote/worker.lock')));
    await stopFixtureInbox(path.join(repo, '.git/supervisor/inbox.log'), {
      script: path.join(source, 'supervisor/prompt-supervisor.mjs'),
    });
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, env, bin, gate, slot, directory, receipt, head, before, git, run, asyncRun, saved, slotSaved, declare };
}
