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
import {commandIntent,finishCommand,forgetActiveCommand,assertCommandQuiescence,readCommandResult} from '../lib/command-receipt.mjs';
import {withRuntimeLocks} from '../line-service/runtime-locks.mjs';
import {serviceRecordBinding} from '../line-service/record-inbox.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';

async function until(predicate){
  const end=Date.now()+30000;
  while(!predicate()){assert.ok(Date.now()<end,'fixture progress did not arrive');await new Promise(resolve=>setTimeout(resolve,15));}
}
function fixture(t,cap=2,{detached=false,fence=false}={}){
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
  const driver=path.join(root,'driver.mjs'),helper=path.join(root,'dispatch-helper.mjs');
  // Run the real foreground receipt helper. This preload replaces only native
  // dispatch in the isolated project, and survives the scheduling parent's kill.
  fs.writeFileSync(helper,`
import fs from 'node:fs';import path from 'node:path';
import {transact} from ${JSON.stringify(pathToFileURL(path.join(sourceRoot,'lib/store.mjs')).href)};
if(process.argv[1]?.endsWith('/dispatch/dispatch.mjs')){
const root=${JSON.stringify(root)},repo=${JSON.stringify(repo)},org=${JSON.stringify(org)},common=${JSON.stringify(project.identity)};
const item=process.argv[2],token=item,brief=process.argv[process.argv.indexOf('--brief')+1],journal=path.join(org,'dispatch',token+'.json');
fs.mkdirSync(path.dirname(journal),{recursive:true});
fs.writeFileSync(journal,JSON.stringify({common,repo,org,item,token,brief,stage:'starting',completion_protocol:1,native_launch_attempted:false}));
fs.appendFileSync(path.join(root,'launches.jsonl'),JSON.stringify({item,at:Date.now(),pid:process.pid})+'\\n');
fs.writeFileSync(path.join(root,'blocked'),'helper entered');
while(!fs.existsSync(path.join(root,'release')))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15);
if(${fence})transact(org,()=>({add:[{type:'dispatch.completed',project:common,journal,attempt:token,item,run:null,failure:{kind:'fence',code:'NATIVE_REFUSAL'}}]}));
process.stdout.write(JSON.stringify({result:'detached',journal,item}));process.exit(0);
}
`);
  fs.writeFileSync(driver,`
import fs from 'node:fs';import path from 'node:path';
import {createLineService} from ${JSON.stringify(pathToFileURL(path.join(sourceRoot,'line-service/line-service.mjs')).href)};
import {checkSessionCap,acquireSessionCapLock} from ${JSON.stringify(pathToFileURL(path.join(sourceRoot,'dispatch/session-cap.mjs')).href)};
import {foregroundCommand} from ${JSON.stringify(pathToFileURL(path.join(sourceRoot,'dispatch/foreground-command.mjs')).href)};
const repo=${JSON.stringify(repo)},org=${JSON.stringify(org)},root=${JSON.stringify(root)},common=${JSON.stringify(project.identity)},config={dispatch:{max_sessions:${cap}}};
createLineService({repo,org,to:'supervisor-test',env:process.env,haltAfter:100,maxStarts:1,
 command:(exe,args,options)=>{
  if(!args[0].endsWith('/dispatch/dispatch.mjs'))return{status:0,stdout:'{}',stderr:''};
  if(${detached})return foregroundCommand(exe,args,{...options,env:{...options.env,NODE_OPTIONS:'--import='+${JSON.stringify(helper)}}});
  const item=args[1],jobs=path.join(org,'dispatch'),file=path.join(jobs,item+'.json');
  const release=acquireSessionCapLock(common);
  try{checkSessionCap({config,org,common,kind:'build'});fs.mkdirSync(jobs,{recursive:true});fs.writeFileSync(file,JSON.stringify({common,repo,org,item,token:item,stage:'starting',native_launch_attempted:false}));}finally{release();}
  fs.appendFileSync(path.join(root,'launches.jsonl'),JSON.stringify({item,at:Date.now(),pid:process.pid})+'\\n');
  if(item==='ENG-1'||item==='ENG-2'&&fs.existsSync(path.join(root,'block-second'))){
   fs.writeFileSync(path.join(root,'blocked-'+item),'original command entered');
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

test('two retained general owners bound repeated wakes before another full-record scan',async t=>{
  const f=fixture(t,3),a=f.start();await until(()=>fs.existsSync(path.join(f.root,'blocked')));
  fs.writeFileSync(path.join(f.root,'block-second'),'hold independent effect');f.add('ENG-2');
  const b=f.start();await until(()=>fs.existsSync(path.join(f.root,'blocked-ENG-2')));
  f.add('ENG-3');const before=f.rows().filter(r=>r.action==='pass-start').length;
  const actions=f.journal().actions,owners=[0,1].map(n=>fs.readFileSync(path.join(f.directory,`general-${n}.lock/owner.json`)));
  for(let n=0;n<3;n++){const wake=f.start();assert.equal((await wake.done).code,0);}
  assert.equal(f.rows().filter(r=>r.action==='pass-start').length,before,'no extra snapshot/backlog scan starts');
  assert.equal(f.rows().filter(r=>r.action==='general-owner-held').length,3);
  assert.deepEqual(f.journal().actions,actions,'pending effects remain unchanged');
  for(let n=0;n<owners.length;n++)assert.deepEqual(fs.readFileSync(path.join(f.directory,`general-${n}.lock/owner.json`)),owners[n]);
  assert.deepEqual(f.launches().map(r=>r.item),['ENG-1','ENG-2']);
  fs.writeFileSync(path.join(f.root,'release'),'original effects may finish');
  assert.equal((await a.done).code,0);assert.equal((await b.done).code,0);
  const next=f.start();assert.equal((await next.done).code,0);
  assert.equal(f.launches().filter(r=>r.item==='ENG-3').length,1);
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
  finishCommand(ref,{status:0,stdout:'original'});assert.throws(()=>assertCommandQuiescence(f.directory),/original caller/);
  const receipt=JSON.parse(fs.readFileSync(ref.receipt));receipt.intent_sha256='0'.repeat(64);fs.writeFileSync(ref.receipt,JSON.stringify(receipt));
  assert.throws(()=>assertCommandQuiescence(f.directory),/binding changed/);assert.ok(fs.existsSync(ref.file));
});

test('missing completion is UNKNOWN; a cleaned active marker requires its bound retained terminal result',t=>{
  const f=fixture(t),ref=commandIntent(f.directory,{exe:'fixture',args:[],cwd:f.repo,subject:'ENG-1',stuck_owner:'brain-chat'});
  const intent=fs.readFileSync(ref.file);
  assert.throws(()=>assertCommandQuiescence(f.directory),error=>{
    assert.equal(error.code,'LINE_COMMAND_OUTCOME_UNKNOWN');assert.equal(error.cause.code,'ENOENT');
    assert.ok(error.message.includes(`cannot validate terminal receipt ${ref.receipt}`));
    assert.deepEqual(error.command,ref);assert.equal(error.stuck_owner,'brain-chat');return true;
  });
  assert.deepEqual(fs.readFileSync(ref.file),intent,'missing receipt never clears the original intent');
  // A terminal failure is also quiescent, but is never converted into success.
  finishCommand(ref,{status:1,stderr:'original failure'});const terminal=fs.readFileSync(ref.receipt);
  assert.throws(()=>assertCommandQuiescence(f.directory),/original caller/);forgetActiveCommand(ref);assertCommandQuiescence(f.directory);
  assert.equal(fs.existsSync(ref.file),false);assert.equal(readCommandResult(ref).result.status,1);
  assert.deepEqual(fs.readFileSync(ref.receipt),terminal);
  const changed=JSON.parse(terminal);changed.intent.subject='ENG-2';fs.writeFileSync(ref.receipt,JSON.stringify(changed));
  assert.throws(()=>readCommandResult(ref),/retained command intent binding changed/);
  fs.unlinkSync(ref.receipt);assert.throws(()=>readCommandResult(ref),{code:'ENOENT'},'absence of both files is no terminal proof');
});

for(const phase of ['intent','receipt'])test(`quiescence proves the original terminal result when cleanup overtakes its ${phase} read`,t=>{
  const f=fixture(t),ref=commandIntent(f.directory,{exe:'fixture',args:[],cwd:f.repo,stuck_owner:'brain-chat'}),open=fs.openSync;
  let completed=false;
  t.mock.method(fs,'openSync',function(file,...args){
    if(!completed&&file===path.basename(ref.file)&&process.cwd()===path.dirname(phase==='intent'?ref.file:ref.receipt)){
      completed=true;finishCommand(ref,{status:0,stdout:'original result'});forgetActiveCommand(ref);
      throw Object.assign(Error('original read observed ENOENT before completion'),{code:'ENOENT'});
    }
    return Reflect.apply(open,fs,[file,...args]);
  });
  assertCommandQuiescence(f.directory,{commands:[ref]});assert.equal(completed,true);
  assert.equal(fs.existsSync(ref.file),false);assert.equal(readCommandResult(ref).result.stdout,'original result');
});

for(const proof of ['missing-reference','wrong-hash','missing-result'])test(`cleaned marker cannot prove quiescence with ${proof}`,t=>{
  const f=fixture(t),ref=commandIntent(f.directory,{exe:'fixture',args:[],cwd:f.repo}),open=fs.openSync;let cleaned=false;
  t.mock.method(fs,'openSync',function(file,...args){
    if(!cleaned&&file===path.basename(ref.file)&&process.cwd()===path.dirname(ref.file)){
      cleaned=true;finishCommand(ref,{status:0});forgetActiveCommand(ref);
      if(proof==='missing-result')fs.unlinkSync(ref.receipt);
      throw Object.assign(Error('marker cleaned after listing'),{code:'ENOENT'});
    }
    return Reflect.apply(open,fs,[file,...args]);
  });
  const commands=proof==='missing-reference'?[]:[{...ref,...(proof==='wrong-hash'?{sha256:'0'.repeat(64)}:{})}];
  assert.throws(()=>assertCommandQuiescence(f.directory,{commands}),{code:'LINE_COMMAND_OUTCOME_UNKNOWN'});
  assert.equal(cleaned,true);
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

for(const fence of [false,true])test(`a finite wake consumes the killed parent's detached dispatch receipt${fence?' and retains its child fence':''}`,async t=>{
  const f=fixture(t,2,{detached:true,fence}),a=f.start();await until(()=>fs.existsSync(path.join(f.root,'blocked')));
  const [key,original]=Object.entries(f.journal().actions).find(([k])=>k.startsWith('dispatch:ENG-1:')),[ref]=original.commands;
  const intent=fs.readFileSync(ref.file);
  a.child.kill('SIGKILL');await a.done;
  fs.writeFileSync(path.join(f.root,'release'),'original helper may finish');
  await until(()=>{try{return readCommandResult(ref).result.status===0;}catch{return false;}});
  const receipt=fs.readFileSync(ref.receipt),terminal=readCommandResult(ref),detached=JSON.parse(terminal.result.stdout);
  const journal=fs.readFileSync(detached.journal);
  assert.equal(detached.result,'detached');assert.ok(terminal.execution.pid>0);
  const wake=f.start(),result=await wake.done;assert.equal(result.code,0,result.stderr);
  const recovered=f.journal().actions[key];
  assert.equal(recovered.state,fence?'held':'complete');assert.equal(recovered.attempt,original.attempt);
  assert.deepEqual(recovered.commands,original.commands);assert.deepEqual(recovered.result,detached);
  assert.deepEqual(recovered.receipt,terminal.result);assert.equal(recovered.command_recovery.consumer,'line-service');
  assert.equal(recovered.command_recovery.attempt,original.attempt);
  if(fence){
    assert.equal(recovered.recorded_dispatch_status.failure.code,'NATIVE_REFUSAL');
    assert.equal(recovered.failure.kind,'fence');assert.ok(f.journal().outcome_decisions[key]);
  }
  assert.equal(f.launches().filter(r=>r.item==='ENG-1').length,1,'no second dispatch launch');
  assert.deepEqual(fs.readFileSync(ref.file),intent);assert.deepEqual(fs.readFileSync(ref.receipt),receipt);
  assert.deepEqual(fs.readFileSync(detached.journal),journal,'original detached request unchanged');
  evidence(t,fence?'crash-receipt-fence':'crash-receipt-consumed',{original,recovered,terminal,launches:f.launches(),
    original_intent_sha256:createHash('sha256').update(intent).digest('hex'),original_receipt_sha256:createHash('sha256').update(receipt).digest('hex'),
    outcome_decisions:f.journal().outcome_decisions??{}});
});

