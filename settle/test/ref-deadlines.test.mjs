import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnScenarioChild, waitForExit } from '../../test/helpers/child.mjs';

process.env.ORG_ACTOR = 'ref-deadlines-test';
const replacement = fileURLToPath(new URL('../replace-lane-head.mjs', import.meta.url));

function fixture(t, stage, mode) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loaded-ref-transaction-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'main'), workspace = path.join(root, 'lane'), bin = path.join(root, 'bin');
  fs.mkdirSync(repo); fs.mkdirSync(bin);
  const env = { ...process.env, ORG_ACTOR: 'loaded-ref-transaction-fixture',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_CONFIG_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(key)) delete env[key];
  const git = (args, cwd = repo, input) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { env, input, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.error?.message); return r.stdout.trim();
  };
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Ref deadline tests']); git(['config', 'user.email', 'refs@example.invalid']);
  fs.writeFileSync(path.join(repo, 'work.txt'), 'from\n'); git(['add', '.']); git(['commit', '-qm', 'Original main']);
  const from = git(['rev-parse', 'HEAD']);
  git(['worktree', 'add', '-qb', 'lane/topic', workspace]);
  fs.writeFileSync(path.join(workspace, 'work.txt'), 'to\n'); git(['add', '.'], workspace); git(['commit', '-qm', 'Proved target'], workspace);
  const to = git(['rev-parse', 'HEAD'], workspace);
  git(['reset', '--hard', from], workspace);
  const plan = { repo, workspace, common: fs.realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir'])),
    branch: 'refs/heads/lane/topic', from, to, main: 'main', mainHead: from };
  const headLock = `${git(['rev-parse', '--path-format=absolute', '--git-path', 'HEAD'], workspace)}.lock`;
  const indexLock = `${git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], workspace)}.lock`;
  const realGit = spawnSync('which', ['git'], { env, encoding: 'utf8' }).stdout.trim();
  const preload = path.join(root, 'load.cjs'), proxy = path.join(root, 'transaction.mjs');
  const timers = path.join(root, 'timers.jsonl'), requests = path.join(root, 'requests.jsonl');
  fs.writeFileSync(preload, `const os=require('node:os');os.loadavg=()=>[24,24,24];os.availableParallelism=()=>4;
if(process.argv[1]===${JSON.stringify(replacement)}){
 const timer=setTimeout;global.setTimeout=(fn,ms,...args)=>{
  if(ms>=15000){require('fs').appendFileSync(${JSON.stringify(timers)},JSON.stringify(ms)+'\\n');
   if(${mode === 'exhausted'})ms/=100;
  }return timer(fn,ms,...args);
 };
}`);
  fs.writeFileSync(proxy, `import fs from 'node:fs';import {spawn,spawnSync} from 'node:child_process';import {createInterface} from 'node:readline';import {once} from 'node:events';
const native=spawn(${JSON.stringify(realGit)},process.argv.slice(2),{stdio:['pipe','pipe','pipe']});
const closed=once(native,'close');closed.catch(()=>{});native.stderr.pipe(process.stderr);
let stopped=false,timer,resume;
const input=createInterface({input:process.stdin});
for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>{
 stopped=true;clearTimeout(timer);resume?.();native.stdin.destroy();native.kill(signal);input.close();process.stdin.destroy();
});
input.on('line',line=>{
 fs.appendFileSync(${JSON.stringify(requests)},JSON.stringify(line)+'\\n');
 const command=line.split(' ')[0];
 if(command===${JSON.stringify(stage)}&&${mode === 'exhausted'})return;
 if(command===${JSON.stringify(stage)}&&${mode === 'refused'}){
  process.stderr.write('injected '+command+' refusal\\n');process.stdout.write(command+': refused\\n');return;
 }
 if(command==='prepare'&&${mode === 'cas-refusal'}){
  const r=spawnSync(${JSON.stringify(realGit)},['-C',${JSON.stringify(repo)},'update-ref',${JSON.stringify(plan.branch)},process.env.REF_CONCURRENT_HEAD,${JSON.stringify(from)}],{encoding:'utf8'});
  if(r.status)throw Error(r.stderr);
 }
 native.stdin.write(line+'\\n');
});
input.on('close',()=>{if(!native.stdin.destroyed)native.stdin.end();});
for await(const line of createInterface({input:native.stdout})){
 if(line===${JSON.stringify(stage + ': ok')}&&${mode === 'delayed'})await new Promise(resolve=>{resume=resolve;timer=setTimeout(resolve,15200);});
 if(!stopped)process.stdout.write(line+'\\n');
}
const [code]=await closed;input.close();process.stdin.destroy();process.exitCode=code??1;
`);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
if [ "$1" = update-ref ]; then exec '${process.execPath}' '${proxy}' "$@"; fi
exec '${realGit}' "$@"
`, { mode: 0o755 });
  const run = async () => {
    const child = spawnScenarioChild(t, process.execPath, [replacement, JSON.stringify(plan)], {
      cwd: repo, env: { ...env, PATH: `${bin}:${env.PATH}`, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --require=${preload}` },
    }, 35000);
    return waitForExit(child);
  };
  return { root, repo, workspace, plan, git, env, headLock, indexLock, timers, requests, run };
}

