import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {foregroundCommand,executeForeground} from '../dispatch/foreground-command.mjs';
import {watchRun} from '../test-slot/watch.mjs';
import {originalDispatchOutcome} from '../dispatch/outcome.mjs';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {gitProject} from '../lib/project.mjs';
import {createLineService,sourceRoot} from '../line-service/line-service.mjs';
import {transact,loadEvents} from '../lib/store.mjs';
import {fold} from '../lib/state.mjs';

test('REV-63 detached refusal routes one decision',t=>{
  for(const kind of ['refusal','success','foreign-attempt']){
    const f=configFixture(t,{custom:true}),repo=f.cwd,org=f.env.ORG_DIR,common=gitProject(repo).identity;
    transact(org,()=>({add:[{type:'item.added',id:'ENG-1',role:'engineer',title:'Original detached work'}]}));
    const journal=path.join(org,'dispatch','original.json'),launches=[],native=[];
    const command=(exe,args)=>{
      if(exe==='herdr'){native.push(args);throw Error('no native call is needed to consume original completion');}
      if(!args[0].endsWith('/dispatch/dispatch.mjs'))return{status:0,stdout:'{}',stderr:''};
      launches.push(args);
      if(args[1]==='ENG-1'){
        fs.mkdirSync(path.dirname(journal),{recursive:true});
        fs.writeFileSync(journal,JSON.stringify({token:'original',repo,org,common,item:'ENG-1',brief:args[args.indexOf('--brief')+1],
          stage:'open',run:null,native_launch_attempted:false,completion_protocol:1}));
        return{status:0,stdout:JSON.stringify({result:'detached',journal,token:'original'}),stderr:''};
      }
      return{status:0,stdout:'{"result":"dispatched"}',stderr:''};
    };
    const options={repo,org,to:'brain-chat',env:f.env,command,haltAfter:100,maxStarts:1,capacity:()=>({count:0,cap:7}),
      recordNotice:r=>({id:r.id,state:'record-only'})};
    const service=createLineService(options),file=path.join(service.directory,'effects.json');
    fs.mkdirSync(service.directory,{recursive:true});
    fs.writeFileSync(path.join(service.directory,'installation.json'),JSON.stringify({at:'2026-10-29T00:00:00Z',repo,org,source:sourceRoot,node:process.execPath,
      file:path.join(service.directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(service.directory)}`}));
    service.pass();service.pass();
    const read=()=>JSON.parse(fs.readFileSync(file)),[key,parent]=Object.entries(read().actions).find(([key])=>key.startsWith('dispatch:ENG-1:'));
    assert.equal(parent.state,'complete');assert.equal(parent.result.result,'detached');assert.equal(parent.original_outcome.producer.attempt,'original');
    assert.equal(parent.recorded_dispatch_status,undefined);
    const original=fs.readFileSync(journal);
    const [status]=transact(org,()=>({add:[{type:'dispatch.completed',project:common,journal,attempt:kind==='foreign-attempt'?'foreign':'original',
      item:'ENG-1',run:null,stage:kind==='success'?'complete':'worker',exit_code:kind==='success'?0:1,native_launch_attempted:kind==='success',
      failure:kind==='success'?null:{code:'EACCES',kind:'fence'},request_sha256:'original-child-terminal-evidence'}]})).added;
    transact(org,()=>({add:[{type:'item.added',id:'ENG-2',role:'engineer',title:'Independent ready work'}]}));
    for(let n=0;n<3;n++)createLineService(options).pass();
    const saved=read(),entry=saved.actions[key],decisions=[...fold(loadEvents(org).events).items.values()].filter(i=>i.meta.uncertain_outcome);
    assert.deepEqual(entry.result,parent.result,'successful detached parent acknowledgement remains saved');
    assert.deepEqual(fs.readFileSync(journal),original,'consumer never rewrites the original request');
    assert.equal(launches.filter(a=>a[1]==='ENG-1').length,1);assert.equal(launches.filter(a=>a[1]==='ENG-2').length,1);assert.deepEqual(native,[]);
    if(kind==='refusal'){
      assert.equal(entry.state,'held');assert.deepEqual(entry.failure,{code:'EACCES',kind:'fence'});assert.deepEqual(entry.recorded_dispatch_status,status);
      assert.equal(decisions.length,1);const check=decisions[0].meta.uncertain_outcome.check;
      assert.deepEqual(check.status,status);assert.equal(check.subject.journal,journal);assert.equal(check.subject.attempt,'original');
      assert.deepEqual(check.failure,status.failure);assert.equal(Object.keys(saved.outcome_decisions).length,1);
    }else{
      assert.equal(decisions.length,0);assert.equal(entry.state,'complete');assert.equal(entry.failure,undefined);
      assert.deepEqual(entry.recorded_dispatch_status,kind==='success'?status:undefined);
    }
  }
});

test('retained launch foreground command outlives an elapsed budget and returns its real original result',()=>{
  const r=foregroundCommand(process.execPath,['-e',"setTimeout(()=>process.stdout.write('original complete'),90)"],{encoding:'utf8',timeout:20,env:{...process.env,MONITOR_TEST_SLOT_FROZEN_SECONDS:'0'}});
  assert.equal(r.status,0,r.stderr);assert.equal(r.signal,null);assert.equal(r.stdout,'original complete');assert.equal(r.error,undefined);
});

test('retained launch activity and unknown audits never signal while confirmed inactivity signals only the same owned birth once',async()=>{
  for(const kind of ['active','unknown','replaced','inactive']){
    let at=0,watcher,signals=0;const child=new EventEmitter();child.pid=421;child.exitCode=null;child.signalCode=null;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{signals++;return true;};
    const read=()=>({ok:true,value:{pid:421,identity:kind==='replaced'&&at>0?'replacement':'owned',state:'S'}});
    const promise=executeForeground({exe:'owned-fixture',args:[],cwd:process.cwd()},{launch:()=>child,readProcess:read,watch:options=>watcher=watchRun({...options,now:()=>at,startTimer:false,frozen:2,idleSeconds:0,
      sample:()=>kind==='unknown'?null:[{pid:421,identity:'owned',state:kind==='active'?'R':'S',cpu:'00:00.01'}]})});
    at=3;watcher.tick();at=6;watcher.tick();assert.equal(signals,kind==='inactive'?1:0,kind);
    child.exitCode=0;child.emit('close',0,null);const r=await promise;assert.equal(r.signal_sent,kind==='inactive');assert.equal(r.status,0);
  }
});

test('retained launch outcome binds the original request and record without inferring zero native work from a missing run',t=>{
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,repo=f.cwd,common=gitProject(repo).identity,dir=path.join(org,'dispatch'),brief=path.join(org,'frozen.ask.md');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(brief,'original');
  const args={repo,org,common,item:'ENG-1',brief,events:[]};assert.equal(originalDispatchOutcome(args).status,'unknown');
  const file=path.join(dir,'original.json'),job={token:'original',repo,org,common,item:'ENG-1',brief,stage:'open',run:null};fs.writeFileSync(file,JSON.stringify(job));const bytes=fs.readFileSync(file);
  const unknown=originalDispatchOutcome(args);assert.equal(unknown.status,'retained');assert.equal(unknown.journal,file);assert.equal(unknown.native_launch_attempted,null);assert.equal(unknown.run,null);assert.deepEqual(fs.readFileSync(file),bytes);
  const event={type:'run.started',id:'R-1',item:'ENG-1',workspace:repo,meta:{dispatch_project:common,dispatch_journal:file,dispatch_attempt:'original'}};
  fs.writeFileSync(file,JSON.stringify({...job,stage:'complete',run:'R-1',workspace:repo,native_launch_attempted:true,worker:{agentName:'original-worker'}}));
  const result=originalDispatchOutcome({...args,events:[event]});assert.equal(result.status,'dispatch-complete');assert.equal(result.run,'R-1');assert.equal(result.native_launch_attempted,true);
  fs.writeFileSync(file,JSON.stringify({...job,repo:'/foreign'}));assert.throws(()=>originalDispatchOutcome(args),/binding/);
});

test('retained launch live-shaped elapsed failure gets original-effect readback and never a second dispatch',t=>{
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,common=gitProject(f.cwd).identity;
  transact(org,()=>({add:[{type:'item.added',id:'ENG-1',role:'engineer',title:'Real ready proof'}]}));
  let launches=0;const command=(_exe,args)=>{
    if(args[0].endsWith('/dispatch/dispatch.mjs')){launches++;const directory=path.join(org,'dispatch');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'original.json'),JSON.stringify({token:'original',repo:f.cwd,org,common,item:'ENG-1',brief:args[args.indexOf('--brief')+1],stage:'open',run:null}));return {error:Object.assign(Error('spawnSync pinned Node ETIMEDOUT'),{code:'ETIMEDOUT'}),status:null,signal:'SIGTERM',stdout:'',stderr:''};}
    return {status:0,stdout:'{}',stderr:''};
  };
  const options={repo:f.cwd,org,to:'brain-chat',env:f.env,command,capacity:()=>({cap:7,count:0}),recordNotice:r=>({id:r.id,state:'record-only'}),maxStarts:1};
  createLineService(options).pass();const service=createLineService(options);service.pass();service.pass();assert.equal(launches,1);
  const effects=JSON.parse(fs.readFileSync(path.join(service.directory,'effects.json'))),entry=Object.values(effects.actions).find(e=>e.receipt?.error==='ETIMEDOUT');
  assert.equal(entry.state,'held');assert.equal(entry.receipt.signal,'SIGTERM');assert.equal(entry.original_outcome.status,'retained');assert.equal(entry.original_outcome.native_launch_attempted,null);
  assert.equal(fs.existsSync(path.join(service.directory,'pass.lock')),false);
});
