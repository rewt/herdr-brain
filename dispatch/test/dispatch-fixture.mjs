import { healthyMemoryEnvironment } from '../../test/helpers/promotion-memory-fixture.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { createReceiptTracker } from '../../test/helpers/receipts.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fold } from '../../lib/state.mjs';
import { BRAIN_CONTROLLER } from '../../lib/run-owner.mjs';

const DISPATCH = fileURLToPath(new URL('../dispatch.mjs', import.meta.url));
const RECORD = fileURLToPath(new URL('../../bin/org.mjs', import.meta.url));
const WATCH = fileURLToPath(new URL('../../watch/watch.mjs', import.meta.url));
const fake = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
const root = process.env.FAKE_ROOT;
const a = process.argv.slice(2), type = path.basename(process.argv[1]);
fs.appendFileSync(path.join(root,'calls'), JSON.stringify({type,a,pane:process.env.HERDR_PANE_ID??null})+'\\n');
const fail = fs.existsSync(path.join(root,'fail')) ? fs.readFileSync(path.join(root,'fail'),'utf8') : '';
const stateFile = path.join(root,'workers');
let workers = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : {};
function save() {
 const temporary=stateFile+'.'+process.pid+'.tmp';
 fs.writeFileSync(temporary,JSON.stringify(workers));fs.renameSync(temporary,stateFile);
}
function result(r) { process.stdout.write(JSON.stringify(r)+'\\n'); }
function git(args) { const r=spawnSync('git',args,{encoding:'utf8'}); if(r.status) throw new Error(r.stderr); return r.stdout.trim(); }
const entry=()=>git(['worktree','list','--porcelain']).split('\\n\\n').find(x=>x.includes('branch refs/heads/lane/topic'))?.split('\\n')[0].slice(9);
if(type==='org') {
 if(fail==='after-prompt' && a[0]==='note' && a[2]?.startsWith('Dispatch: prompt sent')) {console.error('lost process after saved delivery');process.exit(1);}
 if(process.env.TEST_TIMING_FAILURE && a[0]==='set' && /^(dispatch_waits|dispatch_admission_waits)=/.test(a[2]??'')) { console.error('injected timing set failure');process.exit(1); }
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
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)','--',root],{stdio:'ignore'}); child.unref();
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
  const fakeCommand = [process.execPath, '-e', 'setInterval(()=>{},1000)', '--', root].join(' ');
  for (const pid of fs.existsSync(path.join(root, 'pids')) ? fs.readFileSync(path.join(root, 'pids'), 'utf8').trim().split('\n').filter(Boolean).map(Number) : []) {
    receipts.remember(pid, fakeCommand);
  }
  for (const file of fs.existsSync(path.join(org, 'dispatch')) ? fs.readdirSync(path.join(org, 'dispatch')).filter(x => x.endsWith('.json') && !x.endsWith('.routes.json')) : []) {
    const job = JSON.parse(fs.readFileSync(path.join(org, 'dispatch', file)));
    if (job.watcher?.pid) receipts.remember(job.watcher.pid, realWatch ? [process.execPath, WATCH, job.run,
      '--controller', BRAIN_CONTROLLER, '--org', org, '--to', job.to, '--cwd', job.repo, '--log', path.join(org, 'dispatch', `${job.run}.watch.log`)].join(' ') : fakeCommand);
  }
}
function fixture(t, { realWatch = false, preload, noticeRecipient = '', timingFailure = false, timingRecord = timingFailure, lateSession = '', project, sourceEntry = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-test-')));
  const repo = project?.cwd ?? path.join(root, 'repo'), org = project?.env.ORG_DIR ?? path.join(root, 'org'), bin = path.join(root, 'bin');
  // Adopted source entry points select the installed release. Use the fixture's
  // immutable bundle to keep dispatch, record and run ownership in this product.
  const dispatchCLI = sourceEntry ? DISPATCH : project ? path.join(project.bundle, 'dispatch/dispatch.mjs') : DISPATCH;
  const recordCLI = project ? path.join(project.bundle, 'bin/org.mjs') : RECORD;
  if (!project) fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  const env = { ...healthyMemoryEnvironment(project?.env ?? process.env), ORG_ACTOR: 'dispatch-test-agent', ORG_DIR: org, FAKE_ROOT:root, LANE_CONFIG:path.join(repo,'.lane.json'),
    MONITOR_SUPERVISOR_AGENT: noticeRecipient, HERDR_AGENT_NAME: 'chat-operator',
    TEST_LATE_SESSION: lateSession, TEST_NATIVE_PID: String(process.pid),
    HERDR_MONITOR_FLEET: project?.env.HERDR_MONITOR_FLEET ?? path.join(root, 'fleet.json'), TEST_TIMING_FAILURE: timingFailure ? '1' : '',
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1',
    HERDR_PANE_ID:'supervisor:pane', HERDR_TAB_ID:'supervisor:tab', HERDR_WORKSPACE_ID:'supervisor:w' };
  if (project) delete env.LANE_CONFIG;
  if (preload) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --require=${preload}`;
  for(const key of Object.keys(env)) if(key.startsWith('GIT_CONFIG_') && !['GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM'].includes(key)) delete env[key];
  const receipts = createReceiptTracker();
  // Install cleanup before setup or any assertion can fail.
  t.after(()=>{
    try { rememberProcesses(root, org, realWatch, receipts); }
    finally { receipts.cleanup(); fs.rmSync(root,{recursive:true,force:true}); }
  });
  const exec=(cmd,args,cwd=repo,overrides={},options={})=>{
    const result=spawnSync(cmd,args,{cwd,env:{...env,...overrides},encoding:'utf8',...options});
    rememberProcesses(root, org, realWatch, receipts);
    return result;
  };
  const git=(args,cwd)=>{const r=exec('git',args,cwd);assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  if (!project) {
    git(['init','-b','main']);git(['config','user.name','Dispatch Tests']);git(['config','user.email','dispatch@example.invalid']);
    fs.writeFileSync(path.join(repo,'seed'),'seed');git(['add','.']);git(['commit','-m','seed']);
    fs.writeFileSync(path.join(repo,'.lane.json'),JSON.stringify({routes:{engineer:{kind:'codex',model:'model-a',effort:'high'}}}));
  }
  for(const name of ['herdr','lane','watch','org']) fs.writeFileSync(path.join(bin,name),fake,{mode:0o755});
  const rec=(args,overrides={})=>{const r=exec(process.execPath,[recordCLI,...args],repo,overrides);assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  if (!project) rec(['init']);
  const item=rec(['add','Do the work','--role','engineer']).split('\n')[0].match(/ENG-\d+/)[0];
  const brief=path.join(root,'brief with spaces.md');fs.writeFileSync(brief,'# Do the work');
  const common=['--org',org,'--repo',repo, ...(timingRecord?['--org-cli',path.join(bin,'org')]:[]),'--lane-cli',path.join(bin,'lane'), ...(realWatch?[]:['--watch-cli',path.join(bin,'watch')])];
  const dispatch=(args=[],options={})=>{
    const {entry=dispatchCLI,...execution}=options;
    return exec(process.execPath,[entry,...common,...args],repo,{},execution);
  };
  const start=(extra=[],options={})=>dispatch([item,'--lane','topic','--route','engineer','--brief',brief,...extra],options);
  const calls=()=>fs.existsSync(path.join(root,'calls'))?fs.readFileSync(path.join(root,'calls'),'utf8').trim().split('\n').map(x=>JSON.parse(x)):[];
  const jobs=()=>fs.readdirSync(path.join(org,'dispatch')).filter(x=>x.endsWith('.json')&&!x.endsWith('.routes.json')).map(x=>path.join(org,'dispatch',x));
  const fail=(stage)=>fs.writeFileSync(path.join(root,'fail'),stage);
  const show=(run)=>JSON.parse(rec(['show',run,'--json']));
  const concurrent=(args,extraEnv={})=>{
    const child=spawnChild(t,process.execPath,[dispatchCLI,...common,...args],{cwd:repo,env:{...env,...extraEnv},stdio:['ignore','pipe','pipe']});
    const done=waitForExit(child);
    return {child,done};
  };
  const state=()=>fold(fs.readFileSync(path.join(org,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse));
  return {root,repo,org,env,brief,item,start,dispatch,concurrent,rec,show,calls,jobs,fail,git,state};
}
const promptCalls=(f)=>f.calls().filter(x=>x.type==='herdr'&&x.a[0]==='agent'&&x.a[1]==='prompt');
function unlandedSetting(f, cap) {
  const file = path.join(f.repo, '.lane.json'), config = JSON.parse(fs.readFileSync(file));
  config.dispatch = { ...config.dispatch, max_unlanded: cap };
  fs.writeFileSync(file, JSON.stringify(config));
}
function pendingItem(f, { item = f.rec(['add', 'Pending landing', '--role', 'engineer']), meta = [], admitted = true } = {}) {
  const project = f.git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const run = f.rec(['start', item, '--workspace', f.repo, '--meta', `dispatch_project=${project}`,
    ...(admitted ? ['--meta', 'dispatch_unlanded_admitted=true'] : []), ...meta.flatMap(m => ['--meta', m])]).match(/^(R-\d+) started/m)[1];
  return { item, run };
}
// Verbatim supervisor capture from stalled pane w2SW:p1 on 2026-10-05.
const hooksTableScreen = fs.readFileSync(new URL('./fixtures/codex-0.160.0-hooks-screen.txt', import.meta.url), 'utf8');
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
  return {NODE_OPTIONS:`${f.env.NODE_OPTIONS ?? ''} --import=${hook}`,PAUSE_MARKER:path.join(f.root,'paused'),PAUSE_RELEASE:path.join(f.root,'release')};
}

function admissionHook(f, body) {
  return pauseHook(f, `const list=fs.readdirSync;fs.readdirSync=function(dir,...args) {
 if(String(dir).endsWith('dispatch-session-cap.contenders')) fs.appendFileSync(process.env.PAUSE_MARKER+'.attempts',process.pid+'\\n');
 return list.call(this,dir,...args);
}; ${body}`);
}
const admissionAttempts = hook => new Set(fs.readFileSync(`${hook.PAUSE_MARKER}.attempts`, 'utf8').trim().split('\n')).size;
function sessionCapSetting(f, cap) {
  const file = path.join(f.repo, '.lane.json'), config = JSON.parse(fs.readFileSync(file));
  config.dispatch = { ...config.dispatch, max_sessions: cap };
  fs.writeFileSync(file, JSON.stringify(config));
}
// New --reuse requests are refused. Model a request an older dispatcher saved
// before lane preparation, with its reuse run as that dispatcher persisted it;
// --retry then exercises the retained saved-request reuse contract.
function savedReuse(f, reuse, args = [f.item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief]) {
  const before = new Set(fs.existsSync(path.join(f.org, 'dispatch')) ? f.jobs() : []);
  f.fail('prepare'); const r = f.dispatch(args); f.fail('');
  assert.equal(r.status, 1, r.stderr);
  const journal = f.jobs().find(file => !before.has(file)), job = JSON.parse(fs.readFileSync(journal));
  assert.equal(job.stage, 'open'); assert.equal(job.run, null); assert.equal(job.reuse, null);
  fs.writeFileSync(journal, JSON.stringify({ ...job, reuse }));
  return journal;
}
// Memory is advisory; a genuine live proving reservation is the remaining wait.
async function provingWait(f, stage, { dispatch = [f.item, '--lane', 'topic', '--route', 'engineer', '--brief', f.brief] } = {}) {
  const { publishProvingReservation } = await import('../../test-slot/reservations.mjs');
  const lock = path.join(f.root, 'proving-slot');
  // Pause the saved worker stage before its proving check. The open check
  // remains real and unheld; only the intended stage gets a reservation.
  const hook = stage === 'worker' ? pauseHook(f, `const rename=fs.renameSync;let once=true;
fs.renameSync=function(from,to) {
 const result=rename.call(this,from,to);
 if(once && String(to).startsWith(${JSON.stringify(path.join(f.org, 'dispatch') + path.sep)}) && String(to).endsWith('.json') && JSON.parse(read(to)).stage==='worker') {
  once=false;pause();
 }
 return result;
};`) : {};
  const reserve = () => publishProvingReservation({ lockPath: lock, label: 'proof', reason: `dispatch ${stage} barrier`,
    expiresAt: new Date(Date.now() + 60000).toISOString() });
  let held = stage === 'open' ? reserve() : undefined, stderr = '';
  const pending = f.concurrent(dispatch, { ...hook, MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock });
  pending.child.stderr.on('data', data => { stderr += data; });
  try {
    if (stage === 'worker') {
      await until(() => fs.existsSync(hook.PAUSE_MARKER));
      held = reserve(); fs.writeFileSync(hook.PAUSE_RELEASE, 'go');
    }
    await until(() => stderr.includes('waiting; proving'));
    return { pending, held };
  } catch (error) {
    held?.release();
    if (hook.PAUSE_RELEASE) fs.writeFileSync(hook.PAUSE_RELEASE, 'go');
    await pending.done;
    throw error;
  }
}

export { DISPATCH, RECORD, WATCH, fixture, rememberProcesses, promptCalls, unlandedSetting, sessionCapSetting, savedReuse, provingWait, pendingItem, until, pauseHook, admissionHook, admissionAttempts, hooksTableScreen, startupHookReviewScreen };
