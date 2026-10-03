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
if(type==='lane') {
 if(fail===a[0]) { console.error('injected '+fail); process.exit(1); }
 if(a[0]==='open') git(['worktree','add','-b','lane/'+a[1],path.join(root,'lane'),a[2]??'HEAD']);
 if(a[0]==='prepare' && !entry()) process.exit(1);
 if(a[0]==='dispatch') {
  const n='worker-'+(Object.keys(workers).length+1), cwd=entry();
  workers[n]={name:n,pane_id:'w:p'+n,workspace_id:'w',cwd,terminal_id:'t-'+n,agent_session:{value:'s-'+n},agent_status:'idle'};save();
  const snap=JSON.parse(fs.readFileSync(a[a.indexOf('--route-config')+1]));
  fs.writeFileSync(path.join(root,'launch-route'),JSON.stringify(snap.routes.engineer));
  if(fail==='uncertain-launch') process.exit(1);
  result({agentName:n,pane:workers[n].pane_id,workspaceId:'w',terminalId:'t-'+n,agentSessionId:'s-'+n,cwd});
 }
 if(a[0]==='verify-agent') { if(!workers[a[1]] || fs.realpathSync(workers[a[1]].cwd)!==fs.realpathSync(a[2])) process.exit(1); }
} else if(type==='watch') {
 if(fail==='watch') { console.error('injected watch');process.exit(1); }
 const child=spawn(process.execPath,['-e','setTimeout(()=>{},10000)','--',root],{stdio:'ignore'}); child.unref();
 fs.appendFileSync(path.join(root,'pids'),child.pid+'\\n');
 result({run:a[0],pid:child.pid,log:path.join(root,a[0]+'.log')});
} else {
 if(a[0]==='agent' && a[1]==='get') {
  const agent=a[2]==='supervisor-herdr'?{name:a[2]}:workers[a[2]];
  if(!agent) {console.error(JSON.stringify({error:{code:'agent_not_found'}}));process.exit(1);}
  result({result:{agent}});
 }
 if(a[0]==='agent' && a[1]==='prompt') {
  if(fail==='prompt') {console.error('injected prompt');process.exit(1);}
  workers[a[2]].agent_status='working';save();result({result:{}});
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
function fixture(t, { realWatch = false, preload } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-test-')));
  const repo = path.join(root, 'repo'), org = path.join(root, 'org'), bin = path.join(root, 'bin');
  fs.mkdirSync(repo);fs.mkdirSync(bin);
  const env = { ...process.env, ORG_ACTOR: 'dispatch-test-agent', ORG_DIR: org, FAKE_ROOT:root, LANE_CONFIG:path.join(repo,'.lane.json'),
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
  for(const name of ['herdr','lane','watch']) fs.writeFileSync(path.join(bin,name),fake,{mode:0o755});
  const rec=(args,overrides={})=>{const r=exec(process.execPath,[RECORD,...args],repo,overrides);assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  rec(['init']);const item=rec(['add','Do the work','--role','engineer']).split('\n')[0].match(/ENG-\d+/)[0];
  const brief=path.join(root,'brief with spaces.md');fs.writeFileSync(brief,'# Do the work');
  const common=['--org',org,'--repo',repo,'--lane-cli',path.join(bin,'lane'), ...(realWatch?[]:['--watch-cli',path.join(bin,'watch')])];
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
  return {root,repo,org,brief,item,start,dispatch,concurrent,rec,show,calls,jobs,fail,git};
}
const promptCalls=(f)=>f.calls().filter(x=>x.type==='herdr'&&x.a[0]==='agent'&&x.a[1]==='prompt');
test('dispatch serves a validated operator priority, preserves it through recovery and permits unaligned work', t => {
  const f = fixture(t);
  f.rec(['priorities', 'add', 'Adoption', '--why=Useful to people'], { ORG_ACTOR: 'human' });
  let r = f.start(['--serves=P-404']);
  assert.equal(r.status, 1); assert.match(r.stderr, /unknown priority/);
  assert.equal(f.git(['worktree', 'list', '--porcelain']).includes('lane/topic'), false);
  f.fail('watch'); r = f.start(['--serves=P-1']); assert.equal(r.status, 1);
  const job = JSON.parse(fs.readFileSync(f.jobs()[0], 'utf8'));
  assert.equal(job.serves, 'P-1'); assert.equal(f.show(job.run).meta.serves, 'P-1');
  assert.equal(f.show(job.run).started.by, 'dispatch-test-agent');
  assert.equal(JSON.parse(f.rec(['priorities', '--json'])).priorities[0].created.by, 'human');
  assert.match(fs.readFileSync(f.show(job.run).brief_path, 'utf8'), /P-1\*\* Adoption/);
  fs.unlinkSync(path.join(f.root, 'fail'));
  r = f.dispatch(['--retry', job.run, '--serves=P-1']); assert.equal(r.status, 1);
  r = f.dispatch(['--retry', job.run]); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.show(job.run).meta.serves, 'P-1');
  const other = fixture(t); r = other.start(); assert.equal(r.status, 0, r.stderr);
  assert.equal(other.show(JSON.parse(r.stdout).run).meta.serves ?? null, null);
});
test('one command records exact route/worker fields, arms watch before prompt, and preserves briefs',t=>{
  const f=fixture(t), before=fs.readFileSync(f.brief,'utf8');
  const r=f.start(['--report','docs/reports/round.md','--extra','Fix round: inspect the review.']);assert.equal(r.status,0,r.stderr);
  const result=JSON.parse(r.stdout),run=f.show(result.run);
  assert.deepEqual([run.meta.route,run.meta.harness,run.meta.model,run.meta.effort,run.meta.lane],['engineer','codex','model-a','high','topic']);
  assert.equal(run.meta.agent,result.agent);assert.equal(run.meta.pane,result.pane);
  assert.equal(run.report_path,path.join(f.root,'lane','docs/reports/round.md'));
  assert.equal(run.meta.watcher_pid,result.watcher.pid);
  const calls=f.calls(),watch=calls.findIndex(x=>x.type==='watch'),prompt=calls.findIndex(x=>x.a[1]==='prompt');assert.ok(watch<prompt);
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
  r=f.start();assert.equal(r.status,0,r.stderr);assert.notEqual(JSON.parse(r.stdout).agent,first.agent);
  f.rec(['set',first.run,'model=wrong']);r=f.start(['--reuse',first.run]);assert.equal(r.status,1);assert.match(r.stderr,/declared harness/);
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
