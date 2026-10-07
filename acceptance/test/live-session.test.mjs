import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { spawnScenarioChild, waitForExit } from '../../test/helpers/child.mjs';
import { discovery } from '../live.mjs';
import { cases } from '../cases.mjs';
import { sessionEnv } from '../security.mjs';
import { runTemporary } from '../../discovery/temporary.mjs';
import { createLiveSessionTemp } from '../temp.mjs';

const source = path.resolve(import.meta.dirname, '../..');
const nativeCodex = spawnSync('which', ['codex'], { encoding: 'utf8' }).stdout?.trim();

// Execute discovery's real setup through installation, stopping at the first
// Herdr call. Only the boundary probe/native model executable are stand-ins.
async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/al-')), scratchRoots = [root], discoveryRoots = [];
  const socket = path.join(root, 'offline.sock'), server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  const previousSocket = process.env.HERDR_SOCKET_PATH; process.env.HERDR_SOCKET_PATH = socket;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH; else process.env.HERDR_SOCKET_PATH = previousSocket;
    for (const directory of scratchRoots.reverse()) fs.rmSync(directory, { recursive: true, force: true });
  });
  const evidence = path.join(root, 'evidence'), authHome = path.join(root, 'auth');
  for (const directory of [evidence, authHome, path.join(root, 'live-jobs')]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(authHome, 'auth.json'), '{}');
  fs.writeFileSync(path.join(root, 'ownership.json'), '{}');
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = authHome;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
  const binary = path.join(root, 'codex');
  fs.writeFileSync(binary, `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2);
if(args.includes('--help')) console.log('--sandbox --add-dir --permission-profile');
else {
  if(!args.includes('exec')) throw Error('offline native stand-in refuses inference');
  console.log(JSON.stringify({args,cwd:process.cwd(),env:process.env}));
}
`, { mode: 0o755 });
  const gitBinary = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const run = (file, args, options = {}) => {
    if (file === 'which') return { status: 0, stdout: args[0] === 'codex' ? binary : gitBinary, stderr: '' };
    if (file === binary) { assert.equal(args[0], 'sandbox'); return { status: 0, stdout: '', stderr: '' }; }
    const result = spawnSync(file, args, { cwd: options.cwd ?? root, env: options.isolatedEnv ?? process.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result;
  };
  const git = (repo, args) => run(gitBinary, ['-C', repo, ...args]).stdout.trim();
  const initRepo = repo => {
    fs.mkdirSync(repo, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid']]) git(repo, args);
  };
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const stopped = new Error('offline stop before Herdr');
  await assert.rejects(discovery({ root, scratchRoots, discoveryRoots, evidence, candidate: source, opt: {},
    test: async (check, body) => { if (check === cases.discovery) await body(); },
    pending: message => assert.fail(message), initRepo, run, git, write,
    read: file => fs.readFileSync(file, 'utf8'), h: () => { throw stopped; },
  }), error => error === stopped);
  const spec = JSON.parse(fs.readFileSync(path.join(root, 'live-jobs/discovery-french.json'), 'utf8'));
  return { root, evidence, spec, scratchRoots, discoveryRoots };
}

test('real live discovery setup confines a short fleet temp with no project configuration', async t => {
  const { spec } = await fixture(t);
  const entered = spawnSync(spec.entryBinary, ['--role', 'supervisor', '--policy-only'], { cwd: spec.repo, env: sessionEnv(process.env, spec), encoding: 'utf8' });
  assert.equal(entered.status, 0, entered.stderr);
  const lookup = spawnSync(process.execPath, ['--input-type=module', '-e', `import {fleetPath} from ${JSON.stringify(path.join(spec.installation, 'lib/fleet.mjs'))};console.log(fleetPath());`], { env: sessionEnv(process.env, spec), encoding: 'utf8' });
  assert.equal(lookup.status, 0, lookup.stderr);
  const fleet = JSON.parse(fs.readFileSync(lookup.stdout.trim(), 'utf8'));
  const project = fleet.projects.project;
  assert.equal(project.checkout, spec.repo);
  const temporary = runTemporary(project.temp);
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  assert.ok(Buffer.byteLength(temporary) <= 60, temporary);
  assert.equal(path.dirname(project.temp), path.join(spec.temp, 'f/t'));
  assert.match(path.basename(project.temp), /^[a-f0-9]{16}$/u);
  assert.equal(fs.statSync(temporary).mode & 0o777, 0o700);
  for (const file of ['.lane.json', 'AGENTS.md', '.codex/config.toml']) assert.ok(!fs.existsSync(path.join(spec.repo, file)), file);
  assert.equal(sessionEnv(process.env, spec).HERDR_MONITOR_FLEET, path.join(spec.temp, 'f'));
  assert.ok(!('HERDR_SOCKET_PATH' in sessionEnv(process.env, spec)));
});

test('real live-worker arguments reach the installed adapter with its supported private temp grant', async t => {
  const { root, evidence, spec } = await fixture(t);
  // The real gate launches live-worker without the test runner's preload,
  // which would re-add offline Herdr capabilities after sessionEnv scrubs them.
  // env execs in the same bounded suite group; the fake native still refuses
  // inference and the product transport retains every capability leak guard.
  const result = spawnSync('/usr/bin/env', ['-u', 'NODE_OPTIONS', process.execPath,
    path.join(source, 'acceptance/live-worker.mjs'), root, spec.name], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const done = JSON.parse(fs.readFileSync(path.join(root, 'live-jobs', `${spec.name}.done`), 'utf8'));
  assert.equal(done.code, 0, fs.readFileSync(path.join(evidence, `${spec.name}.stderr`), 'utf8'));
  const receipt = JSON.parse(fs.readFileSync(path.join(evidence, `${spec.name}.jsonl`), 'utf8'));
  assert.ok(!receipt.args.includes('--add-dir'));
  assert.ok(receipt.args.includes('exec'));
  assert.notEqual(receipt.cwd, spec.repo);
  assert.ok(receipt.cwd.startsWith(spec.worktreeRoot + path.sep));
  const temporary = receipt.env.TMPDIR;
  const fleet = JSON.parse(fs.readFileSync(path.join(spec.temp, 'f/fleet.json'), 'utf8'));
  assert.equal(path.dirname(temporary), fleet.projects.project.temp);
  assert.match(path.basename(temporary), /^r-[A-Za-z0-9]{6}$/u);
  assert.ok(Buffer.byteLength(temporary) <= 60, temporary);
  assert.equal(receipt.env.TMP, temporary); assert.equal(receipt.env.TEMP, temporary);
  assert.ok(!fs.existsSync(temporary), 'installed adapter removes its run temp on exit');
  const gate = receipt.args.findLast(arg => arg.startsWith('permissions.acceptance.filesystem='));
  assert.ok(gate?.includes('":tmpdir"="write"'));
  assert.ok(gate?.includes('":slash_tmp"="deny"'));
  assert.ok(gate?.includes(`${JSON.stringify(spec.gitCommon)}="read"`));
  assert.ok(receipt.args.includes('permissions.acceptance.network.enabled=false'));
  const entry = JSON.parse(fs.readFileSync(path.join(evidence, `${spec.name}.entry.json`), 'utf8'));
  assert.equal(entry.source, path.join(spec.installation, 'discovery/policy.mjs'));
  assert.ok(entry.policy.includes('Herdr Monitor installed project-entry policy'));
});

test('installed live discovery records concurrent workers and promotes answered routes through native sandbox requests offline',
  { skip: process.platform !== 'darwin' || !nativeCodex, timeout: 90000 }, async t => {
    const { root, evidence, spec: seed, scratchRoots, discoveryRoots } = await fixture(t);
    const native = fs.realpathSync(nativeCodex);
    // This executable accepts only capability queries, native sandbox commands
    // and a fixed offline driver in place of exec. It never invokes inference.
    fs.writeFileSync(seed.binary, `#!${process.execPath}
const path=require('path'),{spawnSync}=require('child_process'),args=process.argv.slice(2);
let result;
if(args.includes('--help')) {console.log('--sandbox --add-dir --permission-profile');process.exit(0);}
if(args.includes('--version')) {console.log('codex offline');process.exit(0);}
if(args[0]==='sandbox') result=spawnSync(${JSON.stringify(native)},args,{stdio:args.includes('--enter')?['inherit','inherit','inherit',3]:'inherit'});
else {
  if(!args.includes('exec')) throw Error('offline stand-in refuses inference');
  const configs=[];
  for(let i=0;i<args.length;i++) if(args[i]==='-c' && /^(default_permissions|permissions\\.acceptance\\.)/.test(args[i+1])) configs.push(args[i],args[i+1]);
  const task=path.basename(args[args.indexOf('-o')+1],'.txt');
  result=spawnSync(${JSON.stringify(native)},['sandbox','-C',process.cwd(),'-P','acceptance',...configs,'--',${JSON.stringify(process.execPath)},path.join(process.env.HOME,'offline-worker.cjs'),${JSON.stringify(seed.installation)},task],{stdio:'inherit'});
}
if(result.error) throw result.error;process.exit(result.status??1);
`, { mode: 0o755 });
    const jobs = [];
    function job(name) {
      const spec = { ...seed, name, temp: createLiveSessionTemp(scratchRoots, discoveryRoots), probeGit: undefined,
        runtimeHome: path.join(root, `runtime-${name}`), toolRoots: [path.resolve(path.dirname(process.execPath), '..'), path.resolve(path.dirname(native), '..'), '/opt/homebrew'] };
      fs.mkdirSync(spec.runtimeHome);
      spec.worktreeRoot = path.join(spec.temp, 'entry-worktrees');
      const transport = path.join(root, `transport-${name}`, 'codex'), bin = path.join(spec.installation, `bin-${name}`);
      fs.mkdirSync(path.dirname(transport));
      spec.path = `${path.dirname(transport)}:${spec.path}`;
      fs.writeFileSync(transport, `#!/bin/sh\nexec '${process.execPath}' '${path.join(root, 'transport/acceptance/native-transport.mjs')}' '${root}' '${name}' "$@"\n`, { mode: 0o755 });
      const installed = spawnSync(process.execPath, [path.join(spec.installation, 'discovery/install.mjs'), '--bin', bin, '--codex', transport],
        { cwd: spec.repo, env: sessionEnv({}, spec), encoding: 'utf8' });
      assert.equal(installed.status, 0, installed.stderr);
      spec.entryBinary = path.join(bin, 'monitor-codex');
      fs.copyFileSync(path.join(source, 'acceptance/test/helpers/discovery-worker.cjs'), path.join(spec.temp, 'offline-worker.cjs'));
      fs.writeFileSync(path.join(root, 'live-jobs', `${name}.json`), JSON.stringify(spec));
      const child = spawnScenarioChild(t, '/usr/bin/env', ['-u', 'NODE_OPTIONS', process.execPath,
        path.join(source, 'acceptance/live-worker.mjs'), root, name], { stdio: ['ignore', 'pipe', 'pipe'] });
      const finished = waitForExit(child);
      const finish = async () => {
        const result = await finished;
        assert.equal(result.code, 0, result.stderr);
        const done = JSON.parse(fs.readFileSync(path.join(root, 'live-jobs', `${name}.done`), 'utf8'));
        assert.equal(done.code, 0, fs.readFileSync(path.join(evidence, `${name}.stderr`), 'utf8'));
        return JSON.parse(fs.readFileSync(path.join(evidence, `${name}.jsonl`), 'utf8'));
      };
      const created = { spec, finish, finished };
      finished.then(result => { created.result = result; }, error => { created.error = error; });
      jobs.push(created); return created;
    }
    const ready = spec => {
      const tempRoot = path.join(spec.temp, 'f/t');
      if (!fs.existsSync(tempRoot)) return;
      for (const project of fs.readdirSync(tempRoot)) for (const run of fs.readdirSync(path.join(tempRoot, project))) {
        const directory = path.join(tempRoot, project, run);
        if (fs.existsSync(path.join(directory, 'ready'))) return directory;
      }
    };
    try {
      const a = job('french'), b = job('german');
      const deadline = Date.now() + 20000;
      while (!ready(a.spec) || !ready(b.spec)) {
        for (const j of jobs) if (j.error) throw j.error;
        for (const j of jobs) if (j.result) assert.fail(`offline worker exited before its barrier: ${j.result.stdout}${j.result.stderr}`);
        assert.ok(Date.now() < deadline, jobs.map(j => fs.existsSync(path.join(evidence, `${j.spec.name}.stderr`)) ? fs.readFileSync(path.join(evidence, `${j.spec.name}.stderr`), 'utf8') : '').join('\n'));
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const record = (args, actor = 'offline-reader') => {
        const result = spawnSync(process.execPath, [path.join(seed.installation, 'bin/org.mjs'), ...args],
          { cwd: seed.repo, env: { ...sessionEnv({}, a.spec), ORG_DIR: path.join(seed.repo, '.org'), ORG_ACTOR: actor }, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr); return result.stdout;
      };
      const concurrent = JSON.parse(record(['status', '--json']));
      assert.equal(concurrent.runs.length, 2, 'both installed sessions recorded runs before integration');
      // Both entered on the same base; the product serializes their promotion.
      for (const j of [a, b]) fs.writeFileSync(path.join(ready(j.spec), 'release'), 'go');
      const results = await Promise.allSettled([a.finish(), b.finish()]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      const [first, second] = results.map(result => result.value);
      assert.notEqual(first.context.workspace, second.context.workspace);
      const questionJob = job('routing'); const question = await questionJob.finish();
      const state = JSON.parse(record(['status', '--json']));
      assert.equal(state.items.filter(i => i.role === 'human' && !i.closed).length, 1);
      assert.ok(!fs.existsSync(path.join(seed.repo, '.lane.json')));
      record(['answer', question.context.routing.question, 'yes'], 'human');
      const applied = await job('routing-apply').finish();
      assert.equal(applied.context.org, first.context.org);
      const routes = JSON.parse(fs.readFileSync(path.join(seed.repo, '.lane.json'), 'utf8')).routes;
      assert.equal(routes.engineer.model, 'gpt-6.1-sol'); assert.equal(routes.review.model, 'opus');
      const final = JSON.parse(record(['status', '--json']));
      assert.equal(final.runs.length, 4);
      assert.deepEqual(final.runs.map(r => r.report.outcome), ['done', 'done', 'needs_human', 'done']);
      for (const language of ['french', 'german']) assert.ok(fs.existsSync(path.join(seed.repo, `${language}.mjs`)));
      const git = args => spawnSync('git', ['-C', seed.repo, ...args], { encoding: 'utf8' });
      assert.equal(git(['status', '--porcelain']).stdout, '');
      assert.equal(git(['rev-list', '--merges', 'main']).stdout, '');
    } finally {
      // Release a surviving partner before fixture teardown even when its peer
      // fails; every launched worker is awaited before scratch roots disappear.
      for (const j of jobs) {
        const directory = ready(j.spec);
        if (directory) fs.writeFileSync(path.join(directory, 'release'), 'go');
      }
      await Promise.allSettled(jobs.map(j => j.finished));
    }
  });
