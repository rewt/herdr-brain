import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { discovery } from '../live.mjs';
import { cases } from '../cases.mjs';
import { sessionEnv } from '../security.mjs';
import { runTemporary } from '../../discovery/temporary.mjs';

const source = path.resolve(import.meta.dirname, '../..');

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
  return { root, evidence, spec };
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
  const result = spawnSync(process.execPath, [path.join(source, 'acceptance/live-worker.mjs'), root, spec.name], { encoding: 'utf8' });
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