for (const stage of ['start', 'prepare', 'commit']) {
  test(`load 24 admits a ${stage} reply beyond the former fifteen-second ref-transaction deadline`, async t => {
    const f = fixture(t, stage, 'delayed'), started = Date.now();
    const r = await f.run();
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.ok(Date.now() - started >= 15200, 'the actual transaction reply crossed the old limit');
    assert.equal(f.git(['rev-parse', f.plan.branch]), f.plan.to);
    assert.equal(f.git(['rev-parse', 'main']), f.plan.mainHead);
    assert.equal(f.git(['symbolic-ref', 'HEAD'], f.workspace), f.plan.branch);
    assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
    assert.equal(fs.readFileSync(path.join(f.workspace, 'work.txt'), 'utf8'), 'to\n');
    assert.equal(fs.existsSync(f.headLock), false); assert.equal(fs.existsSync(f.indexLock), false);
    assert.deepEqual(fs.readFileSync(f.timers, 'utf8').trim().split('\n').map(JSON.parse), [90000, 90000, 90000]);
    const commands = fs.readFileSync(f.requests, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(commands.filter(command => command === stage).length, 1, 'a delayed mutation is never replayed');
  });
  for (const mode of ['exhausted', 'refused']) test(`${mode} ${stage} replies preserve the ref and appropriate checkout locks`, async t => {
    const f = fixture(t, stage, mode), r = await f.run();
    assert.equal(r.code, 1, r.stderr + r.stdout);
    assert.match(r.stderr, mode === 'exhausted' ? /Git ref transaction timed out/ : new RegExp(`injected ${stage} refusal`));
    assert.equal(f.git(['rev-parse', f.plan.branch]), f.plan.from);
    assert.equal(f.git(['rev-parse', 'main']), f.plan.mainHead);
    const uncertain = stage === 'commit';
    assert.equal(fs.existsSync(f.headLock), uncertain); assert.equal(fs.existsSync(f.indexLock), uncertain);
    assert.equal(fs.readFileSync(path.join(f.workspace, 'work.txt'), 'utf8'), uncertain ? 'to\n' : 'from\n');
    if (uncertain) assert.match(r.stderr, /checkout outcome uncertain/);
  });
}

test('loaded transaction prepare retains a concurrent ref instead of overwriting its compare-and-swap refusal', async t => {
  const f = fixture(t, 'prepare', 'cas-refusal');
  const tree = f.git(['rev-parse', `${f.plan.from}^{tree}`]);
  const other = f.git(['commit-tree', tree, '-p', f.plan.from], f.repo, 'Concurrent work\n');
  f.env.REF_CONCURRENT_HEAD = other;
  const r = await f.run();
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /cannot lock ref.*expected/);
  assert.equal(f.git(['rev-parse', f.plan.branch]), other);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'work.txt'), 'utf8'), 'from\n');
  assert.equal(fs.existsSync(f.headLock), false); assert.equal(fs.existsSync(f.indexLock), false);
});

test('loaded transaction refusal never removes a pre-existing HEAD or index lock', async t => {
  for (const kind of ['headLock', 'indexLock']) {
    const f = fixture(t, 'start', 'delayed');
    fs.writeFileSync(f[kind], 'foreign owner\n');
    const r = await f.run();
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /EEXIST/);
    assert.equal(fs.readFileSync(f[kind], 'utf8'), 'foreign owner\n');
    assert.equal(f.git(['rev-parse', f.plan.branch]), f.plan.from);
    assert.equal(fs.existsSync(f[kind === 'headLock' ? 'indexLock' : 'headLock']), false);
  }
});
