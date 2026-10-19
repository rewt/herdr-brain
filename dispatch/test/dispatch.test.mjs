import test from '../../test/helpers/bounded-test.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { createReceiptTracker } from '../../test/helpers/receipts.mjs';
import { createProcessTracker } from '../../test/helpers/processes.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownerAlive } from '../../lib/process-owner.mjs';
import { lookupProcess } from '../../lib/processes.mjs';
import { hookReviewDialog, codexProfile } from '../hook-review.mjs';
import { runMetrics } from '../metrics.mjs';
import { effectiveWorkerIdentity } from '../../lib/worker-identity.mjs';
import { fold } from '../../lib/state.mjs';
import { publishProvingReservation } from '../../test-slot/reservations.mjs';
import { readTiming } from '../../lib/run-timing.mjs';
const DISPATCH = fileURLToPath(new URL('../dispatch.mjs', import.meta.url));
const RECORD = fileURLToPath(new URL('../../bin/org.mjs', import.meta.url));
const WATCH = fileURLToPath(new URL('../../watch/watch.mjs', import.meta.url));
const fake = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
const root = process.env.FAKE_ROOT;
const a = process.argv.slice(2), type = path.basename(process.argv[1]);
fs.appendFileSync(path.join(root,'calls'), JSON.stringify({type,a,pane:process.env.HERDR_PANE_ID??null})+'\\n');
const fail = fs.existsSync(path.join(root,'fail')) ? fs.readFileSync(path.join(root,'fail'),'utf8') : '';
const stateFile = path.join(root,'workers');
let workers = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : {};
function save() { fs.writeFileSync(stateFile,JSON.stringify(workers)); }
function result(r) { process.stdout.write(JSON.stringify(r)+'\\n'); }
function git(args) { const r=spawnSync('git',args,{encoding:'utf8'}); if(r.status) throw new Error(r.stderr); return r.stdout.trim(); }
const entry=()=>git(['worktree','list','--porcelain']).split('\\n\\n').find(x=>x.includes('branch refs/heads/lane/topic'))?.split('\\n')[0].slice(9);
if(type==='org') {
 if(fail==='after-prompt' && a[0]==='note' && a[2]?.startsWith('Dispatch: prompt sent')) {console.error('lost process after saved delivery');process.exit(1);}
 if(process.env.TEST_TIMING_FAILURE && a[0]==='set' && a[2]?.startsWith('dispatch_waits=')) { console.error('injected timing set failure');process.exit(1); }
 const r=spawnSync(process.execPath,[${JSON.stringify(RECORD)},...a],{stdio:'inherit'});
 if(fail==='bind-lost-reply' && a[0]==='session-bind') {console.error('lost bind reply');process.exit(1);}
 process.exit(r.status??1);
} else if(type==='lane') {
 if(fail===a[0]) { console.error('injected '+fail); process.exit(1); }
 if(a[0]==='open') git(['worktree','add','-b','lane/'+a[1],path.join(root,'lane'),a.slice(2).find(x=>!x.startsWith('--'))??'HEAD']);
 if(a[0]==='prepare' && !entry()) process.exit(1);
 if(a[0]==='prepare' && process.env.TEST_MEMORY_WORKER_PRESSURE) fs.writeFileSync(process.env.TEST_MEMORY_FILE,JSON.stringify({available:128*1024**2,swap_used:0}));
 if(a[0]==='dispatch') {
  const n='worker-'+(Object.keys(workers).length+1), cwd=entry();
  workers[n]={name:n,agent:'codex',pane_id:'w:p'+n,workspace_id:'w',cwd,terminal_id:'t-'+n,agent_session:process.env.TEST_LATE_SESSION?null:{value:'s-'+n},agent_status:'idle'};save();
  const snap=JSON.parse(fs.readFileSync(a[a.indexOf('--route-config')+1]));
  fs.writeFileSync(path.join(root,'launch-route'),JSON.stringify(snap.routes.engineer));
  if(fail==='uncertain-launch') process.exit(1);
  result({agentName:n,pane:workers[n].pane_id,workspaceId:'w',terminalId:'t-'+n,agentSessionId:workers[n].agent_session?.value??null,cwd});
 }
 if(a[0]==='verify-agent') { if(!workers[a[1]] || fs.realpathSync(workers[a[1]].cwd)!==fs.realpathSync(a[2])) process.exit(1); }
} else if(type==='watch') {
 if(fail==='watch') { console.error('injected watch');process.exit(1); }
 const child=spawn(process.execPath,['-e','setTimeout(()=>{},10000)','--',root],{stdio:'ignore'}); child.unref();
 fs.appendFileSync(path.join(root,'pids'),child.pid+'\\n');
 const { ownerIdentity } = await import(${JSON.stringify(new URL('../../lib/process-owner.mjs', import.meta.url).href)});
 result({run:a[0],pid:child.pid,identity:ownerIdentity(child.pid),log:path.join(root,a[0]+'.log')});
} else {
 if(a[0]==='pane' && a[1]==='process-info') {
  const prompted=Object.values(workers).some(w=>w.agent_status==='working');
  const replacement=(process.env.TEST_LATE_SESSION==='replacement'&&prompted)||
   (process.env.TEST_LATE_SESSION==='replacement-before-prompt'&&fs.existsSync(path.join(root,'pids')));
  const pid=replacement?Number(fs.readFileSync(path.join(root,'pids'),'utf8').trim().split('\\n')[0]):Number(process.env.TEST_NATIVE_PID);
  result({result:{process_info:{shell_pid:1,foreground_processes:[{name:'codex',pid}]}}});
 }
 if(a[0]==='pane' && a[1]==='read') {
  if(fail==='screen') {console.error('injected screen read failure');process.exit(1);}
  process.stdout.write(fs.existsSync(path.join(root,'screen'))?fs.readFileSync(path.join(root,'screen'),'utf8'):'› Ready for a task');
 }
 if(a[0]==='agent' && a[1]==='get') {
  if(workers[a[2]]?.agent_status==='working' && process.env.TEST_LATE_SESSION) {
   const w=workers[a[2]];w.reads=(w.reads??0)+1;
   if(w.reads>=3) w.agent_session={value:'s-'+a[2]};save();
  }
  const agent=['supervisor-herdr','ops-project','ops-explicit'].includes(a[2])?{name:a[2]}:workers[a[2]];
  if(!agent) {console.error(JSON.stringify({error:{code:'agent_not_found'}}));process.exit(1);}
  result({result:{agent}});
 }
 if(a[0]==='agent' && a[1]==='prompt') {
  if(fail==='prompt-blocked') {console.error(JSON.stringify({error:{code:'agent_blocked',message:'one-time trust prompt'}}));process.exit(1);}
  if(fail==='prompt') {console.error('injected prompt');process.exit(1);}
  workers[a[2]].agent_status='working';save();
  if(fail==='prompt-lost-reply') {console.error('lost prompt reply');process.exit(1);}
  result({result:{}});
 }
 if(a[0]==='agent' && a[1]==='wait') {
  await new Promise(r=>setTimeout(r,1000));result({result:{}});
 }
}
`;
function rememberProcesses(root, org, realWatch, receipts) {
  const fakeCommand = [process.execPath, '-e', 'setTimeout(()=>{},10000)', '--', root].join(' ');
  for (const pid of fs.existsSync(path.join(root, 'pids')) ? fs.readFileSync(path.join(root, 'pids'), 'utf8').trim().split('\n').filter(Boolean).map(Number) : []) {
    receipts.remember(pid, fakeCommand);
  }
  for (const file of fs.existsSync(path.join(org, 'dispatch')) ? fs.readdirSync(path.join(org, 'dispatch')).filter(x => x.endsWith('.json') && !x.endsWith('.routes.json')) : []) {
    const job = JSON.parse(fs.readFileSync(path.join(org, 'dispatch', file)));
    if (job.watcher?.pid) receipts.remember(job.watcher.pid, realWatch ? [process.execPath, WATCH, job.run,
      '--org', org, '--to', job.to, '--cwd', job.repo, '--log', path.join(org, 'dispatch', `${job.run}.watch.log`)].join(' ') : fakeCommand);
  }
}
test('awaited dispatch records the notification and plan step before launching and preserves retry flags', t => {
  const f = fixture(t); f.fail('dispatch');
  assert.equal(f.start(['--awaited', '--awaited-step', 'Cut RC-11']).status, 1);
  assert.equal(f.show(f.item).meta.notify, 'supervisor');
  assert.equal(f.show(f.item).meta.notify_step, 'Cut RC-11');
  const job = JSON.parse(fs.readFileSync(f.jobs()[0]));
  assert.equal(f.dispatch(['--retry', job.run, '--awaited']).status, 1);
  f.rec(['set', f.item, 'meta.notify=none']);
  f.fail(''); const retry = f.dispatch(['--retry', job.run, '--fresh']);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(f.show(f.item).meta.notify, 'none', 'retry must not re-arm an operator-cleared notification');
});
for (const source of ['fake watcher receipt', 'real watcher journal']) {
  test(`${source} refuses PID reuse before registration and retains ownership across retries`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-receipt-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const org = path.join(root, 'org'), dir = path.join(org, 'dispatch');
    fs.mkdirSync(dir, { recursive: true });
    const real = source === 'real watcher journal';
    if (real) fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ run: 'R-1', to: 'supervisor', repo: root, watcher: { pid: 101 } }));
    else fs.writeFileSync(path.join(root, 'pids'), '101\n');
    const command = real ? [process.execPath, WATCH, 'R-1', '--org', org, '--to', 'supervisor', '--cwd', root,
      '--log', path.join(dir, 'R-1.watch.log')].join(' ') : [process.execPath, '-e', 'setTimeout(()=>{},10000)', '--', root].join(' ');
    const suite = { pid: 700, ppid: 1, pgid: 700, state: 'S', identity: 'suite birth', command: 'suite worker' };
    const signals = [], rows = new Map([[700, suite]]);
    const receipts = createReceiptTracker({ suitePid: 700, tracker: createProcessTracker({
      readIdentity: pid => ({ ok: true, value: rows.get(pid) ?? null }),
      sendSignal: pid => signals.push(pid), report: () => {},
    }) });
    // Same command outside the suite, and an unrelated command inside it, both
    // represent replacement processes before the first receipt registration.
    for (const replacement of [{ command, pgid: 900 }, { command: 'operator session', pgid: 700 }]) {
      rows.set(101, { ...suite, pid: 101, identity: 'replacement birth', ...replacement });
      rememberProcesses(root, org, real, receipts); receipts.cleanup();
      assert.deepEqual(signals, []);
    }
    rows.set(101, { ...suite, pid: 101, command, identity: 'fixture birth' });
    rememberProcesses(root, org, real, receipts);
    const original = receipts.remember(101, command);
    rows.set(101, { ...suite, pid: 101, command, identity: 'reused birth' });
    rememberProcesses(root, org, real, receipts); receipts.cleanup();
    assert.equal(receipts.remember(101, command), original);
    assert.deepEqual(signals, [], 'retry must not refresh an owned birth tuple');
    rows.set(101, { ...suite, pid: 101, command, identity: 'fixture birth' });
    receipts.cleanup(); assert.deepEqual(signals, [101]);
  });
}
function fixture(t, { realWatch = false, preload, noticeRecipient = '', timingFailure = false, timingRecord = timingFailure, lateSession = '' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-test-')));
  const repo = path.join(root, 'repo'), org = path.join(root, 'org'), bin = path.join(root, 'bin');
  fs.mkdirSync(repo);fs.mkdirSync(bin);
  const env = { ...process.env, ORG_ACTOR: 'dispatch-test-agent', ORG_DIR: org, FAKE_ROOT:root, LANE_CONFIG:path.join(repo,'.lane.json'),
    MONITOR_SUPERVISOR_AGENT: noticeRecipient, HERDR_AGENT_NAME: 'chat-operator',
    TEST_LATE_SESSION: lateSession, TEST_NATIVE_PID: String(process.pid),
    HERDR_MONITOR_FLEET: path.join(root, 'fleet.json'), TEST_TIMING_FAILURE: timingFailure ? '1' : '',
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1',
    HERDR_PANE_ID:'supervisor:pane', HERDR_TAB_ID:'supervisor:tab', HERDR_WORKSPACE_ID:'supervisor:w' };
  if (preload) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --require=${preload}`;
  for(const key of Object.keys(env)) if(key.startsWith('GIT_CONFIG_') && !['GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM'].includes(key)) delete env[key];
  const receipts = createReceiptTracker();
  // Install cleanup before setup or any assertion can fail.
  t.after(()=>{
    try { rememberProcesses(root, org, realWatch, receipts); }
    finally { receipts.cleanup(); fs.rmSync(root,{recursive:true,force:true}); }
  });
  const exec=(cmd,args,cwd=repo,overrides={})=>{
    const result=spawnSync(cmd,args,{cwd,env:{...env,...overrides},encoding:'utf8'});
    rememberProcesses(root, org, realWatch, receipts);
    return result;
  };
  const git=(args,cwd)=>{const r=exec('git',args,cwd);assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git(['init','-b','main']);git(['config','user.name','Dispatch Tests']);git(['config','user.email','dispatch@example.invalid']);
  fs.writeFileSync(path.join(repo,'seed'),'seed');git(['add','.']);git(['commit','-m','seed']);
  fs.writeFileSync(path.join(repo,'.lane.json'),JSON.stringify({routes:{engineer:{kind:'codex',model:'model-a',effort:'high'}}}));
  for(const name of ['herdr','lane','watch','org']) fs.writeFileSync(path.join(bin,name),fake,{mode:0o755});
  const rec=(args,overrides={})=>{const r=exec(process.execPath,[RECORD,...args],repo,overrides);assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  rec(['init']);const item=rec(['add','Do the work','--role','engineer']).split('\n')[0].match(/ENG-\d+/)[0];
  const brief=path.join(root,'brief with spaces.md');fs.writeFileSync(brief,'# Do the work');
  const common=['--org',org,'--repo',repo, ...(timingRecord?['--org-cli',path.join(bin,'org')]:[]),'--lane-cli',path.join(bin,'lane'), ...(realWatch?[]:['--watch-cli',path.join(bin,'watch')])];
  const dispatch=(args=[])=>exec(process.execPath,[DISPATCH,...common,...args]);
  const start=(extra=[])=>dispatch([item,'--lane','topic','--route','engineer','--brief',brief,...extra]);
  const calls=()=>fs.existsSync(path.join(root,'calls'))?fs.readFileSync(path.join(root,'calls'),'utf8').trim().split('\n').map(x=>JSON.parse(x)):[];
  const jobs=()=>fs.readdirSync(path.join(org,'dispatch')).filter(x=>x.endsWith('.json')&&!x.endsWith('.routes.json')).map(x=>path.join(org,'dispatch',x));
  const fail=(stage)=>fs.writeFileSync(path.join(root,'fail'),stage);
  const show=(run)=>JSON.parse(rec(['show',run,'--json']));
  const concurrent=(args,extraEnv={})=>{
    const child=spawnChild(t,process.execPath,[DISPATCH,...common,...args],{cwd:repo,env:{...env,...extraEnv},stdio:['ignore','pipe','pipe']});
    const done=waitForExit(child);
    return {child,done};
  };
  const state=()=>fold(fs.readFileSync(path.join(org,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse));
  return {root,repo,org,brief,item,start,dispatch,concurrent,rec,show,calls,jobs,fail,git,state};
}
const promptCalls=(f)=>f.calls().filter(x=>x.type==='herdr'&&x.a[0]==='agent'&&x.a[1]==='prompt');

function capSetting(f, cap) {
  const file = path.join(f.repo, '.lane.json'), config = JSON.parse(fs.readFileSync(file));
  config.dispatch = { ...config.dispatch, max_sessions: cap };
  fs.writeFileSync(file, JSON.stringify(config));
}
function occupiedRun(f, { project = f.git(['rev-parse', '--path-format=absolute', '--git-common-dir']), process: owner } = {}) {
  const run = f.rec(['start', f.item, '--workspace', f.repo, '--meta', `dispatch_project=${project}`]).match(/^(R-\d+) started/m)[1];
  f.rec(['worker', run, '--agent', `occupied-${run}`, '--pane', `p-${run}`, '--worker-workspace', 'w', '--terminal-id', `t-${run}`, '--cwd', f.repo]);
  if (owner) {
    fs.mkdirSync(path.join(f.org, 'dispatch'), { recursive: true });
    fs.writeFileSync(path.join(f.org, 'dispatch', `${run}.json`), JSON.stringify({ run, common: project, launchProcess: owner }));
  }
  return run;
}

test('session cap refuses before lane/run creation, lists occupants and admits after an ESRCH exit', t => {
  const f = fixture(t); capSetting(f, 2);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const first = occupiedRun(f), second = occupiedRun(f);
  const refused = f.start();
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(JSON.parse(refused.stdout).reason, new RegExp(`session cap 2 reached: ${first}, ${second}`));
  assert.match(refused.stderr, /2 workers, 0 settle reviewers/);
  assert.equal(f.calls().some(c => c.type === 'lane'), false);
  assert.deepEqual(f.show(f.item).runs, [first, second]);
  fs.mkdirSync(path.join(f.org, 'dispatch'), { recursive: true });
  fs.writeFileSync(path.join(f.org, 'dispatch', `${second}.json`), JSON.stringify({ run: second,
    common: f.git(['rev-parse', '--path-format=absolute', '--git-common-dir']), launchProcess: { pid: dead, identity: 'old' } }));
  const admitted = f.start(); assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(promptCalls(f).length, 1);
});

test('another project in the same record does not occupy this project session cap', t => {
  const f = fixture(t); capSetting(f, 1);
  occupiedRun(f, { project: path.join(f.root, 'other-project/.git') });
  const admitted = f.start(); assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(promptCalls(f).length, 1);
});

test('live reuse and setup-only retries remain admitted at the cap', t => {
  const f = fixture(t); capSetting(f, 1); f.fail('watch');
  assert.equal(f.start().status, 1);
  const job = JSON.parse(fs.readFileSync(f.jobs()[0])); f.fail('');
  const setup = f.dispatch(['--retry', job.run]); assert.equal(setup.status, 0, setup.stderr);
  f.rec(['abandon', job.run]);
  const file = path.join(f.root, 'workers'), workers = JSON.parse(fs.readFileSync(file));
  workers[job.worker.agentName].agent_status = 'idle'; fs.writeFileSync(file, JSON.stringify(workers));
  occupiedRun(f);
  const reused = f.start(['--reuse', job.run]); assert.equal(reused.status, 0, reused.stderr);
  assert.equal(JSON.parse(reused.stdout).agent, job.worker.agentName);
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 1);
});

test('a saved request rechecks the current cap before creating a worker', t => {
  const f = fixture(t); f.fail('prepare');
  assert.equal(f.start().status, 1); const journal = f.jobs()[0];
  occupiedRun(f); capSetting(f, 1); f.fail('');
  const retry = f.dispatch(['--retry', journal]); assert.equal(retry.status, 1);
  assert.match(retry.stderr, /session cap 1 reached/);
  assert.equal(f.calls().some(c => c.type === 'lane' && c.a[0] === 'dispatch'), false);
});

function admissionHook(f, body) {
  return pauseHook(f, `const list=fs.readdirSync;fs.readdirSync=function(dir,...args) {
 if(String(dir).endsWith('dispatch-session-cap.contenders')) fs.appendFileSync(process.env.PAUSE_MARKER+'.attempts',process.pid+'\\n');
 return list.call(this,dir,...args);
}; ${body}`);
}
const admissionAttempts = hook => new Set(fs.readFileSync(`${hook.PAUSE_MARKER}.attempts`, 'utf8').trim().split('\n')).size;

for (const cap of [1, 2]) test(`overlapping final launches wait for admission, then respect cap ${cap}`, async t => {
  const f = fixture(t); capSetting(f, cap);
  const hook = admissionHook(f, `const rename=fs.renameSync;let once=true;fs.renameSync=function(from,to) {
 const result=rename.call(this,from,to);
 if(once && String(to).endsWith('/dispatch-session-cap')) {once=false;pause();}
 return result;
};`);
  const args = [f.item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief];
  const first = f.concurrent(args, hook); let second;
  try {
    await until(() => fs.existsSync(hook.PAUSE_MARKER));
    second = f.concurrent(args, hook);
    await until(() => admissionAttempts(hook) === 2);
    assert.equal(second.child.exitCode, null, 'the overlapping launch waits instead of refusing');
    assert.equal(f.calls().some(c => c.type === 'lane' && c.a[0] === 'dispatch'), false);
  } finally {
    fs.writeFileSync(hook.PAUSE_RELEASE, 'go');
    await Promise.all([first.done, second?.done]);
  }
  const a = await first.done, b = await second.done;
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, cap === 1 ? 1 : 0, b.stderr);
  if (cap === 1) assert.match(b.stderr, /session cap 1 reached/);
  else assert.notEqual(JSON.parse(a.stdout).agent, JSON.parse(b.stdout).agent);
  const full = f.start(); assert.equal(full.status, 1); assert.match(full.stderr, new RegExp(`session cap ${cap} reached`));
  assert.equal(f.show(f.item).runs.length, 2);
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, cap);
  assert.equal(promptCalls(f).length, cap);
});

