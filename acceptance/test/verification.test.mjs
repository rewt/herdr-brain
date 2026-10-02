import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { permissionArgs, sessionEnv } from '../security.mjs';
import { createVerification, safeGitArgs } from '../verify.mjs';

const discovered = spawnSync('which', ['codex'], { encoding: 'utf8' }).stdout?.trim();
const skip = process.platform !== 'darwin' || !discovered;
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-native-')));
  const repo = path.join(root, 'project'), temp = path.join(root, 'session');
  for (const directory of [repo, temp, path.join(root, 'installed'), path.join(root, 'runtime')]) fs.mkdirSync(directory);
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { cwd: options.cwd ?? repo, env: options.isolatedEnv ?? { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8', timeout: 20000, input: options.input });
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
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); for (const directory of discoveryRoots) fs.rmSync(directory, { recursive: true, force: true }); });
  return { root, repo, temp, spec, run, discoveryRoots };
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
  const { root, repo, spec, run, discoveryRoots } = fixture(t);
  const verifier = createVerification(spec, { root, discoveryRoots, run });
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
    assert.ok(!Object.keys(process.env).some(k=>/^(HERDR|ACCEPTANCE)/.test(k)));
    await new Promise((resolve,reject)=>{const s=net.createConnection(${JSON.stringify(socket)});s.once('connect',()=>{s.destroy();reject(Error('socket allowed'))});s.once('error',e=>['EPERM','EACCES'].includes(e.code)?resolve():reject(e))});});`);
  const checked = verifier.execute(process.execPath, ['--test']); assert.match(checked.stdout, /# pass 1/);
  assert.ok(!fs.existsSync(outside));
});

test('record verification and scripted answer are kernel-confined even if model output redirects .org', { skip }, (t) => {
  const { root, repo, spec, run, discoveryRoots } = fixture(t);
  const archive = spawnSync('git', ['archive', 'HEAD', 'bin', 'lib', 'lanes'], { cwd: path.resolve('.'), encoding: undefined });
  assert.equal(archive.status, 0, String(archive.stderr));
  const unpack = spawnSync('tar', ['-x', '-C', spec.installation], { input: archive.stdout }); assert.equal(unpack.status, 0, String(unpack.stderr));
  run(process.execPath, [path.join(spec.installation, 'bin/org.mjs'), 'init', path.join(repo, '.org')]);
  const verifier = createVerification(spec, { root, discoveryRoots, run });
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