test('a changed input stays held with a stuck-owner diagnostic while the crashed caller helper still runs',async t=>{
  const f=fixture(t,2,{detached:true}),a=f.start();await until(()=>fs.existsSync(path.join(f.root,'blocked')));
  const [key,original]=Object.entries(f.journal().actions).find(([k])=>k.startsWith('dispatch:ENG-1:')),[ref]=original.commands;
  const intent=fs.readFileSync(ref.file);
  a.child.kill('SIGKILL');await a.done;
  try{
    transact(f.org,()=>({add:[{type:'item.reopened',id:'ENG-1',note:'changed dispatch generation'}]}));
    assert.equal(fs.existsSync(ref.receipt),false);
    const wake=f.start(),result=await wake.done;assert.equal(result.code,0,result.stderr);
    assert.equal(f.launches().length,1);assert.deepEqual(f.journal().actions[key],original);
    const diagnostic=Object.values(f.journal().record_notices).find(n=>n.scope.owner==='supervisor-test'&&n.scope.command?.sha256===ref.sha256);
    assert.ok(diagnostic,'note() retains the named stuck owner, not only subject-held logging');
    assert.ok(f.rows().some(r=>r.action==='hold'&&r.canonical_key&&r.scope?.owner==='supervisor-test'));
    assert.deepEqual(fs.readFileSync(ref.file),intent);assert.equal(fs.existsSync(ref.receipt),false);
    evidence(t,'crash-no-receipt-changed-input',{original,diagnostic,launches:f.launches(),actions:f.journal().actions});
  }finally{
    fs.writeFileSync(path.join(f.root,'release'),'finish original helper');
    await until(()=>{try{return readCommandResult(ref).result.status===0;}catch{return false;}});
  }
});