test('a dead project admission owner and contender are reclaimed before launching', t => {
  const f = fixture(t), dead = spawnSync(process.execPath, ['-e', '']).pid;
  const directory = path.join(f.git(['rev-parse', '--path-format=absolute', '--git-common-dir']), 'dispatch-session-cap');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: dead }));
  fs.mkdirSync(`${directory}.contenders`);
  fs.writeFileSync(path.join(`${directory}.contenders`, `${dead}-crashed`), '');
  const admitted = f.start(); assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(promptCalls(f).length, 1);
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(fs.readdirSync(`${directory}.contenders`), []);
});

test('concurrent dead-owner reclaim cannot remove the new project admission lock', async t => {
  const f = fixture(t), dead = spawnSync(process.execPath, ['-e', '']).pid;
  const directory = path.join(f.git(['rev-parse', '--path-format=absolute', '--git-common-dir']), 'dispatch-session-cap');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: dead }));
  const hook = admissionHook(f, `process.kill=function(pid,...args) {
 if(pid===${dead}) {try {return kill.call(process,pid,...args);} catch(error) {pause();throw error;}}
 return kill.call(process,pid,...args);
};`);
  const args = [f.item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief];
  const first = f.concurrent(args, hook); let second;
  try {
    await until(() => fs.existsSync(hook.PAUSE_MARKER));
    second = f.concurrent(args, hook);
    await until(() => admissionAttempts(hook) === 2);
    assert.equal(second.child.exitCode, null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'))).pid, dead);
  } finally {
    fs.writeFileSync(hook.PAUSE_RELEASE, 'go');
    await Promise.all([first.done, second?.done]);
  }
  for (const result of await Promise.all([first.done, second.done])) assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 2);
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(fs.readdirSync(`${directory}.contenders`), []);
});

