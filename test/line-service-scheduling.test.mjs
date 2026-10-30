import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {initOrg,transact} from '../lib/store.mjs';
import {gitProject} from '../lib/project.mjs';
import {serviceDirectory,sourceRoot} from '../line-service/line-service.mjs';
import {commandIntent,finishCommand,assertCommandQuiescence,readCommandResult} from '../lib/command-receipt.mjs';
import {withRuntimeLocks} from '../line-service/runtime-locks.mjs';
import {serviceRecordBinding} from '../line-service/record-inbox.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';

async function until(predicate){
  const end=Date.now()+30000;
  while(!predicate()){assert.ok(Date.now()<end,'fixture progress did not arrive');await new Promise(resolve=>setTimeout(resolve,15));}
}
function fixture(t,cap=2){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'line-schedule-'))),repo=path.join(root,'project'),org=path.join(repo,'.org');
  fs.mkdirSync(repo);fs.writeFileSync(path.join(root,'.identity-root'),'fixture\n');
  const fleet=process.env.HERDR_MONITOR_FLEET;process.env.HERDR_MONITOR_FLEET=path.join(root,'fleet');
  t.after(()=>{if(fleet===undefined)delete process.env.HERDR_MONITOR_FLEET;else process.env.HERDR_MONITOR_FLEET=fleet;fs.rmSync(root,{recursive:true,force:true});});
  const env={...process.env,ORG_DIR:org,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
  for(const key of ['LANE_CONFIG','HERDR_ENV','HERDR_PANE_ID','HERDR_WORKSPACE_ID','CODEX_THREAD_ID'])delete env[key];
  const git=(...args)=>{const r=spawnSync('git',args,{cwd:repo,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git('init','-qb','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'source'),'initial');git('add','.');git('commit','-qm','Initial');initOrg(org);
  fs.writeFileSync(path.join(repo,'.lane.json'),JSON.stringify({routes:{engineer:{kind:'codex'}},dispatch:{max_sessions:cap}}));
  const project=gitProject(repo),directory=serviceDirectory(org,project.identity),boundary={id:'fixture',repo,org,project:project.identity,source:sourceRoot,main:'main',canonical_head:git('rev-parse','HEAD')};
  transact(org,()=>({add:['line-service.cutover','line-service.phase0'].map(type=>({type,...boundary}))}));
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({at:'2026-10-30T00:00:00Z',repo,org,source:sourceRoot,node:process.execPath,file:path.join(directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`}));
  const add=id=>transact(org,()=>({add:[{type:'item.added',id,role:'engineer',title:'Independent '+id,priority:id==='ENG-1'?2:1}]}));
  add('ENG-1');
  const driver=path.join(root,'driver.mjs');
  fs.writeFileSync(driver,`
import fs from 'node:fs';import path from 'node:path';
import {createLineService} from ${JSON.stringify(pathToFileURL(path.join(sourceRoot,'line-service/line-service.mjs')).href)};
import {checkSessionCap,acquireSessionCapLock} from ${JSON.stringify(pathToFileURL(path.join(sourceRoot,'dispatch/session-cap.mjs')).href)};
const repo=${JSON.stringify(repo)},org=${JSON.stringify(org)},root=${JSON.stringify(root)},common=${JSON.stringify(project.identity)},config={dispatch:{max_sessions:${cap}}};
createLineService({repo,org,to:'supervisor-test',env:process.env,haltAfter:100,maxStarts:1,
 command:(exe,args)=>{
  if(!args[0].endsWith('/dispatch/dispatch.mjs'))return{status:0,stdout:'{}',stderr:''};
  const item=args[1],jobs=path.join(org,'dispatch'),file=path.join(jobs,item+'.json');
  const release=acquireSessionCapLock(common);
  try{checkSessionCap({config,org,common,kind:'build'});fs.mkdirSync(jobs,{recursive:true});fs.writeFileSync(file,JSON.stringify({common,repo,org,item,token:item,stage:'starting',native_launch_attempted:false}));}finally{release();}
  fs.appendFileSync(path.join(root,'launches.jsonl'),JSON.stringify({item,at:Date.now(),pid:process.pid})+'\\n');
  if(item==='ENG-1'){
   fs.writeFileSync(path.join(root,'blocked'),'original command entered');
   while(!fs.existsSync(path.join(root,'release')))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15);
   const release=acquireSessionCapLock(common);try{fs.unlinkSync(file);}finally{release();}
  }
  return{status:0,stdout:JSON.stringify({result:'dispatched',item}),stderr:''};
 }}).pass();
`);
  const start=()=>{
    const child=spawn(process.execPath,[driver],{cwd:repo,env,stdio:['ignore','pipe','pipe']});let stderr='',stdout='';
    child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',b=>stdout+=b);
    const done=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal,stderr,stdout})));
    t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await done;});return{child,done};
  };
  return{root,repo,org,env,project,directory,add,start,
    journal:()=>JSON.parse(fs.readFileSync(path.join(directory,'effects.json'))),
    rows:()=>fs.readFileSync(path.join(directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse),
    launches:()=>fs.existsSync(path.join(root,'launches.jsonl'))?fs.readFileSync(path.join(root,'launches.jsonl'),'utf8').trim().split('\n').map(JSON.parse):[]};
}
function evidence(t,name,value){
  t.diagnostic(JSON.stringify({name,...value}));
  if(process.env.ENG1034_EVIDENCE){fs.mkdirSync(process.env.ENG1034_EVIDENCE,{recursive:true});fs.writeFileSync(path.join(process.env.ENG1034_EVIDENCE,name+'.json'),JSON.stringify(value,null,2)+'\n');}
}

for(const mode of ['available','full','crashed'])test(`scheduling yields slow A with ${mode} capacity and retains its original attempt`,async t=>{
  const f=fixture(t,mode==='full'?1:2),a=f.start();await until(()=>fs.existsSync(path.join(f.root,'blocked')));
  const original=Object.entries(f.journal().actions).find(([key])=>key.startsWith('dispatch:ENG-1:'));
  assert.equal(original[1].state,'started');assert.throws(()=>assertCommandQuiescence(f.directory),/active or UNKNOWN/);
  // The maintenance path can acquire pass.lock while A runs, but its new quiet
  // point must refuse before entering the original forward/rollback action.
  let transitions=0;assert.throws(()=>withRuntimeLocks({directory:f.directory,identity:f.project.identity,org:f.org},
    {id:'fixture',operation:'upgrade',dryRun:false,owner:{native:{name:'fixture'}},validate:()=>{}},()=>transitions++),/active or UNKNOWN/);
  assert.equal(transitions,0);
  if(mode==='crashed'){a.child.kill('SIGKILL');await a.done;}
  f.add('ENG-2');const b=f.start(),bResult=await b.done;assert.equal(bResult.code,0,bResult.stderr);
  assert.equal(f.launches().filter(r=>r.item==='ENG-1').length,1,'same subject was never launched twice');
  assert.deepEqual(f.journal().actions[original[0]],original[1],'another pass never rewrites the original pending action');
  const launches=f.launches(),eligible=f.rows().find(r=>r.action==='admission-eligible'&&r.item==='ENG-2');assert.ok(eligible);
  if(mode==='full'){
    assert.equal(launches.some(r=>r.item==='ENG-2'),false);assert.ok(f.rows().some(r=>r.action==='capacity-held'&&r.code==='DISPATCH_SESSION_CAP'));
    const wait=Object.values(f.journal().capacity_waits).find(w=>w.item==='ENG-2');assert.equal(wait.state,'waiting');assert.equal(wait.consumer,'line-service');
    fs.writeFileSync(path.join(f.root,'release'),'capacity released');assert.equal((await a.done).code,0);
    const next=f.start();assert.equal((await next.done).code,0);assert.equal(f.launches().filter(r=>r.item==='ENG-2').length,1);
    const released=Object.values(f.journal().capacity_waits).find(w=>w.item==='ENG-2');assert.equal(released.state,'released');assert.ok(released.duration_ms>0);
    assert.equal(released.first_at,wait.first_at);assert.ok(f.rows().some(r=>r.action==='admission-decision'&&r.item==='ENG-2'&&r.capacity_wait_ms===released.duration_ms));
  }else{
    const launched=launches.find(r=>r.item==='ENG-2');assert.ok(launched);assert.ok(launched.at-Date.parse(eligible.at)<5000,'B starts within five seconds of eligibility observation');
    if(mode==='available'){
      assert.equal(a.child.exitCode,null,'A remains deliberately blocked until B has completed');
      fs.writeFileSync(path.join(f.root,'release'),'original completion');assert.equal((await a.done).code,0);
      assertCommandQuiescence(f.directory);
      const actions=f.journal().actions;assert.equal(actions[original[0]].state,'complete');
      assert.ok(Object.values(actions).filter(e=>e.state==='complete').length>=2,'both completions survive interleaved whole-file saves');
      for(const action of Object.values(actions))if(action.state==='complete')for(const ref of action.commands??[]){
        assert.equal(fs.existsSync(ref.file),false);assert.equal(readCommandResult(ref).result.status,0,'terminal receipts remain readable after the active marker is removed');
      }
      withRuntimeLocks({directory:f.directory,identity:f.project.identity,org:f.org},
        {id:'fixture',operation:'rollback',dryRun:false,owner:{native:{name:'fixture'}},validate:()=>{}},()=>transitions++);assert.equal(transitions,1);
    }else assert.throws(()=>assertCommandQuiescence(f.directory),/active or UNKNOWN/,'parent death cannot authorize maintenance or replay');
  }
  const rows=f.rows();evidence(t,mode,{launches:f.launches(),lock_segments:rows.filter(r=>r.action==='schedule-unlocked'),
    completions:rows.filter(r=>r.action==='pass-complete'),admission:rows.filter(r=>r.action.startsWith('admission-')||r.action==='capacity-held'),actions:f.journal().actions,
    capacity_waits:f.journal().capacity_waits??{},command_results:fs.readdirSync(path.join(f.directory,'command-receipts')).map(name=>JSON.parse(fs.readFileSync(path.join(f.directory,'command-receipts',name))))});
});

test('STOP appearing during slow A preserves its receipt and prevents B native admission',async t=>{
  const f=fixture(t),a=f.start();await until(()=>fs.existsSync(path.join(f.root,'blocked')));f.add('ENG-2');
  fs.writeFileSync(path.join(f.directory,'STOP'),'original stop');const b=f.start();const result=await b.done;assert.equal(result.code,0,result.stderr);
  assert.equal(f.launches().length,1);fs.writeFileSync(path.join(f.root,'release'),'finish original');const ended=await a.done;
  // STOP may terminate further scans after the original completion is saved.
  assert.ok([0,1].includes(ended.code));assert.equal(Object.values(f.journal().actions).find(e=>e.subject.startsWith('dispatch:ENG-1:')).state,'complete');
  assert.equal(f.launches().some(e=>e.item==='ENG-2'),false);
});

test('a foreground helper saves the original terminal receipt after its scheduling parent dies',async t=>{
  const f=fixture(t),script=path.join(f.root,'slow.mjs'),parent=path.join(f.root,'parent.mjs'),refFile=path.join(f.root,'ref.json');
  fs.writeFileSync(script,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(f.root,'child-entered'))},'entered');while(!fs.existsSync(${JSON.stringify(path.join(f.root,'release'))}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15);process.stdout.write('original result');`);
  fs.writeFileSync(parent,`import fs from 'node:fs';import {commandIntent} from ${JSON.stringify(pathToFileURL(path.join(sourceRoot,'lib/command-receipt.mjs')).href)};
import {foregroundCommand} from ${JSON.stringify(pathToFileURL(path.join(sourceRoot,'dispatch/foreground-command.mjs')).href)};
const exe=process.execPath,args=[${JSON.stringify(script)}],cwd=${JSON.stringify(f.repo)},ref=commandIntent(${JSON.stringify(f.directory)},{exe,args,cwd,consumer:'line-service',wake_fact:'terminal receipt',stuck_owner:'supervisor-test'});fs.writeFileSync(${JSON.stringify(refFile)},JSON.stringify(ref));foregroundCommand(exe,args,{cwd,env:process.env,commandReceipt:ref});`);
  const child=spawn(process.execPath,[parent],{cwd:f.repo,env:f.env,stdio:'ignore'}),done=new Promise(resolve=>child.once('close',resolve));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await done;});
  await until(()=>fs.existsSync(path.join(f.root,'child-entered')));const ref=JSON.parse(fs.readFileSync(refFile));
  child.kill('SIGKILL');await done;assert.throws(()=>assertCommandQuiescence(f.directory),/active or UNKNOWN/);
  fs.writeFileSync(path.join(f.root,'release'),'original child may finish');await until(()=>{try{return JSON.parse(fs.readFileSync(ref.receipt)).result?.status===0;}catch{return false;}});
  const receipt=JSON.parse(fs.readFileSync(ref.receipt));assert.equal(receipt.result.status,0);assert.equal(receipt.result.stdout,'original result');
  assert.ok(receipt.execution.pid>0);assert.ok(Date.parse(receipt.execution.started_at)>=Date.parse(receipt.intent.at));
  assertCommandQuiescence(f.directory);assert.ok(fs.existsSync(ref.file),'orphan intent remains available for its owner');
  evidence(t,'orphan-result',receipt);
});

test('maintenance refuses redirected or inconsistent terminal evidence and retains the active intent',t=>{
  const f=fixture(t),ref=commandIntent(f.directory,{exe:'fixture',args:[],cwd:f.repo,consumer:'line-service',wake_fact:'terminal receipt',stuck_owner:'supervisor-test'});
  finishCommand(ref,{status:0,stdout:'original'});assertCommandQuiescence(f.directory);
  const receipt=JSON.parse(fs.readFileSync(ref.receipt));receipt.intent_sha256='0'.repeat(64);fs.writeFileSync(ref.receipt,JSON.stringify(receipt));
  assert.throws(()=>assertCommandQuiescence(f.directory),/binding changed/);assert.ok(fs.existsSync(ref.file));
});

test('an UNKNOWN command on a subject fences a changed action key while an independent subject still starts',async t=>{
  const f=fixture(t);f.add('ENG-2');
  const ref=commandIntent(f.directory,{exe:'original-native',args:[],cwd:f.repo,subject:'ENG-1',key:'older-input:ENG-1',
    consumer:'line-service',wake_fact:'original terminal receipt',stuck_owner:'supervisor-test'});
  const before=fs.readFileSync(ref.file),pass=f.start();assert.equal((await pass.done).code,0);
  assert.deepEqual(fs.readFileSync(ref.file),before);assert.deepEqual(f.launches().map(row=>row.item),['ENG-2']);
});

test('direct service operations require the exact subject-lock token as well as the actual owner PID',t=>{
  const f=fixture(t),subject='ENG-1',lock=path.join(f.directory,'subjects',createHash('sha256').update(JSON.stringify(subject)).digest('hex')+'.lock'),release=noticeLock(lock);
  try{
    const owner=JSON.parse(fs.readFileSync(path.join(lock,'owner.json'))),env={...f.env,HERDR_LINE_SUBJECT:subject,HERDR_LINE_SUBJECT_TOKEN:owner.token};
    assert.equal(serviceRecordBinding({repo:f.repo,org:f.org,env}).identity,f.project.identity);
    for(const token of [undefined,'older-owner'])assert.throws(()=>serviceRecordBinding({repo:f.repo,org:f.org,env:{...env,HERDR_LINE_SUBJECT_TOKEN:token}}),/actual owned pass lock/);
  }finally{release();}
});