test('maintenance cannot transition after the terminal receipt while its live caller waits to journal',async t=>{
  const f=fixture(t,2,{detached:true}),a=f.start();await until(()=>fs.existsSync(path.join(f.root,'blocked')));
  const [key,original]=Object.entries(f.journal().actions).find(([k])=>k.startsWith('dispatch:ENG-1:')),[ref]=original.commands;
  let unlock=noticeLock(path.join(f.directory,'pass.lock')),paused=false;
  try{
    fs.writeFileSync(path.join(f.root,'release'),'finish helper behind scheduling owner');
    await until(()=>{try{return readCommandResult(ref).result.status===0;}catch{return false;}});
    assert.equal(f.journal().actions[key].state,'started');
    a.child.kill('SIGSTOP');paused=true;unlock();unlock=null;
    let transitions=0;
    assert.throws(()=>withRuntimeLocks({directory:f.directory,identity:f.project.identity,org:f.org},
      {id:'resume-boundary',operation:'upgrade',dryRun:false,owner:{native:{name:'fixture'}},validate:()=>{}},()=>transitions++),/original caller/);
    assert.equal(transitions,0);assert.ok(fs.existsSync(ref.file));
    evidence(t,'maintenance-resume-boundary',{state:f.journal().actions[key].state,transitions,terminal:readCommandResult(ref)});
  }finally{unlock?.();if(paused)a.child.kill('SIGCONT');}
  assert.equal((await a.done).code,0);assert.equal(f.journal().actions[key].state,'complete');assertCommandQuiescence(f.directory);
});