for (const [stage, cap] of [['open', 2], ['worker', 2], ['worker', 1]]) {
  test(`a ${stage} memory wait allows another dispatch below cap ${cap} and recounts before launch`, async t => {
    const f = fixture(t), memory = path.join(f.root, 'memory.json'); capSetting(f, cap);
    fs.writeFileSync(memory, JSON.stringify({ available: (stage === 'open' ? 128 * 1024 ** 2 : 8 * 1024 ** 3), swap_used: 0 }));
    const pending = f.concurrent([f.item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief],
      { TEST_MEMORY_FILE: memory, ...(stage === 'worker' ? { TEST_MEMORY_WORKER_PRESSURE: '1' } : {}) });
    let stderr = '';
    pending.child.stderr.on('data', data => { stderr += data; });
    try {
      await until(() => stderr.includes('waiting; memory pressure'));
      assert.equal(JSON.parse(fs.readFileSync(f.jobs()[0])).stage, stage);
      const directory = path.join(f.git(['rev-parse', '--path-format=absolute', '--git-common-dir']), 'dispatch-session-cap');
      assert.equal(fs.existsSync(directory), false, 'memory waits must not hold admission');
      const concurrent = f.start(); assert.equal(concurrent.status, 0, concurrent.stderr);
      assert.equal(promptCalls(f).length, 1);
    } finally {
      fs.writeFileSync(memory, JSON.stringify({ available: 8 * 1024 ** 3, swap_used: 0 }));
      await pending.done;
    }
    assert.equal((await pending.done).status, cap === 1 ? 1 : 0, stderr);
    if (cap === 1) assert.match(stderr, /session cap 1 reached/);
    assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, cap);
    assert.equal(promptCalls(f).length, cap);
  });
}

test('delayed native session binds separately before same-session continuation reuses it', t => {
  const f = fixture(t, { lateSession: 'delayed', timingRecord: true });
  const first = f.start(); assert.equal(first.status, 0, first.stderr);
  const job = JSON.parse(fs.readFileSync(f.jobs()[0])), run = f.show(job.run);
  assert.equal(run.meta.agent_session_id, undefined, 'receipt remains terminal-only');
  assert.equal(f.state().sessionBindings.get(job.run).length, 1);
  assert.equal(effectiveWorkerIdentity(run, f.state()).agent_session_id, 's-worker-1');
  assert.equal(job.sessionBinding.status, 'bound');
  assert.equal(Date.parse(job.sessionBinding.deadline) - Date.parse(job.sessionBinding.prompted_at), 60000);
  const calls = f.calls(), receipt = calls.findIndex(c => c.type === 'org' && c.a[0] === 'worker');
  assert.ok(receipt < calls.findIndex(c => c.type === 'herdr' && c.a[1] === 'prompt'));
  f.rec(['abandon', job.run]);
  const file = path.join(f.root, 'workers'), workers = JSON.parse(fs.readFileSync(file));
  workers['worker-1'].agent_status = 'idle'; fs.writeFileSync(file, JSON.stringify(workers));
  const next = f.start(['--reuse', job.run]); assert.equal(next.status, 0, next.stderr);
  const nextRun = f.show(JSON.parse(next.stdout).run);
  assert.equal(nextRun.meta.agent_session_id, 's-worker-1');
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 1);
  assert.equal(promptCalls(f).length, 2);
});

test('ordinary retry after a blocked first delivery binds without another worker or watcher', t => {
  const f = fixture(t, { lateSession: 'delayed' }); f.fail('screen');
  assert.equal(f.start().status, 1);
  const before = JSON.parse(fs.readFileSync(f.jobs()[0]));
  assert.equal(before.stage, 'prompt'); assert.equal(before.sessionBinding, undefined);
  f.fail(''); const retry = f.dispatch(['--retry', before.run]); assert.equal(retry.status, 0, retry.stderr);
  const after = JSON.parse(fs.readFileSync(f.jobs()[0]));
  assert.equal(after.sessionBinding.status, 'bound'); assert.equal(promptCalls(f).length, 1);
  assert.equal(f.state().sessionBindings.get(before.run).length, 1);
  assert.deepEqual(after.launchProcess, before.launchProcess);
  assert.deepEqual(after.watcher, before.watcher);
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 1);
});

for (const recovery of ['resend', 'accept-delivered']) test(`${recovery} binds an expired uncertain delivery once using original launch evidence`, t => {
  const f = fixture(t, { lateSession: 'delayed' });
  f.fail(recovery === 'resend' ? 'prompt-blocked' : 'prompt-lost-reply');
  const first = f.start(); assert.equal(first.status, 1);
  assert.match(first.stderr, recovery === 'resend' ? /agent_blocked/ : /lost prompt reply/);
  const file = f.jobs()[0], before = JSON.parse(fs.readFileSync(file)); assert.equal(before.stage, 'prompting');
  // The trust prompt in the reported incident held delivery for three minutes.
  // Age the saved opportunity without sleeping or changing its identity anchors.
  const attempted = Date.now() - 180000;
  before.sessionBinding.prompted_at = new Date(attempted).toISOString();
  before.sessionBinding.deadline = new Date(attempted + 60000).toISOString();
  fs.writeFileSync(file, JSON.stringify(before));
  f.fail('');
  const uncertain = f.dispatch(['--retry', before.run]);
  assert.equal(uncertain.status, 1); assert.match(uncertain.stderr, /prompt delivery outcome is unknown/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).sessionBinding, before.sessionBinding);
  assert.equal(f.state().sessionBindings.get(before.run), undefined); assert.equal(promptCalls(f).length, 1);
  const retry = f.dispatch(['--retry', before.run, `--${recovery}`]); assert.equal(retry.status, 0, retry.stderr);
  const after = JSON.parse(fs.readFileSync(file)), state = f.state(), run = f.show(before.run);
  assert.equal(JSON.parse(retry.stdout).binding.status, 'bound'); assert.equal(after.stage, 'complete');
  assert.equal(after.sessionBinding.status, 'bound');
  assert.ok(Date.parse(after.sessionBinding.prompted_at) > Date.parse(before.sessionBinding.deadline));
  assert.equal(Date.parse(after.sessionBinding.deadline) - Date.parse(after.sessionBinding.prompted_at), 60000);
  assert.deepEqual(after.sessionBinding.process, before.sessionBinding.process);
  assert.deepEqual(after.sessionBinding.receipt, before.sessionBinding.receipt);
  assert.deepEqual(after.launchProcess, before.launchProcess); assert.deepEqual(after.watcher, before.watcher);
  assert.equal(run.meta.agent_session_id, undefined, 'original receipt remains terminal-only');
  assert.equal(effectiveWorkerIdentity(run, state).agent_session_id, 's-worker-1');
  assert.equal(state.sessionBindings.get(before.run).length, 1);
  const prompts = recovery === 'resend' ? 2 : 1;
  assert.equal(promptCalls(f).length, prompts);
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 1);
  assert.equal(f.calls().filter(c => c.type === 'watch').length, 1);
  assert.equal(f.dispatch(['--retry', before.run, `--${recovery}`]).status, 0);
  assert.deepEqual(f.state().sessionBindings.get(before.run), state.sessionBindings.get(before.run));
  assert.equal(promptCalls(f).length, prompts);
});

for (const recovery of ['resend', 'accept-delivered']) {
  for (const field of ['name', 'terminal_id']) test(`${recovery} refuses a changed worker ${field} without binding or delivering`, t => {
    const f = fixture(t, { lateSession: 'delayed' }); f.fail('prompt-blocked'); assert.equal(f.start().status, 1);
    const file = f.jobs()[0], before = JSON.parse(fs.readFileSync(file));
    const workerFile = path.join(f.root, 'workers'), workers = JSON.parse(fs.readFileSync(workerFile));
    workers[before.worker.agentName][field] = 'replacement'; fs.writeFileSync(workerFile, JSON.stringify(workers));
    f.fail(''); const retry = f.dispatch(['--retry', before.run, `--${recovery}`]);
    assert.equal(retry.status, 1); assert.match(retry.stderr, /worker occupant identity changed/);
    assert.equal(f.state().sessionBindings.get(before.run), undefined); assert.equal(promptCalls(f).length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).sessionBinding, before.sessionBinding);
  });
  test(`${recovery} rejects a replacement native process in the original terminal`, t => {
    const f = fixture(t, { lateSession: 'replacement-before-prompt' }); f.fail('prompt-blocked'); assert.equal(f.start().status, 1);
    const file = f.jobs()[0], before = JSON.parse(fs.readFileSync(file));
    f.fail(''); const retry = f.dispatch(['--retry', before.run, `--${recovery}`]); assert.equal(retry.status, 0, retry.stderr);
    const after = JSON.parse(fs.readFileSync(file));
    assert.equal(after.sessionBinding.status, 'unbound'); assert.equal(after.sessionBinding.reason, 'native process changed');
    assert.deepEqual(after.sessionBinding.process, before.sessionBinding.process);
    assert.equal(f.state().sessionBindings.get(before.run), undefined);
  });
}

for (const mode of ['replacement', 'replacement-before-prompt']) test(`same-terminal ${mode} keeps the original launch unbound despite matching topology`, t => {
  const f = fixture(t, { lateSession: mode }), result = f.start();
  assert.equal(result.status, 0, result.stderr);
  const job = JSON.parse(fs.readFileSync(f.jobs()[0]));
  assert.equal(job.sessionBinding.status, 'unbound'); assert.match(job.sessionBinding.reason, /process changed/);
  assert.equal(f.state().sessionBindings.get(job.run), undefined);
  assert.equal(promptCalls(f).length, 1);
});

for (const fault of ['after-prompt', 'bind-lost-reply']) test(`${fault} recovers within the saved opportunity without replaying delivery`, t => {
  const f = fixture(t, { lateSession: 'delayed', timingRecord: true }); f.fail(fault);
  const first = f.start(); assert.equal(first.status, fault === 'after-prompt' ? 1 : 0, first.stderr);
  const file = f.jobs()[0], before = JSON.parse(fs.readFileSync(file));
  assert.equal(before.stage, 'complete');
  if (fault === 'bind-lost-reply') {
    assert.ok(before.sessionBinding.proposed);
    assert.deepEqual(JSON.parse(first.stdout).binding, { status: 'unknown', retry: `node dispatch/dispatch.mjs --retry ${before.run}` });
    assert.match(first.stderr, new RegExp(`bind reply unknown;.*node dispatch/dispatch.mjs --retry ${before.run}`));
    assert.equal(f.show(before.run).notes.some(n => /bind reply unknown/.test(n.text)), false);
    f.rec(['abandon', before.run]); // Exact reply recovery also works after finishing.
  }
  f.fail('');
  const retry = f.dispatch(['--retry', before.run]); assert.equal(retry.status, 0, retry.stderr);
  const after = JSON.parse(fs.readFileSync(file));
  assert.equal(after.sessionBinding.deadline, before.sessionBinding.deadline);
  assert.equal(after.sessionBinding.status, 'bound');
  assert.equal(f.state().sessionBindings.get(before.run).length, 1);
  assert.equal(promptCalls(f).length, 1);
});

test('the saved bind writer finishes without the observation SIGKILL deadline', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bind-writer-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const preload = path.join(scratch, 'near-deadline.cjs');
  fs.writeFileSync(preload, `if(process.argv[1]===${JSON.stringify(DISPATCH)}) {
const fs=require('node:fs'), rename=fs.renameSync;
fs.renameSync=function(from,to) {
  const result=rename.call(this,from,to);
  if(String(to).endsWith('.json')) {
    const job=JSON.parse(fs.readFileSync(to,'utf8'));
    if(job.sessionBinding?.proposed) Date.now=()=>Date.parse(job.sessionBinding.deadline)-1;
  }
  return result;
};
}`);
  const f = fixture(t, { lateSession: 'delayed', preload });
  const result = f.start(); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).binding.status, 'bound');
  const job = JSON.parse(fs.readFileSync(f.jobs()[0]));
  assert.equal(f.state().sessionBindings.get(job.run).length, 1);
  assert.equal(promptCalls(f).length, 1);
});

test('dispatch journals both memory gates and mirrors allowlisted events into run metadata', t => {
  const f = fixture(t);
  const result = f.start(); assert.equal(result.status, 0, result.stderr);
  const job = JSON.parse(fs.readFileSync(f.jobs()[0]));
  const events = fs.readFileSync(`${f.jobs()[0]}.events.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(e => [e.kind, e.outcome]), [
    ['memory_open', 'entry'], ['memory_open', 'granted'], ['memory_worker', 'entry'], ['memory_worker', 'granted'],
  ]);
  const metadata = JSON.parse(f.show(job.run).meta.dispatch_waits);
  assert.deepEqual(metadata, events.map(e => ({ ...e, run: job.run })));
  for (const e of metadata) {
    assert.deepEqual(Object.keys(e), ['at', 'run', 'item', 'lane', 'kind', 'outcome']);
    assert.equal(e.item, f.item); assert.equal(e.lane, 'topic');
  }
});

test('failed timing record sets leave lane open, launch and prompt delivery unchanged and clocks missing', t => {
  const normal = fixture(t), failed = fixture(t, { timingFailure: true });
  for (const f of [normal, failed]) {
    const result = f.start(); assert.equal(result.status, 0, result.stderr);
    assert.equal(promptCalls(f).length, 1);
  }
  const stages = f => f.calls().filter(c => c.type === 'lane').map(c => c.a[0]);
  assert.deepEqual(stages(failed), stages(normal));
  const job = JSON.parse(fs.readFileSync(failed.jobs()[0]));
  assert.equal(job.stage, 'complete'); assert.equal(job.timing_missing, 3);
  assert.equal(failed.show(job.run).meta.dispatch_waits, undefined);
  const { summary } = runMetrics([failed.show(job.run)]);
  assert.equal(summary.dispatch_wait_s.missing, 1);
  assert.equal(summary.waits_s.memory_worker.missing, 1);
});

test('recovery skips timing record sets when metadata already equals the journal', t => {
  const f = fixture(t, { timingRecord: true }); f.fail('watch');
  assert.equal(f.start().status, 1);
  const job = JSON.parse(fs.readFileSync(f.jobs()[0]));
  const sets = () => f.calls().filter(c => c.type === 'org' && c.a[0] === 'set' && c.a[2].startsWith('dispatch_waits=')).length;
  const before = sets(); assert.equal(before, 3);
  f.fail(''); const result = f.dispatch(['--retry', job.run]);
  assert.equal(result.status, 0, result.stderr); assert.equal(sets(), before);
});

test('failed timing record sets preserve STOP during the worker wait and its stopped receipt', async t => {
  for (const timingFailure of [false, true]) {
    const f = fixture(t, { timingFailure }), memory = path.join(f.root, 'memory.json');
    fs.writeFileSync(memory, JSON.stringify({ available: 8 * 1024 ** 3, swap_used: 0 }));
    const pending = f.concurrent([f.item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief],
      { TEST_MEMORY_FILE: memory, TEST_MEMORY_WORKER_PRESSURE: '1' });
    let stderr = '', stdout = '';
    pending.child.stderr.on('data', data => { stderr += data; });
    pending.child.stdout.on('data', data => { stdout += data; });
    try {
      const until = Date.now() + 10000;
      while (!stderr.includes('waiting; memory pressure') && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
      assert.match(stderr, /waiting; memory pressure/);
      const stop = path.join(f.repo, '.lane/supervisor/STOP');
      fs.mkdirSync(path.dirname(stop), { recursive: true }); fs.writeFileSync(stop, 'Operator stop');
    } finally {
      fs.writeFileSync(memory, JSON.stringify({ available: 8 * 1024 ** 3, swap_used: 0 }));
      await pending.done;
    }
    assert.equal(pending.child.exitCode, 0, stderr);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.result, 'stopped'); assert.equal(receipt.stage, 'worker');
    assert.equal(receipt.reason, 'Supervisor STOP appeared before dispatch; no new worker launched');
    assert.equal(f.calls().some(c => c.type === 'lane' && c.a[0] === 'dispatch'), false);
    assert.equal(promptCalls(f).length, 0);
    if (timingFailure) assert.equal(JSON.parse(fs.readFileSync(receipt.journal)).timing_missing, 3);
  }
});

test('dispatch defaults to project ops from a chat environment and explicit --to wins', t => {
  const f = fixture(t, {noticeRecipient: 'ops-project'}); f.fail('prepare');
  const first = f.start(); assert.equal(first.status, 1);
  const job = JSON.parse(fs.readFileSync(f.jobs()[0])); assert.equal(job.to, 'ops-project');
  assert.deepEqual(f.calls().find(c => c.type === 'herdr' && c.a[1] === 'get').a, ['agent', 'get', 'ops-project']);
  const other = fixture(t, {noticeRecipient: 'ops-project'}); other.fail('prepare');
  assert.equal(other.start(['--to', 'ops-explicit']).status, 1);
  assert.equal(JSON.parse(fs.readFileSync(other.jobs()[0])).to, 'ops-explicit');
  assert.equal(f.calls().some(c => c.a.includes('chat-operator')), false);
});
// Verbatim supervisor capture from stalled pane w2SW:p1 on 2026-10-05.
const hooksTableScreen = fs.readFileSync(new URL('./fixtures/codex-0.160.0-hooks-screen.txt', import.meta.url), 'utf8');
test('captured Codex hooks event table detects the warning count while quoted task text stays safe', () => {
  assert.equal(hookReviewDialog(hooksTableScreen), '1 hook needs review before it can run.');
  assert.equal(hookReviewDialog(hooksTableScreen.replace('⚠ 1 hook needs review before it', '⚠️ 2 hooks need review before they')),
    '2 hooks need review before they can run.');
  assert.equal(hookReviewDialog(`\u001b[33m${hooksTableScreen}\u001b[0m`), '1 hook needs review before it can run.');
  for (const screen of [
    '⚠ 1 hook needs review before it can run.',
    '› ⚠ 1 hook needs review before it can run.',
    hooksTableScreen.replace('  Hooks\n', '› Hooks\n'),
    hooksTableScreen.replace('  ⚠', '› ⚠'),
    hooksTableScreen.replace('  t trust all', '› t trust all'),
    hooksTableScreen.split('\n').map(line => `> ${line}`).join('\n'),
    hooksTableScreen.split('\n').map(line => `› ${line}`).join('\n'),
  ]) assert.equal(hookReviewDialog(screen), undefined, screen);
});
// Codex 0.160.0 startup_hooks_review labels, transcribed from the installed
// binary. ANSI/box framing represents a visible pane; no live session is used.
const startupHookReviewScreen = `╭──────────────────────────────────────────────────────────────────────╮
│ \u001b[1mHooks need review\u001b[0m                                                    │
│                                                                      │
│ 1 hook is new or changed.                                             │
│ Hooks can run outside the sandbox after you trust them.               │
│                                                                      │
│ \u001b[36m› 1. Review hooks\u001b[0m                                                    │
│   2. Trust all and continue                                           │
│   3. Continue without trusting (hooks won't run)                       │
╰──────────────────────────────────────────────────────────────────────╯`;
test('hook dialog detection handles ANSI, borders, plural counts and wrapping without matching task prose', () => {
  for (const [screen, name] of [
    [startupHookReviewScreen, '1 hook is new or changed.'],
    [startupHookReviewScreen.replace('1 hook is', '3 hooks are'), '3 hooks are new or changed.'],
    [startupHookReviewScreen.replace('1 hook is new or changed.', ''), 'Hooks need review'],
    ['Hooks need review\n1 hook is new or changed.', '1 hook is new or changed.'],
    ['│ Hooks need review │\n│ 2 hooks are new or │\n│ changed. │', '2 hooks are new or changed.'],
    ['1 hook needs review before it can run.', '1 hook needs review before it can run.'],
    ['│ 2 hooks need review before they can run. │', '2 hooks need review before they can run.'],
    ['1 hook needs review', '1 hook needs review'],
    ['\u001b[1m│ 2 hooks need review │\u001b[0m', '2 hooks need review'],
    ['╭──╮\n  1 hook needs\n  review\n╰──╯', '1 hook needs review'],
  ]) {
    assert.equal(hookReviewDialog(screen), name);
  }
  for (const screen of [
    '› Ready', '0 hooks pending', 'Explain why 1 hook needs review', '› Fix "1 hook needs review"',
    '› 1 hook needs review', '› 1 hook needs review before it can run.',
    'Explain why Hooks need review\n1 hook is new or changed.',
    '› Hooks need review\n1 hook is new or changed.',
    'Hooks need review\n› 1 hook is new or changed.',
    '› Trust all and continue', 'Hooks need review', '1 hook is new or changed.',
    'Hooks need review\nExplain Trust all and continue',
  ]) assert.equal(hookReviewDialog(screen), undefined, screen);
  for (const args of [['-p', 'worker'], ['--profile', 'worker'], ['--profile=worker'], ['-pworker']]) assert.equal(codexProfile(args), 'worker');
  assert.equal(codexProfile(['-p', 'old', '--profile=new']), 'new');
  assert.equal(codexProfile([]), undefined);
});
for (const [screenName, screen, count] of [
  ['startup dialog', startupHookReviewScreen, '1 hook is new or changed.'],
  ['captured hooks event table', hooksTableScreen, '1 hook needs review before it can run.'],
]) for (const profile of [undefined, 'claude-mem-bastian']) test(`Codex ${screenName} blocks the brief visibly in ${profile ?? 'the default profile'} and ordinary retry delivers once`, t => {
  const f = fixture(t);
  if (profile) fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({
    routes: { engineer: { kind: 'codex', model: 'model-a', effort: 'high', args: ['--profile', profile] } },
  }));
  fs.writeFileSync(path.join(f.root, 'screen'), screen);
  const first = f.start(); assert.equal(first.status, 1, first.stderr);
  const blocked = JSON.parse(first.stdout), job = JSON.parse(fs.readFileSync(blocked.journal));
  assert.equal(blocked.result, 'blocked'); assert.equal(blocked.code, 'DISPATCH_HOOK_REVIEW');
  assert.equal(blocked.run, job.run); assert.equal(blocked.pane, job.worker.pane);
  assert.ok(first.stderr.includes(count)); assert.match(first.stderr, /Open \/hooks/);
  assert.ok(first.stderr.includes(profile ?? 'configured default profile'));
  assert.equal(job.stage, 'prompt'); assert.equal(promptCalls(f).length, 0);
  assert.match(f.show(job.run).notes.at(-1).text, /hook-review dialog.*brief not sent/);
  const watcher = job.watcher;
  assert.equal(f.dispatch(['--retry', job.run]).status, 1); assert.equal(promptCalls(f).length, 0);
  // A changed live config must not misidentify the profile of the saved worker.
  if (profile) {
    fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({routes:{engineer:{kind:'codex',args:['-p','other']}}}));
    assert.ok(f.dispatch(['--retry', job.run]).stderr.includes(profile));
  }
  fs.writeFileSync(path.join(f.root, 'screen'), '› Ready for a task');
  const retry = f.dispatch(['--retry', job.run]); assert.equal(retry.status, 0, retry.stderr);
  const resumed = JSON.parse(retry.stdout); assert.equal(resumed.run, job.run); assert.equal(resumed.agent, job.worker.agentName);
  assert.deepEqual(resumed.watcher, watcher); assert.equal(promptCalls(f).length, 1);
  assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'dispatch').length, 1);
  assert.equal(f.calls().filter(c => c.type === 'watch').length, 1);
  assert.equal(f.calls().some(c => c.a.includes('send-keys')), false, 'dispatch never accepts hook trust');
  const reads = f.calls().filter(c => c.a[0] === 'pane' && c.a[1] === 'read');
  for (const read of reads) assert.deepEqual(read.a, ['pane','read',job.worker.pane,'--source','visible','--format','text']);
  assert.equal(f.dispatch(['--retry', job.run]).status, 0); assert.equal(promptCalls(f).length, 1);
});
test('screen read failure leaves delivery unsent and retryable', t => {
  const f = fixture(t); f.fail('screen'); const first = f.start();
  assert.equal(first.status, 1); assert.match(first.stderr, /screen read failure/);
  const job = JSON.parse(fs.readFileSync(f.jobs()[0])); assert.equal(job.stage, 'prompt'); assert.equal(promptCalls(f).length, 0);
  f.fail(''); const retry = f.dispatch(['--retry', job.run]); assert.equal(retry.status, 0, retry.stderr); assert.equal(promptCalls(f).length, 1);
});
test('an explicitly authorized resend also checks the hook dialog and preserves uncertain delivery', t => {
  const f = fixture(t); f.fail('prompt'); assert.equal(f.start().status, 1);
  const job = JSON.parse(fs.readFileSync(f.jobs()[0])); f.fail('');
  fs.writeFileSync(path.join(f.root, 'screen'), startupHookReviewScreen.replace('1 hook is', '2 hooks are'));
  const stopped = f.dispatch(['--retry', job.run, '--resend']); assert.equal(stopped.status, 1);
  assert.equal(JSON.parse(stopped.stdout).result, 'blocked'); assert.equal(promptCalls(f).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.jobs()[0])).stage, 'prompting');
  fs.writeFileSync(path.join(f.root, 'screen'), '› Ready');
  assert.equal(f.dispatch(['--retry', job.run]).status, 1, 'uncertain earlier delivery still needs explicit recovery');
  const retry = f.dispatch(['--retry', job.run, '--resend']); assert.equal(retry.status, 0, retry.stderr); assert.equal(promptCalls(f).length, 2);
});
test('Linux dispatch watcher receipt and journal round-trip as strings through record set', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-linux-identity-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const preload = path.join(scratch, 'linux.cjs'), boot = '12345678-1234-4234-8234-123456789abc';
  fs.writeFileSync(preload, `const fs=require('node:fs'),path=require('node:path');
if(process.argv[1]===${JSON.stringify(DISPATCH)}||path.basename(process.argv[1]||'')==='watch') {
Object.defineProperty(process,'platform',{value:'linux'});
const read=fs.readFileSync;
fs.readFileSync=function(file,...args){
if(file==='/proc/sys/kernel/random/boot_id') return ${JSON.stringify(boot + '\n')};
const match=String(file).match(/^\\/proc\\/(\\d+)\\/stat$/);
if(match){const pid=Number(match[1]);process.kill(pid,0);return pid+' (watcher) S '+[1,pid,...Array(16).fill(0),'12345'].join(' ')+'\\n';}
if(file==='/proc/meminfo') return 'MemTotal: 16777216 kB\\nMemAvailable: 8388608 kB\\nSwapTotal: 0 kB\\nSwapFree: 0 kB\\n';
return read.call(this,file,...args);};require('node:module').syncBuiltinESMExports();}
`);
  const f = fixture(t, { preload });
  const r = f.start(); assert.equal(r.status, 0, r.stderr);
  const receipt = JSON.parse(r.stdout), job = JSON.parse(fs.readFileSync(receipt.journal));
  const identity = f.show(receipt.run).meta.watcher_identity;
  assert.equal(typeof identity, 'string');
  assert.equal(identity, receipt.watcher.identity);
  assert.equal(identity, job.watcher.identity);
  const readProcess = birth => pid => lookupProcess(pid, { platform: 'linux', identityOnly: true, readFile: file =>
    file === '/proc/sys/kernel/random/boot_id' ? `${boot}\n` : `${pid} (watcher) S ${[1, pid, ...Array(16).fill(0), birth].join(' ')}\n` });
  assert.equal(ownerAlive({ pid: receipt.watcher.pid, identity }, readProcess('12345')), true);
  assert.equal(ownerAlive({ pid: receipt.watcher.pid, identity }, readProcess('12346')), false);
  const retry = f.dispatch(['--retry', receipt.journal]); assert.equal(retry.status, 0, retry.stderr);
  assert.equal(f.show(receipt.run).meta.watcher_identity, identity);
  assert.equal(promptCalls(f).length, 1);
});
test('a proving reservation pauses dispatch before lane open within the existing memory_open clock', async t => {
  const f = fixture(t), lock = path.join(f.root, 'slot');
  const held = publishProvingReservation({ lockPath: lock, label: 'proof', reason: 'ENG-424 R-601', expiresAt: new Date(Date.now() + 60000).toISOString() });
  t.after(() => held.release());
  const pending = f.concurrent([f.item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief],
    { MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock });
  let stderr = ''; pending.child.stderr.on('data', data => { stderr += data; });
  try {
    const deadline = Date.now() + 10000;
    while (!stderr.includes('waiting; proving') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(stderr, /waiting; proving.*ENG-424 R-601; expiry/);
    assert.equal(f.calls().some(c => c.type === 'lane' && c.a[0] === 'open'), false);
    assert.deepEqual(readTiming(f.jobs()[0]).filter(row => row.kind === 'memory_open').map(row => row.outcome), ['entry']);
  } finally { held.release(); await pending.done; }
  assert.equal(pending.child.exitCode, 0, stderr); assert.match(stderr, /proving reservation ended; proceeding/);
  assert.deepEqual(readTiming(f.jobs()[0]).filter(row => row.kind === 'memory_open').map(row => row.outcome), ['entry', 'granted']);
});

test('dispatch waits under simulated swap pressure before opening a lane and resumes the same request', async t => {
  const f = fixture(t), memory = path.join(f.root, 'memory.json');
  fs.writeFileSync(memory, JSON.stringify({ available: 2 * 1024 ** 3, swap_used: 1024 ** 3 }));
  const pending = f.concurrent([f.item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief], { TEST_MEMORY_FILE: memory });
  let stderr = '';
  pending.child.stderr.on('data', data => { stderr += data; });
  const end = Date.now() + 10000;
  while (!stderr.includes('waiting; memory pressure') && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(stderr, /swap in use 1024 MiB/);
  assert.equal(f.calls().some(c => c.type === 'lane' && c.a[0] === 'open'), false);
  const journal = f.jobs()[0]; assert.equal(JSON.parse(fs.readFileSync(journal)).stage, 'open');
  fs.writeFileSync(memory, JSON.stringify({ available: 8 * 1024 ** 3, swap_used: 1024 ** 2 }));
  await pending.done;
  assert.equal(pending.child.exitCode, 0, stderr);
  assert.match(stderr, /cleared; proceeding/);
  assert.equal(f.jobs().length, 1); assert.equal(promptCalls(f).length, 1);
});
for (const stage of ['open', 'worker']) {
  test(`STOP during dispatch ${stage} memory wait retains the request without a worker launch`, async t => {
    const f = fixture(t), memory = path.join(f.root, 'memory.json');
    fs.writeFileSync(memory, JSON.stringify({ available: (stage === 'open' ? 128 * 1024 ** 2 : 8 * 1024 ** 3), swap_used: 0 }));
    const pending = f.concurrent([f.item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief],
      { TEST_MEMORY_FILE: memory, ...(stage === 'worker' ? { TEST_MEMORY_WORKER_PRESSURE: '1' } : {}) });
    let stderr = '', stdout = '';
    pending.child.stderr.on('data', data => { stderr += data; });
    pending.child.stdout.on('data', data => { stdout += data; });
    const stop = path.join(f.repo, '.lane/supervisor/STOP');
    try {
      const end = Date.now() + 10000;
      while (!stderr.includes('waiting; memory pressure') && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
      assert.match(stderr, /waiting; memory pressure/);
      assert.equal(JSON.parse(fs.readFileSync(f.jobs()[0])).stage, stage);
      fs.mkdirSync(path.dirname(stop), { recursive: true }); fs.writeFileSync(stop, 'Operator stop');
    } finally {
      fs.writeFileSync(memory, JSON.stringify({ available: 8 * 1024 ** 3, swap_used: 0 }));
      await pending.done;
    }
    assert.equal(pending.child.exitCode, 0, stderr);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.result, 'stopped'); assert.equal(receipt.stage, stage);
    assert.match(receipt.reason, /Supervisor STOP/);
    assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'open').length, stage === 'open' ? 0 : 1);
    assert.equal(f.calls().some(c => c.type === 'lane' && c.a[0] === 'dispatch'), false);
    assert.equal(promptCalls(f).length, 0);
    assert.equal(fs.existsSync(`${receipt.journal}.lock`), false, 'stopping releases the request lock');
    const stillStopped = f.dispatch(['--retry', receipt.journal]);
    assert.equal(stillStopped.status, 0, stillStopped.stderr);
    assert.equal(JSON.parse(stillStopped.stdout).result, 'stopped');
    fs.unlinkSync(stop);
    const resumed = f.dispatch(['--retry', receipt.journal]);
    assert.equal(resumed.status, 0, resumed.stderr);
    if (receipt.run) assert.equal(JSON.parse(resumed.stdout).run, receipt.run);
    assert.equal(f.jobs().length, 1); assert.equal(promptCalls(f).length, 1);
    assert.equal(f.calls().filter(c => c.type === 'lane' && c.a[0] === 'open').length, 1);
  });
}
test('one command records exact route/worker fields, arms watch before prompt, and preserves briefs',t=>{
  const f=fixture(t), before=fs.readFileSync(f.brief,'utf8');
  const r=f.start(['--report','docs/reports/round.md','--extra','Fix round: inspect the review.']);assert.equal(r.status,0,r.stderr);
  const result=JSON.parse(r.stdout),run=f.show(result.run);
  assert.deepEqual([run.meta.route,run.meta.harness,run.meta.model,run.meta.effort,run.meta.lane],['engineer','codex','model-a','high','topic']);
  assert.equal(run.meta.agent,result.agent);assert.equal(run.meta.pane,result.pane);
  assert.equal(run.report_path,path.join(f.root,'lane','docs/reports/round.md'));
  assert.equal(run.meta.watcher_pid,result.watcher.pid);
  const calls=f.calls(),watch=calls.findIndex(x=>x.type==='watch'),prompt=calls.findIndex(x=>x.a[1]==='prompt');assert.ok(watch<prompt);
  assert.deepEqual(calls.find(x=>x.type==='lane'&&x.a[0]==='open').a, ['open','topic','--git-only']);
  assert.match(promptCalls(f)[0].a[3],new RegExp(result.run));assert.ok(promptCalls(f)[0].a[3].includes(run.brief_path));
  assert.ok(promptCalls(f)[0].a[3].includes(run.report_path));assert.match(promptCalls(f)[0].a[3],/Fix round/);
  assert.equal(fs.readFileSync(f.brief,'utf8'),before);
  assert.equal(f.dispatch(['--retry',result.run]).status,0);assert.equal(promptCalls(f).length,1);
});
test('open/prepare failures keep a visible request, create no run, and retry cleanly',t=>{
  for(const stage of ['open','prepare']) {
    const f=fixture(t);f.fail(stage);let r=f.start();assert.equal(r.status,1);const journal=f.jobs()[0];
    const job=JSON.parse(fs.readFileSync(journal));assert.equal(job.run,null);assert.match(job.error,/injected/);
    f.fail('');r=f.dispatch(['--retry',journal]);assert.equal(r.status,0,r.stderr);assert.equal(promptCalls(f).length,1);
  }
});
test('watch failure records a worker but never sends work; retry reuses the same worker/run',t=>{
  const f=fixture(t);f.fail('watch');let r=f.start();assert.equal(r.status,1);
  const job=JSON.parse(fs.readFileSync(f.jobs()[0]));assert.equal(job.stage,'watch');assert.ok(f.show(job.run).meta.agent);
  assert.equal(promptCalls(f).length,0);assert.match(f.show(job.run).notes.at(-1).text,/incomplete/);
  f.fail('');r=f.dispatch(['--retry',job.run]);assert.equal(r.status,0,r.stderr);
  assert.equal(f.calls().filter(x=>x.type==='lane'&&x.a[0]==='dispatch').length,1);
});
test('uncertain launch refuses automatic replay and requires explicit adoption',t=>{
  const f=fixture(t);f.fail('uncertain-launch');assert.equal(f.start().status,1);
  const job=JSON.parse(fs.readFileSync(f.jobs()[0]));f.fail('');let r=f.dispatch(['--retry',job.run]);assert.equal(r.status,1);assert.match(r.stderr,/--adopt/);
  r=f.dispatch(['--retry',job.run,'--adopt','worker-1']);assert.equal(r.status,0,r.stderr);
  assert.equal(f.calls().filter(x=>x.type==='lane'&&x.a[0]==='dispatch').length,1);
});
test('uncertain prompt refuses automatic resend; caller can authorize it after inspection',t=>{
  const f=fixture(t);f.fail('prompt');assert.equal(f.start().status,1);const job=JSON.parse(fs.readFileSync(f.jobs()[0]));
  f.fail('');let r=f.dispatch(['--retry',job.run]);assert.equal(r.status,1);assert.match(r.stderr,/delivery outcome is unknown/);assert.equal(promptCalls(f).length,1);
  r=f.dispatch(['--retry',job.run,'--resend']);assert.equal(r.status,0,r.stderr);assert.equal(promptCalls(f).length,2);
});
test('a fix round can reuse a stopped worker or start fresh; changed route is refused',t=>{
  const f=fixture(t);let r=f.start();assert.equal(r.status,0,r.stderr);const first=JSON.parse(r.stdout);
  const report=path.join(f.root,'first-report.md');
  fs.writeFileSync(report,`---\nrun: ${first.run}\noutcome: done\nsummary: First round complete\n---\n`);f.rec(['ingest',report]);
  const workerFile=path.join(f.root,'workers'),workers=JSON.parse(fs.readFileSync(workerFile));workers[first.agent].agent_status='idle';fs.writeFileSync(workerFile,JSON.stringify(workers));
  r=f.start(['--reuse',first.run]);assert.equal(r.status,0,r.stderr);const second=JSON.parse(r.stdout);assert.notEqual(second.run,first.run);assert.equal(second.agent,first.agent);
  assert.equal(second.pane,first.pane);
  const continued=f.show(second.run),previous=f.show(first.run);
  assert.equal(continued.meta.continuation_of,first.run);assert.equal(continued.meta.same_session,true);
  assert.equal(continued.meta.agent_session_id,previous.meta.agent_session_id);
  r=f.start();assert.equal(r.status,0,r.stderr);assert.notEqual(JSON.parse(r.stdout).agent,first.agent);
  const runs=f.show(f.item).runs,calls=f.calls().length,jobs=f.jobs().length;
  fs.writeFileSync(path.join(f.repo,'.lane.json'),JSON.stringify({routes:{engineer:{kind:'codex',model:'changed',effort:'high'}}}));r=f.start(['--reuse',first.run]);assert.equal(r.status,1);assert.match(r.stderr,/declared harness/);
  assert.equal(JSON.parse(r.stdout).code,'REUSE_MISMATCH');assert.deepEqual(f.show(f.item).runs,runs);
  assert.equal(f.jobs().length,jobs);assert.equal(f.calls().slice(calls).filter(c=>c.type==='lane').length,0);
});
test('retry pins routes across config edits and detects a replaced occupant',t=>{
  const f=fixture(t);f.fail('watch');assert.equal(f.start().status,1);const job=JSON.parse(fs.readFileSync(f.jobs()[0]));
  fs.writeFileSync(path.join(f.repo,'.lane.json'),JSON.stringify({routes:{engineer:{kind:'codex',model:'changed',effort:'low'}}}));
  f.fail('');let r=f.dispatch(['--retry',job.run]);assert.equal(r.status,0,r.stderr);assert.equal(f.show(job.run).meta.model,'model-a');
  const file=path.join(f.root,'workers'),workers=JSON.parse(fs.readFileSync(file));workers[job.worker.agentName].terminal_id='replacement';fs.writeFileSync(file,JSON.stringify(workers));
  r=f.dispatch(['--retry',job.run]);assert.equal(r.status,1);assert.match(r.stderr,/occupant identity changed/);assert.equal(promptCalls(f).length,1);
});
test('base moves a clean reused lane only by fast-forward; dirty lane is preserved',t=>{
  const f=fixture(t);assert.equal(f.start().status,0);
  fs.writeFileSync(path.join(f.repo,'second'),'second');f.git(['add','second']);f.git(['commit','-m','base advance']);
  let r=f.start(['--base','main']);assert.equal(r.status,0,r.stderr);assert.equal(f.git(['rev-parse','HEAD'],path.join(f.root,'lane')),f.git(['rev-parse','main']));
  fs.writeFileSync(path.join(f.root,'lane','dirty'),'dirty');r=f.start(['--base','main']);assert.equal(r.status,1);assert.match(r.stderr,/clean lane/);
});
test('a real detached watcher acknowledges initialization and sheds supervisor pane identity',async t=>{
  const f=fixture(t,{realWatch:true});const r=f.start();assert.equal(r.status,0,r.stderr);const result=JSON.parse(r.stdout);
  assert.ok(result.watcher.pid);process.kill(result.watcher.pid,0);
  const until=Date.now()+3000;
  while(!f.calls().some(x=>x.type==='herdr'&&x.a[2]===result.agent&&x.pane===null)&&Date.now()<until) await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(f.calls().some(x=>x.type==='herdr'&&x.a[2]===result.agent&&x.pane===null));
  assert.match(fs.readFileSync(result.watcher.log,'utf8'),/watching R-/);
  const duplicate=spawnSync(process.execPath,[WATCH,result.run,'--org',f.org,'--detach','--log',path.join(f.root,'duplicate.log')],{cwd:f.repo,env:{...process.env,ORG_ACTOR:'dispatch-test-agent',PATH:`${path.join(f.root,'bin')}:${process.env.PATH}`,FAKE_ROOT:f.root},encoding:'utf8'});
  assert.equal(duplicate.status,1);assert.match(fs.readFileSync(path.join(f.root,'duplicate.log'),'utf8'),/another watcher/);
});

test('lost record start result is visible and recovered without starting a second run',t=>{
  const f=fixture(t),adapter=path.join(f.root,'record-adapter');
  fs.writeFileSync(adapter,`#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
const a=process.argv.slice(2),r=spawnSync(process.execPath,[${JSON.stringify(RECORD)},...a],{encoding:'utf8',env:process.env});
if(a[0]==='start') { console.error('lost start response');process.exit(1); }
process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status);
`,{mode:0o755});
  let r=f.start(['--org-cli',adapter]);assert.equal(r.status,1);const journal=f.jobs()[0],job=JSON.parse(fs.readFileSync(journal));assert.equal(job.stage,'starting');assert.equal(job.run,null);
  assert.equal(f.show('R-1').meta.dispatch_journal,journal);
  r=f.dispatch(['--retry',journal]);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).run,'R-1');
  assert.equal(f.show(f.item).runs.length,1);
});
test('live request locks refuse retries without changing the journal',t=>{
  const f=fixture(t);f.fail('watch');assert.equal(f.start().status,1);const journal=f.jobs()[0],before=fs.readFileSync(journal,'utf8');
  fs.writeFileSync(journal+'.lock',String(process.pid));
  const r=f.dispatch(['--retry',journal]);assert.equal(r.status,1);assert.match(r.stderr,/already running/);assert.equal(fs.readFileSync(journal,'utf8'),before);
});
test('explicit fresh launch and accepted delivery recover uncertain attempts',t=>{
  const f=fixture(t);f.fail('dispatch');assert.equal(f.start().status,1);const job=JSON.parse(fs.readFileSync(f.jobs()[0]));
  f.fail('prompt');let r=f.dispatch(['--retry',job.run,'--fresh']);assert.equal(r.status,1);assert.match(r.stderr,/injected prompt/);
  f.fail('');r=f.dispatch(['--retry',job.run,'--accept-delivered']);assert.equal(r.status,0,r.stderr);assert.equal(promptCalls(f).length,1);
});
test('invalid route and empty brief mutate neither lane nor record',t=>{
  const f=fixture(t);let r=f.dispatch([f.item,'--lane','topic','--route','missing','--brief',f.brief]);assert.equal(r.status,1);assert.match(r.stderr,/unknown route/);
  fs.writeFileSync(f.brief,'');r=f.start();assert.equal(r.status,1);assert.match(r.stderr,/nonempty/);
  assert.equal(f.calls().filter(x=>x.type==='lane').length,0);assert.equal(fs.existsSync(path.join(f.org,'dispatch')),false);
});

test('a refused record start with no matching run retries the saved request',t=>{
  const f=fixture(t),adapter=path.join(f.root,'record-adapter'),refuse=path.join(f.root,'refuse-start');
  fs.writeFileSync(refuse,'yes');
  fs.writeFileSync(adapter,`#!/usr/bin/env node
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const a=process.argv.slice(2);
if(a[0]==='start' && fs.existsSync(${JSON.stringify(refuse)})) { console.error('record: injected record refusal');process.exit(1); }
const r=spawnSync(process.execPath,[${JSON.stringify(RECORD)},...a],{encoding:'utf8',env:process.env});
process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status);
`,{mode:0o755});
  let r=f.start(['--org-cli',adapter]);assert.equal(r.status,1);
  const journal=f.jobs()[0];assert.equal(JSON.parse(fs.readFileSync(journal)).stage,'starting');
  assert.deepEqual(f.show(f.item).runs,[]);
  fs.unlinkSync(refuse);r=f.dispatch(['--retry',journal,'--org-cli',adapter]);assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(r.stdout).run,'R-1');assert.equal(promptCalls(f).length,1);
  assert.equal(f.calls().filter(x=>x.type==='lane'&&x.a[0]==='open').length,1);
});
test('a run ID supplied as ITEM is refused before creating a lane or journal',t=>{
  const f=fixture(t),run=f.rec(['start',f.item]).match(/^(R-\d+) started/m)[1];
  const r=f.dispatch([run,'--lane','topic','--route','engineer','--brief',f.brief]);
  assert.equal(r.status,1);assert.match(r.stderr,/must be an item/);
  assert.equal(f.calls().filter(x=>x.type==='lane').length,0);
  assert.equal(fs.existsSync(path.join(f.org,'dispatch')),false);
  assert.deepEqual(f.show(f.item).runs,[run]);
});
test('reuse refuses an idle worker whose previous run is still open',t=>{
  const f=fixture(t),first=JSON.parse(f.start().stdout);
  const file=path.join(f.root,'workers'),workers=JSON.parse(fs.readFileSync(file));
  workers[first.agent].agent_status='idle';fs.writeFileSync(file,JSON.stringify(workers));
  const r=f.start(['--reuse',first.run]);assert.equal(r.status,1);assert.match(r.stderr,/reported or abandoned/);
  assert.equal(JSON.parse(r.stdout).code,'REUSE_RUN_OPEN');
  assert.equal(promptCalls(f).length,1);
  assert.equal(f.calls().filter(x=>x.type==='lane'&&x.a[0]==='dispatch').length,1);
  assert.deepEqual(f.show(f.item).runs,[first.run]);
});
test('reuse accepts an abandoned run with the same stopped occupant',t=>{
  const f=fixture(t),first=JSON.parse(f.start().stdout);f.rec(['abandon',first.run]);
  const file=path.join(f.root,'workers'),workers=JSON.parse(fs.readFileSync(file));
  workers[first.agent].agent_status='done';fs.writeFileSync(file,JSON.stringify(workers));
  const r=f.start(['--reuse',first.run]);assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(r.stdout).agent,first.agent);
});

test('reuse lane, route and declared-field mismatches refuse before any lane or run side effect',t=>{
  const f=fixture(t),first=JSON.parse(f.start().stdout);f.rec(['abandon',first.run]);
  const config=JSON.parse(fs.readFileSync(path.join(f.repo,'.lane.json')));
  config.routes.other={...config.routes.engineer};
  fs.writeFileSync(path.join(f.repo,'.lane.json'),JSON.stringify(config));
  for(const field of ['lane','route','harness','model','effort']) {
    const changed=structuredClone(config);
    if(field==='harness') changed.routes.engineer.kind='claude';
    if(['model','effort'].includes(field)) changed.routes.engineer[field]='changed';
    fs.writeFileSync(path.join(f.repo,'.lane.json'),JSON.stringify(changed));
    const events=fs.readFileSync(path.join(f.org,'events.jsonl')),calls=f.calls().length,jobs=f.jobs().length;
    const r=f.dispatch([f.item,'--lane',field==='lane'?'other-lane':'topic','--route',field==='route'?'other':'engineer',
      '--brief',f.brief,'--reuse',first.run,'--awaited']);
    assert.equal(r.status,1,field);assert.equal(JSON.parse(r.stdout).code,'REUSE_MISMATCH',r.stderr);
    assert.deepEqual(fs.readFileSync(path.join(f.org,'events.jsonl')),events);
    assert.equal(f.jobs().length,jobs);assert.equal(f.calls().slice(calls).filter(c=>c.type==='lane').length,0);
  }
});

test('from-run refuses another item and superseded origins before opening a lane or starting a run',t=>{
  const f=fixture(t),other=f.rec(['add','Other item','--role','engineer']).split(' ')[0];
  const first=f.rec(['start',f.item]).match(/R-\d+/)[0],later=f.rec(['start',f.item]).match(/R-\d+/)[0];
  const foreign=f.rec(['start',other]).match(/R-\d+/)[0];
  for(const [origin,code] of [[foreign,'FROM_RUN_OTHER_ITEM'],[first,'FROM_RUN_SUPERSEDED']]) {
    const events=fs.readFileSync(path.join(f.org,'events.jsonl'));
    const r=f.start(['--from-run',origin,'--awaited']);
    assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).code,code);
    if(origin===first) assert.match(JSON.parse(r.stdout).reason,new RegExp(`${first} is superseded by ${later}`));
    assert.deepEqual(fs.readFileSync(path.join(f.org,'events.jsonl')),events);
    assert.equal(f.calls().filter(c=>c.type==='lane').length,0);
    assert.equal(fs.existsSync(path.join(f.org,'dispatch')),false);
  }
});

test('cross-item reuse accepts the same lane and identity without adding an origin precondition',t=>{
  const f=fixture(t),first=JSON.parse(f.start().stdout);f.rec(['abandon',first.run]);
  const file=path.join(f.root,'workers'),workers=JSON.parse(fs.readFileSync(file));
  workers[first.agent].agent_status='done';fs.writeFileSync(file,JSON.stringify(workers));
  const other=f.rec(['add','Sibling slice','--role','engineer']).split(' ')[0];
  const r=f.dispatch([other,'--lane','topic','--route','engineer','--brief',f.brief,'--reuse',first.run]);
  assert.equal(r.status,0,r.stderr);const next=JSON.parse(r.stdout),run=f.show(next.run);
  assert.equal(next.agent,first.agent);assert.equal(next.pane,first.pane);
  assert.equal(run.meta.agent_session_id,f.show(first.run).meta.agent_session_id);
  assert.equal(run.meta.continuation_of,first.run);assert.equal(run.meta.same_session,true);
  assert.equal(JSON.parse(fs.readFileSync(next.journal)).fromRun,null);
  assert.deepEqual(f.show(f.item).runs,[first.run]);assert.deepEqual(f.show(other).runs,[next.run]);
  assert.equal(f.calls().filter(c=>c.type==='lane'&&c.a[0]==='dispatch').length,1);
});

test('an older reported run cannot lend a worker held by a newer open correction, even when idle or done',t=>{
  const f=fixture(t),first=JSON.parse(f.start().stdout),report=f.show(first.run).report_path;
  fs.writeFileSync(report,`---\nrun: ${first.run}\noutcome: done\nsummary: First run complete\n---\n`);f.rec(['ingest',report]);
  const file=path.join(f.root,'workers'),workers=JSON.parse(fs.readFileSync(file));
  workers[first.agent].agent_status='idle';fs.writeFileSync(file,JSON.stringify(workers));
  const second=f.start(['--reuse',first.run]);assert.equal(second.status,0,second.stderr);
  const correction=JSON.parse(second.stdout);
  const other=f.rec(['add','Sibling work','--role','engineer']).split(' ')[0];
  const reuse=()=>f.dispatch([other,'--lane','topic','--route','engineer','--brief',f.brief,'--reuse',first.run,'--awaited']);
  for(const status of ['idle','done']) {
    workers[first.agent].agent_status=status;fs.writeFileSync(file,JSON.stringify(workers));
    const events=fs.readFileSync(path.join(f.org,'events.jsonl')),jobs=f.jobs().length,calls=f.calls().length;
    const r=reuse();assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).code,'REUSE_WORKER_BUSY');
    assert.ok(JSON.parse(r.stdout).reason.includes(correction.run));
    assert.deepEqual(fs.readFileSync(path.join(f.org,'events.jsonl')),events);
    assert.equal(f.jobs().length,jobs);assert.equal(f.calls().slice(calls).filter(c=>c.type==='lane').length,0);
    assert.equal(promptCalls(f).length,2);
  }
  f.rec(['abandon',correction.run]);
  const released=reuse();assert.equal(released.status,0,released.stderr);
  assert.equal(JSON.parse(released.stdout).agent,first.agent);
});

test('reuse rechecks newer open occupant holders immediately before prompting',async t=>{
  const f=fixture(t),first=JSON.parse(f.start().stdout);f.rec(['abandon',first.run]);
  const file=path.join(f.root,'workers'),workers=JSON.parse(fs.readFileSync(file));
  workers[first.agent].agent_status='done';fs.writeFileSync(file,JSON.stringify(workers));
  const hook=pauseHook(f,`const rename=fs.renameSync;let once=true;fs.renameSync=function(from,to) {
 const result=rename.call(fs,from,to);
 if(once && String(to).endsWith('.json')) {
  const job=JSON.parse(read.call(fs,to,'utf8'));
  if(job.reuse && job.stage==='prompt') {once=false;pause();}
 }
 return result;
};`);
  const pending=f.concurrent([f.item,'--lane','topic','--route','engineer','--brief',f.brief,'--reuse',first.run],hook);
  let holder;
  try {
    await until(()=>fs.existsSync(hook.PAUSE_MARKER));
    const other=f.rec(['add','Sibling work','--role','engineer']).split(' ')[0],prior=f.show(first.run);
    holder=f.rec(['start',other,'--workspace',prior.workspace]).match(/R-\d+/)[0];
    f.rec(['worker',holder,'--agent',prior.meta.agent,'--pane',prior.meta.pane,
      '--worker-workspace',prior.meta.worker_workspace,'--cwd',prior.workspace,
      '--terminal-id',prior.meta.terminal_id,'--agent-session-id',prior.meta.agent_session_id]);
  } finally {fs.writeFileSync(hook.PAUSE_RELEASE,'go');await pending.done;}
  const r=await pending.done;assert.equal(r.status,1,r.stderr);
  assert.equal(JSON.parse(r.stdout).code,'REUSE_WORKER_BUSY');assert.ok(JSON.parse(r.stdout).reason.includes(holder));
  assert.equal(promptCalls(f).length,1,'the new dispatch never prompts its worker');
});

test('terminal-only reuse refused before prompting retries with a fresh session binding window',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-reuse-window-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const preload=path.join(root,'clock.cjs');
  fs.writeFileSync(preload,`if([${JSON.stringify(DISPATCH)},${JSON.stringify(RECORD)}].includes(process.argv[1])) {
 const fs=require('node:fs'),path=require('node:path'),now=Date.now;
 const offset=path.join(process.env.FAKE_ROOT,'clock-offset');
 Date.now=()=>now()+(fs.existsSync(offset)?Number(fs.readFileSync(offset,'utf8')):0);
}`);
  const f=fixture(t,{lateSession:'delayed',preload});f.fail('watch');
  const initial=f.start();assert.equal(initial.status,1,initial.stderr);
  const prior=f.show(JSON.parse(fs.readFileSync(f.jobs()[0])).run);
  assert.ok(prior.meta.terminal_id);assert.equal(prior.meta.agent_session_id,undefined);
  assert.equal(f.state().sessionBindings.get(prior.id),undefined);
  f.fail('');f.rec(['abandon',prior.id]);
  // Start the holder first but publish its terminal claim only after preflight.
  // A newer worker receipt independently forbids late binding even if abandoned.
  const other=f.rec(['add','Temporary holder','--role','engineer']).split(' ')[0];
  const holder=f.rec(['start',other,'--workspace',prior.workspace]).match(/R-\d+/)[0];
  const hook=pauseHook(f,`const rename=fs.renameSync;let once=true;fs.renameSync=function(from,to) {
 const result=rename.call(fs,from,to);
 if(once && String(to).endsWith('.json')) {
  const job=JSON.parse(read.call(fs,to,'utf8'));
  if(job.reuse && job.stage==='prompt') {once=false;pause();}
 }
 return result;
};`);
  hook.NODE_OPTIONS+=` --require=${preload}`;
  const pending=f.concurrent([f.item,'--lane','topic','--route','engineer','--brief',f.brief,'--reuse',prior.id],hook);
  try {
    await until(()=>fs.existsSync(hook.PAUSE_MARKER));
    f.rec(['worker',holder,'--agent','temporary-holder','--pane','holder:pane',
      '--worker-workspace',prior.meta.worker_workspace,'--cwd',prior.workspace,'--terminal-id',prior.meta.terminal_id]);
  } finally {fs.writeFileSync(hook.PAUSE_RELEASE,'go');await pending.done;}
  const refused=await pending.done;assert.equal(refused.status,1,refused.stderr);
  const receipt=JSON.parse(refused.stdout);assert.equal(receipt.code,'REUSE_WORKER_BUSY');
  const before=JSON.parse(fs.readFileSync(receipt.journal));
  assert.equal(before.stage,'prompt');assert.equal(before.worker.agentSessionId,undefined);
  assert.equal(before.sessionBinding,undefined,'a refused prompt does not start its observation window');
  assert.equal(promptCalls(f).length,0);
  const refusedAt=Date.now();
  fs.writeFileSync(path.join(f.root,'clock-offset'),'61000');
  f.rec(['abandon',holder]);
  const retry=f.dispatch(['--retry',before.run]);assert.equal(retry.status,0,retry.stderr);
  assert.equal(JSON.parse(retry.stdout).binding.status,'bound');
  const after=JSON.parse(fs.readFileSync(receipt.journal)),state=f.state(),run=f.show(before.run);
  assert.ok(Date.parse(after.sessionBinding.prompted_at)>=refusedAt+61000);
  assert.equal(Date.parse(after.sessionBinding.deadline)-Date.parse(after.sessionBinding.prompted_at),60000);
  assert.equal(state.sessionBindings.get(before.run).length,1);
  assert.equal(run.meta.agent_session_id,undefined,'the launch receipt stays terminal-only');
  assert.equal(effectiveWorkerIdentity(run,state).agent_session_id,'s-worker-1');
  assert.equal(promptCalls(f).length,1,'only the successful retry delivers work');
});

test('reuse identity classification is local to the worker stage and preserves existing codes',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-reuse-codes-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const preload=path.join(root,'fault.cjs');
  fs.writeFileSync(preload,`if(process.argv[1]===${JSON.stringify(DISPATCH)}) {
 const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),spawn=cp.spawnSync;
 cp.spawnSync=function(command,args,options) {
  const root=process.env.FAKE_ROOT,fault=path.join(root,'reuse-fault.json');
  if(path.basename(command)==='lane' && args?.[0]==='verify-agent' && fs.existsSync(fault)) {
   const target=JSON.parse(fs.readFileSync(fault,'utf8')),directory=path.join(process.env.ORG_DIR,'dispatch');
   const matches=fs.readdirSync(directory).filter(file=>file.endsWith('.json')&&!file.endsWith('.routes.json'))
    .map(file=>JSON.parse(fs.readFileSync(path.join(directory,file),'utf8')))
    .some(job=>job.reuse && job.stage===target.stage);
   if(matches) throw Object.assign(new Error('injected reuse identity transport failure'),target.code?{code:target.code}:{});
  }
  return spawn.call(this,command,args,options);
 };require('node:module').syncBuiltinESMExports();
}`);
  for(const [stage,code,expected] of [
    ['worker',null,'REUSE_IDENTITY_UNKNOWN'],['worker','REUSE_WORKER_BUSY','REUSE_WORKER_BUSY'],
    ['worker','EAGAIN','DISPATCH_FAILED'],['record-worker',null,'DISPATCH_FAILED'],
    ['watch',null,'DISPATCH_FAILED'],['prompt',null,'DISPATCH_FAILED'],['watch','EMFILE','DISPATCH_FAILED'],
  ]) {
    const f=fixture(t,{preload}),first=JSON.parse(f.start().stdout);f.rec(['abandon',first.run]);
    const file=path.join(f.root,'workers'),workers=JSON.parse(fs.readFileSync(file));
    workers[first.agent].agent_status='done';fs.writeFileSync(file,JSON.stringify(workers));
    fs.writeFileSync(path.join(f.root,'reuse-fault.json'),JSON.stringify({stage,code}));
    const r=f.start(['--reuse',first.run]);assert.equal(r.status,1,`${stage}: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).code,expected,`${stage} ${code}: ${r.stderr}`);
    assert.match(JSON.parse(r.stdout).reason,/injected reuse identity transport failure/);
    const job=JSON.parse(fs.readFileSync(JSON.parse(r.stdout).journal));
    assert.equal(job.stage,stage);assert.equal(promptCalls(f).length,1);
  }
});

test('native filesystem error codes are normalized without changing failure reasons',t=>{
  const f=fixture(t),missing=path.join(f.root,'missing-brief.md');
  const r=f.dispatch([f.item,'--lane','topic','--route','engineer','--brief',missing]);
  assert.equal(r.status,1);const failed=JSON.parse(r.stdout);
  assert.equal(failed.result,'failed');assert.equal(failed.code,'DISPATCH_FAILED');
  assert.match(failed.reason,/ENOENT/);assert.ok(failed.reason.includes(missing));
  assert.ok(r.stderr.includes(failed.reason));assert.deepEqual(f.show(f.item).runs,[]);
  assert.equal(fs.existsSync(path.join(f.org,'dispatch')),false);
});

test('late reuse identity and busy refusals retain their messages and supply stable codes',t=>{
  for(const kind of ['missing','replaced','busy']) {
    const f=fixture(t),first=JSON.parse(f.start().stdout);f.rec(['abandon',first.run]);
    const file=path.join(f.root,'workers'),workers=JSON.parse(fs.readFileSync(file));
    workers[first.agent].agent_status=kind==='busy'?'working':'done';
    if(kind==='missing') f.rec(['set',first.run,'terminal_id=','agent_session_id=']);
    if(kind==='replaced') workers[first.agent].terminal_id='replacement';
    fs.writeFileSync(file,JSON.stringify(workers));
    const r=f.start(['--reuse',first.run]);assert.equal(r.status,1);
    assert.equal(JSON.parse(r.stdout).code,kind==='busy'?'REUSE_WORKER_BUSY':'REUSE_IDENTITY_UNKNOWN',r.stderr);
    assert.match(r.stderr,kind==='busy'?/idle or done/:kind==='missing'?/consistent recorded occupant/:/occupant identity changed/);
    assert.equal(promptCalls(f).length,1);
    assert.equal(f.calls().filter(c=>c.type==='lane'&&c.a[0]==='dispatch').length,1);
  }
});
async function until(predicate) {
  const end=Date.now()+5000;
  while(!predicate()) { if(Date.now()>end)throw new Error('test barrier timed out');await new Promise(r=>setTimeout(r,10)); }
}
function pauseHook(f,body) {
  const hook=path.join(f.root,'pause.mjs');
  fs.writeFileSync(hook,`import fs from 'node:fs';
const read=fs.readFileSync,kill=process.kill;
function pause() {
 fs.writeFileSync(process.env.PAUSE_MARKER,'ready');
 const end=Date.now()+10000;
 while(!fs.existsSync(process.env.PAUSE_RELEASE)) {
  if(Date.now()>end)throw new Error('hook barrier timed out');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
 }
}
if(process.argv[1]===${JSON.stringify(DISPATCH)}) { ${body} }
`);
  return {NODE_OPTIONS:`--import=${hook}`,PAUSE_MARKER:path.join(f.root,'paused'),PAUSE_RELEASE:path.join(f.root,'release')};
}
test('retry locks before reading its journal so another retry cannot replay stale progress',async t=>{
  const f=fixture(t);f.fail('watch');assert.equal(f.start().status,1);
  const journal=f.jobs()[0];f.fail('');
  const hook=pauseHook(f,`let once=true;fs.readFileSync=function(file,...args) {
 const value=read.call(fs,file,...args);
 if(once && String(file)===${JSON.stringify(journal)}) {once=false;pause();}
 return value;
};`);
  const first=f.concurrent(['--retry',journal],hook);
  try {
    await until(()=>fs.existsSync(hook.PAUSE_MARKER));
    const second=f.dispatch(['--retry',journal]);
    assert.equal(second.status,1,second.stderr);assert.match(second.stderr,/already running/);
  } finally { fs.writeFileSync(hook.PAUSE_RELEASE,'go');await first.done; }
  assert.equal((await first.done).status,0);
  assert.equal(promptCalls(f).length,1);assert.equal(f.calls().filter(x=>x.type==='watch').length,2);
  assert.equal(f.dispatch(['--retry',journal]).status,0);assert.equal(promptCalls(f).length,1);
});
test('two retries cannot both take over a dead-owner lock',async t=>{
  const f=fixture(t);f.fail('watch');assert.equal(f.start().status,1);
  const journal=f.jobs()[0];f.fail('');
  const dead=spawnSync(process.execPath,['-e',''],{encoding:'utf8'}).pid;
  fs.writeFileSync(journal+'.lock',String(dead));
  fs.mkdirSync(journal+'.locks',{recursive:true});fs.writeFileSync(path.join(journal+'.locks',`${dead}-crashed`),'');
  const hook=pauseHook(f,`process.kill=function(pid,...args) {
 if(pid===${dead}) { try {return kill.call(process,pid,...args);} catch(error) {pause();throw error;} }
 return kill.call(process,pid,...args);
};`);
  const first=f.concurrent(['--retry',journal],hook);
  try {
    await until(()=>fs.existsSync(hook.PAUSE_MARKER));
    const second=f.dispatch(['--retry',journal]);
    assert.equal(second.status,1,second.stderr);assert.match(second.stderr,/already running/);
  } finally { fs.writeFileSync(hook.PAUSE_RELEASE,'go');await first.done; }
  assert.equal((await first.done).status,0);assert.equal(promptCalls(f).length,1);
  assert.equal(fs.existsSync(journal+'.lock'),false);
  assert.deepEqual(fs.readdirSync(journal+'.locks'),[]);
});

test('an unknown start outcome with no match stays conservative; multiple matches require explicit recovery',t=>{
  const f=fixture(t),adapter=path.join(f.root,'record-adapter');
  fs.writeFileSync(adapter,`#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
const a=process.argv.slice(2);
if(a[0]==='start') {console.error('unknown transport failure');process.exit(1);}
const r=spawnSync(process.execPath,[${JSON.stringify(RECORD)},...a],{encoding:'utf8',env:process.env});
process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status);
`,{mode:0o755});
  assert.equal(f.start(['--org-cli',adapter]).status,1);
  const journal=f.jobs()[0],job=JSON.parse(fs.readFileSync(journal));
  let r=f.dispatch(['--retry',journal]);assert.equal(r.status,1);assert.match(r.stderr,/--recover-run/);
  assert.deepEqual(f.show(f.item).runs,[]);
  for(let i=0;i<2;i++)f.rec(['start',f.item,'--route',job.route,'--route-config',job.routeConfig,
    '--workspace',job.workspace,'--meta',`lane=${job.lane}`,'--meta',`dispatch_journal=${journal}`]);
  r=f.dispatch(['--retry',journal]);assert.equal(r.status,1);assert.match(r.stderr,/multiple matches/);
  assert.equal(promptCalls(f).length,0);assert.equal(f.show(f.item).runs.length,2);
  // Also cover a committed run whose brief was never materialized.
  fs.unlinkSync(f.show('R-1').brief_path);
  r=f.dispatch(['--retry',journal,'--recover-run','R-1']);assert.equal(r.status,0,r.stderr);
  assert.ok(fs.readFileSync(f.show('R-1').brief_path,'utf8').includes('R-1'));
  assert.equal(JSON.parse(r.stdout).run,'R-1');assert.equal(f.show(f.item).runs.length,2);
});


test('dispatch waits for a real watcher whose configuration read exceeds the old startup deadline at load 24', { timeout: 60000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-loaded-start-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const preload = path.join(root, 'load.cjs');
  fs.writeFileSync(preload, `const os=require('node:os');os.loadavg=()=>[24,24,24];os.availableParallelism=()=>4;
const cp=require('node:child_process'),original=cp.spawnSync;
cp.spawnSync=function(command,args,options){
if(process.argv[1]===${JSON.stringify(WATCH)}&&!process.argv.includes('--detach')&&args?.includes('show'))
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,11000);
return original.call(this,command,args,options);};require('node:module').syncBuiltinESMExports();`);
  const f = fixture(t, { realWatch: true, preload });
  const result = f.start();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const receipt = JSON.parse(result.stdout);
  assert.ok(receipt.watcher.pid > 0);
  const job = JSON.parse(fs.readFileSync(receipt.journal));
  assert.equal(job.stage, 'complete');
  assert.equal(promptCalls(f).length, 1);
  const log = fs.readFileSync(receipt.watcher.log, 'utf8');
  assert.match(log, /watching R-1/);
});