test('STOP plus a dead scheduling holder cannot replace a completed command result during resume',async t=>{
  const f=fixture(t),a=f.start();await until(()=>fs.existsSync(path.join(f.root,'blocked')));
  const [key,original]=Object.entries(f.journal().actions).find(([k])=>k.startsWith('dispatch:ENG-1:'));
  const holder=spawnSync(process.execPath,['--input-type=module','-e',
    `import {noticeLock} from ${JSON.stringify(pathToFileURL(path.join(sourceRoot,'supervisor/notice-lock.mjs')).href)};noticeLock(${JSON.stringify(path.join(f.directory,'pass.lock'))});`],{env:f.env,encoding:'utf8'});
  assert.equal(holder.status,0,holder.stderr);
  fs.writeFileSync(path.join(f.directory,'STOP'),'stop new effects');
  fs.writeFileSync(path.join(f.root,'release'),'finish owned effect');
  const result=await a.done;assert.ok([0,1].includes(result.code),result.stderr);
  const completed=f.journal().actions[key];assert.equal(completed.state,'complete');assert.equal(completed.attempt,original.attempt);
  assert.equal(readCommandResult(completed.commands[0]).result.status,0);
  assert.ok(f.rows().some(r=>r.action==='general-pass-lock-recovery'&&r.resume&&r.phase==='recovered'));
  assert.doesNotMatch(result.stderr,/journal mutation requires|scheduling lock/);assert.equal(f.launches().length,1);
  evidence(t,'stop-dead-holder-resume',{completed,result,recoveries:f.rows().filter(r=>r.action==='general-pass-lock-recovery')});
});

test('ordinary review-health overlap does not accumulate inspection diagnostics',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.root,'release'),'dispatch may finish');
  const lock=path.join(f.directory,'subjects',createHash('sha256').update(JSON.stringify('review-health')).digest('hex')+'.lock'),unlock=noticeLock(lock);
  try{
    for(let n=0;n<3;n++){const wake=f.start(),result=await wake.done;assert.equal(result.code,0,result.stderr);}
    assert.equal(f.rows().filter(r=>r.action==='review-health-held').length,3);
    assert.equal(Object.values(f.journal().record_notices??{}).some(n=>n.boundary==='review-health'),false);
    evidence(t,'review-health-overlap',{held:f.rows().filter(r=>r.action==='review-health-held'),notices:f.journal().record_notices??{}});
  }finally{unlock();}
});
